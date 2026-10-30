const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BRIDGE = fs.readFileSync(
  path.join(__dirname, '../web/player-bridge.js'),
  'utf8'
);
const PARENT = 'https://parent.example';
const OWN = 'https://host.example';
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Loads the classic bridge before the core's ready handlers in a fresh page.
 * Fetch answers and a controllable clock cover session probes without real
 * requests or delays; the dispatcher and animation frames model the player.
 */
function bridge(options = {}) {
  const framed = options.framed !== false;
  const search =
    options.search ?? `?parentOrigin=${encodeURIComponent(PARENT)}`;
  const notifications = [];
  const listeners = [];
  const readyHandlers = [];
  const dispatcherHandlers = {};
  const frames = [];
  const triggered = [];
  const content = {
    getAttribute: (name) => (name === 'data-content-id' ? '7' : null)
  };
  const parent = {
    postMessage(message, origin) {
      if (options.refusePost) {
        throw new DOMException('could not be cloned', 'DataCloneError');
      }
      notifications.push({ message: structuredClone(message), origin });
    }
  };
  const timers = new Map();
  let timerId = 0;
  let now = 1_000_000;
  const H5P = options.H5P || {};
  H5P.instances ??= [];
  H5P.trigger ??= (instance, type) => triggered.push([instance, type]);
  H5P.externalDispatcher ??= {
    on(type, fn) {
      (dispatcherHandlers[type] ||= []).push(fn);
    },
    trigger(type) {
      for (const fn of dispatcherHandlers[type] || []) fn();
    }
  };
  H5P.jQuery ??= () => ({ ready: (fn) => readyHandlers.push(fn) });
  let queryThrows = false;
  const document = {
    querySelector: (selector) => {
      if (queryThrows) throw new Error('odd DOM');
      return selector === '.h5p-content' ? content : null;
    }
  };
  const context = {
    H5P,
    document,
    location: new URL(
      `${OWN}/h5p-editor-core/api/v1/content/7/render${search}`
    ),
    URL,
    URLSearchParams,
    AbortController,
    setTimeout(fn, ms) {
      timers.set(++timerId, { fn, due: now + ms });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener(type, fn, listenerOptions) {
      listeners.push({ type, fn, options: listenerOptions });
    },
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    }
  };
  // `H5P: null`: the core itself did not load.
  if (options.H5P === null) {
    delete context.H5P;
  }
  context.window = context;
  context.self = context;
  context.parent = framed ? parent : context;
  if (options.integration !== undefined) {
    context.H5PIntegration = options.integration;
  }
  // Separate the embedder's probes from the content's fetch requests.
  const probes = [];
  if (options.fetch || options.probe) {
    const probe = options.probe || (async () => ({ status: 204 }));
    context.fetch = function (url, init) {
      if (/\/session\/probe\?/.test(String(url))) {
        probes.push({ url: String(url), init });
        return probe(url, init);
      }
      return options.fetch
        ? options.fetch.apply(this, arguments)
        : Promise.reject(new TypeError('Failed to fetch'));
    };
  }
  const pageFetch = context.fetch;
  if (options.XMLHttpRequest) {
    context.XMLHttpRequest = options.XMLHttpRequest;
  }
  if (options.scriptSrc !== undefined) {
    document.currentScript = { src: options.scriptSrc };
  }
  vm.createContext(context);
  vm.runInContext(BRIDGE, context);

  function dispatch(type, extra = {}) {
    for (const listener of listeners) {
      if (listener.type === type) listener.fn({ type, ...extra });
    }
  }
  return {
    H5P,
    probes,
    pageFetch,
    listeners,
    notifications,
    frames,
    triggered,
    readyHandlers,
    queryThrows: () => {
      queryThrows = true;
    },
    messages: () => notifications.map((entry) => entry.message),
    resize: () => dispatch('resize'),
    failLoad: (target) => dispatch('error', { target }),
    receive(data, { origin = PARENT, source = parent } = {}) {
      dispatch('message', { data, origin, source });
    },
    context,
    // Fire timers in deadline order, including any scheduled by a callback.
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const [next] = [...timers].sort((a, b) => a[1].due - b[1].due);
        if (!next || next[1].due > until) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].due);
        next[1].fn();
      }
      now = until;
    }
  };
}

