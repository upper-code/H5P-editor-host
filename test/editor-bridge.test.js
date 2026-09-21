const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

// An answer the host really sent, as opposed to a transport failure:
// `respond(async () => rejected(409))` makes the stubbed fetch report a status.
function rejected(status, body = {}) {
  return { __status: status, __body: body };
}

// Polls `notifications` (a plain synchronous array `window.parent.postMessage`
// pushes onto) until `predicate` matches or `budgetMs` of real wall-clock time
// passes. Used instead of `node:test`'s mock timers for the bridge's ready
// watch: several existing tests below already enable
// `t.mock.timers.enable({ apis: ['setTimeout'] })` *before* calling `bridge()`,
// and a wait built on `setTimeout` would then hang forever waiting for a
// `.tick()` nobody calls. `setImmediate` is never one of the mocked APIs in
// this file, so looping on it stays real regardless of what a given test
// mocked `setTimeout` for.
async function waitForNotification(notifications, predicate, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs;
  while (!notifications.some(predicate) && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function bridge(options = {}) {
  const location = new URL(
    `https://host.example/h5p-editor-core/editor/new${options.search || ''}`
  );
  const moduleUrl = 'https://host.example/h5p-editor-core/web/editor-host.js';
  const source = fs
    .readFileSync(path.join(__dirname, '../web/editor-host.js'), 'utf8')
    .replace('import.meta.url', JSON.stringify(moduleUrl))
    // The production values (100 ms poll, 60 s deadline) would make the
    // ready-watch tests either slow (waitForNotification's real-time loop)
    // or need a literal minute of wall-clock time for the deadline case.
    // Both are const declarations that appear exactly once.
    .replace(
      'const READY_POLL_INTERVAL_MS = 100;',
      'const READY_POLL_INTERVAL_MS = 4;'
    )
    .replace(
      'const EDITOR_READY_TIMEOUT_MS = 60000;',
      'const EDITOR_READY_TIMEOUT_MS = 20;'
    );
  const notifications = [];
  const requests = [];
  const reads = [];
  let listener;
  const iframeListeners = {};
  const iframeAjaxHandlers = {};
  let libraryWatchBindings = 0;
  let editorInstance;
  let capturedOnIframeLoaded;
  let serialize = (submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{},"metadata":{}}'
    });
  let saveResponse = async () => ({
    contentId: '7',
    savedBytes: 10,
    deltaBytes: 10
  });
  let revision = 'rev-1';
  const parent = {
    postMessage(message) {
      notifications.push(message);
    }
  };
  const element = { setAttribute() {}, appendChild() {}, remove() {} };
  // Called by the editor with the form iframe's window as `this`, once per
  // 'load' of its internal iframe (can be more than once — see
  // `reloadIframe`). A fresh stand-in each time, like a real reload getting a
  // new `contentWindow`. `H5P.jQuery` is enough of `watchLibraryLoad`'s
  // `iframeWindow.H5P.jQuery(iframeWindow.document).on(...)` to record the
  // handlers it binds, in `iframeAjaxHandlers`.
  // The form iframe's own `H5PEditor.List`: closure-style like the vendored
  // one (instance methods assigned in the constructor, a prototype chain,
  // an EventDispatcher-like `on`/`trigger`), with `addedItem`/`removedItem`
  // triggered after the mutation and a `moveItem` that triggers nothing.
  function stubListNamespace() {
    function addEventDispatcher(target) {
      const handlers = {};
      target.on = (type, fn) => {
        (handlers[type] = handlers[type] || []).push(fn);
      };
      target.trigger = (type, data) => {
        (handlers[type] || []).forEach((fn) => fn(data));
      };
    }
    function SemanticStructure() {}
    SemanticStructure.prototype.validate = () => true;
    function List(parent, field, parameters) {
      const self = this;
      self.parameters = parameters || [];
      addEventDispatcher(self);
      self.addItem = (params) => {
        self.parameters.push(params);
        self.trigger('addedItem', params);
        return true;
      };
      self.removeItem = (index) => {
        self.parameters.splice(index, 1);
        self.trigger('removedItem', index);
      };
      self.moveItem = (from, to) => {
        const [item] = self.parameters.splice(from, 1);
        self.parameters.splice(to, 0, item);
      };
    }
    List.prototype = Object.create(SemanticStructure.prototype);
    List.prototype.constructor = List;
    List.someStatic = 'kept';
    // Media widgets, vendored-style: `changes` is a list of callbacks the
    // widget runs after it really changed (never during construction), and
    // `image` invokes `File` as its super-constructor with `.call`.
    function File(parent, field, params) {
      this.field = field;
      this.params = params;
      this.changes = [];
      this.applyUpload = (path) => {
        this.params = { path };
        this.changes.forEach((fn) => fn(this.params));
      };
    }
    File.prototype.validate = () => true;
    const image = function (parent, field, params) {
      File.call(this, parent, field, params);
      this.isImage = true;
    };
    image.prototype = Object.create(File.prototype);
    image.prototype.constructor = image;
    const AV = function (parent, field, params) {
      this.changes = [];
      this.useUrl = (url) => {
        this.params = [{ path: url }];
        this.changes.forEach((fn) => fn(this.params[0]));
      };
    };
    AV.providers = [];
    const dialogs = [];
    // `ns.confirmReplace(library, top, next)`: asks when a library is set,
    // runs `next` on confirmation only; no library → no question.
    const confirmReplace = (library, top, next) => {
      if (library) {
        dialogs.push({ confirm: next });
      } else {
        next();
      }
    };
    function LibrarySelector(libraries, defaultLibrary) {
      this.libraries = libraries;
      this.currentLibrary = defaultLibrary;
      addEventDispatcher(this);
    }
    LibrarySelector.prototype.getCurrentLibrary = function () {
      return this.currentLibrary;
    };
    function Form() {}
    Form.prototype.setSubContentDefaultLanguage = function setLanguage(
      params,
      language
    ) {
      if (params?.metadata) {
        params.metadata.defaultLanguage = language;
      }
      for (const value of Object.values(params || {})) {
        if (value && typeof value === 'object') {
          this.setSubContentDefaultLanguage(value, language);
        }
      }
      return params;
    };
    return {
      List,
      File,
      AV,
      Form,
      LibrarySelector,
      confirmReplace,
      dialogs,
      widgets: { list: List, image, file: File, video: AV, audio: AV },
      original: {
        List,
        image,
        File,
        AV,
        Form,
        LibrarySelector,
        confirmReplace
      }
    };
  }
  let lastIframeWindow;
  function fireIframeLoaded(onIframeLoaded) {
    const {
      List,
      File,
      AV,
      Form,
      LibrarySelector,
      confirmReplace,
      dialogs,
      widgets,
      original
    } = stubListNamespace();
    lastIframeWindow = {
      dialogs,
      H5P: {
        jQuery: () => ({
          on(type, handler) {
            iframeAjaxHandlers[type] = handler;
            libraryWatchBindings += 1;
            return this;
          }
        })
      },
      H5PEditor: {
        List,
        File,
        AV,
        Form,
        LibrarySelector,
        confirmReplace,
        widgets
      },
      original,
      document: {
        addEventListener(type, fn) {
          iframeListeners[type] = fn;
        }
      }
    };
    onIframeLoaded?.call(lastIframeWindow);
  }
  const window = {
    parent,
    H5P: { jQuery: {} },
    H5PEditor: {
      Editor: function (_library, _params, _mount, onIframeLoaded) {
        editorInstance = this;
        capturedOnIframeLoaded = onIframeLoaded;
        this.getContent = (...args) => serialize(...args);
        // Deferred, like the vendored runtime: `iframeLoaded` fires only
        // once the form iframe has actually navigated, well after
        // `new ns.Editor(...)` returned and `editor` (the module variable in
        // editor-host.js) was assigned — unlike a synchronous call here.
        queueMicrotask(() => {
          fireIframeLoaded(onIframeLoaded);
          // `self.selector` appearing is the content-type list AJAX
          // resolving. Auto-appears so every test that does not care about
          // readiness timing keeps seeing the same fast 'ready' this harness
          // always gave; `options.controlReadiness` holds it back for the
          // tests that do (see `appearSelector`/`appearForm` below).
          if (!options.controlReadiness) {
            editorInstance.selector = {};
          }
        });
      }
    },
    addEventListener(_type, handler) {
      listener = handler;
    }
  };
  // The bridge is served as an ES module; it must never gain import/export
  // statements or top-level await, which a classic vm script cannot parse.
  // Timers are looked up on the test's global at call time so node:test's
  // mock timers apply; real ones are unref'd so a pending watchdog cannot
  // hold the runner open.
  const context = vm.createContext({
    URL,
    URLSearchParams,
    location,
    window,
    // The page needs a source of randomness for the save's idempotency key.
    // `crypto.randomUUID` exists only in a secure context, so the bridge must
    // work with the getRandomValues-only object too (`options.crypto`).
    crypto: 'crypto' in options ? options.crypto : nodeCrypto.webcrypto,
    setTimeout(fn, ms) {
      const id = setTimeout(fn, ms);
      if (typeof id?.unref === 'function') id.unref();
      return id;
    },
    clearTimeout: (id) => clearTimeout(id),
    // `awaitEditorReady`'s poll. Real (never one of this file's mocked
    // `t.mock.timers` APIs), but cheap at the patched 4 ms.
    setInterval(fn, ms) {
      const id = setInterval(fn, ms);
      if (typeof id?.unref === 'function') id.unref();
      return id;
    },
    clearInterval: (id) => clearInterval(id),
    document: {
      getElementById: () => ({ ...element }),
      createElement: () => ({ ...element })
    },
    async fetch(url, options) {
      if (options?.method === 'PATCH') {
        requests.push({
          url,
          body: JSON.parse(options.body),
          headers: options.headers
        });
        const value = await saveResponse();
        if (value?.__status) {
          return {
            ok: false,
            status: value.__status,
            text: async () => JSON.stringify(value.__body)
          };
        }
        return { ok: true, text: async () => JSON.stringify(value) };
      }
      reads.push(String(url));
      // Only stored content has a revision; `new` has nothing to match yet.
      const stored = !String(url).includes('/content/new/');
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            ...(stored ? { revision } : {}),
            h5p: {
              integration: { editor: { assets: {} } },
              styles: [],
              scripts: [],
              ...(options.library ? { library: options.library } : {})
            }
          })
      };
    }
  });
  vm.runInContext(source, context);
  if (options.expectReady !== false) {
    await waitForNotification(
      notifications,
      (message) => message.type === 'ready' || message.type === 'error'
    );
    assert.equal(notifications[0]?.type, 'ready');
  } else {
    // Nothing will ever be posted in this case (no valid parent origin, or
    // the caller is deliberately holding readiness back); one tick is enough
    // for bootstrap's synchronous-ish setup to run.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    requests,
    notifications,
    reads,
    save(origin = location.origin, from = parent) {
      listener({
        origin,
        source: from,
        data: { source: 'editor-embedder', type: 'save' }
      });
    },
    serialize(fn) {
      serialize = fn;
    },
    edit(type = 'input', target) {
      iframeListeners[type]?.({ type, target });
    },
    click(target) {
      iframeListeners.click?.({ type: 'click', target });
    },
    /** The form iframe's window as of its latest 'load'. */
    iframeWindow: () => lastIframeWindow,
    /** How many ajax handlers `watchLibraryLoad` has bound so far. */
    libraryWatchBindings: () => libraryWatchBindings,
    respond(fn) {
      saveResponse = fn;
    },
    stored(next) {
      revision = next;
    },
    tick: () => new Promise((resolve) => setImmediate(resolve)),
    // --- Readiness (options.controlReadiness): fine-grained control over
    // what the default auto-appearing selector otherwise hides. ---
    appearSelector() {
      editorInstance.selector = {};
    },
    appearForm() {
      editorInstance.selector.form = {};
    },
    reloadIframe() {
      fireIframeLoaded(capturedOnIframeLoaded);
    },
    libraryAjaxError(status = 0) {
      iframeAjaxHandlers.ajaxError?.({}, { status });
    },
    libraryAjaxUnsuccessful(message, errorCode) {
      iframeAjaxHandlers.ajaxSuccess?.(
        {},
        {},
        {},
        {
          success: false,
          message,
          errorCode
        }
      );
    },
    waitReady: () =>
      waitForNotification(
        notifications,
        (message) => message.type === 'ready' || message.type === 'error'
      )
  };
}

