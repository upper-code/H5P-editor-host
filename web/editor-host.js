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
const upgradeBox = document.getElementById('host-upgrade');
const upgradeButton = document.getElementById('host-upgrade-button');
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
let editVersion = 0;

// 'loading' until the vendored runtime has actually rendered something
// `getContent()` can act on: `self.selector` (and, when the model already
// names a library, `self.selector.form`) — see `awaitEditorReady`. `save()`
// refuses while this is not 'ready'; 'failed' is terminal (the library list
// or a content type's semantics did not load). 'blocked' means the stored
// content names library versions that are not installed and no editor was
// built; an upgrade to the installed versions starts it ('loading' again).
let readyState = 'loading';
// Set when the editor is started on parameters upgraded in this page: they
// differ from what is stored, so the first `ready` is followed by `changed`.
let changedOnReady = false;
// Set once, the first time the editor's internal form iframe fires 'load'
// (the `onIframeLoaded` callback passed to `ns.Editor` in `bootstrap`). The
// vendored runtime can reload that iframe later (`onUnload` in
// h5peditor-editor.js), which re-invokes the callback; only the first call
// starts the ready watch and the ready-timeout clock.
let iframeLoaded = false;
let hasLibrary = false;

// How long a content upgrade (`upgradeContent`) may take in all: loading the
// core's upgrade scripts, the libraries and their upgrade scripts, and running
// them. A request that never answers would otherwise leave the button
// disabled for good.
const UPGRADE_TIMEOUT_MS = 60000;

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

// `details` extends the `error` DTO: a load failure carries the `revision`
// the page read (Shelf can still replace the content by an import pinned to
// it) and, for stored content naming uninstalled libraries, a `code`.
function showError(message, details = {}) {
  errorBox.hidden = !message;
  errorBox.textContent = message || '';
  if (message) {
    notify('error', { message, ...details });
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
// fail the same way forever and block every later save. Authentication can
// fail in Shelf before Host sees a retry: 401/403 say nothing about whether
// an earlier request committed. Keep its key, body, target and revision until
// authentication is restored. 408/429, every 5xx, a network failure and the
// request deadline also leave the attempt replayable.
function isDefinitive(status) {
  return (
    status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status)
  );
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
  editVersion += 1;
  // Warn the parent immediately, including while a clean editor is saving.
  // editVersion also re-reports edits outside the snapshot after `saved`.
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
  showError(message, revision ? { revision } : {});
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
    notify('ready', { contentId, revision });
    if (changedOnReady) {
      changedOnReady = false;
      markChanged();
    }
  }, READY_POLL_INTERVAL_MS);
}

