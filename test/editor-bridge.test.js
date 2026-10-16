const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { mixedUpgradeVersions } = require('./fixtures/upgrade-libraries');

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
  // `fetch(url, options)` below shadows the name.
  const bridgeOptions = options;
  const location = new URL(
    `https://host.example/h5p-editor-core/editor/${options.contentId || 'new'}${options.search || ''}`
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
  const scriptLoads = [];
  let listener;
  const iframeListeners = {};
  const iframeAjaxHandlers = {};
  let libraryWatchBindings = 0;
  let editorInstance;
  // `[library, serializedState]` of every `new ns.Editor(...)`.
  const editors = [];
  // Page elements by id, so a test can see what the bridge did to them
  // (`hidden`, `disabled`) and click them (`listeners`).
  const elements = {};
  let capturedOnIframeLoaded;
  let serialize = (submit) =>
    submit({
      library: 'H5P.Column 1.18',
      params: '{"params":{},"metadata":{}}'
    });
  let saveResponse = async () => ({
    contentId: '7',
    revision: 'rev-saved',
    savedBytes: 10,
    deltaBytes: 10
  });
  let revision = 'rev-1';
  const parent = {
    postMessage(message) {
      notifications.push(message);
    }
  };
  const element = {
    setAttribute() {},
    appendChild(child) {
      (this.children ||= []).push(child);
    },
    remove() {}
  };
  // The id of the element that last took the focus.
  const focused = {};
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
  function fireIframeLoaded(onIframeLoaded, reusedDocument) {
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
    // Enough of XMLHttpRequest for `watchEditorRequests`: a test ends a
    // request with `listeners.loadend()`, which runs every listener bound;
    // a second `send` of a running request throws, as a browser's does.
    function XMLHttpRequest() {
      this.handlers = {};
      this.listeners = {
        loadend: () => {
          this.active = false;
          (this.handlers.loadend || []).slice().forEach((fn) => fn());
        }
      };
    }
    XMLHttpRequest.prototype.addEventListener = function (type, fn) {
      (this.handlers[type] ||= []).push(fn);
    };
    XMLHttpRequest.prototype.removeEventListener = function (type, fn) {
      this.handlers[type] = (this.handlers[type] || []).filter(
        (handler) => handler !== fn
      );
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.active) throw new Error('InvalidStateError');
      this.active = true;
    };
    lastIframeWindow = {
      dialogs,
      XMLHttpRequest,
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
      // Every listener this document got, so a test can tell one binding
      // per load from bindings piling up; `iframeListeners` keeps the latest.
      document: reusedDocument || {
        listeners: {},
        addEventListener(type, fn) {
          (this.listeners[type] ||= []).push(fn);
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
      Editor: function (library, params, _mount, onIframeLoaded) {
        editorInstance = this;
        editors.push([library, params]);
        capturedOnIframeLoaded = onIframeLoaded;
        this.getContent = (...args) => serialize(...args);
        // What the form holds: by default what it was started with; a test
        // replaces `getParams` on `host.editor()` for input made since.
        this.getLibrary = () => library;
        this.getParams = () => (params ? JSON.parse(params) : undefined);
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
      getElementById: (id) =>
        (elements[id] ||= {
          ...element,
          listeners: {},
          addEventListener(type, fn) {
            this.listeners[type] = fn;
          },
          // Enough of `<dialog>` and its list for the upgrade dialog.
          open: false,
          showModal() {
            this.open = true;
          },
          close() {
            this.open = false;
            this.listeners.close?.();
          },
          replaceChildren(...children) {
            this.children = children;
          },
          focus() {
            focused.id = id;
          }
        }),
      createElement: () => ({ ...element }),
      // `loadScript`: runs the source `options.scripts` has for the URL in
      // this context, as a browser would run the script, or fails its load.
      // `null` is a request that never answers: neither event fires.
      head: {
        appendChild(script) {
          scriptLoads.push(script.src);
          const scriptSource = bridgeOptions.scripts?.[script.src];
          if (scriptSource === null) {
            return;
          }
          setImmediate(() => {
            if (scriptSource === undefined) {
              script.onerror?.();
              return;
            }
            vm.runInContext(scriptSource, context);
            script.onload?.();
          });
        }
      }
    },
    async fetch(url, options) {
      // The editor's AJAX `libraries` action: `options.libraries` by
      // ubername, a 404 otherwise.
      const libraryQuery =
        /[?&]action=libraries&machineName=([^&]+)&majorVersion=(\d+)&minorVersion=(\d+)/.exec(
          String(url)
        );
      if (libraryQuery) {
        reads.push(String(url));
        const data =
          bridgeOptions.libraries?.[
            `${decodeURIComponent(libraryQuery[1])} ${libraryQuery[2]}.${libraryQuery[3]}`
          ];
        return {
          ok: Boolean(data),
          status: data ? 200 : 404,
          text: async () => JSON.stringify(data || {})
        };
      }
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
        return {
          ok: true,
          status: 200,
          text: async () => value?.__raw ?? JSON.stringify(value)
        };
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
              ...(options.library ? { library: options.library } : {}),
              ...bridgeOptions.editModel?.h5p
            },
            ...(bridgeOptions.editModel?.missingLibraries
              ? { missingLibraries: bridgeOptions.editModel.missingLibraries }
              : {}),
            ...(bridgeOptions.editModel?.availableUpgrade !== undefined
              ? { availableUpgrade: bridgeOptions.editModel.availableUpgrade }
              : {})
          })
      };
    }
  });
  // The core scripts an upgrade loads refer to the bare global.
  context.H5P = window.H5P;
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
    scriptLoads,
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
    editors,
    /** The editor built last. */
    editor: () => editorInstance,
    element: (id) => elements[id],
    focused: () => focused.id,
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
    /**
     * A refill through `document.open()`: the same document comes back with
     * its listeners erased, as the HTML spec has it.
     */
    refillIframe() {
      const { document } = lastIframeWindow;
      document.listeners = {};
      for (const type of Object.keys(iframeListeners)) {
        delete iframeListeners[type];
      }
      fireIframeLoaded(capturedOnIframeLoaded, document);
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
  pending.resolve({
    contentId: '7',
    revision: 'rev-saved',
    savedBytes: 10,
    deltaBytes: 10
  });
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
  host.respond(async () => ({ contentId: '7', revision: 'rev-saved' }));
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

test('each form-iframe load binds the input listeners once, on its own document', async () => {
  const host = await bridge();
  const first = host.iframeWindow().document;
  host.reloadIframe();
  const second = host.iframeWindow().document;
  assert.notEqual(second, first);
  for (const [name, doc] of [
    ['first', first],
    ['reloaded', second]
  ]) {
    for (const type of ['input', 'change', 'drop']) {
      assert.equal(doc.listeners[type]?.length, 1, `${name} document, ${type}`);
    }
  }
});

test('a form iframe refilled through document.open() gets its input listeners back', async () => {
  const host = await bridge();
  const document = host.iframeWindow().document;
  host.refillIframe();
  assert.equal(host.iframeWindow().document, document);
  for (const type of ['input', 'change', 'drop']) {
    assert.equal(document.listeners[type]?.length, 1, type);
  }
  host.edit();
  assert.equal(
    host.notifications.filter((message) => message.type === 'changed').length,
    1
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
  first.resolve({
    contentId: '7',
    revision: 'rev-saved',
    savedBytes: 10,
    deltaBytes: 10
  });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saving');
  second.resolve({
    contentId: '8',
    revision: 'rev-saved',
    savedBytes: 10,
    deltaBytes: 10
  });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(host.notifications.at(-1).contentId, '8');
  host.respond(async () => ({ contentId: '8', revision: 'rev-saved' }));
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
  late.resolve({
    contentId: '7',
    revision: 'rev-saved',
    savedBytes: 10,
    deltaBytes: 10
  });
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
  assert.equal(host.notifications.at(-1).contentId, '7');
  host.respond(async () => ({ contentId: '7', revision: 'rev-saved' }));
  host.save();
  await host.tick();
  assert.equal(host.requests.length, 2);
  assert.match(
    host.requests[1].url,
    /content\/7$/,
    'the adopted id is updated, not created again'
  );
});

test('edits after an HTTP timeout remain dirty when the late answer arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const late = Promise.withResolvers();
  host.respond(() => late.promise);
  host.edit();
  host.save();
  t.mock.timers.tick(120_000);
  host.edit();
  late.resolve({ contentId: '7', revision: 'old-snapshot' });
  await host.tick();
  assert.deepEqual(
    host.notifications.slice(-2).map((m) => m.type),
    ['saved', 'changed']
  );
  host.respond(async () => ({ contentId: '7', revision: 'rev-saved' }));
  host.save();
  await host.tick();
  assert.equal(host.notifications.at(-1).type, 'saved');
});

test('input during serialization is reported even if the editor never calls back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  host.serialize(() => {});
  host.save();
  host.edit();
  assert.equal(host.notifications.at(-1).type, 'changed');
  t.mock.timers.tick(60_000);
  assert.deepEqual(
    host.notifications.slice(-2).map((m) => m.type),
    ['changed', 'error']
  );
});