test('repeated save messages cannot create duplicate content while a save is pending', async () => {
  const host = await bridge();
  const pending = Promise.withResolvers();
  host.respond(() => pending.promise);
  host.save();
  host.save();
  assert.equal(host.requests.length, 1);
  assert.equal(
    host.notifications.filter((message) => message.type === 'saving').length,
    2,
    'the duplicate is answered with saving rather than dropped silently'
  );
  pending.resolve({ contentId: '7', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 2);
  assert.match(host.requests[0].url, /content\/new$/);
  assert.match(host.requests[1].url, /content\/7$/);
});

test('validation errors, runtime exceptions and failed requests all allow a retry', async () => {
  const host = await bridge();
  host.serialize((_submit, error) => error('missing-title'));
  host.save();
  host.serialize(() => {
    throw new Error('runtime failure');
  });
  host.save();
  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{},"metadata":{}}'
    })
  );
  host.respond(async () => {
    throw new Error('network failure');
  });
  host.save();
  await host.tick();
  host.respond(async () => ({ contentId: '7' }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 2);
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(
    host.notifications.filter((message) => message.type === 'error').length,
    3
  );
});

test('a save the editor never answers times out, and its late callback cannot save', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  let lateSubmit;
  host.serialize((submit) => {
    lateSubmit = submit;
  });
  host.save();
  t.mock.timers.tick(59_999);
  assert.equal(host.notifications.at(-1).type, 'saving');
  t.mock.timers.tick(1);
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(host.notifications.at(-1).message, /did not respond/);
  lateSubmit({
    library: 'H5P.Column 1.18',
    params: '{"params":{},"metadata":{}}'
  });
  await host.tick();
  assert.equal(
    host.requests.length,
    0,
    'an abandoned attempt must not create content'
  );
  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{},"metadata":{}}'
    })
  );
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 1);
  assert.equal(host.notifications.at(-1).type, 'saved');
});

