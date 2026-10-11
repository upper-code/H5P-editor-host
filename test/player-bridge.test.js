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
const ID = 'data-sub-content-id';
const LIBRARY = 'data-sub-content-library';

// Just enough of an Element for the bridge: attributes, classes, a parent
// chain and `closest` for the two selectors it asks about.
class FakeElement {
  constructor(attributes = {}, classes = []) {
    this.nodeType = 1;
    this.parentElement = null;
    this.attributes = new Map(Object.entries(attributes));
    const set = new Set(classes);
    this.classList = {
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
      contains: (name) => set.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !set.has(name) : force;
        if (on) set.add(name);
        else set.delete(name);
        return on;
      }
    };
  }
  append(child) {
    child.parentElement = this;
    return child;
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  matches(selector) {
    if (selector === `[${ID}]`) return this.hasAttribute(ID);
    if (selector.startsWith('.'))
      return this.classList.contains(selector.slice(1));
    throw new Error(`unsupported selector ${selector}`);
  }
  closest(selector) {
    for (let element = this; element; element = element.parentElement) {
      if (element.matches(selector)) return element;
    }
    return null;
  }
}

// A jQuery-wrapped element, as libraries pass `$attachTo`.
const $ = (element) => ({ jquery: '3.5.1', 0: element, toggleClass() {} });

function event(type, target, extra = {}) {
  return {
    type,
    target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
    ...extra
  };
}

// The core's `H5P.addQueryParameter`, `setSource`, `getCrossOrigin` and
// `getPath`, cut out of the vendored h5p.js: the bridge wraps the real ones.
function corePaths() {
  const core = fs.readFileSync(
    path.join(__dirname, '../assets/h5p/core/js/h5p.js'),
    'utf8'
  );
  const start = core.indexOf(
    '(function () {\n  /**\n   * Helper for adding a query parameter'
  );
  const end = core.indexOf('\n})();\n', start) + '\n})();\n'.length;
  const source = core.slice(start, end);
  assert.ok(start > 0 && end > start, 'path helpers found in h5p.js');
  for (const name of ['addQueryParameter', 'setSource', 'getPath']) {
    assert.ok(source.includes(`H5P.${name} = function`), name);
  }
  return source;
}

// Just enough of a Blob for the bridge to hand to `URL.createObjectURL`.
class FakeBlob {
  constructor(parts, options = {}) {
    this.parts = parts;
    this.type = options.type ?? '';
  }
}