test('input in a clean editor is reported while the HTTP save is still pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await bridge();
  const late = Promise.withResolvers();
  host.respond(() => late.promise);
  host.save();
  host.edit();
  assert.equal(host.notifications.at(-1).type, 'changed');
  t.mock.timers.tick(120_000);
  assert.equal(host.notifications.at(-1).type, 'error');
  late.resolve({ contentId: '7', revision: 'old-snapshot' });
  await host.tick();
  assert.deepEqual(
    host.notifications.slice(-2).map((m) => m.type),
    ['saved', 'changed']
  );
  host.respond(async () => ({ contentId: '7', revision: 'new-snapshot' }));
  host.save();
  await host.tick();
  assert.equal(host.requests[1].headers['if-match'], 'old-snapshot');
  assert.equal(host.notifications.at(-1).type, 'saved');
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
  assert.equal(
    changes().length,
    1,
    'an already dirty editor needs no duplicate report'
  );
  pending.resolve({
    contentId: '7',
    revision: 'rev-saved',
    savedBytes: 10,
    deltaBytes: 10
  });
  await host.tick();
  const types = host.notifications.map((message) => message.type);
  assert.deepEqual(
    types.slice(-2),
    ['saved', 'changed'],
    'edits outside the saved snapshot are reported again'
  );
  assert.equal(changes()[1].contentId, '7');

  host.respond(async () => ({ contentId: '7', revision: 'rev-saved' }));
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

const invalidSaveReplies = [
  ['HTML', '<html>Sign in again</html>'],
  ['empty body', ''],
  ['truncated JSON', '{"contentId":'],
  ['missing contentId', '{}'],
  ['null', 'null'],
  ['array', '[]'],
  ['scalar', '"7"'],
  ['null contentId', '{"contentId":null}'],
  ['numeric contentId', '{"contentId":7}'],
  ['empty contentId', '{"contentId":""}'],
  ['unsafe contentId', '{"contentId":"../7"}'],
  ['contentId with whitespace', JSON.stringify({ contentId: '7\n' })],
  // Every save answer and journal replay carries a revision; one without it
  // would leave the next save with no If-Match, free to overwrite another
  // author's write.
  ['missing revision', '{"contentId":"7"}'],
  ['null revision', '{"contentId":"7","revision":null}'],
  ['numeric revision', '{"contentId":"7","revision":9}'],
  ['empty revision', '{"contentId":"7","revision":""}'],
  // The first two would reach the host as an empty If-Match (fetch trims
  // the header, the host strips the quotes), which cannot match stored
  // content; inner whitespace is no token the host ever issues either, and a
  // NUL cannot be sent as a header value at all: adopting one would fail
  // every later save until the page is reloaded. Non-ASCII is refused by the
  // bridge's own printable-ASCII rule.
  ['blank revision', '{"contentId":"7","revision":" "}'],
  ['quotes-only revision', JSON.stringify({ contentId: '7', revision: '""' })],
  ['revision with whitespace', '{"contentId":"7","revision":"a b"}'],
  [
    'revision with a control character',
    '{"contentId":"7","revision":"\\u0000"}'
  ],
  ['non-ASCII revision', '{"contentId":"7","revision":"r\\u00e9v"}']
];

for (const [name, reply] of invalidSaveReplies) {
  test(`a 200 save response with ${name} keeps edits and the operation replayable`, async () => {
    const host = await bridge();
    host.edit();
    host.respond(async () => ({ __raw: reply }));
    host.save();
    await host.tick();
    assert.equal(host.notifications.at(-1).type, 'error');
    assert.match(host.notifications.at(-1).message, /invalid save response/i);
    assert.equal(
      host.notifications.some((m) => m.type === 'saved'),
      false
    );
    host.edit();
    assert.equal(
      host.notifications.filter((m) => m.type === 'changed').length,
      1,
      'the editor remains dirty after an unconfirmed save'
    );

    host.respond(async () => ({ contentId: '7', revision: 'rev-recovered' }));
    host.save();
    await host.tick();
    assert.deepEqual(host.requests[1], host.requests[0]);
    assert.equal(host.notifications.at(-1).type, 'saved');
    assert.equal(host.notifications.at(-1).contentId, '7');
    host.save();
    await host.tick();
    assert.match(host.requests[2].url, /content\/7$/);
    assert.equal(host.requests[2].headers['if-match'], 'rev-recovered');
    assert.notEqual(
      host.requests[2].headers['idempotency-key'],
      host.requests[0].headers['idempotency-key']
    );
  });
}

for (const reply of [
  '<html>Sign in again</html>',
  '{}',
  '{"contentId":"7"}',
  '{"contentId":"7","revision":7}',
  '{"contentId":"7","revision":" "}',
  JSON.stringify({ contentId: '7', revision: '""' }),
  '{"contentId":"7","revision":"a b"}',
  '{"contentId":"7","revision":"\\u0000"}'
]) {
  test(`invalid recovery response ${reply} cannot submit newer edits or advance the revision`, async () => {
    const host = await bridge();
    host.respond(async () => ({ contentId: '7', revision: 'rev-before' }));
    host.save();
    await host.tick();
    host.edit();
    host.respond(async () => {
      throw new Error('connection lost after commit');
    });
    host.save();
    await host.tick();
    const original = host.requests[1];
    host.edit();
    host.serialize((submit) =>
      submit({
        library: 'H5P.Column 1.18',
        params: '{"params":{"text":"newer"},"metadata":{}}'
      })
    );
    host.respond(async () => ({ __raw: reply }));
    host.save();
    await host.tick();
    assert.equal(host.notifications.at(-1).type, 'error');
    assert.match(host.notifications.at(-1).message, /invalid save response/i);
    assert.equal(
      host.requests.length,
      3,
      'newer edits wait for a valid receipt'
    );
    assert.deepEqual(host.requests[2], original);

    let replies = 0;
    host.respond(async () => ({
      contentId: '7',
      revision: ++replies === 1 ? 'rev-recovered' : 'rev-newer'
    }));
    host.save();
    await host.tick();
    assert.deepEqual(host.requests[3], original);
    assert.equal(host.requests[3].headers['if-match'], 'rev-before');
    assert.equal(host.requests.length, 5);
    assert.equal(host.requests[4].headers['if-match'], 'rev-recovered');
    assert.deepEqual(host.requests[4].body.params, { text: 'newer' });
    assert.equal(host.notifications.at(-1).type, 'saved');
  });
}

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
  assert.equal(saved.revision, 'rev-9');
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
  host.respond(async () => ({
    contentId: '7',
    revision: 'rev-saved',
    savedBytes: 5,
    deltaBytes: 5
  }));
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

test('a refused save reports the status and the host code to the parent', async () => {
  const host = await bridge();
  // A conflict: the host names no code, so the DTO carries only the status.
  host.respond(async () =>
    rejected(409, {
      error: 'This content was changed in another editor. Reload before saving.'
    })
  );
  host.save();
  await host.tick();
  let error = host.notifications.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.status, 409);
  assert.equal('code' in error, false, 'no code is invented for a 409');
  assert.match(error.message, /changed in another editor/);

  // A verdict the embedder branches on by code.
  host.respond(async () =>
    rejected(422, {
      error: 'Import the exam package before saving.',
      code: 'exam-import-required'
    })
  );
  host.save();
  await host.tick();
  error = host.notifications.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.status, 422);
  assert.equal(error.code, 'exam-import-required');
  assert.match(error.message, /Import the exam package/);

  // A code that is not a string is not forwarded.
  host.respond(async () => rejected(500, { error: 'boom', code: 42 }));
  host.save();
  await host.tick();
  error = host.notifications.at(-1);
  assert.equal(error.status, 500);
  assert.equal('code' in error, false);

  // No answer from the host: nothing to report but the message.
  host.respond(async () => {
    throw new Error('network failure');
  });
  host.save();
  await host.tick();
  error = host.notifications.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.message, 'network failure');
  assert.equal('status' in error, false);
  assert.equal('code' in error, false);

  // A transport exception's own code (a DOMException's number, a platform
  // string) is not a host code: without a status nothing but the message.
  for (const code of [20, 'ECONNRESET']) {
    host.respond(async () => {
      throw Object.assign(new Error('request aborted'), { code });
    });
    host.save();
    await host.tick();
    error = host.notifications.at(-1);
    assert.equal(error.type, 'error');
    assert.equal('status' in error, false);
    assert.equal('code' in error, false);
  }
});