test('top-level previews leave lifecycle and resize handling to the core', () => {
  for (const search of ['', '?pickMode=1']) {
    const harness = bridge({ framed: false, search });
    harness.H5P.externalDispatcher.trigger('initialized');
    assert.deepEqual(harness.readyHandlers, []);
    assert.deepEqual(harness.listeners, []);
    assert.deepEqual(harness.notifications, []);
  }
});

test('an invalid or opaque parentOrigin keeps the bridge silent', () => {
  for (const origin of ['not a url', 'data:text/plain,opaque']) {
    const harness = bridge({
      search: `?parentOrigin=${encodeURIComponent(origin)}`
    });
    harness.H5P.externalDispatcher.trigger('initialized');
    for (const ready of harness.readyHandlers) ready();
    assert.deepEqual(harness.notifications, []);
  }
});

test('a refused readiness post never interrupts the core', () => {
  const harness = bridge({ refusePost: true });
  assert.doesNotThrow(() =>
    harness.H5P.externalDispatcher.trigger('initialized')
  );
  for (const ready of harness.readyHandlers) ready();
  assert.deepEqual(harness.notifications, []);
});

test('the parent hears player-ready once, on the first initialized', () => {
  const harness = bridge();
  harness.H5P.externalDispatcher.trigger('initialized');
  harness.H5P.externalDispatcher.trigger('initialized');
  for (const ready of harness.readyHandlers) ready();
  assert.deepEqual(harness.notifications, [
    {
      origin: PARENT,
      message: {
        source: 'h5p-player-host',
        type: 'player-ready',
        contentId: '7'
      }
    }
  ]);
});

test('a failure while reporting readiness never reaches the core', () => {
  const harness = bridge();
  // `contentId()` without an element asks querySelector.
  harness.queryThrows();
  assert.doesNotThrow(() =>
    harness.H5P.externalDispatcher.trigger('initialized')
  );
  for (const ready of harness.readyHandlers) ready();
  assert.deepEqual(harness.messages(), [
    { source: 'h5p-player-host', type: 'player-ready', contentId: null }
  ]);
});

test('the parent hears player-error when document ready passes uninitialized', () => {
  const harness = bridge();
  for (const ready of harness.readyHandlers) ready();
  assert.deepEqual(harness.messages(), [
    { source: 'h5p-player-host', type: 'player-error', contentId: '7' }
  ]);
});

test('without a parentOrigin the bridge posts to its own origin', () => {
  const harness = bridge({ search: '' });
  harness.H5P.externalDispatcher.trigger('initialized');
  assert.equal(harness.notifications[0].origin, 'https://host.example');
});

test('framed, a window resize reaches every instance once per frame', () => {
  const instances = [{ id: 1 }, { id: 2 }];
  const harness = bridge({ H5P: { instances } });
  harness.resize();
  harness.resize();
  assert.equal(harness.frames.length, 1, 'throttled to one animation frame');
  harness.frames[0]();
  assert.deepEqual(harness.triggered, [
    [instances[0], 'resize'],
    [instances[1], 'resize']
  ]);
  harness.resize();
  assert.equal(harness.frames.length, 2, 'the next resize schedules again');

  // An internal embed: the core relays resizes itself.
  const internal = bridge({ H5P: { externalEmbed: false, instances } });
  internal.resize();
  assert.equal(internal.frames.length, 0);

  const topLevel = bridge({ framed: false });
  assert.equal(
    topLevel.listeners.some((entry) => entry.type === 'resize'),
    false,
    'top level the core already listens'
  );
});

// ---- Session expiry (a session of the embedder's own) ----------------

const PROBE = `${OWN}/h5p-editor-core/session/probe?contentId=7&op=render`;
const EXPIRED = { source: 'h5p-player-host', type: 'session-expired' };

