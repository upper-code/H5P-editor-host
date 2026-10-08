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

/**
 * Loads the bridge into a fresh context. `framed` decides whether
 * `window.parent` is another window; `search` is the page's query string;
 * `H5P` is the namespace as the libraries left it.
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
  const parent = {
    postMessage(message, origin) {
      notifications.push({
        message: JSON.parse(JSON.stringify(message)),
        origin
      });
    }
  };
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
    URL,
    URLSearchParams,
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
  vm.createContext(context);
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
    }
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