/**
 * Loads the bridge into a fresh context. `framed` decides whether
 * `window.parent` is another window; `search` is the page's query string;
 * `H5P` is the namespace as the libraries left it; `integration` becomes
 * `H5PIntegration`; `core` loads the core's path helpers first; `fetch`
 * answers the bridge's downloads.
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
  const styles = [];
  const html = new FakeElement();
  const content = new FakeElement({ 'data-content-id': '7' }, ['h5p-content']);
  // A real structured clone: buffers arrive as bytes, and a transferred one
  // is detached on the sending side.
  const parent = {
    postMessage(message, origin, transfer) {
      notifications.push({
        message: structuredClone(message, { transfer }),
        origin,
        ...(transfer ? { transfer } : {})
      });
    }
  };
  const blobs = new Map();
  const revoked = [];
  class HarnessURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:https://host.example/${blobs.size + 1}`;
      blobs.set(url, blob);
      return url;
    }
    static revokeObjectURL(url) {
      revoked.push(url);
    }
  }
  const timers = new Map();
  let timerId = 0;
  const H5P = options.H5P || {};
  H5P.newRunnable ??= () => ({});
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
    documentElement: html,
    head: { appendChild: (style) => styles.push(style) },
    createElement: () => ({}),
    querySelector: (selector) => {
      if (queryThrows) throw new Error('odd DOM');
      return selector === '.h5p-content' ? content : null;
    }
  };
  const context = {
    H5P,
    document,
    location: new URL(
      `https://host.example/h5p-editor-core/api/v1/content/7/render${search}`
    ),
    URL: HarnessURL,
    URLSearchParams,
    Blob: FakeBlob,
    AbortController,
    setTimeout(fn, ms) {
      timers.set(++timerId, { fn, ms });
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
  context.window = context;
  context.self = context;
  context.parent = framed ? parent : context;
  if (options.integration !== undefined) {
    context.H5PIntegration = options.integration;
  }
  if (options.fetch) {
    context.fetch = options.fetch;
  }
  vm.createContext(context);
  if (options.core) {
    vm.runInContext(corePaths(), context);
  }
  const corePath = H5P.getPath;
  vm.runInContext(BRIDGE, context);

  function dispatch(e) {
    for (const listener of listeners) {
      if (listener.type === e.type && !e.stopped) listener.fn(e);
    }
    return e;
  }
  return {
    H5P,
    html,
    content,
    parent,
    listeners,
    notifications,
    frames,
    triggered,
    styles,
    readyHandlers,
    queryThrows: () => {
      queryThrows = true;
    },
    messages: () => notifications.map((entry) => entry.message),
    click: (target) => dispatch(event('click', target)),
    press: (type, target) => dispatch(event(type, target)),
    resize: () => dispatch(event('resize', context)),
    receive(data, { origin = PARENT, source = parent } = {}) {
      dispatch({ type: 'message', data, origin, source });
    },
    context,
    corePath,
    blobs,
    revoked,
    timers,
    pagehide: (persisted) =>
      dispatch(event('pagehide', context, { persisted })),
    // Fires every pending timer once, as if its time had come.
    runTimers() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.fn();
      }
    },
    // Code evaluated in the page's realm, where `H5P` and `H5PIntegration`
    // are globals.
    evaluate: (code) => vm.runInContext(code, context)
  };
}

// chapter > row > item A > text, and item B beside A in the same row.
function book(content) {
  const chapter = content.append(
    new FakeElement({ [ID]: 'chap-1', [LIBRARY]: 'H5P.Column' })
  );
  const row = chapter.append(
    new FakeElement({ [ID]: 'row-1', [LIBRARY]: 'H5P.Row' })
  );
  const itemA = row.append(
    new FakeElement({ [ID]: 'Item-A', [LIBRARY]: 'H5P.AdvancedText' })
  );
  const text = itemA.append(new FakeElement());
  const itemB = row.append(
    new FakeElement({ [ID]: 'item-b', [LIBRARY]: 'H5P.Image' })
  );
  const shell = content.append(new FakeElement());
  return { chapter, row, itemA, text, itemB, shell };
}

// The core's own `H5P.newRunnable`, cut out of the vendored h5p.js and run in
// this realm (it checks `params instanceof Object`) against `H5P`.
function coreNewRunnable(H5P, namespace) {
  const core = fs.readFileSync(
    path.join(__dirname, '../assets/h5p/core/js/h5p.js'),
    'utf8'
  );
  const start = core.indexOf('H5P.newRunnable = function');
  const end = core.indexOf('\n};\n', start) + 4;
  assert.ok(start > 0 && end > start, 'newRunnable found in h5p.js');
  const jQuery = () => ({ ready() {} });
  jQuery.extend = (target, ...sources) => Object.assign(target, ...sources);
  jQuery.inArray = (value, array) => array.indexOf(value);
  H5P.jQuery = jQuery;
  H5P.ContentType = () => {
    function ContentType() {}
    return ContentType;
  };
  H5P.error = (error) => {
    throw new Error(String(error));
  };
  new Function('H5P', 'window', core.slice(start, end))(H5P, {
    H5P: namespace
  });
  return H5P.newRunnable;
}

test('a sub-content is tagged on its container, given as jQuery or Element', () => {
  const { H5P } = bridge();
  const jqueryHost = new FakeElement();
  H5P.newRunnable(
    { library: 'H5P.Image 1.1', params: {}, subContentId: 'img-1' },
    7,
    $(jqueryHost)
  );
  assert.equal(jqueryHost.getAttribute(ID), 'img-1');
  assert.equal(jqueryHost.getAttribute(LIBRARY), 'H5P.Image');

  const elementHost = new FakeElement();
  H5P.newRunnable(
    { library: 'H5P.Audio 1.5', params: {}, subContentId: 'aud-1' },
    7,
    elementHost
  );
  assert.equal(elementHost.getAttribute(ID), 'aud-1');

  // The root content has no subContentId and stays untagged.
  const root = new FakeElement();
  H5P.newRunnable({ library: 'H5P.Column 1.18', params: {} }, 7, $(root));
  assert.equal(root.hasAttribute(ID), false);
});

test('a deferred attach tags its container, and an existing tag is kept', () => {
  const attached = [];
  const instance = {
    attach($container) {
      attached.push($container);
    }
  };
  const { H5P } = bridge({ H5P: { newRunnable: () => instance } });
  const result = H5P.newRunnable(
    { library: 'H5P.Column 1.18', params: {}, subContentId: 'chap-1' },
    7
  );
  assert.equal(result, instance);

  const first = new FakeElement();
  instance.attach($(first));
  assert.equal(first.getAttribute(ID), 'chap-1');
  assert.equal(attached[0][0], first, 'the original attach still runs');

  // A re-attach into a container someone else tagged earlier leaves it alone.
  const taken = new FakeElement({ [ID]: 'outer' });
  instance.attach(taken);
  assert.equal(taken.getAttribute(ID), 'outer');
  assert.equal(attached[1], taken);

  // Wrapped once: a second newRunnable returning the same instance does not
  // stack another wrapper.
  const wrapped = instance.attach;
  H5P.newRunnable(
    { library: 'H5P.Column 1.18', params: {}, subContentId: 'chap-1' },
    7
  );
  assert.equal(instance.attach, wrapped);
  const keys = [];
  for (const key in instance) keys.push(key);
  assert.deepEqual(keys, ['attach'], 'the flag stays out of enumeration');
});

test('a library attaching a child into its own container leaves the outer id there', () => {
  const H5P = {};
  const namespace = {};
  function Outer() {}
  Outer.prototype.attach = function ($container) {
    H5P.newRunnable(
      { library: 'H5P.Inner 1.0', params: {}, subContentId: 'inner-id' },
      7,
      $container
    );
  };
  function Inner() {}
  Inner.prototype.attach = function () {};
  namespace.Outer = Outer;
  namespace.Inner = Inner;
  coreNewRunnable(H5P, namespace);
  bridge({ H5P });
  const outer = {
    library: 'H5P.Outer 1.0',
    params: {},
    subContentId: 'outer-id'
  };

  // Attached by newRunnable itself: the core calls `attach` inside it.
  const direct = new FakeElement();
  H5P.newRunnable(outer, 7, $(direct));
  assert.equal(direct.getAttribute(ID), 'outer-id');
  assert.equal(direct.getAttribute(LIBRARY), 'H5P.Outer');

  // Created first, attached later (VMB.Column, book chapters).
  const deferred = new FakeElement();
  const instance = H5P.newRunnable(outer, 7, undefined, true);
  assert.equal(deferred.hasAttribute(ID), false);
  instance.attach($(deferred));
  assert.equal(deferred.getAttribute(ID), 'outer-id');
});

test('the newRunnable in place at load is wrapped transparently', () => {
  const calls = [];
  const returned = { attach() {} };
  // A library replaced the core's newRunnable before the bridge loaded.
  const replaced = function (...args) {
    calls.push({ self: this, args });
    if (args[0].fail) throw new Error('library failed');
    return returned;
  };
  const { H5P } = bridge({ H5P: { newRunnable: replaced } });
  assert.notEqual(H5P.newRunnable, replaced);

  const self = { name: 'caller' };
  const library = { library: 'H5P.Image 1.1', params: {}, subContentId: 'x' };
  const container = $(new FakeElement());
  const extras = { parent: 1 };
  assert.equal(
    H5P.newRunnable.call(self, library, 7, container, true, extras),
    returned
  );
  assert.equal(calls[0].self, self);
  assert.deepEqual(calls[0].args, [library, 7, container, true, extras]);

  assert.throws(
    () => H5P.newRunnable({ ...library, fail: true }, 7),
    /library failed/
  );

  // A failure inside the bridge's own work never reaches the caller.
  const hostile = {
    jquery: '3',
    get 0() {
      throw new Error('bridge-side');
    }
  };
  assert.equal(H5P.newRunnable(library, 7, hostile), returned);
  assert.equal(calls.at(-1).args[2], hostile);
  const frozen = Object.freeze({ attach() {} });
  const { H5P: other } = bridge({ H5P: { newRunnable: () => frozen } });
  assert.equal(other.newRunnable(library, 7), frozen);
});

test('top level without ?pickMode=1 the bridge does nothing at all', () => {
  const original = () => ({});
  const harness = bridge({ framed: false, H5P: { newRunnable: original } });
  assert.equal(harness.H5P.newRunnable, original);
  assert.deepEqual(harness.listeners, []);
  assert.deepEqual(harness.styles, []);
  assert.deepEqual(harness.readyHandlers, []);
});

test('top level with ?pickMode=1 picks locally and posts nothing', () => {
  const harness = bridge({ framed: false, search: '?pickMode=1' });
  assert.equal(harness.html.classList.contains('h5p-pick-mode'), true);
  const { text, itemA } = book(harness.content);
  const click = harness.click(text);
  assert.equal(click.defaultPrevented, true);
  // No `selectable` given: the innermost tagged element is the pick.
  assert.equal(itemA.classList.contains('h5p-pick-selected'), true);
  assert.deepEqual(harness.notifications, []);
});

test('a click outside pick mode passes through and sends nothing', () => {
  const harness = bridge();
  const { text } = book(harness.content);
  const click = harness.click(text);
  assert.equal(click.defaultPrevented, false);
  assert.equal(click.stopped, false);
  assert.deepEqual(harness.notifications, []);
});

test('a pick frames the nearest selectable ancestor and reports it', () => {
  const harness = bridge();
  const { text, itemA, itemB } = book(harness.content);
  harness.receive({
    source: 'editor-embedder',
    type: 'pick-mode',
    enabled: true,
    selectable: ['item-a', 'ITEM-B']
  });
  assert.equal(harness.html.classList.contains('h5p-pick-mode'), true);

  const click = harness.click(text);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.stopped, true);
  assert.equal(itemA.classList.contains('h5p-pick-selected'), true);
  assert.deepEqual(harness.notifications, [
    {
      origin: PARENT,
      message: {
        source: 'h5p-player-host',
        type: 'picked',
        contentId: '7',
        subContentId: 'Item-A',
        library: 'H5P.AdvancedText',
        path: ['Item-A', 'row-1', 'chap-1']
      }
    }
  ]);

  harness.click(itemB);
  assert.equal(itemA.classList.contains('h5p-pick-selected'), false);
  assert.equal(itemB.classList.contains('h5p-pick-selected'), true);
  assert.equal(harness.messages()[1].subContentId, 'item-b');

  // A text node as the target resolves through its parent element.
  harness.click({ nodeType: 3, parentElement: text });
  assert.equal(itemA.classList.contains('h5p-pick-selected'), true);
  assert.equal(harness.messages()[2].subContentId, 'Item-A');
});

test('a click inside tagged content with nothing selectable is swallowed', () => {
  const harness = bridge();
  const { row, itemA, text } = book(harness.content);
  harness.receive({
    source: 'editor-embedder',
    type: 'pick-mode',
    enabled: true,
    selectable: ['item-a']
  });
  // The row's own padding: tagged, but neither it nor the chapter is
  // selectable.
  const click = harness.click(row);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.stopped, true);
  assert.deepEqual(harness.notifications, []);
  assert.equal(row.classList.contains('h5p-pick-selected'), false);

  // An empty list means there is nothing to pick.
  harness.receive({
    source: 'editor-embedder',
    type: 'pick-mode',
    enabled: true,
    selectable: []
  });
  harness.click(text);
  assert.deepEqual(harness.notifications, []);
  assert.equal(itemA.classList.contains('h5p-pick-selected'), false);

  // No `selectable` field: any tagged element, innermost first.
  harness.receive({
    source: 'editor-embedder',
    type: 'pick-mode',
    enabled: true
  });
  harness.click(row);
  assert.equal(harness.messages()[0].subContentId, 'row-1');
});

test('a click outside tagged content is left to the book', () => {
  const harness = bridge();
  const { shell } = book(harness.content);
  harness.receive({
    source: 'editor-embedder',
    type: 'pick-mode',
    enabled: true,
    selectable: ['item-a']
  });
  const click = harness.click(shell);
  assert.equal(click.defaultPrevented, false);
  assert.equal(click.stopped, false);
  assert.deepEqual(harness.notifications, []);
});

test('presses and touches are stopped passively, never default-prevented', () => {
  const harness = bridge();
  const presses = [
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'touchstart',
    'touchend'
  ];
  for (const type of presses) {
    const listener = harness.listeners.find((entry) => entry.type === type);
    assert.deepEqual(
      { ...listener.options },
      { capture: true, passive: true },
      type
    );
  }
  const click = harness.listeners.find((entry) => entry.type === 'click');
  assert.equal(click.options.capture, true);
  assert.equal(
    harness.listeners.some((entry) => entry.type === 'touchmove'),
    false,
    'scrolling stays native'
  );

  const { text, shell } = book(harness.content);
  assert.equal(
    harness.press('touchstart', text).stopped,
    false,
    'pick mode off'
  );
  harness.receive({
    source: 'editor-embedder',
    type: 'pick-mode',
    enabled: true
  });
  for (const type of presses) {
    const inside = harness.press(type, text);
    assert.equal(inside.stopped, true, type);
    assert.equal(inside.defaultPrevented, false, type);
    assert.equal(harness.press(type, shell).stopped, false, type);
  }
});

test('only the parent window at the parent origin steers pick mode', () => {
  const harness = bridge();
  const { text, row, itemA } = book(harness.content);
  const enable = {
    source: 'editor-embedder',
    type: 'pick-mode',
    enabled: true,
    selectable: ['item-a']
  };
  harness.receive(enable, { origin: 'https://evil.test' });
  harness.receive(enable, { source: {} });
  harness.receive({ ...enable, source: 'someone-else' });
  assert.equal(harness.html.classList.contains('h5p-pick-mode'), false);
  harness.click(text);
  assert.deepEqual(harness.notifications, []);

  harness.receive(enable);
  harness.click(text);
  assert.equal(itemA.classList.contains('h5p-pick-selected'), true);

  harness.receive({ source: 'editor-embedder', type: 'pick-clear' });
  assert.equal(itemA.classList.contains('h5p-pick-selected'), false);
  assert.equal(harness.html.classList.contains('h5p-pick-mode'), true);

  // A repeated pick-mode replaces the list rather than adding to it.
  harness.receive({ ...enable, selectable: ['row-1'] });
  harness.click(text);
  assert.equal(harness.messages().at(-1).subContentId, 'row-1');

  harness.receive({
    source: 'editor-embedder',
    type: 'pick-mode',
    enabled: false
  });
  assert.equal(harness.html.classList.contains('h5p-pick-mode'), false);
  assert.equal(row.classList.contains('h5p-pick-selected'), false);
  const click = harness.click(text);
  assert.equal(click.defaultPrevented, false);
});

test('an unparseable parentOrigin keeps the bridge silent', () => {
  const harness = bridge({ search: '?parentOrigin=not%20a%20url' });
  const { text } = book(harness.content);
  harness.receive(
    { source: 'editor-embedder', type: 'pick-mode', enabled: true },
    { origin: 'https://host.example' }
  );
  harness.H5P.externalDispatcher.trigger('initialized');
  harness.click(text);
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

  const topLevel = bridge({ framed: false, search: '?pickMode=1' });
  assert.equal(
    topLevel.listeners.some((entry) => entry.type === 'resize'),
    false,
    'top level the core already listens'
  );
});

// ---- Book remote control -------------------------------------------------

const OWN = 'https://host.example';
const BOOK = 'VMB.InteractiveBook 1.6';
const EXAM = {
  page: 15,
  alg: 'aes-256-cbc+hmac-sha256',
  iv: 'aXY=',
  data: 'Y2lwaGVy',
  mac: 'bWFj',
  media: [
    { path: 'images/a.png', iv: 'aXYx', mac: 'bWFjMQ==' },
    { path: 'images/q/b.svg', iv: 'aXYy', mac: 'bWFjMg==' }
  ]
};
const CONTENT_URL = '/h5p-editor-core/h5p/content/7';

function bookParams(fields = {}) {
  return {
    chapters: [{ library: 'H5P.Column 1.18', params: {}, subContentId: 'c1' }],
    behaviour: { enableRemoteControl: true, baseColor: '#1768c4' },
    ...fields
  };
}

function integrationOf(library, params, extra = {}) {
  return {
    url: '/h5p-editor-core/h5p',
    contents: {
      'cid-7': {
        library,
        jsonContent:
          typeof params === 'string' ? params : JSON.stringify(params),
        contentUrl: CONTENT_URL
      }
    },
    ...extra
  };
}

function framedBook(params, options = {}) {
  const integration = integrationOf(
    options.library || BOOK,
    params,
    options.extra
  );
  const harness = bridge({ integration, ...options });
  harness.integration = integration;
  harness.stored = () => JSON.parse(integration.contents['cid-7'].jsonContent);
  return harness;
}

// The parameters with `behaviour.remoteOrigins` taken out (and a `behaviour`
// the bridge created dropped again), for "nothing else changed".
function withoutOrigins(params, createdBehaviour = false) {
  const copy = structuredClone(params);
  if (createdBehaviour) {
    delete copy.behaviour;
  } else if (copy.behaviour) {
    delete copy.behaviour.remoteOrigins;
  }
  return copy;
}

test('a framed book without remoteOrigins opens to its own origin and the parent', () => {
  const params = bookParams({ vmbExam: EXAM });
  const harness = framedBook(params);
  const stored = harness.stored();
  assert.deepEqual(stored.behaviour.remoteOrigins, [OWN, PARENT]);
  assert.deepEqual(withoutOrigins(stored), params);
  assert.deepEqual(stored.vmbExam, EXAM);
});

test('an authored list keeps its entries as written and gains the parent', () => {
  const authored = [
    'https://a.example',
    { origin: 'https://b.example/lesson' },
    ' https://c.example '
  ];
  const params = bookParams();
  params.behaviour.remoteOrigins = authored;
  const stored = framedBook(params).stored();
  assert.deepEqual(stored.behaviour.remoteOrigins, [...authored, PARENT]);
  assert.deepEqual(withoutOrigins(stored), withoutOrigins(params));

  // A single value is the book's one-entry list.
  const single = bookParams();
  single.behaviour.remoteOrigins = 'https://a.example';
  assert.deepEqual(framedBook(single).stored().behaviour.remoteOrigins, [
    'https://a.example',
    PARENT
  ]);
});

test('an origin already listed in another spelling is not added again', () => {
  for (const spelling of [
    ' https://parent.example/path ',
    'https://parent.example:443',
    { origin: 'HTTPS://PARENT.EXAMPLE' }
  ]) {
    const params = bookParams();
    params.behaviour.remoteOrigins = ['https://a.example', spelling];
    const json = JSON.stringify(params);
    const harness = framedBook(json);
    assert.equal(
      harness.integration.contents['cid-7'].jsonContent,
      json,
      JSON.stringify(spelling)
    );
  }

  // The parent on the page's own origin is written once.
  const harness = framedBook(bookParams(), {
    search: `?parentOrigin=${encodeURIComponent(OWN)}`
  });
  assert.deepEqual(harness.stored().behaviour.remoteOrigins, [OWN]);
});

test('an effectively empty list gets the own origin before the parent', () => {
  const authored = ['*', 'not a URL', 'ftp://x', 'null', '', { origin: 5 }];
  const params = bookParams();
  params.behaviour.remoteOrigins = authored;
  const stored = framedBook(params).stored();
  assert.deepEqual(stored.behaviour.remoteOrigins, [...authored, OWN, PARENT]);

  for (const empty of [[], null]) {
    const other = bookParams();
    other.behaviour.remoteOrigins = empty;
    assert.deepEqual(framedBook(other).stored().behaviour.remoteOrigins, [
      OWN,
      PARENT
    ]);
  }
});

test('a missing behaviour is created, a malformed one is left alone', () => {
  for (const behaviour of [undefined, null]) {
    const params = { chapters: [], behaviour };
    if (behaviour === undefined) delete params.behaviour;
    const stored = framedBook(params).stored();
    assert.deepEqual(stored.behaviour, { remoteOrigins: [OWN, PARENT] });
    assert.deepEqual(withoutOrigins(stored, true), { chapters: [] });
  }
  for (const behaviour of [['x'], 'text', 3]) {
    const json = JSON.stringify({ chapters: [], behaviour });
    const harness = framedBook(json);
    assert.equal(harness.integration.contents['cid-7'].jsonContent, json);
  }
});

test('other libraries keep their parameters byte for byte', () => {
  for (const library of [
    'H5P.InteractiveBook 1.11',
    'H5P.ArithmeticQuiz 1.1'
  ]) {
    const json = JSON.stringify(bookParams({ vmbExam: EXAM }));
    const harness = framedBook(json, { library, core: true });
    assert.equal(harness.integration.contents['cid-7'].jsonContent, json);
    // Not a book: no exam channel either.
    assert.equal(harness.H5P.getPath, harness.corePath);
  }
});

test('without a parent or usable parameters the book is left alone and the page still works', () => {
  const json = JSON.stringify(bookParams());
  const cases = [
    { framed: false, search: '?pickMode=1' },
    { search: '?parentOrigin=not%20a%20url' }
  ];
  for (const options of cases) {
    const harness = framedBook(json, options);
    assert.equal(harness.integration.contents['cid-7'].jsonContent, json);
  }

  const broken = framedBook('{"chapters": [');
  assert.equal(
    broken.integration.contents['cid-7'].jsonContent,
    '{"chapters": ['
  );

  for (const integration of [undefined, { contents: {} }, { contents: null }]) {
    const harness = bridge({ integration });
    // Pick mode is unaffected.
    const { text, itemA } = book(harness.content);
    harness.receive({
      source: 'editor-embedder',
      type: 'pick-mode',
      enabled: true
    });
    harness.click(text);
    assert.equal(itemA.classList.contains('h5p-pick-selected'), true);
    assert.equal(harness.messages()[0].subContentId, 'Item-A');
  }
});

// ---- Exam bytes ----------------------------------------------------------

const bytes = (...values) => Uint8Array.from(values).buffer;
const view = (buffer) => [...new Uint8Array(buffer)];
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ORIGINAL = (file, id = 7) =>
  `${OWN}/h5p-editor-core/h5p/content/${id}/${file}`;

function examBook(options = {}) {
  return framedBook(bookParams({ vmbExam: options.exam || EXAM }), {
    core: true,
    ...options
  });
}

function plainFiles() {
  return [
    { path: 'images/a.png', data: bytes(1, 2, 3), type: 'image/png' },
    { path: 'images/q/b.svg', data: bytes(4, 5) }
  ];
}

function sendMedia(harness, files, requestId = 'm1') {
  harness.receive({
    source: 'editor-embedder',
    type: 'exam-media',
    requestId,
    files
  });
  return harness.messages().at(-1);
}

test('exam-media maps every exam path of this content to a blob URL', () => {
  const harness = examBook();
  assert.notEqual(harness.H5P.getPath, harness.corePath);
  const files = plainFiles();
  assert.deepEqual(sendMedia(harness, files), {
    source: 'h5p-player-host',
    type: 'exam-media-ready',
    contentId: '7',
    requestId: 'm1',
    count: 2
  });
  const { H5P, blobs } = harness;
  const url = H5P.getPath('images/a.png', '7');
  assert.match(url, /^blob:/);
  // Coming back to the exam page asks again and gets the same URL.
  assert.equal(H5P.getPath('images/a.png', 7), url);
  assert.equal(blobs.get(url).parts[0], files[0].data);
  assert.equal(blobs.get(url).type, 'image/png');
  // No declared type: guessed from the extension.
  assert.equal(
    blobs.get(H5P.getPath('images/q/b.svg', '7')).type,
    'image/svg+xml'
  );

  assert.equal(
    H5P.getPath('images/open.png', '7'),
    ORIGINAL('images/open.png')
  );
  assert.equal(
    H5P.getPath('images/a.png', '8'),
    `${OWN}/h5p-editor-core/h5p/content/8/images/a.png`
  );
  assert.equal(
    H5P.getPath('https://cdn.test/x.png', '7'),
    'https://cdn.test/x.png'
  );
  // A request without an id is answered with `requestId: null`.
  harness.receive({
    source: 'editor-embedder',
    type: 'exam-media',
    files: plainFiles()
  });
  assert.equal(harness.messages().at(-1).type, 'exam-media-ready');
  assert.equal(harness.messages().at(-1).requestId, null);
});

test('a declared type that is not a media type falls back to the extension', () => {
  const harness = examBook({
    exam: {
      ...EXAM,
      media: [
        { path: 'media/clip.webm' },
        { path: 'media/track.vtt' },
        { path: 'media/blob' },
        { path: 'media/x.PNG' }
      ]
    }
  });
  sendMedia(harness, [
    { path: 'media/clip.webm', data: bytes(1), type: 'not a type' },
    { path: 'media/track.vtt', data: bytes(2), type: 7 },
    { path: 'media/blob', data: bytes(3) },
    { path: 'media/x.PNG', data: bytes(4), type: 'image/png; q=1' }
  ]);
  const type = (file) => harness.blobs.get(harness.H5P.getPath(file, 7)).type;
  assert.equal(type('media/clip.webm'), 'video/webm');
  assert.equal(type('media/track.vtt'), 'text/vtt');
  assert.equal(type('media/blob'), 'application/octet-stream');
  assert.equal(type('media/x.PNG'), 'image/png');
});

test('setSource reaches the blob URL with crossorigin and a cache buster', () => {
  const harness = examBook({
    extra: { crossorigin: 'anonymous', crossoriginCacheBuster: 'cb=1' }
  });
  sendMedia(harness, plainFiles());
  const url = harness.H5P.getPath('images/a.png', 7);
  for (const kind of ['img', 'video', 'audio']) {
    const element = { kind, crossOrigin: null, src: '', removeAttribute() {} };
    harness.H5P.setSource(element, { path: 'images/a.png' }, 7);
    assert.equal(element.src, url, kind);
    assert.equal(element.crossOrigin, 'anonymous', kind);
  }
});

test('exactly the cache buster is cut before the lookup', () => {
  const harness = examBook({ extra: { crossoriginCacheBuster: 'cb=1' } });
  sendMedia(harness, plainFiles());
  const { H5P } = harness;
  const url = H5P.getPath('images/a.png', 7);
  assert.equal(H5P.getPath('images/a.png?cb=1', 7), url);
  assert.equal(H5P.getPath('images/a.png&cb=1', 7), url);
  assert.equal(
    H5P.getPath('images/a.png?cb=2', 7),
    ORIGINAL('images/a.png?cb=2')
  );
  assert.equal(
    H5P.getPath('images/a.png?x=1', 7),
    ORIGINAL('images/a.png?x=1')
  );
  assert.equal(
    H5P.getPath('images/a.png?x=1&cb=1', 7),
    ORIGINAL('images/a.png?x=1&cb=1')
  );

  // Without a buster nothing is cut.
  harness.integration.crossoriginCacheBuster = '';
  assert.equal(
    H5P.getPath('images/a.png?cb=1', 7),
    ORIGINAL('images/a.png?cb=1')
  );
});

test("H5P.Video's own cache buster leaves an exam blob URL whole", () => {
  const harness = examBook({
    extra: { crossorigin: 'anonymous', crossoriginCacheBuster: 'cb=1' }
  });
  sendMedia(harness, plainFiles());
  const helper = fs.readFileSync(
    path.join(__dirname, 'fixtures/h5p-video-1.6-get-cross-origin-path.txt'),
    'utf8'
  );
  assert.match(helper, /const getCrossOriginPath = function \(source\)/);
  const getCrossOriginPath = harness.evaluate(
    `(function (self, video) {\n${helper}\nreturn getCrossOriginPath;\n})`
  )({ contentId: 7 }, { crossOrigin: 'anonymous' });

  const url = harness.H5P.getPath('images/a.png', 7);
  // Poster, track and source all go through the same helper.
  assert.equal(getCrossOriginPath({ path: 'images/a.png' }), url);
  assert.equal(
    getCrossOriginPath({ path: 'videos/open.mp4' }),
    ORIGINAL('videos/open.mp4') + '?cb=1'
  );
  assert.equal(
    harness.H5P.addQueryParameter('https://cdn.test/v.mp4#t=1', 'cb=1'),
    'https://cdn.test/v.mp4?cb=1#t=1'
  );
});

test('a wrong exam-media changes nothing and says why', () => {
  const harness = examBook();
  sendMedia(harness, plainFiles());
  const before = harness.H5P.getPath('images/a.png', 7);
  const created = harness.blobs.size;
  const [a, b] = plainFiles();
  const cases = [
    [[a, { ...b, path: 'images/c.png' }], 'unknown-path'],
    [[a, { ...b, path: 'IMAGES/q/b.svg' }], 'unknown-path'],
    [[a, { ...b, path: './images/q/b.svg' }], 'unknown-path'],
    [[a, null], 'unknown-path'],
    [[a], 'incomplete'],
    [[], 'incomplete'],
    [[a, a, b], 'duplicate'],
    [[a, { ...b, data: 'text' }], 'bad-data'],
    [[a, { ...b, data: new Uint8Array([1]) }], 'bad-data'],
    [[a, { ...b, data: new Blob(['x']) }], 'bad-data'],
    ['not a list', 'bad-data']
  ];
  for (const [files, reason] of cases) {
    assert.deepEqual(
      sendMedia(harness, files, 'bad'),
      {
        source: 'h5p-player-host',
        type: 'exam-media-error',
        contentId: '7',
        requestId: 'bad',
        reason
      },
      JSON.stringify(files)
    );
  }
  assert.equal(harness.H5P.getPath('images/a.png', 7), before);
  assert.equal(harness.blobs.size, created);
});

test('a book without an exam answers no-exam and keeps the core getPath', () => {
  const harness = framedBook(bookParams(), { core: true });
  assert.equal(harness.H5P.getPath, harness.corePath);
  assert.deepEqual(sendMedia(harness, plainFiles(), 'x'), {
    source: 'h5p-player-host',
    type: 'exam-media-error',
    contentId: '7',
    requestId: 'x',
    reason: 'no-exam'
  });
  harness.receive({ source: 'editor-embedder', type: 'exam-cipher' });
  assert.deepEqual(harness.messages().at(-1), {
    source: 'h5p-player-host',
    type: 'exam-cipher-error',
    contentId: '7',
    requestId: null,
    reason: 'no-exam'
  });
});

test('only the parent window at the parent origin hands over exam media', () => {
  const harness = examBook();
  const message = {
    source: 'editor-embedder',
    type: 'exam-media',
    files: plainFiles()
  };
  harness.receive(message, { origin: 'https://evil.test' });
  harness.receive(message, { source: {} });
  assert.deepEqual(harness.notifications, []);
  assert.equal(harness.blobs.size, 0);
  assert.equal(
    harness.H5P.getPath('images/a.png', 7),
    ORIGINAL('images/a.png')
  );
});

test('a new set replaces the mapping, and only a real unload revokes', () => {
  const harness = examBook();
  sendMedia(harness, plainFiles());
  const first = harness.H5P.getPath('images/a.png', 7);
  sendMedia(harness, plainFiles(), 'm2');
  const second = harness.H5P.getPath('images/a.png', 7);
  assert.notEqual(second, first);
  assert.deepEqual(harness.revoked, []);
  // Replaced URLs are still ours: no cache buster lands on them.
  assert.equal(harness.H5P.addQueryParameter(first, 'cb=1'), first);

  harness.pagehide(true);
  assert.deepEqual(harness.revoked, []);
  assert.equal(harness.H5P.getPath('images/a.png', 7), second);
  harness.pagehide(false);
  assert.deepEqual(harness.revoked.sort(), [...harness.blobs.keys()].sort());
  assert.equal(harness.revoked.length, 4);
});

test('an exam without media of its own needs no substitution', async () => {
  const exam = { ...EXAM };
  delete exam.media;
  const calls = [];
  const harness = examBook({
    exam,
    fetch: (...args) => calls.push(args)
  });
  assert.equal(harness.H5P.getPath, harness.corePath);
  assert.deepEqual(sendMedia(harness, [], 'empty'), {
    source: 'h5p-player-host',
    type: 'exam-media-ready',
    contentId: '7',
    requestId: 'empty',
    count: 0
  });
  harness.receive({
    source: 'editor-embedder',
    type: 'exam-cipher',
    requestId: 'c'
  });
  await flush();
  assert.deepEqual(harness.messages().at(-1), {
    source: 'h5p-player-host',
    type: 'exam-cipher',
    contentId: '7',
    requestId: 'c',
    vmbExam: exam,
    files: []
  });
  assert.deepEqual(calls, []);
});

test('top level or without an exam the core getPath stays in place', () => {
  const topLevel = examBook({ framed: false, search: '?pickMode=1' });
  assert.equal(topLevel.H5P.getPath, topLevel.corePath);
  const plain = framedBook(bookParams(), { core: true });
  assert.equal(plain.H5P.getPath, plain.corePath);
  assert.equal(
    plain.H5P.addQueryParameter('images/a.png', 'cb=1'),
    'images/a.png?cb=1'
  );
});

// ---- Exam ciphertext -----------------------------------------------------

// Answers each URL with its bytes; `hang` leaves a URL unanswered, `hangBody`
// answers its headers but never its body (both until the request is
// aborted), `status` fails it.
function cipherServer(files = {}) {
  const calls = [];
  const server = {
    calls,
    files: {
      [ORIGINAL('images/a.png')]: [9, 9, 9],
      [ORIGINAL('images/q/b.svg')]: [8, 8],
      ...files
    },
    hang: new Set(),
    hangBody: new Set(),
    status: {},
    throws: new Set(),
    // Requests (or bodies) still waiting for an answer.
    active: 0,
    // Never answers, but ends with an AbortError on its signal, like fetch.
    pending(signal) {
      if (signal.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      server.active++;
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            server.active--;
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true }
        );
      });
    },
    fetch(url, init) {
      calls.push({ url, init });
      if (server.throws.has(url)) return Promise.reject(new Error('offline'));
      if (server.hang.has(url)) return server.pending(init.signal);
      const status = server.status[url] || 200;
      return Promise.resolve({
        ok: status === 200,
        status,
        arrayBuffer: () =>
          server.hangBody.has(url)
            ? server.pending(init.signal)
            : Promise.resolve(Uint8Array.from(server.files[url]).buffer)
      });
    }
  };
  return server;
}

function askCipher(harness, requestId) {
  harness.receive({
    source: 'editor-embedder',
    type: 'exam-cipher',
    requestId
  });
}

test('exam-cipher sends the stored ciphertext of every exam file', async () => {
  const server = cipherServer();
  const harness = examBook({ fetch: server.fetch });
  askCipher(harness, 'c1');
  await flush();
  const [entry] = harness.notifications;
  assert.equal(entry.origin, PARENT);
  const { files, ...rest } = entry.message;
  assert.deepEqual(rest, {
    source: 'h5p-player-host',
    type: 'exam-cipher',
    contentId: '7',
    requestId: 'c1',
    vmbExam: EXAM
  });
  assert.deepEqual(
    files.map((file) => [file.path, view(file.data)]),
    [
      ['images/a.png', [9, 9, 9]],
      ['images/q/b.svg', [8, 8]]
    ]
  );
  // Handed over, not copied: the page's own buffers are detached.
  assert.equal(entry.transfer.length, 2);
  assert.deepEqual(
    [...entry.transfer].map((buffer) => buffer.byteLength),
    [0, 0]
  );
  assert.deepEqual(
    server.calls.map((call) => [call.url, call.init.credentials]),
    [
      [ORIGINAL('images/a.png'), 'same-origin'],
      [ORIGINAL('images/q/b.svg'), 'same-origin']
    ]
  );
  assert.ok(server.calls.every((call) => call.init.signal));
  assert.equal(harness.timers.size, 0, 'no timer outlives the download');
});

test('the ciphertext comes from the stored files even after exam-media', async () => {
  const server = cipherServer();
  const harness = examBook({
    fetch: server.fetch,
    extra: { crossoriginCacheBuster: 'cb=1' }
  });
  askCipher(harness, 'c1');
  await flush();
  sendMedia(harness, plainFiles());
  askCipher(harness, 'c2');
  await flush();
  const second = harness.messages().at(-1);
  assert.equal(second.requestId, 'c2');
  assert.deepEqual(view(second.files[0].data), [9, 9, 9]);
  assert.ok(second.files.every((file) => file.data.byteLength > 0));
  // Downloaded again: nothing of the first answer was kept.
  assert.deepEqual(
    server.calls.map((call) => call.url),
    [
      ORIGINAL('images/a.png'),
      ORIGINAL('images/q/b.svg'),
      ORIGINAL('images/a.png'),
      ORIGINAL('images/q/b.svg')
    ]
  );
});

test('requests during a download share it and each get whole bytes', async () => {
  const server = cipherServer();
  const harness = examBook({ fetch: server.fetch });
  askCipher(harness, 'c1');
  askCipher(harness, 'c2');
  await flush();
  assert.equal(server.calls.length, 2, 'one set of downloads');
  const [first, second] = harness.notifications;
  assert.deepEqual(
    [first.message.requestId, second.message.requestId],
    ['c1', 'c2']
  );
  for (const entry of [first, second]) {
    assert.deepEqual(
      entry.message.files.map((file) => view(file.data)),
      [
        [9, 9, 9],
        [8, 8]
      ]
    );
  }
  // The first got copies (detached by its own post), the last the originals.
  assert.notEqual(first.transfer[0], second.transfer[0]);

  askCipher(harness, 'c3');
  await flush();
  assert.equal(server.calls.length, 4, 'a later request downloads again');
});

test('a failed download answers fetch-failed and nothing else', async () => {
  for (const fail of ['status', 'throws']) {
    const server = cipherServer();
    if (fail === 'status') server.status[ORIGINAL('images/q/b.svg')] = 404;
    else server.throws.add(ORIGINAL('images/q/b.svg'));
    const harness = examBook({ fetch: server.fetch });
    askCipher(harness, 'c1');
    await flush();
    assert.deepEqual(
      harness.messages(),
      [
        {
          source: 'h5p-player-host',
          type: 'exam-cipher-error',
          contentId: '7',
          requestId: 'c1',
          reason: 'fetch-failed'
        }
      ],
      fail
    );
  }
});

test('a download that hangs times out, and the next request starts afresh', async () => {
  for (const stuck of ['hang', 'hangBody']) {
    const server = cipherServer();
    server[stuck].add(ORIGINAL('images/a.png'));
    const harness = examBook({ fetch: server.fetch });
    askCipher(harness, 'c1');
    await flush();
    assert.deepEqual(harness.notifications, [], stuck);
    assert.ok(
      [...harness.timers.values()].every((timer) => timer.ms >= 30000),
      'a generous per-file deadline'
    );
    harness.runTimers();
    await flush();
    assert.equal(harness.messages()[0].reason, 'fetch-failed', stuck);
    assert.ok(
      server.calls.every((call) => call.init.signal.aborted),
      stuck
    );
    assert.equal(server.active, 0, `${stuck}: nothing left downloading`);

    server[stuck].clear();
    askCipher(harness, 'c2');
    await flush();
    assert.equal(harness.messages()[1].type, 'exam-cipher', stuck);
    assert.equal(server.calls.length, 4, stuck);
  }
});

test('the first failure cancels the rest of the set', async () => {
  // The neighbour still waits for its headers, or already reads its body.
  for (const stuck of ['hang', 'hangBody']) {
    const server = cipherServer();
    server[stuck].add(ORIGINAL('images/a.png'));
    server.status[ORIGINAL('images/q/b.svg')] = 404;
    const harness = examBook({ fetch: server.fetch });
    askCipher(harness, 'c1');
    await flush();
    assert.equal(harness.messages()[0].reason, 'fetch-failed', stuck);
    assert.deepEqual(
      server.calls.map((call) => call.init.signal.aborted),
      [true, true],
      stuck
    );
    assert.equal(harness.timers.size, 0, `${stuck}: no timer is left running`);
    assert.equal(server.active, 0, `${stuck}: no download is left running`);

    server[stuck].clear();
    delete server.status[ORIGINAL('images/q/b.svg')];
    askCipher(harness, 'c2');
    await flush();
    assert.equal(harness.messages()[1].type, 'exam-cipher', stuck);
    assert.equal(server.calls.length, 4, stuck);
  }
});

test('only the parent window at the parent origin gets the ciphertext', async () => {
  const server = cipherServer();
  const harness = examBook({ fetch: server.fetch });
  const message = { source: 'editor-embedder', type: 'exam-cipher' };
  harness.receive(message, { origin: 'https://evil.test' });
  harness.receive(message, { source: {} });
  await flush();
  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(server.calls, []);
});