// The probe's answers in order, each a status or a held promise of one.
function probeAnswers(...answers) {
  return async () => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    return { status: await answer };
  };
}

function held() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, answer: (status) => resolve(status) };
}

const image = (src) => ({ nodeType: 1, tagName: 'IMG', src, currentSrc: '' });
const expiries = (harness) =>
  harness.messages().filter((message) => message.type === 'session-expired');

test('framed by a parent on another origin, the bridge asks for the session once at the start', async () => {
  const harness = bridge({ probe: probeAnswers(204) });
  await flush();
  assert.deepEqual(
    harness.probes.map((probe) => probe.url),
    [PROBE]
  );
  assert.equal(harness.probes[0].init.credentials, 'same-origin');
  assert.equal(harness.probes[0].init.cache, 'no-store');
  assert.equal(typeof harness.pageFetch, 'function');
  assert.notEqual(harness.context.fetch, harness.pageFetch, 'fetch is wrapped');
  assert.deepEqual(harness.notifications, [], '204: nothing to say');
  for (const status of [404, 403, 500, 0]) {
    const other = bridge({ probe: probeAnswers(status) });
    await flush();
    assert.deepEqual(other.notifications, [], `${status}: no signal`);
  }
  const offline = bridge({
    probe: () => Promise.reject(new TypeError('Failed to fetch'))
  });
  await flush();
  assert.deepEqual(offline.notifications, []);
});

test("the start-up probe's 401 reaches the parent even without the H5P core", async () => {
  const harness = bridge({ H5P: null, probe: probeAnswers(401) });
  await flush();
  assert.deepEqual(harness.messages(), [EXPIRED]);
  assert.equal(harness.notifications[0].origin, PARENT);
});

test('the probe goes under the prefix the bridge was loaded from', async () => {
  const harness = bridge({
    probe: probeAnswers(204),
    scriptSrc: `${OWN}/editor-core-prefix/web/player-bridge.js`
  });
  await flush();
  assert.deepEqual(
    harness.probes.map((probe) => probe.url),
    [`${OWN}/editor-core-prefix/session/probe?contentId=7&op=render`]
  );
});

test('without a framing parent nothing is probed or wrapped', async () => {
  for (const options of [
    { framed: false, search: '' },
    { framed: false, search: '?pickMode=1' },
    { search: '?parentOrigin=not%20a%20url' }
  ]) {
    const fetch = () => Promise.resolve({ status: 401 });
    const harness = bridge({ ...options, probe: probeAnswers(401), fetch });
    await flush();
    assert.equal(harness.probes.length, 0, options.search);
    assert.equal(
      harness.listeners.some((listener) => listener.type === 'error'),
      false
    );
    harness.context.fetch(`${OWN}/h5p-editor-core/h5p/content/7/a.png`);
    await flush();
    assert.deepEqual(harness.notifications, [], options.search);
  }
});

test("a parent on the page's own origin: nothing is probed, wrapped or reported", async () => {
  class XMLHttpRequest {
    send() {}
  }
  const send = XMLHttpRequest.prototype.send;
  // Without `parentOrigin` the parent is taken to share the page's origin.
  for (const search of ['', `?parentOrigin=${encodeURIComponent(OWN)}`]) {
    const fetch = () => Promise.resolve({ status: 401, url: '' });
    const harness = bridge({
      search,
      probe: probeAnswers(401),
      fetch,
      XMLHttpRequest
    });
    await flush();
    assert.equal(harness.probes.length, 0, search);
    assert.equal(
      harness.listeners.some((listener) => listener.type === 'error'),
      false,
      search
    );
    assert.equal(harness.context.XMLHttpRequest.prototype.send, send, search);
    assert.equal(typeof harness.pageFetch, 'function');
    assert.equal(harness.context.fetch, harness.pageFetch, search);
    harness.failLoad(image(`${OWN}/h5p-editor-core/h5p/content/7/a.png`));
    harness.context.fetch(`${OWN}/h5p-editor-core/h5p/content/7/a.json`);
    await flush();
    assert.equal(harness.probes.length, 0, search);
    assert.deepEqual(harness.notifications, [], search);
  }
});