for (const status of [401, 403]) {
  for (const existing of [false, true]) {
    for (const changed of [false, true]) {
      test(`an ambiguous ${existing ? 'update' : 'create'} survives ${status} with ${changed ? 'newer' : 'unchanged'} input`, async () => {
        const host = await bridge();
        if (existing) {
          host.respond(async () => ({
            contentId: '7',
            revision: 'rev-before'
          }));
          host.save();
          await host.tick();
        }
        const offset = host.requests.length;
        host.edit();
        host.respond(async () => {
          // The server committed this snapshot, but its reply never arrived.
          throw new Error('connection lost after commit');
        });
        host.save();
        await host.tick();
        const original = host.requests[offset];
        if (changed) {
          host.edit();
          host.serialize((submit) =>
            submit({
              library: 'H5P.Column 1.18',
              params: '{"params":{"text":"newer"},"metadata":{}}'
            })
          );
        }
        host.respond(async () =>
          rejected(status, { error: 'Authentication required.' })
        );
        for (let retry = 0; retry < 2; retry += 1) {
          host.save();
          await host.tick();
          assert.equal(host.notifications.at(-1).type, 'error');
          assert.deepEqual(host.requests.at(-1), original);
        }
        let replies = 0;
        host.respond(async () => ({
          contentId: '7',
          revision: ++replies === 1 ? 'rev-recovered' : 'rev-newer'
        }));
        host.save();
        await host.tick();
        assert.deepEqual(
          host.requests[offset + 3],
          original,
          'reauthentication replays the exact target, key, body and revision'
        );
        assert.equal(replies, changed ? 2 : 1);
        if (changed) {
          const update = host.requests.at(-1);
          assert.match(update.url, /content\/7$/);
          assert.equal(update.headers['if-match'], 'rev-recovered');
          assert.notEqual(
            update.headers['idempotency-key'],
            original.headers['idempotency-key']
          );
          assert.deepEqual(update.body.params, { text: 'newer' });
        }
        assert.equal(host.notifications.at(-1).type, 'saved');
        assert.equal(host.notifications.at(-1).contentId, '7');
      });
    }
  }
}

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

test('ready carries the revision actually loaded into the editor', async () => {
  const host = await bridge({ contentId: '7', revision: 'rev-saved' });
  assert.equal(host.notifications[0].type, 'ready');
  assert.equal(host.notifications[0].revision, 'rev-1');
});

// Stored content on library versions the host does not have (the edit model's
// `missingLibraries`): a book on H5P.Book 1.0 whose chapter is an H5P.Col 1.0,
// where only Book 1.2 and Col 1.1 are installed. The upgrade runs the real
// core `h5p-version.js` and `h5p-content-upgrade-process.js`.
const CORE_JS = path.join(__dirname, '../assets/h5p/core/js');
function outdatedBook({
  acceptedColumn = 'H5P.Col 1.1',
  library = 'H5P.Book 1.0',
  missing
} = {}) {
  return {
    contentId: '7',
    expectReady: false,
    editModel: {
      h5p: {
        integration: {
          libraryUrl: '/h5p/core/js',
          pluginCacheBuster: '?v=1',
          editor: { assets: {}, ajaxPath: '/h5p/ajax?action=' }
        },
        library,
        params: {
          chapters: [{ library: 'H5P.Col 1.0', params: { text: 'a' } }]
        },
        metadata: { title: 'Book' }
      },
      missingLibraries: missing || [
        { library: 'H5P.Book 1.0', upgrade: 'H5P.Book 1.2' },
        { library: 'H5P.Col 1.0', upgrade: 'H5P.Col 1.1' }
      ]
    },
    libraries: {
      'H5P.Book 1.2': {
        name: 'H5P.Book',
        version: { major: 1, minor: 2 },
        semantics: [
          {
            name: 'chapters',
            type: 'list',
            field: {
              name: 'chapter',
              type: 'library',
              options: [acceptedColumn]
            }
          }
        ],
        upgradesScript: '/h5p/libraries/H5P.Book-1.2/upgrades.js'
      },
      'H5P.Col 1.1': {
        name: 'H5P.Col',
        version: { major: 1, minor: 1 },
        semantics: [{ name: 'text', type: 'text' }],
        upgradesScript: null
      }
    },
    scripts: {
      '/h5p/core/js/h5p-version.js?v=1': fs.readFileSync(
        path.join(CORE_JS, 'h5p-version.js'),
        'utf8'
      ),
      '/h5p/core/js/h5p-content-upgrade-process.js?v=1': fs.readFileSync(
        path.join(CORE_JS, 'h5p-content-upgrade-process.js'),
        'utf8'
      ),
      // Hooks for 1.1 and 1.2: both run, the stored 1.0 being older than both.
      '/h5p/libraries/H5P.Book-1.2/upgrades.js': `
        var H5PUpgrades = H5PUpgrades || {};
        H5PUpgrades['H5P.Book'] = {
          1: {
            1: function (params, finished) { params.steps = ['1.1']; finished(null, params); },
            2: function (params, finished, extras) {
              params.steps.push('1.2');
              finished(null, params, { metadata: { ...extras.metadata, upgraded: true } });
            }
          }
        };`
    }
  };
}

async function waitForError(host) {
  await waitForNotification(host.notifications, (m) => m.type === 'error');
  return host.notifications.find((m) => m.type === 'error');
}

test('content on missing library versions builds no editor and offers the upgrade', async () => {
  const host = await bridge(outdatedBook());
  const error = await waitForError(host);
  assert.equal(error.code, 'library-missing');
  // The revision lets the parent replace the content by an import pinned to it.
  assert.equal(error.revision, 'rev-1');
  // Versions that are not installed: the player and download fail as well.
  assert.equal(error.notInstalled, true);
  assert.match(error.message, /H5P\.Book 1\.0, H5P\.Col 1\.0/);
  assert.match(error.message, /H5P\.Book 1\.2, H5P\.Col 1\.1/);
  assert.equal(host.editors.length, 0);
  // The dialog lists each version with the one it is upgraded to.
  const dialog = host.element('host-upgrade');
  assert.equal(dialog.open, true);
  assert.deepEqual(
    host.element('host-upgrade-list').children.map((item) => item.textContent),
    ['H5P.Book 1.0 → H5P.Book 1.2', 'H5P.Col 1.0 → H5P.Col 1.1']
  );
  assert.equal(host.element('host-upgrade-button').hidden, false);
  assert.equal(host.focused(), 'host-upgrade-button');
  assert.ok(!host.notifications.some((m) => m.type === 'ready'));
  host.save();
  assert.match(host.notifications.at(-1).message, /not ready/);
});