// The vendored runtime stringifies params on the upgrade path as well
// (h5p-content-upgrade-process.js); the object form is tolerated, not relied on.
test('a params object is accepted as well as the serialized string', async () => {
  const host = await bridge();
  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: { params: { text: 'upgraded' }, metadata: { title: 'Book' } }
    })
  );
  host.save();
  await host.tick();
  assert.deepEqual(host.requests[0].body, {
    library: 'H5P.Column 1.18',
    params: { text: 'upgraded' },
    metadata: { title: 'Book' }
  });
  assert.equal(host.notifications.at(-1).type, 'saved');
});

test('save messages from another origin or window are ignored', async () => {
  const host = await bridge();
  host.save('https://stranger.example');
  host.save('https://host.example', {});
  await host.tick();
  assert.equal(host.requests.length, 0);
});

test('a present but unparseable parentOrigin refuses to run rather than post to the wrong window', async () => {
  const host = await bridge({
    search: '?parentOrigin=not-a-valid-origin',
    expectReady: false
  });
  // Nothing was posted anywhere: with no valid parent the bridge must not fall
  // back to this page's own origin and aim `ready`/`error` at the wrong window.
  assert.equal(
    host.notifications.length,
    0,
    'no postMessage is sent when the parent origin is invalid'
  );
  // And a save message — even one that names this page's own origin — cannot
  // drive a write, because the frame never loaded an editor.
  host.save('https://host.example');
  await host.tick();
  assert.equal(host.requests.length, 0);
});

// --- Readiness (review item #5): `ready` must mean the form is actually
// usable, not just that `new ns.Editor(...)` was constructed. ---

test('ready is not sent until the selector exists, and, for existing content, until its form does too', async () => {
  const host = await bridge({
    library: 'H5P.Column 1.18',
    controlReadiness: true,
    expectReady: false
  });
  assert.equal(
    host.notifications.length,
    0,
    'the iframe has not even loaded yet'
  );
  host.appearSelector();
  await host.tick();
  assert.equal(
    host.notifications.length,
    0,
    'the model named a library, so the selector alone is not enough'
  );
  host.appearForm();
  await host.waitReady();
  assert.equal(host.notifications.at(-1).type, 'ready');
});

test('save before readiness answers an error DTO instead of throwing', async () => {
  const host = await bridge({ controlReadiness: true, expectReady: false });
  host.save();
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(host.notifications.at(-1).message, /not ready/);
  assert.equal(host.requests.length, 0, 'getContent() is never called');
});