test("an element's failed load under this host asks the probe; its 401 tells the parent once", async () => {
  const harness = bridge({ probe: probeAnswers(204, 204, 401) });
  await flush();
  const listener = harness.listeners.find((entry) => entry.type === 'error');
  assert.equal(listener.options, true, 'capturing: load errors do not bubble');

  // Not this host's, not an element, or not one that loads: no probe.
  harness.failLoad(image('https://cdn.example/h5p-editor-core/a.png'));
  harness.failLoad(image(`${OWN}/other/a.png`));
  harness.failLoad({ nodeType: 1, tagName: 'DIV', src: `${PROBE}x` });
  harness.failLoad(harness.context);
  await flush();
  assert.equal(harness.probes.length, 1);

  harness.failLoad(image(`${OWN}/h5p-editor-core/h5p/content/7/a.png`));
  await flush();
  assert.equal(harness.probes.length, 2);
  assert.deepEqual(harness.notifications, [], 'the session still holds');

  // A stylesheet is asked about by its `href`; this probe answers 401.
  harness.failLoad({
    nodeType: 1,
    tagName: 'link',
    href: `${OWN}/h5p-editor-core/h5p/libraries/x/a.css`
  });
  await flush();
  assert.equal(harness.probes.length, 3);
  assert.deepEqual(harness.messages(), [EXPIRED]);

  // The series is reported: no more probes until a renewal.
  harness.failLoad({
    nodeType: 1,
    tagName: 'VIDEO',
    src: '',
    currentSrc: `${OWN}/h5p-editor-core/h5p/content/7/v.mp4`
  });
  await flush();
  assert.equal(harness.probes.length, 3);
  assert.equal(expiries(harness).length, 1);
});

test('one probe at a time; failures meanwhile ask once more after it', async () => {
  const first = held();
  const second = held();
  const harness = bridge({
    probe: probeAnswers(first.promise, second.promise)
  });
  await flush();
  for (let i = 0; i < 3; i++) {
    harness.failLoad(image(`${OWN}/h5p-editor-core/h5p/content/7/${i}.png`));
  }
  await flush();
  assert.equal(harness.probes.length, 1, 'the start-up probe still runs');
  first.answer(204);
  await flush();
  assert.equal(harness.probes.length, 2, 'one more for all three');
  second.answer(401);
  await flush();
  assert.deepEqual(harness.messages(), [EXPIRED]);
  assert.equal(harness.probes.length, 2);
});

test('a renewal starts a new series; a 401 to a request sent before it is not reported', async () => {
  const late = held();
  const harness = bridge({ probe: probeAnswers(401, late.promise, 401) });
  await flush();
  assert.equal(expiries(harness).length, 1);

  // Only the parent window at the parent origin renews.
  const renewed = { source: 'editor-embedder', type: 'session-renewed' };
  harness.receive(renewed, { origin: 'https://evil.example' });
  harness.receive(renewed, { source: {} });
  harness.failLoad(image(`${OWN}/h5p-editor-core/h5p/content/7/a.png`));
  await flush();
  assert.equal(harness.probes.length, 1, 'still the reported series');

  harness.receive(renewed);
  harness.failLoad(image(`${OWN}/h5p-editor-core/h5p/content/7/a.png`));
  await flush();
  assert.equal(harness.probes.length, 2);
  // The probe was sent before the next renewal: its 401 is the old one's.
  harness.receive(renewed);
  late.answer(401);
  await flush();
  assert.equal(expiries(harness).length, 1);
  harness.failLoad(image(`${OWN}/h5p-editor-core/h5p/content/7/a.png`));
  await flush();
  assert.equal(expiries(harness).length, 2);
});