test('without a newer installed version the content is not upgradable', async () => {
  const host = await bridge(
    outdatedBook({
      missing: [{ library: 'H5P.Book 1.0', upgrade: null }]
    })
  );
  const error = await waitForError(host);
  assert.equal(error.code, 'library-missing');
  assert.match(error.message, /No newer installed version/);
  // The dialog explains, with no button to upgrade.
  assert.equal(host.element('host-upgrade').open, true);
  assert.equal(host.element('host-upgrade-button').hidden, true);
  assert.deepEqual(
    host.element('host-upgrade-list').children.map((item) => item.textContent),
    ['H5P.Book 1.0 — no newer version installed']
  );
  assert.equal(host.focused(), 'host-upgrade-close');
  host.element('host-upgrade-close').listeners.click();
  assert.equal(host.element('host-upgrade').open, false);
  assert.notEqual(host.element('host-upgrade-reopen')?.hidden, false);
});

test('closing the upgrade dialog builds no editor and lets the author reopen it', async () => {
  const host = await bridge(outdatedBook());
  await waitForError(host);
  const dialog = host.element('host-upgrade');
  const reopen = host.element('host-upgrade-reopen');
  const cancel = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    }
  };
  dialog.listeners.cancel(cancel);
  assert.equal(cancel.defaultPrevented, false);
  host.element('host-upgrade-close').listeners.click();
  assert.equal(dialog.open, false);
  assert.equal(reopen.hidden, false);
  assert.equal(host.editors.length, 0);
  // The empty editor area does not push the message out of view.
  assert.equal(host.element('h5p-editor-root').hidden, true);
  host.save();
  assert.match(host.notifications.at(-1).message, /not ready/);
  reopen.listeners.click();
  assert.equal(dialog.open, true);
  assert.equal(reopen.hidden, true);
});

test('the upgrade dialog cannot be closed while the upgrade runs', async () => {
  const options = outdatedBook();
  // The core's upgrade script never answers: the upgrade keeps running.
  options.scripts['/h5p/core/js/h5p-content-upgrade-process.js?v=1'] = null;
  const host = await bridge(options);
  await waitForError(host);
  const dialog = host.element('host-upgrade');
  const button = host.element('host-upgrade-button');
  void button.listeners.click();
  await host.tick();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Upgrading…');
  assert.equal(host.element('host-upgrade-close').disabled, true);
  const cancel = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    }
  };
  dialog.listeners.cancel(cancel);
  assert.equal(cancel.defaultPrevented, true);
  host.element('host-upgrade-close').listeners.click();
  assert.equal(dialog.open, true);
});

test('the upgrade runs the library upgrade hooks, replaces nested versions and opens the result unsaved', async () => {
  const host = await bridge(outdatedBook());
  await waitForError(host);
  await host.element('host-upgrade-button').listeners.click();
  // Content that names a library is ready once its form exists too.
  await host.tick();
  host.appearForm();
  await waitForNotification(host.notifications, (m) => m.type === 'ready');
  await waitForNotification(host.notifications, (m) => m.type === 'changed');
  assert.equal(host.editors.length, 1);
  const [library, state] = host.editors[0];
  assert.equal(library, 'H5P.Book 1.2');
  assert.deepEqual(JSON.parse(state), {
    params: {
      chapters: [{ library: 'H5P.Col 1.1', params: { text: 'a' } }],
      steps: ['1.1', '1.2']
    },
    metadata: { title: 'Book', upgraded: true }
  });
  assert.equal(host.element('host-upgrade').open, false);
  assert.equal(host.element('host-upgrade-reopen').hidden, true);
  assert.equal(host.element('h5p-editor-root').hidden, false);
  const types = host.notifications.map((m) => m.type);
  assert.deepEqual(types.slice(types.indexOf('ready')), ['ready', 'changed']);
  // Nothing is written until the author saves.
  assert.equal(host.requests.length, 0);
  host.save();
  await waitForNotification(host.notifications, (m) => m.type === 'saved');
  assert.equal(host.requests[0].headers['if-match'], 'rev-1');
});

test('an installed version its container no longer accepts is upgraded without changing the container', async () => {
  // A patch of the installed book (still 1.2) replaced the column 1.0 in its
  // chapter field by 1.1. The editor would clear the chapter; the page offers
  // the upgrade instead, which keeps the book on 1.2 and runs none of its
  // hooks.
  const host = await bridge(
    outdatedBook({
      library: 'H5P.Book 1.2',
      missing: [
        {
          library: 'H5P.Col 1.0',
          upgrade: 'H5P.Col 1.1',
          reason: 'not-accepted'
        }
      ]
    })
  );
  const error = await waitForError(host);
  assert.equal(error.code, 'library-missing');
  // Every version is installed: only the editor is blocked.
  assert.equal(error.notInstalled, false);
  assert.match(
    error.message,
    /^This content uses library versions that the installed content types no longer accept: H5P\.Col 1\.0\. Upgrade it to the installed H5P\.Col 1\.1 /
  );
  assert.equal(host.editors.length, 0);
  const [item] = host.element('host-upgrade-list').children;
  assert.equal(item.textContent, 'H5P.Col 1.0 → H5P.Col 1.1');
  assert.equal(
    item.children[0].textContent,
    ' (no longer accepted by the installed content type)'
  );
  await host.element('host-upgrade-button').listeners.click();
  await host.tick();
  host.appearForm();
  await waitForNotification(host.notifications, (m) => m.type === 'ready');
  const [library, state] = host.editors[0];
  assert.equal(library, 'H5P.Book 1.2');
  assert.deepEqual(JSON.parse(state), {
    params: { chapters: [{ library: 'H5P.Col 1.1', params: { text: 'a' } }] },
    metadata: { title: 'Book' }
  });
});

test('one version that is not installed among unaccepted ones marks the content not installed', async () => {
  const host = await bridge(
    outdatedBook({
      missing: [
        { library: 'H5P.Book 1.0', upgrade: 'H5P.Book 1.2' },
        {
          library: 'H5P.Col 1.0',
          upgrade: 'H5P.Col 1.1',
          reason: 'not-accepted'
        }
      ]
    })
  );
  const error = await waitForError(host);
  assert.equal(error.code, 'library-missing');
  assert.equal(error.notInstalled, true);
});

test('a version one field no longer accepts may stay where another field still does', async () => {
  // The book's chapter field moved to column 1.1, its appendix field still
  // takes 1.0: after the upgrade 1.0 is still used, legitimately.
  const options = outdatedBook({
    library: 'H5P.Book 1.2',
    missing: [
      { library: 'H5P.Col 1.0', upgrade: 'H5P.Col 1.1', reason: 'not-accepted' }
    ]
  });
  options.editModel.h5p.params.appendix = {
    library: 'H5P.Col 1.0',
    params: { text: 'b' }
  };
  options.libraries['H5P.Book 1.2'].semantics.push({
    name: 'appendix',
    type: 'library',
    options: ['H5P.Col 1.0']
  });
  const host = await bridge(options);
  await waitForError(host);
  await host.element('host-upgrade-button').listeners.click();
  await host.tick();
  host.appearForm();
  await waitForNotification(host.notifications, (m) => m.type === 'ready');
  assert.deepEqual(JSON.parse(host.editors[0][1]).params, {
    chapters: [{ library: 'H5P.Col 1.1', params: { text: 'a' } }],
    appendix: { library: 'H5P.Col 1.0', params: { text: 'b' } }
  });
});