test('a library-list AJAX failure fails the ready watch with an error DTO', async () => {
  const networkFailure = await bridge({
    controlReadiness: true,
    expectReady: false
  });
  networkFailure.libraryAjaxError(500);
  assert.equal(networkFailure.notifications.at(-1).type, 'error');
  assert.match(
    networkFailure.notifications.at(-1).message,
    /could not load its libraries/
  );
  // And save() refuses afterward too — the watch is terminal, not just late.
  networkFailure.save();
  assert.equal(networkFailure.notifications.at(-1).type, 'error');
  assert.match(networkFailure.notifications.at(-1).message, /not ready/);

  const unsuccessful = await bridge({
    controlReadiness: true,
    expectReady: false
  });
  unsuccessful.libraryAjaxUnsuccessful('Hub unreachable', 'HUB_DOWN');
  assert.equal(unsuccessful.notifications.at(-1).type, 'error');
  assert.match(
    unsuccessful.notifications.at(-1).message,
    /could not load its libraries.*Hub unreachable/
  );
});

test('the ready deadline fails the watch if the editor never becomes ready', async () => {
  const host = await bridge({ controlReadiness: true, expectReady: false });
  await host.waitReady();
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(host.notifications.at(-1).message, /did not finish loading/);
});

test('a reloaded form iframe does not send a second ready', async () => {
  const host = await bridge();
  assert.equal(
    host.notifications.filter((message) => message.type === 'ready').length,
    1
  );
  host.reloadIframe();
  await host.tick();
  assert.equal(
    host.notifications.filter((message) => message.type === 'ready').length,
    1,
    'a reload must not send ready again'
  );
});

test('a form iframe reloaded while still loading keeps a library-load watch on its new window', async () => {
  const host = await bridge({ controlReadiness: true, expectReady: false });
  const bound = host.libraryWatchBindings();
  assert.ok(bound > 0, 'the first load bound the watch');
  host.reloadIframe();
  assert.equal(
    host.libraryWatchBindings(),
    bound * 2,
    'the new window gets its own handlers (the old ones never fire again)'
  );
  // The failure now arrives through the new window's handlers.
  host.libraryAjaxError(502);
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(
    host.notifications.at(-1).message,
    /could not load its libraries \(502\)/
  );
});

test('a save the host never answers times out and can be retried; its late answer is then ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const first = Promise.withResolvers();
  host.respond(() => first.promise);
  host.save();
  t.mock.timers.tick(119_999);
  host.save();
  assert.equal(host.requests.length, 1, 'still pending: no second request');
  assert.equal(host.notifications.at(-1).type, 'saving');
  t.mock.timers.tick(1);
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(host.notifications.at(-1).message, /did not answer/);
  const second = Promise.withResolvers();
  host.respond(() => second.promise);
  host.save();
  assert.equal(
    host.requests.length,
    2,
    'a retry is possible after the timeout'
  );
  assert.match(host.requests[1].url, /content\/new$/);
  // The superseded attempt's answer must not disturb the newer save.
  first.resolve({ contentId: '7', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saving');
  second.resolve({ contentId: '8', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(host.notifications.at(-1).contentId, '8');
  host.respond(async () => ({ contentId: '8' }));
  host.save();
  await host.tick();
  assert.match(host.requests[2].url, /content\/8$/);
});

// --- Save-request timeout budget (review item #6): sized by the embedder via
// `saveTimeoutMs` on this page's URL, not fixed here. ---

test('saveTimeoutMs from the embedder is read and clamped to the 30 s floor', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge({ search: '?saveTimeoutMs=1000' });
  host.respond(() => new Promise(() => {}));
  host.save();
  t.mock.timers.tick(29_999);
  assert.equal(
    host.notifications.at(-1).type,
    'saving',
    'clamped up to the 30 s floor, not the requested 1 s'
  );
  t.mock.timers.tick(1);
  assert.equal(host.notifications.at(-1).type, 'error');
});

test('saveTimeoutMs from the embedder is clamped to the 30-minute ceiling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge({ search: '?saveTimeoutMs=999999999' });
  host.respond(() => new Promise(() => {}));
  host.save();
  t.mock.timers.tick(1_800_000 - 1);
  assert.equal(
    host.notifications.at(-1).type,
    'saving',
    'clamped down to the 30-minute ceiling, not the requested value'
  );
  t.mock.timers.tick(1);
  assert.equal(host.notifications.at(-1).type, 'error');
});

for (const search of ['', '?saveTimeoutMs=not-a-number', '?saveTimeoutMs=']) {
  test(`a missing or malformed saveTimeoutMs (${JSON.stringify(search)}) falls back to the default 120 s budget`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const host = await bridge({ search });
    host.respond(() => new Promise(() => {}));
    host.save();
    t.mock.timers.tick(119_999);
    assert.equal(host.notifications.at(-1).type, 'saving');
    t.mock.timers.tick(1);
    assert.equal(host.notifications.at(-1).type, 'error');
  });
}