function editorError(code) {
  // With a newer version of the content's library installed, the editor
  // upgrades the content before handing it over, and a failed upgrade is
  // reported with the core's error object rather than a code
  // (h5peditor-editor.js `getContent`).
  if (code !== null && typeof code === 'object') {
    showError(
      `The content could not be upgraded before saving: ${upgradeError(code)}`
    );
    return;
  }
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
async function submitContent(attempt, content, submittedVersion) {
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
    const send = async (pending) => {
      request = pending;
      const result = await fetchJson(
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
      // A 2xx may contain a proxy's HTML page or an incomplete receipt.
      // Validate both a normal save and a replay before either can consume
      // the pending key, adopt an id/revision or clear the parent's dirty flag.
      if (
        typeof result?.contentId !== 'string' ||
        !result.contentId ||
        /\D/.test(result.contentId)
      ) {
        throw new Error(
          'The H5P host returned an invalid save response. The save may ' +
            'have completed; try again to recover its result.'
        );
      }
      return result;
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
      revision,
      // The host's idempotency key for this write (contract version 3). The
      // embedder already acknowledged the delta server-side before it
      // answered, so this is here to be logged and correlated, not acted on.
      operationId: saved.operationId,
      savedBytes: saved.savedBytes || 0,
      deltaBytes: saved.deltaBytes || 0
    });
    // The only place `dirty` is cleared, so the only place edits made after
    // this request's snapshot (while it ran, or after it timed out) have to
    // be reported again; every other outcome leaves the flag as input set it.
    if (editVersion !== submittedVersion) {
      dirty = true;
      notify('changed', { contentId });
    }
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
  // Start before getContent: an asynchronous upgrade may serialize the
  // snapshot before its callback, while the author continues typing.
  const submittedVersion = editVersion;
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
        submitContent(attempt, content, submittedVersion);
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
  const missing = Array.isArray(data.missingLibraries)
    ? data.missingLibraries.filter(
        (entry) => typeof entry?.library === 'string' && entry.library
      )
    : [];
  if (missing.length) {
    offerLibraryUpgrade(ns, model, missing);
    return;
  }
  startEditor(
    ns,
    model.library || '',
    model.params
      ? JSON.stringify({ params: model.params, metadata: model.metadata })
      : undefined
  );
}

function startEditor(ns, library, serializedState) {
  const mount = document.createElement('div');
  root.appendChild(mount);
  hasLibrary = Boolean(library);
  editor = new ns.Editor(
    library,
    serializedState,
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

/**
 * Stored content that names a library version this host does not have cannot
 * be opened: the editor would ask for that version's semantics and get a 404.
 * Instead of building that editor, the page says which versions are missing
 * and — when every one of them has a newer installed version (the edit
 * model's `missingLibraries`, see library-resolution.ts) — offers to upgrade
 * the content to those versions. The upgraded content is opened in the
 * editor unsaved: nothing is written until the author saves it.
 */
function offerLibraryUpgrade(ns, model, missing) {
  readyState = 'blocked';
  // The upgrade starts from the stored main library's version.
  const upgradable =
    /^\S+ \d+\.\d+$/.test(model.library || '') &&
    missing.every(
      (entry) => typeof entry.upgrade === 'string' && entry.upgrade
    );
  const names = missing.map((entry) => entry.library).join(', ');
  const message = upgradable
    ? `This content uses library versions that are not installed: ${names}. ` +
      `Upgrade it to the installed ${missing.map((entry) => entry.upgrade).join(', ')} ` +
      'to edit it, or replace it with a package made for the installed libraries.'
    : `This content uses library versions that are not installed: ${names}. ` +
      'No newer installed version can replace them; replace the content ' +
      'with a package made for the installed libraries.';
  showError(message, { code: 'library-missing', revision });
  if (!upgradable || !upgradeBox || !upgradeButton) {
    return;
  }
  upgradeBox.hidden = false;
  const label = upgradeButton.textContent;
  let running = false;
  upgradeButton.addEventListener('click', async () => {
    if (running || readyState !== 'blocked') {
      return;
    }
    running = true;
    upgradeButton.disabled = true;
    upgradeButton.textContent = 'Upgrading…';
    let upgraded;
    try {
      upgraded = await upgradeContent(ns, model, missing);
    } catch (error) {
      upgradeButton.disabled = false;
      upgradeButton.textContent = label;
      showError(`The content could not be upgraded: ${error.message}`, {
        code: 'library-upgrade-failed',
        revision
      });
      return;
    } finally {
      running = false;
    }
    upgradeBox.hidden = true;
    showError('');
    readyState = 'loading';
    changedOnReady = true;
    try {
      startEditor(
        ns,
        upgraded.library,
        JSON.stringify({ params: upgraded.params, metadata: upgraded.metadata })
      );
    } catch (error) {
      // As when bootstrap's own editor fails to construct.
      failReady(error.message);
    }
  });
}

/** Every `library` string of a `{ library, params }` pair nested in `value`. */
function usedLibraries(value, result = new Set()) {
  if (value && typeof value === 'object') {
    if (typeof value.library === 'string' && value.library && value.params) {
      result.add(value.library);
    }
    Object.values(value).forEach((child) => usedLibraries(child, result));
  }
  return result;
}

/**
 * Upgrades the stored parameters to the installed library versions with the
 * H5P core's own `H5P.ContentUpgradeProcess` — the routine H5P's content
 * upgrade page and the editor's save-time upgrade use. It needs only the
 * *target* versions: their semantics (which name the nested library versions
 * a container accepts) and their `upgrades.js`, whose hooks run for every
 * version step between the stored and the installed one. A library without
 * `upgrades.js` just has its version replaced. The stored version itself is
 * never loaded, which is what makes this work when it is not installed.
 *
 * Resolves `{ library, params, metadata }`; rejects with a readable error,
 * including when a nested library is left on a missing version because the
 * installed container does not accept a newer one.
 */
async function upgradeContent(ns, model, missing) {
  let deadline;
  const timedOut = new Promise((_resolve, reject) => {
    deadline = setTimeout(
      () => reject(new Error('The upgrade did not finish in time.')),
      UPGRADE_TIMEOUT_MS
    );
  });
  try {
    // The loser keeps running unobserved; `offerLibraryUpgrade` starts a
    // fresh run on the next click.
    return await Promise.race([runUpgrade(ns, model, missing), timedOut]);
  } finally {
    clearTimeout(deadline);
  }
}

async function runUpgrade(ns, model, missing) {
  const integration = window.H5PIntegration || {};
  const coreUrl = String(integration.libraryUrl || '').replace(/\/+$/, '');
  const buster = integration.pluginCacheBuster || '';
  if (typeof window.H5P.Version !== 'function') {
    await loadScript(`${coreUrl}/h5p-version.js${buster}`);
  }
  if (typeof window.H5P.ContentUpgradeProcess !== 'function') {
    await loadScript(`${coreUrl}/h5p-content-upgrade-process.js${buster}`);
  }
  const replacements = new Map(
    missing.map((entry) => [entry.library, entry.upgrade])
  );
  const target = replacements.get(model.library) || model.library;
  const [name, fromVersion] = model.library.split(' ');
  const toVersion = target.split(' ')[1];

  const libraries = new Map();
  const scripts = new Map();
  const loadLibraryData = (libraryName, version) => {
    const key = `${libraryName} ${version.major}.${version.minor}`;
    if (!libraries.has(key)) {
      libraries.set(
        key,
        fetchJson(
          ns.getAjaxUrl('libraries', {
            machineName: libraryName,
            majorVersion: version.major,
            minorVersion: version.minor
          })
        ).catch(() => {
          // A version the content already names and this host lacks: an
          // installed container's semantics still accept only that one.
          throw new Error(
            replacements.has(key)
              ? `${key} could not be replaced: an installed library accepts no newer version of it.`
              : `Could not load data for library ${key}.`
          );
        })
      );
    }
    return libraries.get(key).then((library) => {
      const url = library.upgradesScript;
      if (!url) {
        return { ...library, upgradeHooks: undefined };
      }
      if (!scripts.has(url)) {
        // Cache the hooks while this version owns the global registration;
        // another version can replace it before the next use of this URL.
        scripts.set(
          url,
          loadScript(url).then(
            () => {
              const { ContentUpgradeProcess } = window.H5P;
              if (typeof ContentUpgradeProcess.getUpgradeHooks !== 'function') {
                // A core older than this page, e.g. a stale cached copy.
                throw new Error(
                  `The upgrades script for ${key} loaded, but the loaded H5P core does not support getUpgradeHooks.`
                );
              }
              return ContentUpgradeProcess.getUpgradeHooks(library.name);
            },
            () => {
              throw new Error(`Could not load the upgrades script for ${key}.`);
            }
          )
        );
      }
      return scripts.get(url).then((upgradeHooks) => ({
        ...library,
        upgradeHooks
      }));
    });
  };

  const result = await new Promise((resolve, reject) => {
    const settle = (error, upgraded) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(upgradeError(error)));
      } else {
        resolve(upgraded);
      }
    };
    try {
      new window.H5P.ContentUpgradeProcess(
        name,
        new window.H5P.Version(fromVersion),
        new window.H5P.Version(toVersion),
        JSON.stringify({ params: model.params, metadata: model.metadata }),
        contentId,
        (libraryName, version, next) => {
          loadLibraryData(libraryName, version).then(
            (library) => next(null, library),
            (error) => next(error)
          );
        },
        settle
      );
    } catch (error) {
      settle(error);
    }
  });
  const upgraded = JSON.parse(result);
  const left = [...usedLibraries(upgraded.params)].filter((library) =>
    replacements.has(library)
  );
  if (left.length) {
    throw new Error(
      `${left.join(', ')} could not be replaced: the installed ${target} ` +
        'accepts no installed version of it.'
    );
  }
  return {
    library: target,
    params: upgraded.params,
    metadata: upgraded.metadata
  };
}

// The error objects `H5P.ContentUpgradeProcess` reports, worded like the
// H5P content upgrade page words them. It also passes on, unchanged, a string
// from the library loader it was given and an exception an upgrade hook threw.
function upgradeError(error) {
  switch (error?.type) {
    case 'errorParamsBroken':
      return 'The parameters are broken.';
    case 'libraryMissing':
      return `Missing required library ${error.library}.`;
    case 'scriptMissing':
      return `Could not load the upgrades script for ${error.library}.`;
    case 'errorTooHighVersion':
      return `The parameters contain ${error.used} while only ${error.supported} or earlier are supported.`;
    case 'errorNotSupported':
      return `The parameters contain ${error.used}, which is not supported.`;
    default:
      if (typeof error === 'string') {
        return error;
      }
      return typeof error?.message === 'string' && error.message
        ? error.message
        : 'Unknown error.';
  }
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