test('an installed version no version of which its container accepts is not upgradable', async () => {
  // The field names no version of the column at all: nothing can replace it,
  // and the chapter is kept by building no editor.
  const host = await bridge(
    outdatedBook({
      library: 'H5P.Book 1.2',
      acceptedColumn: 'H5P.Other 1.0',
      missing: [
        {
          library: 'H5P.Col 1.0',
          upgrade: null,
          reason: 'not-accepted'
        }
      ]
    })
  );
  const error = await waitForError(host);
  assert.equal(error.code, 'library-missing');
  assert.match(error.message, /no longer accept: H5P\.Col 1\.0\. No newer/);
  assert.equal(host.element('host-upgrade-button').hidden, true);
  assert.equal(host.editors.length, 0);
});

test('an upgrade that leaves a missing version in place fails and can be retried', async () => {
  // The installed book still names the missing column version. The column
  // nests no library, so the upgrade leaves it alone and the check of the
  // upgraded parameters finds it.
  const host = await bridge(outdatedBook({ acceptedColumn: 'H5P.Col 1.0' }));
  await waitForError(host);
  const button = host.element('host-upgrade-button');
  await button.listeners.click();
  const failure = host.notifications.at(-1);
  assert.equal(failure.type, 'error');
  assert.equal(failure.code, 'library-upgrade-failed');
  assert.equal(failure.revision, 'rev-1');
  assert.match(
    failure.message,
    /H5P\.Col 1\.0 could not be replaced: the installed H5P\.Book 1\.2 accepts no installed version of it\./
  );
  assert.equal(button.disabled, false);
  assert.equal(host.editors.length, 0);
  // The dialog stays open and says why.
  assert.equal(host.element('host-upgrade').open, true);
  const shown = host.element('host-upgrade-error');
  assert.equal(shown.hidden, false);
  assert.equal(shown.textContent, failure.message);
  assert.equal(host.focused(), 'host-upgrade-button');
  // Reopened, the dialog starts afresh; the page keeps the failure.
  host.element('host-upgrade-close').listeners.click();
  host.element('host-upgrade-reopen').listeners.click();
  assert.equal(shown.hidden, true);
});

test('a missing version left in place fails when the upgrade has to load it', async () => {
  // As above, but the column nests a library, so the upgrade walks into it
  // and asks for the missing version's data.
  const options = outdatedBook({ acceptedColumn: 'H5P.Col 1.0' });
  options.editModel.h5p.params = {
    chapters: [
      {
        library: 'H5P.Col 1.0',
        params: { text: { library: 'H5P.Txt 1.0', params: {} } }
      }
    ]
  };
  const host = await bridge(options);
  await waitForError(host);
  await host.element('host-upgrade-button').listeners.click();
  assert.match(
    host.notifications.at(-1).message,
    /H5P\.Col 1\.0 could not be replaced: an installed library accepts no newer version of it\./
  );
  assert.equal(host.editors.length, 0);
});

test('a library that cannot be loaded fails the upgrade with its name', async () => {
  const options = outdatedBook();
  delete options.libraries['H5P.Col 1.1'];
  const host = await bridge(options);
  await waitForError(host);
  await host.element('host-upgrade-button').listeners.click();
  assert.match(
    host.notifications.at(-1).message,
    /could not be upgraded: Could not load data for library H5P\.Col 1\.1/
  );
});

test('a library load failure reports the revision the page read', async () => {
  const host = await bridge({
    contentId: '7',
    controlReadiness: true,
    expectReady: false
  });
  host.libraryAjaxError(404);
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.equal(host.notifications.at(-1).revision, 'rev-1');
});

// The patched core (assets/h5p/patches/core/0003-…): an upgrade across a
// major version runs the hooks of every step, not only those whose minor
// number falls between the two minors.
test('an upgrade across a major version runs every intermediate upgrade hook', async () => {
  const options = outdatedBook({
    missing: [
      { library: 'H5P.Book 1.9', upgrade: 'H5P.Book 2.0' },
      { library: 'H5P.Col 1.0', upgrade: 'H5P.Col 1.1' }
    ]
  });
  options.editModel.h5p.library = 'H5P.Book 1.9';
  options.libraries['H5P.Book 2.0'] = {
    ...options.libraries['H5P.Book 1.2'],
    version: { major: 2, minor: 0 },
    upgradesScript: '/h5p/libraries/H5P.Book-2.0/upgrades.js'
  };
  delete options.libraries['H5P.Book 1.2'];
  // 1.9 is the stored version: its hook ran when the content reached it.
  options.scripts['/h5p/libraries/H5P.Book-2.0/upgrades.js'] = `
    var H5PUpgrades = H5PUpgrades || {};
    H5PUpgrades['H5P.Book'] = {
      1: {
        9: function (params, finished) { params.steps = ['1.9']; finished(null, params); },
        10: function (params, finished) { params.steps = (params.steps || []).concat('1.10'); finished(null, params); }
      },
      2: {
        0: function (params, finished) { params.steps = (params.steps || []).concat('2.0'); finished(null, params); }
      }
    };`;
  const host = await bridge(options);
  await waitForError(host);
  await host.element('host-upgrade-button').listeners.click();
  assert.equal(host.editors.length, 1, host.notifications.at(-1).message);
  const [library, state] = host.editors[0];
  assert.equal(library, 'H5P.Book 2.0');
  assert.deepEqual(JSON.parse(state).params, {
    chapters: [{ library: 'H5P.Col 1.1', params: { text: 'a' } }],
    steps: ['1.10', '2.0']
  });
});

// The patched core, second part: a nested library already on the version the
// container accepts is walked into, so what is nested in *it* is upgraded too.
test('a missing version nested in a container on its current version is upgraded', async () => {
  const options = outdatedBook({
    acceptedColumn: 'H5P.Col 1.1',
    missing: [
      { library: 'H5P.Book 1.0', upgrade: 'H5P.Book 1.2' },
      { library: 'H5P.Txt 1.0', upgrade: 'H5P.Txt 1.2' }
    ]
  });
  // The chapter column is installed; the text inside it is not.
  options.editModel.h5p.params = {
    chapters: [
      {
        library: 'H5P.Col 1.1',
        params: { text: { library: 'H5P.Txt 1.0', params: { v: 'a' } }, w: 'x' }
      }
    ]
  };
  options.libraries['H5P.Col 1.1'].semantics = [
    { name: 'text', type: 'library', options: ['H5P.Txt 1.2'] },
    { name: 'w', type: 'text' }
  ];
  options.libraries['H5P.Txt 1.2'] = {
    name: 'H5P.Txt',
    version: { major: 1, minor: 2 },
    semantics: [{ name: 'v', type: 'text' }],
    upgradesScript: null
  };
  const host = await bridge(options);
  await waitForError(host);
  await host.element('host-upgrade-button').listeners.click();
  assert.equal(host.editors.length, 1, host.notifications.at(-1).message);
  const [library, state] = host.editors[0];
  assert.equal(library, 'H5P.Book 1.2');
  assert.deepEqual(JSON.parse(state).params.chapters, [
    {
      library: 'H5P.Col 1.1',
      params: { text: { library: 'H5P.Txt 1.2', params: { v: 'a' } }, w: 'x' }
    }
  ]);
});

test('the upgrade deadline covers the core scripts it loads first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = outdatedBook();
  // The core's version script never arrives.
  options.scripts['/h5p/core/js/h5p-version.js?v=1'] = null;
  const host = await bridge(options);
  await waitForError(host);
  const button = host.element('host-upgrade-button');
  const clicked = button.listeners.click();
  await host.tick();
  assert.equal(button.disabled, true);
  t.mock.timers.tick(59_999);
  await host.tick();
  assert.equal(button.disabled, true);
  t.mock.timers.tick(1);
  await clicked;
  const failure = host.notifications.at(-1);
  assert.equal(failure.type, 'error');
  assert.equal(failure.code, 'library-upgrade-failed');
  assert.match(failure.message, /did not finish in time/);
  assert.equal(button.disabled, false);
  assert.equal(host.editors.length, 0);
});

