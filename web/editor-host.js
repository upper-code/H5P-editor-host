/*
 * Browser integration for the H5P editor runtime. GPL-3.0-or-later; see COPYING.
 * The parent page controls saving through the postMessage events in
 * docs/USAGE.md.
 */

const hostRoot = new URL('../', import.meta.url);

function hostUrl(path = '') {
  return new URL(String(path).replace(/^\/+/, ''), hostRoot).toString();
}

const root = document.getElementById('h5p-editor-root');
const loading = document.getElementById('host-loading');
const errorBox = document.getElementById('host-error');
const segments = location.pathname.split('/').filter(Boolean);
let contentId = segments[segments.length - 1] || 'new';
let editor = null;
let saving = false;
let saveAttempt = 0;
let revision;
let pendingSave;
// Whether the editor holds input the host has not saved. Reported to the
// parent once per dirty period as a `changed` DTO so it can warn before the
// page is left; the parent learns nothing about what changed.
let dirty = false;
let editedWhileSaving = false;

// 'loading' until the vendored runtime has actually rendered something
// `getContent()` can act on: `self.selector` (and, when the model already
// names a library, `self.selector.form`) — see `awaitEditorReady`. `save()`
// refuses while this is not 'ready'; 'failed' is terminal (the library list
// or a content type's semantics did not load).
let readyState = 'loading';
// Set once, the first time the editor's internal form iframe fires 'load'
// (the `onIframeLoaded` callback passed to `ns.Editor` in `bootstrap`). The
// vendored runtime can reload that iframe later (`onUnload` in
// h5peditor-editor.js), which re-invokes the callback; only the first call
// starts the ready watch and the ready-timeout clock.
let iframeLoaded = false;
let hasLibrary = false;

// How long the H5P editor may take to answer getContent() before the bridge
// gives the save up. Validation is instant; a library upgrade first loads
// scripts, which is what the margin is for.
const SAVE_CALLBACK_TIMEOUT_MS = 60000;

// How long the host may take to answer the save request itself. The request is
// not aborted at the deadline: that would neither stop a write already under
// way nor reveal the id it produced. The parent is told the save failed so it
// can offer a retry, and an answer that still arrives is adopted as long as no
// newer save has started since.
//
// Sized by the embedder (`saveTimeoutMs` on this page's URL, set by
// web/editor.js off the same H5P_HOST_TIMEOUT_MS the save request itself
// waits behind server-side) rather than fixed here, so the two budgets stay
// in lockstep without a second place to configure the host's own timeout.
// Clamped against a missing, malformed or absurd value: this is a
// browser-supplied parameter the host's own `/editor/:id` route does not
// validate.
function saveRequestTimeoutMs() {
  // A missing param reads back as `null` from `URLSearchParams`, and
  // `Number(null)` is `0` — finite, not caught by the `isFinite` check below
  // — which would otherwise clamp a plain missing param to the 30 s floor
  // instead of falling through to the default.
  const raw = new URLSearchParams(location.search).get('saveTimeoutMs');
  const requested = raw ? Number(raw) : NaN;
  if (!Number.isFinite(requested)) {
    return 120000;
  }
  return Math.min(Math.max(requested, 30_000), 1_800_000);
}
const SAVE_REQUEST_TIMEOUT_MS = saveRequestTimeoutMs();

// The vendored runtime exposes no event for `self.selector`/`self.selector.
// form` appearing — they are just assigned once their own AJAX calls resolve
// — so the bridge polls for them.
const READY_POLL_INTERVAL_MS = 100;

// How long the editor's form iframe may take, after it first loads, to finish
// listing content types (or, once one is chosen, loading its semantics)
// before the bridge gives up and reports the editor unusable. Counted from
// the iframe's own 'load' event, not from `bootstrap()`'s start: loading the
// outer chrome's own scripts is covered by the browser embedder's handshake
// timeout instead.
const EDITOR_READY_TIMEOUT_MS = 60000;

