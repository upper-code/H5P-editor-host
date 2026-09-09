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

// How long the H5P editor may take to answer getContent() before the bridge
// gives the save up. Validation is instant; a library upgrade first loads
// scripts, which is what the margin is for.
const SAVE_CALLBACK_TIMEOUT_MS = 60000;

// How long the host may take to answer the save request itself. The request is
// not aborted at the deadline: that would neither stop a write already under
// way nor reveal the id it produced. The parent is told the save failed so it
// can offer a retry, and an answer that still arrives is adopted as long as no
// newer save has started since.
const SAVE_REQUEST_TIMEOUT_MS = 120000;

function parentOrigin() {
  const requested = new URLSearchParams(location.search).get('parentOrigin');
  if (!requested) {
    return location.origin;
  }
  try {
    return new URL(requested).origin;
  } catch (error) {
    return location.origin;
  }
}

const expectedParentOrigin = parentOrigin();

function notify(type, payload = {}) {
  if (window.parent !== window) {
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
          `H5P host request failed (${response.status}).`
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
  ns.enableContentHub = editorIntegration.enableContentHub || false;
  if (editorIntegration.nodeVersionId != null) {
    ns.contentId = editorIntegration.nodeVersionId;
  }
  if (editorIntegration.hub !== undefined) {
    integration.Hub = {
      contentSearchUrl: editorIntegration.hub.contentSearchUrl
    };
  }
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
  ['input', 'change', 'drop'].forEach((type) =>
    doc.addEventListener(type, markChanged, true)
  );
  doc.addEventListener(
    'click',
    (event) => {
      if (
        event.target?.closest?.(
          'button, [role=button], .h5peditor-button, .h5peditor-remove, .h5peditor-move-up, .h5peditor-move-down'
        )
      )
        markChanged();
    },
    true
  );
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
      'The H5P host did not answer the save request in time. Try again.'
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
  if (!editor) {
    showError('The H5P editor is not ready.');
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
    showError('The H5P editor did not respond to the save request. Try again.');
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
    throw new Error('The H5P editor model is incomplete.');
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
    throw new Error('The H5P editor runtime failed to load.');
  }
  const ns = initEditorNamespace(window.H5PIntegration);
  loading.remove();
  root.setAttribute('aria-busy', 'false');
  const mount = document.createElement('div');
  root.appendChild(mount);
  const defaultParams = model.params
    ? JSON.stringify({ params: model.params, metadata: model.metadata })
    : undefined;
  editor = new ns.Editor(
    model.library || '',
    defaultParams,
    mount,
    function onIframeLoaded() {
      // Called by the editor with the form iframe's window as `this`.
      const iframeNs = this.H5PEditor;
      if (iframeNs && typeof iframeNs.getAjaxUrl !== 'function') {
        iframeNs.getAjaxUrl = buildGetAjaxUrl(ns.ajaxPath);
      }
      watchEditorInput(this.document);
    }
  );
  notify('ready', { contentId });
}

bootstrap().catch((error) => showError(error.message));