// The patched core, third part (0004): the walk continues between steps in
// microtasks. Browsers give nested timers a 4 ms minimum, and one timer per
// step made a book of a few thousand fields take tens of seconds.
test('an upgrade steps through the content without waiting on timers', async (t) => {
  const host = await bridge(outdatedBook());
  await waitForError(host);
  // From here on no timer fires (the harness's own waits use setImmediate).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  host
    .element('host-upgrade-button')
    .listeners.click()
    .then(() => {
      settled = true;
    });
  for (let turn = 0; turn < 100 && !settled; turn += 1) {
    await host.tick();
  }
  assert.ok(settled, 'the upgrade waited for a timer');
  assert.equal(host.editors.length, 1, host.notifications.at(-1).message);
});

test('a long upgrade still lets a timer run every 256 steps', async (t) => {
  const options = outdatedBook();
  // Hundreds of chapters: several hundred steps of the walk.
  options.editModel.h5p.params = {
    chapters: Array.from({ length: 300 }, () => ({
      library: 'H5P.Col 1.0',
      params: { text: 'a' }
    }))
  };
  const host = await bridge(options);
  await waitForError(host);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  host
    .element('host-upgrade-button')
    .listeners.click()
    .then(() => {
      settled = true;
    });
  for (let turn = 0; turn < 100 && !settled; turn += 1) {
    await host.tick();
  }
  assert.equal(settled, false, 'the walk never yielded to a timer');
  // Each yield is one timer; the upgrade's own 60 s deadline stays far off.
  let yields = 0;
  while (!settled && yields < 50) {
    t.mock.timers.tick(1);
    yields += 1;
    for (let turn = 0; turn < 20 && !settled; turn += 1) {
      await host.tick();
    }
  }
  assert.ok(settled, 'the upgrade did not finish');
  assert.ok(yields >= 3, `only ${yields} yields`);
  assert.equal(host.editors.length, 1, host.notifications.at(-1).message);
  assert.equal(JSON.parse(host.editors[0][1]).params.chapters.length, 300);
});

test('an upgrade does not load a library on its current version that nests none', async () => {
  const options = outdatedBook({
    missing: [{ library: 'H5P.Book 1.0', upgrade: 'H5P.Book 1.2' }]
  });
  // The chapter column is on the version the book accepts and holds no other
  // library: there is nothing in it to upgrade.
  options.editModel.h5p.params = {
    chapters: [{ library: 'H5P.Col 1.1', params: { text: 'a' } }]
  };
  const host = await bridge(options);
  await waitForError(host);
  await host.element('host-upgrade-button').listeners.click();
  assert.equal(host.editors.length, 1, host.notifications.at(-1).message);
  assert.deepEqual(JSON.parse(host.editors[0][1]).params.chapters, [
    { library: 'H5P.Col 1.1', params: { text: 'a' } }
  ]);
  assert.ok(host.reads.some((url) => url.includes('machineName=H5P.Book')));
  assert.ok(!host.reads.some((url) => url.includes('machineName=H5P.Col')));
});

// The patched core, fourth part (0005): errorNotSupported names the library
// instead of "H5P.Row undefined".
test('a nested library the installed container does not accept is named in the failure', async () => {
  const options = outdatedBook({
    missing: [{ library: 'H5P.Book 1.0', upgrade: 'H5P.Book 1.2' }]
  });
  // The installed book accepts only H5P.Col 1.1 as a chapter.
  options.editModel.h5p.params = {
    chapters: [{ library: 'H5P.Row 1.0', params: {} }]
  };
  const host = await bridge(options);
  await waitForError(host);
  await host.element('host-upgrade-button').listeners.click();
  const failure = host.notifications.at(-1);
  assert.equal(failure.code, 'library-upgrade-failed');
  assert.equal(
    failure.message,
    'The content could not be upgraded: The parameters contain H5P.Row 1.0, which is not supported.'
  );
});

test('a content upgrade that fails before saving says why', async () => {
  const host = await bridge();
  // With a newer version of the content's library installed, the editor
  // upgrades the content in getContent and hands a failure to the error
  // callback as the core's error object (h5peditor-editor.js).
  host.serialize((_submit, error) =>
    error({ type: 'errorNotSupported', used: 'H5P.Row 1.0', id: 1 })
  );
  host.save();
  const failure = host.notifications.at(-1);
  assert.equal(failure.type, 'error');
  assert.equal(
    failure.message,
    'The content could not be upgraded before saving: The parameters contain H5P.Row 1.0, which is not supported.'
  );
  // An exception an upgrade hook threw reaches the callback as it is.
  host.serialize((_submit, error) => error(new Error('hook failed')));
  host.save();
  assert.equal(
    host.notifications.at(-1).message,
    'The content could not be upgraded before saving: hook failed'
  );
});

for (const middle of [
  'unchanged-leaf',
  'unchanged-container',
  'upgraded-leaf',
  'no-script',
  'mutating-script',
  'mutating-wrapper'
]) {
  test(`the host keeps version-specific upgrade hooks with ${middle} between repeated targets`, async () => {
    const host = await bridge(mixedUpgradeVersions(middle));
    await waitForError(host);
    await host.element('host-upgrade-button').listeners.click();
    assert.equal(host.editors.length, 1, host.notifications.at(-1).message);
    const { params } = JSON.parse(host.editors[0][1]);
    assert.deepEqual(params.first.params.steps, ['new 1.1', 'new 1.2']);
    assert.deepEqual(params.last, params.first);
    assert.equal(params.last.library, 'H5P.Item 1.2');
    assert.equal(params.last.metadata.migrated, true);
    assert.deepEqual(
      params.middle.params.steps,
      ['upgraded-leaf', 'mutating-script', 'mutating-wrapper'].includes(middle)
        ? ['old 1.1']
        : undefined
    );
    if (middle === 'unchanged-container') {
      assert.equal(params.middle.params.child.library, 'H5P.Text 1.1');
    }
    assert.equal(
      host.scriptLoads.filter((url) => url.includes('H5P.Item-1.2')).length,
      1,
      'returning to the newer version must use its cached hooks'
    );
    assert.equal(host.requests.length, 0);
  });
}

test('the upgrade button names a core too old to snapshot upgrade hooks', async () => {
  // A core cached from before getUpgradeHooks, next to this newer page. The
  // page keeps that core, so a retry fails the same way, without waiting.
  const options = outdatedBook();
  options.scripts['/h5p/core/js/h5p-content-upgrade-process.js?v=1'] +=
    '\ndelete H5P.ContentUpgradeProcess.getUpgradeHooks;';
  const host = await bridge(options);
  await waitForError(host);
  const button = host.element('host-upgrade-button');
  for (let attempt = 1; attempt <= 2; attempt++) {
    const posted = host.notifications.length;
    await button.listeners.click();
    assert.equal(host.notifications.length, posted + 1);
    const failure = host.notifications.at(-1);
    assert.equal(failure.code, 'library-upgrade-failed');
    assert.equal(
      failure.message,
      'The content could not be upgraded: The upgrades script for H5P.Book ' +
        '1.2 loaded, but the loaded H5P core does not support getUpgradeHooks.'
    );
    assert.equal(host.editors.length, 0);
    assert.equal(button.disabled, false);
  }
});