function parentOrigin() {
  const requested = new URLSearchParams(location.search).get('parentOrigin');
  if (!requested) {
    // The same-origin, reverse-proxied deployment: the embedder omits the
    // param and the parent shares this page's origin.
    return location.origin;
  }
  try {
    return new URL(requested).origin;
  } catch (error) {
    // A present-but-unparseable parentOrigin must never fall back to this
    // page's own origin: doing so would aim the editor's status messages at
    // the wrong window and turn the misconfiguration into a silent handshake
    // timeout upstream. Refuse to run instead (see bootstrap guard below).
    return null;
  }
}

const expectedParentOrigin = parentOrigin();

function notify(type, payload = {}) {
  // With no valid parent origin there is nowhere safe to post; the visible
  // error box still tells whoever opened the frame what went wrong.
  if (expectedParentOrigin && window.parent !== window) {
    window.parent.postMessage(
      { source: 'h5p-editor-host', type, ...payload },
      expectedParentOrigin
    );
  }
}

function showError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message || '';
  if (message) {
    notify('error', { message });
  }
}

// Requests carry no X-H5P-Host-Secret or X-Distributor-Id: the embedder's
// reverse proxy adds both on the way to the host, so the browser never holds
// the secret. This page is only ever served through that proxy.
async function fetchJson(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    // Status handling below produces the useful error.
  }
  if (!response.ok) {
    // The status is what tells a verdict on this body (a 4xx) apart from an
    // outcome that may still be retried unchanged; see `isDefinitive`.
    throw Object.assign(
      new Error(
        data.detail ||
          data.error ||
          `Editor service request failed (${response.status}).`
      ),
      { status: response.status }
    );
  }
  return data;
}

// Statuses that are a verdict on this exact request body: replaying it would
// fail the same way forever and block every later save. 408 and 429 are the
// conventional "come back later" codes, so they — like every 5xx, a network
// failure and the request deadline — leave the attempt replayable.
function isDefinitive(status) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * A random idempotency key.
 *
 * `crypto.randomUUID` is unavailable outside a secure context, which includes
 * a plain-http deployment reached by anything but localhost, and in any host
 * that provides no `crypto` at all; the key is not a security token, so a
 * v4-shaped id from `getRandomValues` (or, failing that, `Math.random`) serves
 * the same purpose.
 */