test('a late answer to a timed-out save is adopted while no newer save has started', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const late = Promise.withResolvers();
  host.respond(() => late.promise);
  host.save();
  t.mock.timers.tick(120_000);
  assert.equal(host.notifications.at(-1).type, 'error');
  late.resolve({ contentId: '7', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(host.notifications.at(-1).contentId, '7');
  host.respond(async () => ({ contentId: '7' }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 2);
  assert.match(
    host.requests[1].url,
    /content\/7$/,
    'the adopted id is updated, not created again'
  );
});

test('input in the editor is reported once as `changed`, cleared by a save, and re-reported after it', async () => {
  const host = await bridge();
  const changes = () =>
    host.notifications.filter((message) => message.type === 'changed');
  assert.equal(changes().length, 0, 'a freshly opened editor is not dirty');
  host.edit('input');
  host.edit('change');
  host.edit('input');
  assert.equal(changes().length, 1, 'one report per dirty period');
  assert.equal(changes()[0].contentId, 'new');

  const pending = Promise.withResolvers();
  host.respond(() => pending.promise);
  host.save();
  host.edit('input');
  assert.equal(changes().length, 1, 'an edit during a save is held back');
  pending.resolve({ contentId: '7', savedBytes: 10, deltaBytes: 10 });
  await host.tick();
  const types = host.notifications.map((message) => message.type);
  assert.deepEqual(
    types.slice(-2),
    ['saved', 'changed'],
    'the held-back edit follows the save'
  );
  assert.equal(changes()[1].contentId, '7');

  host.respond(async () => ({ contentId: '7' }));
  host.save();
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  host.edit('input');
  assert.equal(
    changes().length,
    3,
    'a save clears the flag so the next edit is reported again'
  );
});

// A minimal fake DOM element supporting exactly the selector features
// watchEditorInput's click handler uses: a tag name, `.class`, `[attr]` /
// `[attr=value]`, comma-separated alternatives and one `>` child combinator.
// Real enough to exercise the literal selector text in web/editor-host.js
// rather than re-deciding the answer in the test.
function fakeElement(tag, { classes = [], attrs = {}, parent = null } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    classes: new Set(classes),
    attrs,
    parentElement: parent
  };
  const matchesCompound = (node, compound) => {
    let rest = compound;
    for (const [, name, value] of compound.matchAll(
      /\[([a-zA-Z-]+)(?:=([^\]]+))?\]/g
    )) {
      if (
        value === undefined ? !(name in node.attrs) : node.attrs[name] !== value
      )
        return false;
    }
    rest = rest.replace(/\[[^\]]+\]/g, '');
    for (const cls of rest.match(/\.[\w-]+/g) || []) {
      if (!node.classes.has(cls.slice(1))) return false;
    }
    rest = rest.replace(/\.[\w-]+/g, '');
    return !rest || rest.toLowerCase() === node.tagName.toLowerCase();
  };
  el.matches = (selector) =>
    selector.split(',').some((alt) => {
      const parts = alt
        .trim()
        .split('>')
        .map((part) => part.trim());
      let node = el;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (!node || !matchesCompound(node, parts[i])) return false;
        node = node.parentElement;
      }
      return true;
    });
  el.closest = (selector) => {
    let node = el;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  };
  return el;
}

// markChanged() reports at most once per dirty period (see "one report per
// dirty period" above), so each case below starts from its own fresh bridge
// rather than accumulating clicks on one instance.
test("expanding a chapter (the group's own toggle) does not report `changed`", async () => {
  const host = await bridge();
  // h5peditor-group.js: the fieldset's own expand/collapse toggle.
  const group = fakeElement('fieldset', { classes: ['field', 'group'] });
  const groupToggle = fakeElement('div', {
    classes: ['title'],
    attrs: { role: 'button' },
    parent: group
  });
  host.click(groupToggle);
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    0,
    'expanding a chapter is not an edit'
  );
});

test('the list widget\'s "collapse/expand all" buttons do not report `changed`', async () => {
  const host = await bridge();
  // h5peditor-list-editor.js: the list-level "collapse/expand all" controls.
  host.click(
    fakeElement('button', {
      classes: [
        'h5peditor-button',
        'h5peditor-button-textual',
        'h5peditor-button-collapse'
      ]
    })
  );
  host.click(fakeElement('button', { classes: ['h5peditor-label-button'] }));
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    0,
    'collapsing/expanding every chapter is not an edit either'
  );
});

test('a list add reports `changed` from the list model, however the widget triggered it', async () => {
  const host = await bridge();
  const win = host.iframeWindow();
  // The runtime builds lists through the widget registry, not the name.
  assert.equal(win.H5PEditor.widgets.list, win.H5PEditor.List);
  const list = new win.H5PEditor.widgets.list({}, { name: 'chapters' }, []);
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    0,
    'building a list is not an edit'
  );
  list.addItem({ library: 'H5P.Column 1.18' });
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    1
  );
});

test('a remove reports `changed` only once the model removed the item, not when Remove was pressed', async () => {
  const host = await bridge();
  const { List } = host.iframeWindow().H5PEditor;
  const list = new List({}, {}, [{}, {}]);
  // Pressing Remove opens a confirmation dialog; cancelling it leaves the
  // model untouched — nothing here to report.
  host.click(
    fakeElement('div', {
      classes: ['h5peditor-button', 'remove'],
      attrs: { role: 'button' }
    })
  );
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    0,
    'a cancelled removal is not an edit'
  );
  list.removeItem(0);
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    1
  );
});

test('a reorder reports `changed` through moveItem — the call both the order buttons and a drag make', async () => {
  const host = await bridge();
  const { List } = host.iframeWindow().H5PEditor;
  const list = new List({}, {}, ['a', 'b']);
  // An order button on the first/last item returns before touching the
  // model; only an actual move reaches moveItem.
  host.click(
    fakeElement('div', {
      classes: ['h5peditor-button', 'order-up'],
      attrs: { role: 'button', 'aria-disabled': 'true' }
    })
  );
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    0
  );
  list.moveItem(0, 1);
  assert.deepEqual(list.parameters, ['b', 'a'], 'the original move still ran');
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    1
  );
});