for (const [label, error, message] of [
  [
    'broken params',
    { type: 'errorParamsBroken' },
    'The parameters are broken.'
  ],
  [
    'missing library',
    { type: 'libraryMissing', library: 'H5P.Col 1.1' },
    'Missing required library H5P.Col 1.1.'
  ],
  [
    'missing script',
    { type: 'scriptMissing', library: 'H5P.Col 1.1' },
    'Could not load the upgrades script for H5P.Col 1.1.'
  ],
  [
    'version too high',
    {
      type: 'errorTooHighVersion',
      used: 'H5P.Col 2.0',
      supported: 'H5P.Col 1.1'
    },
    'The parameters contain H5P.Col 2.0 while only H5P.Col 1.1 or earlier are supported.'
  ],
  ['unknown error type', { type: 'newError' }, 'Unknown error.'],
  [
    'unknown error with a message',
    { type: 'newError', message: 'Specific failure' },
    'Specific failure'
  ],
  ['empty message', { message: '' }, 'Unknown error.'],
  ['non-string message', { message: 42 }, 'Unknown error.'],
  ['empty error object', {}, 'Unknown error.']
]) {
  test(`an upgrade failure before saving formats ${label}`, async () => {
    const host = await bridge({ contentId: '7', revision: 'rev-saved' });
    host.serialize((_submit, fail) => fail(error));
    host.save();
    assert.equal(
      host.notifications.at(-1).message,
      `The content could not be upgraded before saving: ${message}`
    );
    assert.equal(host.notifications.at(-1).type, 'error');
    assert.equal(host.requests.length, 0);
    // Formatting the error must also release the save operation for retry.
    host.serialize((submit) =>
      submit({
        library: 'H5P.Column 1.18',
        params: '{"params":{},"metadata":{}}'
      })
    );
    host.save();
    await waitForNotification(host.notifications, (m) => m.type === 'saved');
    assert.equal(host.requests.length, 1);
    assert.equal(host.notifications.at(-1).type, 'saved');
  });
}

for (const [label, change, message] of [
  [
    'missing semantics',
    (options) => {
      options.libraries['H5P.Col 1.1'].semantics = null;
    },
    'Missing required library H5P.Col 1.1.'
  ],
  [
    'script with no registered hooks',
    (options) => {
      options.scripts['/h5p/libraries/H5P.Book-1.2/upgrades.js'] = '';
    },
    'Could not load the upgrades script for H5P.Book 1.2.'
  ],
  [
    'failed script request',
    (options) => {
      delete options.scripts['/h5p/libraries/H5P.Book-1.2/upgrades.js'];
    },
    'Could not load the upgrades script for H5P.Book 1.2.'
  ],
  [
    'unsupported newer nested version',
    (options) => {
      options.editModel.h5p.params.chapters[0].library = 'H5P.Col 2.0';
    },
    'The parameters contain H5P.Col 2.0 while only H5P.Col 1.1 or earlier are supported.'
  ],
  [
    'string error from a hook',
    (options) => {
      options.scripts['/h5p/libraries/H5P.Book-1.2/upgrades.js'] = `
        var H5PUpgrades = H5PUpgrades || {};
        H5PUpgrades['H5P.Book'] = {1: {1: function (params, done) {
          done('The hook rejected these parameters.');
        }}};`;
    },
    'The hook rejected these parameters.'
  ]
]) {
  test(`the upgrade button reports ${label} and permits retry`, async () => {
    const options = outdatedBook();
    change(options);
    const host = await bridge(options);
    await waitForError(host);
    const button = host.element('host-upgrade-button');
    await button.listeners.click();
    const failure = host.notifications.at(-1);
    assert.equal(failure.code, 'library-upgrade-failed');
    assert.equal(failure.revision, 'rev-1');
    assert.equal(
      failure.message,
      `The content could not be upgraded: ${message}`
    );
    assert.equal(host.editors.length, 0);
    assert.equal(host.requests.length, 0);
    assert.equal(button.disabled, false);
    Object.assign(options, outdatedBook());
    if (label === 'unsupported newer nested version') {
      // The page retains the loaded parameters. Install support for their
      // version before retrying rather than changing the stored document.
      options.libraries['H5P.Book 1.2'].semantics[0].field.options = [
        'H5P.Col 2.1'
      ];
      options.libraries['H5P.Col 2.1'] = {
        ...options.libraries['H5P.Col 1.1'],
        version: { major: 2, minor: 1 }
      };
    }
    await button.listeners.click();
    assert.equal(host.editors.length, 1, host.notifications.at(-1).message);
  });
}

// Stored content on an installed, older version of its main library (the
// edit model's `availableUpgrade`): a book on H5P.Book 1.2 whose chapter is
// an H5P.Col 1.0, where Book 1.3 — accepting Col 1.1 — is installed too.
function olderBook() {
  const options = outdatedBook({ library: 'H5P.Book 1.2', missing: [] });
  options.editModel.availableUpgrade = {
    library: 'H5P.Book 1.2',
    upgrade: 'H5P.Book 1.3'
  };
  options.libraries['H5P.Book 1.3'] = {
    ...options.libraries['H5P.Book 1.2'],
    version: { major: 1, minor: 3 },
    upgradesScript: '/h5p/libraries/H5P.Book-1.3/upgrades.js'
  };
  delete options.libraries['H5P.Book 1.2'];
  options.scripts['/h5p/libraries/H5P.Book-1.3/upgrades.js'] = `
    var H5PUpgrades = H5PUpgrades || {};
    H5PUpgrades['H5P.Book'] = {
      1: {
        3: function (params, finished) { params.steps = ['1.3']; finished(null, params); }
      }
    };`;
  return options;
}

async function readyOlderBook(options = olderBook()) {
  const host = await bridge(options);
  await host.tick();
  host.appearForm();
  await waitForNotification(host.notifications, (m) => m.type === 'ready');
  assert.equal(host.notifications[0]?.type, 'ready');
  return host;
}

// The rebuilt editor becomes ready quietly: wait for the notice to say so.
async function waitForOffer(host, pattern) {
  const deadline = Date.now() + 2000;
  while (
    !pattern.test(host.element('host-offer-text').textContent || '') &&
    Date.now() < deadline
  ) {
    await host.tick();
  }
  assert.match(host.element('host-offer-text').textContent, pattern);
}

test('content on an older installed version opens in the editor with the newer one offered', async () => {
  const host = await readyOlderBook();
  assert.equal(host.editors.length, 1);
  assert.equal(host.editors[0][0], 'H5P.Book 1.2');
  assert.equal(host.element('host-offer').hidden, false);
  assert.match(
    host.element('host-offer-text').textContent,
    /^This content uses H5P\.Book 1\.2\. A newer version, H5P\.Book 1\.3, is installed\./
  );
  assert.ok(!host.notifications.some((m) => m.type === 'error'));
  host.element('host-offer-dismiss').listeners.click();
  assert.equal(host.element('host-offer').hidden, true);
});

test('no upgrade is offered for an offer that does not match the opened content', async () => {
  for (const availableUpgrade of [
    null,
    { library: 'H5P.Book 1.1', upgrade: 'H5P.Book 1.3' },
    { library: 'H5P.Book 1.2', upgrade: 'H5P.Book 1.3.4' },
    { library: 'H5P.Book 1.2' }
  ]) {
    const options = olderBook();
    options.editModel.availableUpgrade = availableUpgrade;
    const host = await readyOlderBook(options);
    assert.notEqual(
      host.element('host-offer')?.hidden,
      false,
      JSON.stringify(availableUpgrade)
    );
  }
});