function uuid() {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') {
    return source.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadStyle(href) {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = resolve;
    document.head.appendChild(link);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function buildGetAjaxUrl(ajaxPath) {
  return function getAjaxUrl(action, parameters) {
    let url = ajaxPath + action;
    if (parameters !== undefined) {
      let separator = url.includes('?') ? '&' : '?';
      Object.keys(parameters).forEach((property) => {
        url += `${separator}${property}=${encodeURIComponent(parameters[property])}`;
        separator = '&';
      });
    }
    return url;
  };
}

/**
 * Which of the editor model's scripts belong in this outer document.
 *
 * The model lists the complete editor runtime, but most of it is meant for
 * the editor's own iframe (`H5PEditor.Editor` builds that document from
 * `integration.editor.assets`). One of those iframe-only files,
 * `scripts/h5peditor.js`, re-initialises `H5PEditor` and `H5PIntegration`
 * from `window.parent` — correct inside the editor iframe, but run here it
 * replaces both globals with copies taken from the *embedding* page, which
 * by design has neither. The outer document needs only what the reference
 * `h5peditor-init.js` integration loads: the H5P core, the `Editor`
 * constructor and the UI translations.
 */
function isOuterChromeScript(src) {
  const pathname = new URL(src, location.href).pathname;
  return (
    /\/core\/js\/[^/]+\.js$/.test(pathname) ||
    /\/scripts\/h5peditor-editor\.js$/.test(pathname) ||
    /\/language\/[^/]+\.js$/.test(pathname)
  );
}

// Mirrors the reference integration (`scripts/h5peditor-init.js`): the
// namespace fields the editor iframe copies from this window on load.
function initEditorNamespace(integration) {
  const ns = window.H5PEditor;
  const editorIntegration = integration.editor;
  ns.$ = window.H5P.jQuery;
  ns.basePath = editorIntegration.libraryUrl;
  ns.fileIcon = editorIntegration.fileIcon;
  ns.ajaxPath = editorIntegration.ajaxPath;
  ns.getAjaxUrl = buildGetAjaxUrl(editorIntegration.ajaxPath);
  ns.filesPath = editorIntegration.filesPath;
  ns.apiVersion = editorIntegration.apiVersion;
  ns.contentLanguage = editorIntegration.language;
  ns.copyrightSemantics = editorIntegration.copyrightSemantics;
  ns.metadataSemantics = editorIntegration.metadataSemantics;
  ns.assets = editorIntegration.assets;
  ns.baseUrl = integration.baseUrl || '';
  // The host is local-only. Never let an upstream model switch the catalogue
  // client back on or publish its endpoint into the iframe namespace.
  ns.enableContentHub = false;
  if (editorIntegration.nodeVersionId != null) {
    ns.contentId = editorIntegration.nodeVersionId;
  }
  delete integration.Hub;
  return ns;
}

function markChanged() {
  if (saving) {
    // The serialized state may or may not include this edit; report it again
    // once the save has settled rather than let `saved` clear it.
    editedWhileSaving = true;
    return;
  }
  if (dirty) {
    return;
  }
  dirty = true;
  notify('changed', { contentId });
}

/**
 * Watches the editor's own document for input. The H5P editor renders its
 * form inside an iframe of this page; native `input`/`change` events bubble
 * from every text field, select, checkbox and CKEditor's contenteditable, so
 * no editor internals are consulted. Widgets that mutate parameters without a
 * native event (a drag-and-drop layout) are not caught — this is a guard
 * against losing typed work, not an exact dirty flag.
 */
function watchEditorInput(doc) {
  if (!doc || typeof doc.addEventListener !== 'function') {
    return;
  }
  // Native field edits. Everything a control *requests* — a list add,
  // remove or reorder, a paste over a library field, a media insert, remove
  // or image edit — is reported from the editor model once it actually
  // happened (`watchEditorModel`), never from the click: most of those go
  // through a confirmation dialog or a validation first, and a cancelled
  // one changes nothing, so a click-based report would leave Shelf showing
  // "unsaved changes" and blocking Publish for an edit that never was.
  ['input', 'change', 'drop'].forEach((type) =>
    doc.addEventListener(
      type,
      (event) => {
        // These controls edit only a temporary UI value or start an
        // asynchronous operation. Their corresponding model hooks below
        // report the edit after it is confirmed/completed. In particular,
        // treating their native event as an edit would make Cancel and a
        // rejected upload dirty the Shelf despite leaving saved parameters
        // untouched.
        if (event.target?.closest?.(MODEL_DEFERRED_CONTROL_SELECTOR)) {
          return;
        }
        markChanged();
      },
      true
    )
  );
}

const MODEL_DEFERRED_CONTROL_SELECTOR = [
  'select[name=h5peditor-library]',
  'select[id=h5peditor-language-switcher]',
  'input[type=file]',
  '.h5p-file-url',
  '.h5p-file-drop-upload'
].join(', ');

// The media widgets whose instances keep an old-style `changes` list of
// callbacks the widget runs after it really changed its params (upload
// completed, URL inserted, file removed on confirmation, image edit saved) —
// and never during construction. Registry names, as `processSemanticsChunk`
// looks them up; `H5PEditor.File`/`H5PEditor.AV` themselves are left alone,
// since other widgets call them as super-constructors and read statics off
// them.
const MEDIA_WIDGETS_WITH_CHANGE_LISTENERS = ['image', 'file', 'video', 'audio'];

/**
 * Reports edits from the editor *model* — the point where a change has
 * actually been applied — rather than from the controls that request them.
 *
 * - Lists (`H5PEditor.List`, the structure every list widget drives: the
 *   default ListEditor, VerticalTabs for InteractiveBook chapters): a click on
 *   Remove opens a confirmation dialog and mutates nothing until confirmed; an
 *   order button on the first/last item returns early; drag-and-drop reorders
 *   through mousedown/mousemove/mouseup with no click, input or change event
 *   at all. `addedItem`/`removedItem` are triggered only after the parameters
 *   were spliced, and `moveItem` (which has no event) is the single call both
 *   the order buttons and a drag make once an item actually moved.
 * - Paste over a library field (the content-type selector's and
 *   `H5PEditor.Library`'s paste buttons): both ask through
 *   `H5PEditor.confirmReplace(library, top, next)` and replace only in `next`.
 * - Media (image/file/video/audio widgets): each instance's `changes` list is
 *   run after an upload completed, a URL was inserted, a file was removed on
 *   confirmation or an image edit was saved — and the image popup's Reset
 *   only redraws the preview, so it is rightly not reported.
 *
 * Bound by wrapping the form iframe's own constructors and helper before any
 * form is built (`onIframeLoaded` runs before the runtime's content-type
 * AJAX, which is what creates the first form). Wrappers call the original
 * constructor on `this` (closure-style constructors assign onto it), so a
 * subclass that invokes one as a super-constructor keeps working, and the
 * prototype chain is kept as-is. The vendored runtime instantiates widgets
 * through `H5PEditor.widgets.<name>`, so those registry entries are what is
 * replaced (plus the `H5PEditor.List` alias of the same function).
 */
function watchEditorModel(iframeWindow) {
  const editorNs = iframeWindow.H5PEditor;
  if (!editorNs || editorNs.__hostWatched) {
    return;
  }
  editorNs.__hostWatched = true;
  const widgets = editorNs.widgets || {};

  const wrapConstructor = (Original, afterConstruct) => {
    function Watched(...args) {
      Original.apply(this, args);
      afterConstruct(this, args);
    }
    Watched.prototype = Original.prototype;
    Object.assign(Watched, Original);
    return Watched;
  };

  const OriginalList = editorNs.List;
  if (typeof OriginalList === 'function') {
    const WatchedList = wrapConstructor(OriginalList, (list) => {
      if (typeof list.on === 'function') {
        list.on('addedItem', markChanged);
        list.on('removedItem', markChanged);
      }
      const moveItem = list.moveItem;
      if (typeof moveItem === 'function') {
        list.moveItem = function watchedMoveItem(...moveArgs) {
          const result = moveItem.apply(this, moveArgs);
          markChanged();
          return result;
        };
      }
    });
    editorNs.List = WatchedList;
    if (widgets.list === OriginalList) {
      widgets.list = WatchedList;
    }
  }

  const confirmReplace = editorNs.confirmReplace;
  if (typeof confirmReplace === 'function') {
    editorNs.confirmReplace = function watchedConfirmReplace(
      library,
      top,
      next,
      ...rest
    ) {
      return confirmReplace.call(
        this,
        library,
        top,
        function replaced(...args) {
          const result = next.apply(this, args);
          markChanged();
          return result;
        },
        ...rest
      );
    };
  }

  // The top-level content-type selector owns a separate confirmation dialog;
  // it emits `editorload` only for the initial/default library or after a
  // selection was accepted. Ignore that one initial load when present, then
  // report confirmed changes for both the legacy and Hub selectors.
  const OriginalLibrarySelector = editorNs.LibrarySelector;
  if (typeof OriginalLibrarySelector === 'function') {
    editorNs.LibrarySelector = wrapConstructor(
      OriginalLibrarySelector,
      (selector, args) => {
        let skipInitialLoad = Boolean(args[1]);
        if (typeof selector.on === 'function') {
          selector.on('editorload', () => {
            if (skipInitialLoad) {
              skipInitialLoad = false;
              return;
            }
            markChanged();
          });
        }
      }
    );
  }

  // Changing the content language is also confirmation-gated. Its only model
  // entry point is this recursive helper, invoked after the user confirms;
  // wrap the outermost call so Cancel stays clean while an accepted language
  // change is reported once.
  const formPrototype = editorNs.Form && editorNs.Form.prototype;
  const setSubContentDefaultLanguage =
    formPrototype && formPrototype.setSubContentDefaultLanguage;
  if (typeof setSubContentDefaultLanguage === 'function') {
    let languageUpdateDepth = 0;
    formPrototype.setSubContentDefaultLanguage = function watchedLanguage(
      ...args
    ) {
      languageUpdateDepth += 1;
      try {
        const result = setSubContentDefaultLanguage.apply(this, args);
        if (languageUpdateDepth === 1) {
          markChanged();
        }
        return result;
      } finally {
        languageUpdateDepth -= 1;
      }
    };
  }

  // `video` and `audio` are one constructor registered twice (H5PEditor.AV);
  // one wrapper serves both, so the registry keeps them identical.
  const wrappedMedia = new Map();
  MEDIA_WIDGETS_WITH_CHANGE_LISTENERS.forEach((name) => {
    const Original = widgets[name];
    if (typeof Original !== 'function') {
      return;
    }
    if (!wrappedMedia.has(Original)) {
      wrappedMedia.set(
        Original,
        wrapConstructor(Original, (widget) => {
          if (Array.isArray(widget.changes)) {
            widget.changes.push(markChanged);
          }
        })
      );
    }
    widgets[name] = wrappedMedia.get(Original);
  });
}

/**
 * Fails the ready watch once, with a message the parent sees as an `error`
 * DTO. A no-op once `readyState` has already left 'loading' — the watchers
 * below stay bound for the page's life (the form iframe can reload), but only
 * the first failure (or the first success, in `awaitEditorReady`) matters.
 */
function failReady(message) {
  if (readyState !== 'loading') {
    return;
  }
  readyState = 'failed';
  showError(message);
}

/**
 * Watches the form iframe's *own* AJAX traffic for the two requests that
 * stand between 'load' and a usable editor: the content-type list
 * (`libraries`/`content-type-cache`) and, once one is chosen, that type's
 * semantics (also `action=libraries`, with a library parameter — see
 * `h5peditor.js` `loadLibrary`). Both run through `iframeWindow.H5P.jQuery`,
 * a separate module instance from this outer window's — the vendored
 * `h5peditor-editor.js` reads `this.contentWindow.H5P.jQuery` when it issues
 * them (`this` being the `<iframe>` element) — so jQuery's global ajax events
 * fire on the iframe's own `document`, not this page's. Not filtered to
 * those two requests by URL: nothing else in this bridge's flow uses jQuery
 * AJAX (`save()` uses `fetch`), and `failReady` is already a no-op once
 * `readyState` has left 'loading', so a later, unrelated iframe AJAX call
 * (there are none today, but this stays correct if one is added) cannot
 * retroactively fail an editor that already became ready.
 */
function watchLibraryLoad(iframeWindow) {
  const iframeJQuery = iframeWindow.H5P && iframeWindow.H5P.jQuery;
  if (typeof iframeJQuery !== 'function') {
    return;
  }
  iframeJQuery(iframeWindow.document)
    .on('ajaxError', (event, xhr) => {
      failReady(
        `The editor could not load its libraries (${xhr?.status || 'network error'}).`
      );
    })
    .on('ajaxSuccess', (event, xhr, settings, data) => {
      // A 200 the endpoint itself marks unsuccessful — h5peditor-editor.js
      // shows this inline in the iframe (`$container.html(...)`) and reports
      // it nowhere else.
      if (data && data.success === false) {
        failReady(
          `The editor could not load its libraries (${data.message || data.errorCode || 'unknown error'}).`
        );
      }
    });
}

/**
 * Polls for the point `getContent()` becomes safe to call: `editor.selector`
 * existing (assigned once the content-type list AJAX resolves), and, only
 * when the model already named a library, `editor.selector.form` too
 * (assigned once that library's semantics AJAX resolves). For `new` content
 * with no library yet, the selector alone is the ready state — `getContent()`
 * then correctly answers `content-not-selected` instead of throwing.
 */
function awaitEditorReady() {
  const deadline = setTimeout(() => {
    failReady('The editor did not finish loading.');
  }, EDITOR_READY_TIMEOUT_MS);
  const poll = setInterval(() => {
    if (readyState !== 'loading') {
      clearInterval(poll);
      clearTimeout(deadline);
      return;
    }
    if (!editor?.selector || (hasLibrary && !editor.selector.form)) {
      return;
    }
    clearInterval(poll);
    clearTimeout(deadline);
    readyState = 'ready';
    notify('ready', { contentId });
  }, READY_POLL_INTERVAL_MS);
}

function editorError(code) {
  const messages = {
    'content-not-selected': 'Choose a content type before saving.',
    'missing-title': 'Enter a title before saving.',
    'missing-library': 'Choose a content type before saving.',
    'missing-params': 'There is nothing to save yet.',
    'missing-params-params': 'There is nothing to save yet.'
  };
  showError(messages[code] || `Cannot save: ${code}`);
}

/**
 * Sends one serialized editor state to the host and reports the outcome of
 * save attempt `attempt`. Everything that touches shared state first checks
 * that the attempt is still the current one: a newer save may have started
 * after this one timed out, and its state must not be disturbed.
 */
async function submitContent(attempt, content) {
  const current = () => attempt === saveAttempt;
  let request;
  let timedOut = false;
  const deadline = setTimeout(() => {
    if (!current() || !saving) {
      return;
    }
    timedOut = true;
    saving = false;
    showError(
      'The H5P host did not answer the save request in time. The save may ' +
        'still complete; the next save will pick up its answer instead of ' +
        'creating a duplicate. Try again.'
    );
  }, SAVE_REQUEST_TIMEOUT_MS);
  try {
    // H5P serializes the editor state as a JSON string of
    // { params, metadata } — the vendored runtime does so on the upgrade
    // path too (h5p-content-upgrade-process.js stringifies its result).
    // An object is tolerated in case a future core stops doing that.
    // Send the host a flat { library, params, metadata } body, the same
    // shape POST /api/v1/generated-content accepts.
    const editorState =
      typeof content.params === 'string'
        ? JSON.parse(content.params)
        : content.params;
    const body = JSON.stringify({
      library: content.library,
      params: editorState.params,
      metadata: editorState.metadata
    });
    const send = (pending) => {
      request = pending;
      return fetchJson(
        hostUrl(`api/v1/content/${encodeURIComponent(pending.target)}`),
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': pending.key,
            ...(pending.revision ? { 'if-match': pending.revision } : {})
          },
          body: pending.body
        }
      );
    };
    if (pendingSave && pendingSave.body !== body) {
      // Resolve the previous ambiguous save before applying newly edited
      // input. A definitive rejection of it is reported by the catch below,
      // which also drops it, so the retry starts from this newer body.
      const recovered = await send(pendingSave);
      // A superseded attempt settles nothing: the id this answer carries is
      // dropped with it, so the operation has to stay for whoever is current
      // to replay. Dropping the key here instead would leave a newer attempt
      // that is still serializing with no record of the ambiguous save, and it
      // would create a second item under a fresh key.
      if (!current()) {
        return;
      }
      // The host settled that operation whoever asked for it, so the key it
      // answered is spent, and this attempt owns the editor state below.
      if (pendingSave === request) {
        pendingSave = undefined;
      }
      contentId = String(recovered.contentId);
      revision = recovered.revision;
    }
    pendingSave ||= { key: uuid(), target: contentId, revision, body };
    const saved = await send(pendingSave);
    // Only the current attempt owns the editor state, including after a
    // replay of an older operation. A superseded attempt may still get a reply.
    if (!current()) {
      return;
    }
    if (timedOut) {
      showError('');
    }
    pendingSave = undefined;
    revision = saved.revision;
    contentId = String(saved.contentId);
    dirty = false;
    notify('saved', {
      contentId,
      // The host's idempotency key for this write (contract version 3). The
      // embedder already acknowledged the delta server-side before it
      // answered, so this is here to be logged and correlated, not acted on.
      operationId: saved.operationId,
      savedBytes: saved.savedBytes || 0,
      deltaBytes: saved.deltaBytes || 0
    });
  } catch (error) {
    // A definitive answer settles this attempt: keeping it would replay the
    // same rejected body ahead of every later save, forever.
    if (current() && pendingSave === request && isDefinitive(error.status)) {
      pendingSave = undefined;
    }
    if (current() && !timedOut) {
      showError(error.message);
    }
    // Keep the revision the author actually edited. Reloading the document
    // is required after a conflict; retrying must not silently overwrite it.
  } finally {
    clearTimeout(deadline);
    if (current()) {
      saving = false;
      if (editedWhileSaving) {
        editedWhileSaving = false;
        markChanged();
      }
    }
  }
}