test('the wrapped List keeps the prototype chain, statics and the widget alias, and is wrapped once per window', async () => {
  const host = await bridge();
  const win = host.iframeWindow();
  const list = new win.H5PEditor.List({}, {}, []);
  assert.ok(list instanceof win.original.List, 'instanceof the vendored List');
  assert.equal(list.validate(), true, 'SemanticStructure prototype methods');
  assert.equal(win.H5PEditor.List.someStatic, 'kept');
  assert.notEqual(win.H5PEditor.List, win.original.List);
  assert.equal(win.H5PEditor.widgets.list, win.H5PEditor.List);
  // A reload hands the bridge a fresh window whose List is wrapped anew; the
  // old window's wrapper is not wrapped a second time.
  host.reloadIframe();
  const fresh = host.iframeWindow();
  assert.notEqual(fresh, win);
  assert.notEqual(fresh.H5PEditor.List, fresh.original.List);
  assert.equal(fresh.H5PEditor.widgets.list, fresh.H5PEditor.List);
  new fresh.H5PEditor.List({}, {}, []).addItem({});
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    1
  );
});

test('a paste over a library field reports `changed` when the replacement is confirmed, not when Paste is pressed', async () => {
  const host = await bridge();
  const win = host.iframeWindow();
  const changed = () =>
    host.notifications.filter((message) => message.type === 'changed').length;
  host.click(fakeElement('div', { classes: ['h5peditor-paste-button'] }));
  assert.equal(changed(), 0, 'the click only opens the question');
  // H5PEditor.Library / the content-type selector: ask, then replace.
  let replaced = 0;
  win.H5PEditor.confirmReplace('H5P.Column 1.18', 0, () => {
    replaced += 1;
  });
  assert.equal(win.dialogs.length, 1);
  assert.equal(changed(), 0, 'nothing changed while the dialog is open');
  win.dialogs[0].confirm();
  assert.equal(replaced, 1, 'the original replacement still ran');
  assert.equal(changed(), 1);
});

test('a cancelled paste, and a paste onto an empty field, behave as the editor does', async () => {
  const cancelled = await bridge();
  cancelled
    .iframeWindow()
    .H5PEditor.confirmReplace('H5P.Column 1.18', 0, () => {
      assert.fail('never confirmed');
    });
  assert.equal(
    cancelled.notifications.filter((message) => message.type === 'changed')
      .length,
    0,
    'Cancel leaves the content untouched'
  );

  const empty = await bridge();
  let replaced = 0;
  // No library yet: the editor replaces without asking.
  empty.iframeWindow().H5PEditor.confirmReplace(undefined, 0, () => {
    replaced += 1;
  });
  assert.equal(replaced, 1);
  assert.equal(
    empty.notifications.filter((message) => message.type === 'changed').length,
    1
  );
});

test('temporary selector and media controls stay clean until their model changes', async () => {
  const host = await bridge();
  const mediaDrop = fakeElement('div', {
    classes: ['h5p-file-drop-upload']
  });
  const controls = [
    ['change', fakeElement('select', { attrs: { name: 'h5peditor-library' } })],
    [
      'change',
      fakeElement('select', {
        attrs: { id: 'h5peditor-language-switcher' }
      })
    ],
    ['input', fakeElement('input', { classes: ['h5p-file-url'] })],
    ['change', fakeElement('input', { attrs: { type: 'file' } })],
    ['drop', fakeElement('span', { parent: mediaDrop })]
  ];
  controls.forEach(([type, target]) => host.edit(type, target));
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    0,
    'Cancel and a rejected upload leave the serialized editor state untouched'
  );
});

test('the top-level library selector reports only accepted selections, not its initial load or Cancel', async () => {
  const existing = await bridge();
  const ExistingSelector = existing.iframeWindow().H5PEditor.LibrarySelector;
  const selector = new ExistingSelector([], 'H5P.Column 1.18');
  const changed = () =>
    existing.notifications.filter((message) => message.type === 'changed')
      .length;
  selector.trigger('editorload');
  assert.equal(changed(), 0, 'loading the saved library is initialization');
  // Cancel emits no editorload; the legacy selector only resets its UI.
  assert.equal(changed(), 0);
  selector.trigger('editorload');
  assert.equal(changed(), 1, 'a confirmed replacement is an edit');

  const created = await bridge();
  const NewSelector = created.iframeWindow().H5PEditor.LibrarySelector;
  new NewSelector([], '').trigger('editorload');
  assert.equal(
    created.notifications.filter((message) => message.type === 'changed')
      .length,
    1,
    'the first explicit content-type selection is also an edit'
  );
});

test('a content-language change reports only after its confirmation callback mutates the form', async () => {
  const host = await bridge();
  const win = host.iframeWindow();
  const languageSelect = fakeElement('select', {
    attrs: { id: 'h5peditor-language-switcher' }
  });
  host.edit('change', languageSelect);
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    0,
    'opening then cancelling the language dialog is not an edit'
  );
  const params = { child: { metadata: { defaultLanguage: 'en' } } };
  new win.H5PEditor.Form().setSubContentDefaultLanguage(params, 'fr');
  assert.equal(params.child.metadata.defaultLanguage, 'fr');
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    1
  );
});