test('the offered upgrade takes the editor state, rebuilds the editor unsaved and posts no second ready', async () => {
  const host = await readyOlderBook();
  // Input the change watch did not catch, as a drag-and-drop layout edit.
  host.editor().getParams = () => ({
    params: {
      chapters: [{ library: 'H5P.Col 1.0', params: { text: 'typed' } }]
    },
    metadata: { title: 'Book' }
  });
  const upgrade = host.element('host-offer-upgrade').listeners.click();
  assert.equal(host.element('h5p-editor-root').inert, true);
  assert.equal(host.element('host-offer-upgrade').disabled, true);
  assert.equal(host.element('host-offer-upgrade').textContent, 'Upgrading…');
  assert.equal(host.element('host-offer-dismiss').disabled, true);
  await upgrade;
  assert.equal(host.element('h5p-editor-root').inert, false);
  assert.equal(host.editors.length, 2);
  const [library, state] = host.editors[1];
  assert.equal(library, 'H5P.Book 1.3');
  assert.deepEqual(JSON.parse(state), {
    params: {
      chapters: [{ library: 'H5P.Col 1.1', params: { text: 'typed' } }],
      steps: ['1.3']
    },
    metadata: { title: 'Book' }
  });
  // Saving is refused until the rebuilt editor is ready.
  host.save();
  assert.equal(host.notifications.at(-1).type, 'error');
  assert.match(host.notifications.at(-1).message, /being upgraded/);
  assert.equal(host.requests.length, 0);
  await host.tick();
  host.appearForm();
  await waitForOffer(host, /was upgraded to H5P\.Book 1\.3\. Save it/);
  await waitForNotification(host.notifications, (m) => m.type === 'changed');
  assert.deepEqual(
    host.notifications.map((m) => m.type),
    ['ready', 'error', 'changed']
  );
  assert.equal(host.element('host-offer-upgrade').hidden, true);
  assert.equal(host.element('host-offer-dismiss').disabled, false);
  // The refusal is out of date once the upgrade is done.
  assert.equal(host.element('host-error').hidden, true);
  // Nothing was written; the next save is conditioned on what was read.
  assert.equal(host.requests.length, 0);
  host.save();
  await waitForNotification(host.notifications, (m) => m.type === 'saved');
  assert.equal(host.requests[0].headers['if-match'], 'rev-1');
});

test('an editor already holding unsaved input does not post changed again after the offered upgrade', async () => {
  const host = await readyOlderBook();
  host.edit('input');
  assert.equal(host.notifications.at(-1).type, 'changed');
  await host.element('host-offer-upgrade').listeners.click();
  await host.tick();
  host.appearForm();
  await waitForOffer(host, /was upgraded/);
  assert.deepEqual(
    host.notifications.map((m) => m.type),
    ['ready', 'changed']
  );
});

test('the offered upgrade waits for a running save', async () => {
  const host = await readyOlderBook();
  const pending = Promise.withResolvers();
  host.respond(() => pending.promise);
  host.save();
  await host.element('host-offer-upgrade').listeners.click();
  assert.match(
    host.element('host-offer-error').textContent,
    /being saved\. Upgrade once the save has finished/
  );
  assert.equal(host.element('host-offer-error').hidden, false);
  assert.equal(host.editors.length, 1);
  pending.resolve({ contentId: '7', revision: 'rev-2' });
});

test('a failed offered upgrade is shown in the notice and leaves the editor as it was', async () => {
  const options = olderBook();
  delete options.libraries['H5P.Col 1.1'];
  const host = await readyOlderBook(options);
  await host.element('host-offer-upgrade').listeners.click();
  const failure = host.element('host-offer-error');
  assert.equal(failure.hidden, false);
  assert.match(
    failure.textContent,
    /^The content could not be upgraded: Could not load data for library H5P\.Col 1\.1\. It stays on H5P\.Book 1\.2 in the editor\.$/
  );
  // Not the parent's business: its editor works as before.
  assert.ok(!host.notifications.some((m) => m.type === 'error'));
  assert.equal(host.editors.length, 1);
  assert.equal(host.element('h5p-editor-root').inert, false);
  const button = host.element('host-offer-upgrade');
  assert.equal(button.disabled, false);
  assert.notEqual(button.textContent, 'Upgrading…');
  host.save();
  await waitForNotification(host.notifications, (m) => m.type === 'saved');
});

test('a change that lands while the offered upgrade runs cancels it', async () => {
  const host = await readyOlderBook();
  const upgrade = host.element('host-offer-upgrade').listeners.click();
  // An upload finishing in the inert editor.
  host.edit('input');
  await upgrade;
  assert.match(
    host.element('host-offer-error').textContent,
    /The content changed while it was upgraded; try again\./
  );
  assert.equal(host.editors.length, 1);
  assert.equal(host.element('host-offer-upgrade').disabled, false);
});

test('an upgraded editor that fails to load is rebuilt from the state the upgrade started from', async () => {
  const host = await readyOlderBook();
  host.edit('input');
  const edited = {
    params: { chapters: [{ library: 'H5P.Col 1.0', params: { text: 'b' } }] },
    metadata: { title: 'Book' }
  };
  host.editor().getParams = () => edited;
  await host.element('host-offer-upgrade').listeners.click();
  await host.tick();
  assert.equal(host.editors.length, 2);
  host.libraryAjaxError(500);
  assert.equal(host.editors.length, 3);
  const [library, state] = host.editors[2];
  assert.equal(library, 'H5P.Book 1.2');
  assert.deepEqual(JSON.parse(state), edited);
  await host.tick();
  host.appearForm();
  await waitForOffer(host, /^This content uses H5P\.Book 1\.2\./);
  assert.match(
    host.element('host-offer-error').textContent,
    /could not be opened in the editor \(The editor could not load its libraries \(500\)\.\)\. It was reopened on H5P\.Book 1\.2\./
  );
  assert.equal(host.element('host-offer-upgrade').disabled, false);
  // The parent heard nothing of it: the frame worked throughout.
  assert.deepEqual(
    host.notifications.map((m) => m.type),
    ['ready', 'changed']
  );
  host.save();
  await waitForNotification(host.notifications, (m) => m.type === 'saved');
});

test('the offered upgrade waits for an upload or library load in the editor', async () => {
  const host = await readyOlderBook();
  const upload = new (host.iframeWindow().XMLHttpRequest)();
  upload.send();
  const button = host.element('host-offer-upgrade');
  await button.listeners.click();
  assert.match(
    host.element('host-offer-error').textContent,
    /still uploading or loading\. Upgrade once it has finished\./
  );
  assert.equal(host.editors.length, 1);
  // A refused second send of the running request counts nothing twice.
  assert.throws(() => upload.send(), /InvalidStateError/);
  upload.listeners.loadend();
  await button.listeners.click();
  await host.tick();
  host.appearForm();
  await waitForOffer(host, /was upgraded/);
  assert.equal(host.editors.length, 2);
});

test('a request the editor starts while the offered upgrade runs cancels it', async () => {
  const host = await readyOlderBook();
  const upgrade = host.element('host-offer-upgrade').listeners.click();
  // Started and ended before the upgrade finishes: still cancels it.
  const request = new (host.iframeWindow().XMLHttpRequest)();
  request.send();
  request.listeners.loadend();
  await upgrade;
  assert.match(
    host.element('host-offer-error').textContent,
    /was busy \(a request or a reload\) while the content was upgraded/
  );
  assert.equal(host.editors.length, 1);
});

test('a reload of the form iframe while the offered upgrade runs cancels it', async () => {
  const host = await readyOlderBook();
  const upgrade = host.element('host-offer-upgrade').listeners.click();
  // The reloaded form starts afresh, and what it holds may differ.
  host.reloadIframe();
  await upgrade;
  assert.match(
    host.element('host-offer-error').textContent,
    /was busy \(a request or a reload\) while the content was upgraded/
  );
  assert.equal(host.editors.length, 1);
});

test('a request started by reading the editor state cancels the offered upgrade', async () => {
  const host = await readyOlderBook();
  const editor = host.editor();
  const read = editor.getParams;
  editor.getParams = (...args) => {
    new (host.iframeWindow().XMLHttpRequest)().send();
    return read(...args);
  };
  await host.element('host-offer-upgrade').listeners.click();
  assert.match(
    host.element('host-offer-error').textContent,
    /was busy \(a request or a reload\) while the content was upgraded/
  );
  assert.equal(host.editors.length, 1);
});