function save() {
  // Repeated parent messages while creating an item must not create copies.
  // Answering `saving` again tells the parent the bridge is busy, not dead.
  if (saving) {
    notify('saving');
    return;
  }
  if (!editor || readyState !== 'ready') {
    showError('The editor is not ready.');
    return;
  }
  showError('');
  saving = true;
  const attempt = ++saveAttempt;
  // getContent() calls back neither when a script it loads for a library
  // upgrade throws nor on other asynchronous failures inside the editor;
  // without a deadline one such save would silently swallow every later one.
  const watchdog = setTimeout(() => {
    if (attempt !== saveAttempt || !saving) {
      return;
    }
    saving = false;
    showError('The editor did not respond to the save request. Try again.');
  }, SAVE_CALLBACK_TIMEOUT_MS);
  // A callback arriving after the watchdog gave up belongs to an abandoned
  // attempt: acting on it could create a second copy of new content.
  const abandoned = () => attempt !== saveAttempt || !saving;
  notify('saving');
  try {
    editor.getContent(
      (content) => {
        clearTimeout(watchdog);
        if (abandoned()) {
          return;
        }
        submitContent(attempt, content);
      },
      (code) => {
        clearTimeout(watchdog);
        if (abandoned()) {
          return;
        }
        saving = false;
        editorError(code);
      }
    );
  } catch (error) {
    clearTimeout(watchdog);
    saving = false;
    showError(error.message);
  }
}