test("a 401 to the core's fetch from this host tells the parent; the call stays the core's", async () => {
  const answers = [];
  const fetch = (url) => {
    const { promise, resolve } = Promise.withResolvers();
    answers.push(resolve);
    return promise;
  };
  const harness = bridge({ fetch });
  await flush();
  const wrapped = harness.context.fetch;
  const call = (url, response) => {
    const result = wrapped(url);
    answers.at(-1)(response);
    return result;
  };
  // Not this host's, not a 401, an opaque answer: no signal.
  call('https://cdn.example/a.js', { status: 401, url: '' });
  call(`${OWN}/h5p-editor-core/h5p/content/7/a.json`, { status: 403, url: '' });
  call(`${OWN}/h5p-editor-core/h5p/content/7/a.json`, { status: 0, url: '' });
  await flush();
  assert.deepEqual(harness.notifications, []);

  // The core gets the very promise, rejections included.
  const before = wrapped(`${OWN}/h5p-editor-core/h5p/contentUserData/7`);
  const sentBefore = answers.at(-1);
  harness.receive({ source: 'editor-embedder', type: 'session-renewed' });
  sentBefore({ status: 401, url: '' });
  assert.equal((await before).status, 401);
  assert.deepEqual(harness.notifications, [], 'sent before the renewal');

  const response = { status: 401, url: `${OWN}/h5p-editor-core/h5p/x` };
  const after = call('relative/after', response);
  assert.equal(await after, response);
  await flush();
  assert.deepEqual(harness.messages(), [EXPIRED]);
});

test("a 401 to the core's XMLHttpRequest from this host tells the parent", async () => {
  class XMLHttpRequest {
    constructor() {
      this.handlers = [];
    }
    addEventListener(type, fn) {
      if (type === 'loadend') this.handlers.push(fn);
    }
    removeEventListener(type, fn) {
      this.handlers = this.handlers.filter((handler) => handler !== fn);
    }
    send() {
      if (this.sent) throw new Error('InvalidStateError');
      this.sent = true;
    }
    end(status, url) {
      this.status = status;
      this.responseURL = url;
      this.handlers.slice().forEach((fn) => fn());
    }
  }
  const harness = bridge({ XMLHttpRequest, probe: probeAnswers(204) });
  await flush();
  const xhr = () => {
    const request = new harness.context.XMLHttpRequest();
    request.send();
    return request;
  };
  xhr().end(401, 'https://cdn.example/x');
  xhr().end(500, `${OWN}/h5p-editor-core/h5p/contentUserData/7`);
  // A refused second `send` leaves no listener of its own behind.
  const twice = xhr();
  assert.throws(() => twice.send(), /InvalidStateError/);
  assert.equal(twice.handlers.length, 1);
  twice.end(200, `${OWN}/h5p-editor-core/h5p/contentUserData/7`);
  assert.equal(twice.handlers.length, 0);
  assert.deepEqual(harness.notifications, []);
  xhr().end(401, `${OWN}/h5p-editor-core/h5p/contentUserData/7`);
  xhr().end(401, `${OWN}/h5p-editor-core/h5p/contentUserData/7`);
  assert.deepEqual(harness.messages(), [EXPIRED]);
});

test('a probe that never answers is abandoned, and the next failure is asked about', async () => {
  const stuck = held();
  const harness = bridge({ probe: probeAnswers(stuck.promise, 401) });
  await flush();
  harness.failLoad(image(`${OWN}/h5p-editor-core/h5p/content/7/a.png`));
  await flush();
  assert.equal(harness.probes.length, 1, 'waits behind the running probe');
  harness.advance(14999);
  await flush();
  assert.equal(harness.probes.length, 1);
  assert.deepEqual(harness.notifications, []);
  harness.advance(1);
  await flush();
  assert.equal(harness.probes[0].init.signal.aborted, true);
  assert.equal(harness.probes.length, 2, 'the failure meanwhile is asked');
  assert.deepEqual(harness.messages(), [EXPIRED]);
  // A late answer of the abandoned probe changes nothing.
  stuck.answer(401);
  await flush();
  assert.equal(expiries(harness).length, 1);
});