test('media widgets report `changed` through their change listeners, after the change', async () => {
  const host = await bridge();
  const { widgets } = host.iframeWindow().H5PEditor;
  const changed = () =>
    host.notifications.filter((message) => message.type === 'changed').length;
  const image = new widgets.image({}, { name: 'file' }, undefined);
  const video = new widgets.video({}, { name: 'sources' }, undefined);
  assert.ok(video, 'the wrapped video constructor still returns an instance');
  assert.equal(changed(), 0, 'construction is not an edit');
  // Insert/remove/image-save controls are questions or validations first;
  // their clicks report nothing …
  ['h5p-insert', 'h5p-remove', 'h5p-editing-image-save-button'].forEach((cls) =>
    host.click(fakeElement('div', { classes: [cls] }))
  );
  // … and the image popup's Reset only redraws the preview.
  host.click(
    fakeElement('div', {
      classes: ['h5p-editing-image-reset-button', 'h5p-remove']
    })
  );
  assert.equal(changed(), 0);
  image.applyUpload('images/edited.png');
  assert.equal(changed(), 1, 'an upload that completed is an edit');
  assert.deepEqual(image.params, { path: 'images/edited.png' });

  const later = await bridge();
  const av = new (later.iframeWindow().H5PEditor.widgets.video)(
    {},
    {},
    undefined
  );
  av.useUrl('https://example.test/clip.mp4');
  assert.equal(
    later.notifications.filter((message) => message.type === 'changed').length,
    1,
    'a URL insert that went through is an edit'
  );
});

test('wrapping keeps super-constructor calls, prototypes, statics and the named constructors intact', async () => {
  const host = await bridge();
  const win = host.iframeWindow();
  const { widgets } = win.H5PEditor;
  // `image` calls `H5PEditor.File.call(this, …)`; the named constructors
  // stay the originals so that keeps initialising `this`.
  assert.equal(win.H5PEditor.File, win.original.File);
  assert.equal(win.H5PEditor.AV, win.original.AV);
  assert.notEqual(widgets.image, win.original.image);
  assert.notEqual(widgets.video, win.original.AV);
  assert.equal(widgets.video, widgets.audio);
  const image = new widgets.image({}, {}, { path: 'a.png' });
  assert.ok(image instanceof win.original.image);
  assert.ok(image instanceof win.original.File);
  assert.equal(image.isImage, true);
  assert.equal(image.validate(), true);
  assert.deepEqual(image.params, { path: 'a.png' });
  assert.equal(widgets.video.providers, win.original.AV.providers, 'statics');
});

test('generic buttons and role-buttons used for navigation do not report `changed`', async () => {
  const host = await bridge();
  host.click(
    fakeElement('div', { classes: ['title'], attrs: { role: 'button' } })
  );
  host.click(
    fakeElement('button', {
      classes: [
        'h5peditor-form-manager-button',
        'h5peditor-form-manager-fullscreen'
      ]
    })
  );
  host.click(
    fakeElement('button', { classes: ['h5p-editing-image-cancel-button'] })
  );
  // List controls are deliberately not clicks the bridge reports: their
  // effect (if any — Remove asks first, an edge order button does nothing)
  // arrives through the list model instead.
  host.click(
    fakeElement('div', {
      classes: ['h5peditor-button', 'h5peditor-button-textual', 'add-entity'],
      attrs: { role: 'button' }
    })
  );
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    0
  );
});

test('a failed save keeps the dirty state and does not report it twice', async () => {
  const host = await bridge();
  host.edit('input');
  host.respond(async () => {
    throw new Error('network failure');
  });
  host.save();
  host.edit('input');
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    1
  );
});

// --- Contract version 3: idempotency key, revision matching, operation id ---

test('the saved DTO carries the operation id the parent acknowledges, keyed idempotently', async () => {
  const host = await bridge();
  host.respond(async () => ({
    contentId: '7',
    operationId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    revision: 'rev-9',
    savedBytes: 10,
    deltaBytes: 10
  }));
  host.save();
  await host.tick();
  const saved = host.notifications.at(-1);
  assert.equal(saved.type, 'saved');
  assert.equal(saved.operationId, '1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  assert.match(
    host.requests[0].headers['idempotency-key'],
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
});

test('the idempotency key is generated without crypto.randomUUID', async () => {
  const v4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  // A plain-http page outside localhost has no secure context, so
  // `crypto.randomUUID` is missing even though `crypto` itself is there.
  const insecure = await bridge({
    crypto: { getRandomValues: (bytes) => bytes.fill(7) }
  });
  insecure.save();
  await insecure.tick();
  assert.match(insecure.requests[0].headers['idempotency-key'], v4);

  // And with no Web Crypto at all the key is still a well-formed v4.
  const bare = await bridge({ crypto: undefined });
  bare.save();
  await bare.tick();
  assert.match(bare.requests[0].headers['idempotency-key'], v4);
});

test('a body the host definitively rejected is dropped, not replayed for ever', async () => {
  const host = await bridge();
  host.respond(async () =>
    rejected(422, { error: 'H5P.Video is not supported here.' })
  );
  host.save();
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(host.notifications.at(-1).message, /not supported/);

  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{"text":"second"},"metadata":{}}'
    })
  );
  host.respond(async () => ({ contentId: '7', savedBytes: 5, deltaBytes: 5 }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 2, 'the rejected body is not sent again');
  assert.deepEqual(host.requests[1].body.params, { text: 'second' });
  assert.notEqual(
    host.requests[1].headers['idempotency-key'],
    host.requests[0].headers['idempotency-key'],
    'a new attempt is a new operation'
  );
  assert.equal(host.notifications.at(-1).type, 'saved');
});

test('an ambiguous save is replayed under its own key before newer input is sent', async () => {
  const host = await bridge();
  host.respond(async () => {
    throw new Error('network failure');
  });
  host.save();
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'error');

  host.serialize((submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{"text":"second"},"metadata":{}}'
    })
  );
  host.respond(async () => ({
    contentId: '7',
    revision: 'rev-1',
    savedBytes: 5,
    deltaBytes: 5
  }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 3);
  assert.equal(
    host.requests[1].headers['idempotency-key'],
    host.requests[0].headers['idempotency-key'],
    'the attempt whose outcome is unknown is replayed, not repeated as a new one'
  );
  assert.deepEqual(host.requests[1].body.params, {});
  assert.match(host.requests[1].url, /content\/new$/);
  assert.deepEqual(host.requests[2].body.params, { text: 'second' });
  assert.match(
    host.requests[2].url,
    /content\/7$/,
    'the id the replay resolved is used'
  );
  assert.equal(host.notifications.at(-1).type, 'saved');
});