window.addEventListener('message', (event) => {
  if (event.origin !== expectedParentOrigin || event.source !== window.parent) {
    return;
  }
  if (event.data?.source !== 'editor-embedder') {
    return;
  }
  if (event.data.type === 'save') {
    save();
  }
});

async function bootstrap() {
  const encoded = encodeURIComponent(contentId);
  const data = await fetchJson(hostUrl(`api/v1/content/${encoded}/edit`));
  revision = data.revision;
  const model = data.h5p;
  if (!model?.integration) {
    throw new Error('The editor model is incomplete.');
  }
  window.H5PIntegration = model.integration;
  await Promise.all((model.styles || []).map(loadStyle));
  for (const script of (model.scripts || []).filter(isOuterChromeScript)) {
    await loadScript(script);
  }
  // Belt and braces: whatever a script did to the global, the editor iframe
  // must copy the model's integration from this window.
  window.H5PIntegration = model.integration;
  if (
    !window.H5P ||
    !window.H5PEditor ||
    typeof window.H5PEditor.Editor !== 'function'
  ) {
    throw new Error('The editor runtime failed to load.');
  }
  const ns = initEditorNamespace(window.H5PIntegration);
  loading.remove();
  root.setAttribute('aria-busy', 'false');
  const mount = document.createElement('div');
  root.appendChild(mount);
  const defaultParams = model.params
    ? JSON.stringify({ params: model.params, metadata: model.metadata })
    : undefined;
  hasLibrary = Boolean(model.library);
  editor = new ns.Editor(
    model.library || '',
    defaultParams,
    mount,
    function onIframeLoaded() {
      // Called by the editor with the form iframe's window as `this`, each
      // time its internal form iframe fires 'load' — which can happen more
      // than once (the vendored runtime reloads it in some flows). Only the
      // first call starts the ready watch and its deadline; `notify('ready',
      // ...)` itself (in `awaitEditorReady`) is guarded by `readyState`, so
      // a later reload cannot send a second one.
      const iframeNs = this.H5PEditor;
      if (iframeNs && typeof iframeNs.getAjaxUrl !== 'function') {
        iframeNs.getAjaxUrl = buildGetAjaxUrl(ns.ajaxPath);
      }
      watchEditorInput(this.document);
      watchEditorModel(this);
      // Bound per window: a reload hands the runtime a fresh contentWindow
      // with its own jQuery, and handlers on the old one never fire again.
      // Harmless once ready — `failReady` is a no-op then.
      watchLibraryLoad(this);
      if (iframeLoaded) {
        return;
      }
      iframeLoaded = true;
      awaitEditorReady();
    }
  );
}

if (expectedParentOrigin) {
  bootstrap().catch((error) => {
    // A crash here means `editor` was never assigned (`save()`'s own `!editor`
    // guard already covers that), but marking the state terminal too keeps
    // `readyState` an honest answer for whoever reads it later. `failReady`'s
    // own guard makes this safe even on the (currently impossible) chance
    // that bootstrap rejects after the ready watch already settled.
    failReady(error.message);
  });
} else {
  showError(
    'This editor was opened without a valid parent origin and cannot load.'
  );
}