test('a conflict preserves the authored revision so retry cannot overwrite unseen changes', async () => {
  const host = await bridge();
  host.respond(async () => ({
    contentId: '7',
    revision: 'rev-1',
    savedBytes: 5,
    deltaBytes: 5
  }));
  host.save();
  await host.tick();
  assert.equal(
    host.requests[0].headers['if-match'],
    undefined,
    'a new item matches nothing'
  );
  assert.equal(host.notifications.at(-1).type, 'saved');

  // Another window saved in the meantime.
  host.stored('rev-2');
  host.respond(async () =>
    rejected(409, { error: 'This content was changed in another editor.' })
  );
  host.save();
  await host.tick();
  assert.equal(host.requests[1].headers['if-match'], 'rev-1');
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.ok(
    !host.reads.some((url) => /content\/7\/edit$/.test(url)),
    'a conflict cannot silently adopt an unseen revision'
  );

  host.respond(async () => ({
    contentId: '7',
    revision: 'rev-3',
    savedBytes: 6,
    deltaBytes: 1
  }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 3, 'the conflicting body is not replayed');
  assert.equal(
    host.requests[2].headers['if-match'],
    'rev-1',
    'the host still rejects overwriting an unseen revision'
  );
  assert.equal(host.notifications.at(-1).type, 'saved');
});

test('superseded recovery cannot submit its old body after a newer attempt starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const deferred = [];
  host.respond(() => {
    const pending = Promise.withResolvers();
    deferred.push(pending);
    return pending.promise;
  });
  const edit = (text) =>
    host.serialize((submit) =>
      submit({
        library: 'H5P.Column 1.18',
        params: JSON.stringify({ params: { text }, metadata: {} })
      })
    );
  edit('A');
  host.save();
  t.mock.timers.tick(120001);
  edit('B');
  host.save();
  t.mock.timers.tick(120001);
  edit('C');
  host.save();
  deferred[2].resolve({
    contentId: '7',
    revision: 'rev-A',
    operationId: 'op-A'
  });
  await host.tick();
  assert.deepEqual(
    host.requests.map((r) => r.body.params.text),
    ['A', 'A', 'A', 'C']
  );
  deferred[1].resolve({
    contentId: '7',
    revision: 'rev-A',
    operationId: 'op-A'
  });
  await host.tick();
  assert.equal(host.requests.length, 4, 'the superseded B must not be sent');
  deferred[3].resolve({
    contentId: '7',
    revision: 'rev-C',
    operationId: 'op-C'
  });
  await host.tick();
  assert.equal(host.notifications.at(-1).operationId, 'op-C');
  deferred[0].resolve({
    contentId: '7',
    revision: 'rev-A',
    operationId: 'op-A'
  });
  await host.tick();
  assert.equal(host.notifications.at(-1).operationId, 'op-C');
});

test('an obsolete HTTP rejection cannot discard the current ambiguous operation key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const deferred = [];
  host.respond(() => {
    const pending = Promise.withResolvers();
    deferred.push(pending);
    return pending.promise;
  });
  host.save();
  t.mock.timers.tick(120001);
  host.save();
  const key = host.requests[1].headers['idempotency-key'];
  deferred[0].resolve(rejected(409));
  await host.tick();
  t.mock.timers.tick(120001);
  host.save();
  assert.equal(host.requests[2].headers['idempotency-key'], key);
  deferred[2].resolve({ contentId: '7', revision: 'rev-A' });
  deferred[1].resolve({ contentId: '7', revision: 'rev-A' });
  await host.tick();
});

test('a recovery answered after its attempt was superseded still resolves the id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const deferred = [];
  host.respond(() => {
    const pending = Promise.withResolvers();
    deferred.push(pending);
    return pending.promise;
  });
  const edit = (text) =>
    host.serialize((submit) =>
      submit({
        library: 'H5P.Column 1.18',
        params: JSON.stringify({ params: { text }, metadata: {} })
      })
    );
  edit('A');
  host.save();
  t.mock.timers.tick(120001);
  edit('B');
  host.save();
  assert.equal(host.requests.length, 2, 'B first replays the ambiguous A');
  t.mock.timers.tick(120001);
  // The third attempt is still inside the editor's serialization when the
  // replay finally answers, so it has not yet looked at the pending operation.
  let lateSubmit;
  host.serialize((submit) => {
    lateSubmit = submit;
  });
  host.save();
  const key = host.requests[1].headers['idempotency-key'];
  deferred[1].resolve({ contentId: '7', revision: 'rev-A' });
  await host.tick();
  lateSubmit({
    library: 'H5P.Column 1.18',
    params: JSON.stringify({ params: { text: 'C' }, metadata: {} })
  });
  await host.tick();
  assert.equal(
    host.requests[2].headers['idempotency-key'],
    key,
    'the settled key is replayed rather than a new item created'
  );
  deferred[2].resolve({ contentId: '7', revision: 'rev-A' });
  await host.tick();
  assert.equal(host.requests.length, 4);
  assert.match(
    host.requests[3].url,
    /content\/7$/,
    'the recovered id is used instead of a second /content/new'
  );
  assert.deepEqual(host.requests[3].body.params, { text: 'C' });
  deferred[3].resolve({ contentId: '7', revision: 'rev-C' });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(host.notifications.at(-1).contentId, '7');
});
