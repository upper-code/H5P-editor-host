/*
 * The H5P player page's side of the framing parent. GPL-3.0-or-later; see
 * COPYING. An embedder that frames `GET …/api/v1/content/:id/render` can let
 * the user click an element of the content and receive its `subContentId`
 * (pick mode). Framed, the script also opens a VMB.InteractiveBook's own
 * remote-control bridge to the parent and carries the bytes of the book's
 * encrypted exam both ways; the book's protocol stays the book's, not this
 * host's. The postMessage DTOs are in docs/USAGE.md.
 *
 * A classic script, not a module: renderPlayerHtml loads it right after the
 * libraries, so it runs before the core's document-ready `H5P.init`.
 */
(function () {
  'use strict';

  const H5P = window.H5P;
  const query = new URLSearchParams(location.search);
  const framed = window.self !== window.parent;
  const pickParam = query.get('pickMode') === '1';
  // Shelf opens this page top-level: leave it exactly as the core made it.
  if (!H5P || (!framed && !pickParam)) {
    return;
  }

  const ID = 'data-sub-content-id';
  const LIBRARY = 'data-sub-content-library';
  const TAGGED = `[${ID}]`;
  const SELECTED = 'h5p-pick-selected';
  const MODE = 'h5p-pick-mode';
  const ATTACH_WRAPPED =
    typeof Symbol === 'function' ? Symbol('pickAttach') : '__pickAttach';

  function readParentOrigin() {
    const requested = query.get('parentOrigin');
    if (!requested) {
      // The same-origin, reverse-proxied deployment: the parent shares this
      // page's origin.
      return location.origin;
    }
    try {
      const origin = new URL(requested).origin;
      // An opaque origin cannot be a postMessage target.
      return origin === 'null' ? null : origin;
    } catch (error) {
      // Never fall back to this page's own origin: that would aim the
      // messages at the wrong window. Stay silent instead.
      return null;
    }
  }

  const parentOrigin = readParentOrigin();

  // `transfer` lists the ArrayBuffers handed over rather than copied.
  function post(message, transfer) {
    if (!framed || !parentOrigin) {
      return;
    }
    const envelope = Object.assign({ source: 'h5p-player-host' }, message);
    try {
      if (transfer) {
        window.parent.postMessage(envelope, parentOrigin, transfer);
      } else {
        window.parent.postMessage(envelope, parentOrigin);
      }
    } catch (error) {}
  }

  function contentId(from) {
    const content =
      (from && from.closest && from.closest('.h5p-content')) ||
      document.querySelector('.h5p-content');
    return content ? content.getAttribute('data-content-id') : null;
  }

  // ---- Book remote control -----------------------------------------------
  // VMB.InteractiveBook carries its own postMessage bridge (`vmb-host` in,
  // `vmb-book` out; the book's EXAM_BRIDGE_CONTRACT.md). It takes commands
  // only from, and posts events only to, the origins in
  // `behaviour.remoteOrigins` — by default its own, this host's — so a
  // framing parent on another origin could neither hear nor steer it. The
  // parent this page already trusts is added to that list here, before the
  // core's `H5P.init` parses the parameters; from then on the parent talks to
  // the book directly. The book checks every command itself (origin and
  // ancestry); this script neither checks nor relays its protocol.
  // `enableRemoteControl: false` is left to the book: without an exam it then
  // starts no bridge, and the added origin is unused.

  const BOOK_LIBRARY = 'VMB.InteractiveBook ';
  const bookOpen = framed && !!parentOrigin;
  let pageContentId = null;
  if (bookOpen) {
    try {
      pageContentId = contentId();
    } catch (error) {}
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  // The book's own `normalizeOrigin`: anything but a concrete http(s) origin
  // counts as absent.
  function normalizeOrigin(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || trimmed === '*' || trimmed === 'null') {
      return null;
    }
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? parsed.origin
        : null;
    } catch (error) {
      return null;
    }
  }

  // The book's `normalizeOrigins`: a list or a single value, of strings or
  // the editor's `{ origin }` entries.
  function normalizeOrigins(values) {
    if (values === null || values === undefined) {
      return [];
    }
    const origins = [];
    for (const value of Array.isArray(values) ? values : [values]) {
      const origin = normalizeOrigin(
        typeof value === 'string' ? value : value && value.origin
      );
      if (origin && !origins.includes(origin)) {
        origins.push(origin);
      }
    }
    return origins;
  }

  // Adds the parent to the book's `remoteOrigins` and returns the book's
  // parameters, or null for any other content. An authored list that keeps a
  // usable origin is final for the book, so its own default — this page's
  // origin — is written out first when the list is effectively empty. The
  // authored entries stay as written; only missing origins are appended.
  function openBookToParent() {
    const integration = window.H5PIntegration;
    const entry =
      integration &&
      integration.contents &&
      integration.contents['cid-' + pageContentId];
    if (
      !entry ||
      typeof entry.library !== 'string' ||
      !entry.library.startsWith(BOOK_LIBRARY) ||
      typeof entry.jsonContent !== 'string'
    ) {
      return null;
    }
    const params = JSON.parse(entry.jsonContent);
    if (!isPlainObject(params)) {
      return null;
    }
    const behaviour =
      params.behaviour === undefined || params.behaviour === null
        ? {}
        : params.behaviour;
    // An array or a primitive is not the book's shape: leave it to the book.
    if (!isPlainObject(behaviour)) {
      return params;
    }
    const authored = behaviour.remoteOrigins;
    const known = normalizeOrigins(authored);
    const wanted = known.length
      ? [parentOrigin]
      : [location.origin, parentOrigin];
    const added = [];
    for (const candidate of wanted) {
      const origin = normalizeOrigin(candidate);
      if (origin && !known.includes(origin) && !added.includes(origin)) {
        added.push(origin);
      }
    }
    if (added.length) {
      behaviour.remoteOrigins =
        authored === undefined || authored === null
          ? added
          : (Array.isArray(authored) ? authored : [authored]).concat(added);
      params.behaviour = behaviour;
      entry.jsonContent = JSON.stringify(params);
    }
    return params;
  }

  // The exam the book carries (`vmbExam`, encrypted by the embedder's
  // backend), as parsed from this page's own parameters, and the content
  // files its `media` names, spelled exactly as written.
  let exam = null;
  const examMedia = new Set();
  if (bookOpen && pageContentId !== null) {
    let params = null;
    try {
      params = openBookToParent();
    } catch (error) {
      // No integration, no entry, unparseable parameters: the page renders
      // as the core makes it.
    }
    if (params && isPlainObject(params.vmbExam)) {
      exam = params.vmbExam;
      if (Array.isArray(exam.media)) {
        for (const item of exam.media) {
          if (item && typeof item.path === 'string') {
            examMedia.add(item.path);
          }
        }
      }
    }
  }

  // ---- Exam bytes --------------------------------------------------------
  // The book shows a decrypted exam chapter only when the parent injects it
  // (`injectExam`); neither the book nor this host decrypts. The book does
  // not move files, though: the parent fetches the ciphertext of the exam's
  // own media from this page (`exam-cipher`, so it decrypts exactly the copy
  // shown) and hands the plain bytes back (`exam-media`). Those are served
  // as blob URLs through `H5P.getPath`, where every standard library resolves
  // a content file; the core's `hasProtocol` does not take `blob:` for a
  // protocol, so the substitution cannot happen in the parameters instead.
  // A library building a file URL on its own bypasses it.

  // Unwrapped on purpose: `exam-cipher` must read the stored ciphertext even
  // after `exam-media` has mapped the same paths to plain bytes.
  const originalGetPath = H5P.getPath;
  const originalAddQueryParameter = H5P.addQueryParameter;
  // Path → blob URL of the current set.
  let plainMedia = new Map();
  // Every blob URL handed out, including those of replaced sets.
  const issuedUrls = new Set();

  const MEDIA_TYPES = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogg: 'application/ogg',
    ogv: 'video/ogg',
    oga: 'audio/ogg',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    vtt: 'text/vtt'
  };
  const MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;

  // The `mime` the decrypted chapter declares, else a guess by extension: an
  // SVG, for one, renders in an <img> only under its own type.
  function mediaType(declared, filePath) {
    if (typeof declared === 'string' && MEDIA_TYPE.test(declared)) {
      return declared;
    }
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(MEDIA_TYPES, extension)
      ? MEDIA_TYPES[extension]
      : 'application/octet-stream';
  }

  // Realm-independent: `instanceof` fails for a buffer from another realm.
  function isArrayBuffer(value) {
    return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
  }

  function plainMediaUrl(filePath, id) {
    if (
      plainMedia.size === 0 ||
      typeof filePath !== 'string' ||
      String(id) !== pageContentId
    ) {
      return null;
    }
    // `H5P.setSource` appends the cache buster before asking `getPath`; cut
    // exactly that suffix and nothing else.
    const integration = window.H5PIntegration;
    const buster = integration && integration.crossoriginCacheBuster;
    let key = filePath;
    if (typeof buster === 'string' && buster) {
      for (const suffix of ['?' + buster, '&' + buster]) {
        if (key.endsWith(suffix)) {
          key = key.slice(0, -suffix.length);
          break;
        }
      }
    }
    return plainMedia.get(key) || null;
  }

  if (examMedia.size > 0 && typeof originalGetPath === 'function') {
    // Transparent like the newRunnable wrapper: same `this`, arguments and
    // result for everything but this page's exam files.
    H5P.getPath = function (filePath, id) {
      let url = null;
      try {
        url = plainMediaUrl(filePath, id);
      } catch (error) {}
      return url || originalGetPath.apply(this, arguments);
    };
    // H5P.Video appends the buster to what `getPath` returned (poster,
    // tracks, a quality switch); `blob:…?buster` would not resolve.
    if (typeof originalAddQueryParameter === 'function') {
      H5P.addQueryParameter = function (url) {
        if (typeof url === 'string' && issuedUrls.has(url)) {
          return url;
        }
        return originalAddQueryParameter.apply(this, arguments);
      };
    }
    // A page kept in the back/forward cache may come back with instances
    // still holding these URLs; only a real unload releases them.
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) {
        return;
      }
      for (const url of issuedUrls) {
        try {
          URL.revokeObjectURL(url);
        } catch (error) {}
      }
      issuedUrls.clear();
      plainMedia = new Map();
    });
  }

  function requestIdOf(data) {
    return data.requestId === undefined ? null : data.requestId;
  }

  // `exam-media`: the parent's plain bytes for every file of the exam's
  // `media`. Checked as a whole — a partial set would leave ciphertext on the
  // page — and applied as a whole.
  function receiveExamMedia(data) {
    const reply = (message) =>
      post(
        Object.assign(
          { contentId: pageContentId, requestId: requestIdOf(data) },
          message
        )
      );
    const refuse = (reason) => reply({ type: 'exam-media-error', reason });
    if (!exam) {
      return refuse('no-exam');
    }
    if (!Array.isArray(data.files)) {
      return refuse('bad-data');
    }
    const received = new Map();
    for (const file of data.files) {
      const filePath = file ? file.path : undefined;
      if (typeof filePath !== 'string' || !examMedia.has(filePath)) {
        return refuse('unknown-path');
      }
      if (received.has(filePath)) {
        return refuse('duplicate');
      }
      if (!isArrayBuffer(file.data)) {
        return refuse('bad-data');
      }
      received.set(filePath, file);
    }
    if (received.size !== examMedia.size) {
      return refuse('incomplete');
    }
    const next = new Map();
    try {
      for (const [filePath, file] of received) {
        const type = mediaType(file.type, filePath);
        next.set(
          filePath,
          URL.createObjectURL(new Blob([file.data], { type }))
        );
      }
    } catch (error) {
      for (const url of next.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch (revokeError) {}
      }
      return refuse('bad-data');
    }
    // The URLs of a replaced set are not revoked: library instances created
    // from them may still hold them, and repeating `injectExam` for the same
    // run does not rebuild the chapter.
    for (const url of next.values()) {
      issuedUrls.add(url);
    }
    plainMedia = next;
    return reply({ type: 'exam-media-ready', count: next.size });
  }

  // Per file, covering both the headers and the body.
  const CIPHER_FETCH_TIMEOUT_MS = 60000;

  function fetchCipher(filePath, signal) {
    return new Promise((resolve, reject) => {
      let timer = 0;
      let onAbort = null;
      const settle = (done, value) => {
        clearTimeout(timer);
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
        }
        done(value);
      };
      onAbort = () => settle(reject, new Error('aborted'));
      timer = setTimeout(
        () => settle(reject, new Error('timed out')),
        CIPHER_FETCH_TIMEOUT_MS
      );
      if (signal) {
        signal.addEventListener('abort', onAbort);
      }
      try {
        const url = originalGetPath.call(H5P, filePath, pageContentId);
        if (typeof url !== 'string') {
          throw new Error('no URL');
        }
        fetch(url, { credentials: 'same-origin', signal })
          .then((response) => {
            if (!response.ok) {
              throw new Error('status ' + response.status);
            }
            return response.arrayBuffer();
          })
          .then(
            (buffer) =>
              isArrayBuffer(buffer)
                ? settle(resolve, buffer)
                : settle(reject, new Error('not bytes')),
            (error) => settle(reject, error)
          );
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  // One set of downloads under one controller: the first failure cancels the
  // rest before the set fails, so a retry never races leftovers of the last.
  function loadCipher() {
    const controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    const paths = Array.from(examMedia);
    return Promise.all(
      paths.map((filePath) =>
        fetchCipher(filePath, controller ? controller.signal : undefined)
      )
    ).then(
      (buffers) =>
        paths.map((filePath, index) => ({
          path: filePath,
          data: buffers[index]
        })),
      (error) => {
        if (controller) {
          controller.abort();
        }
        throw error;
      }
    );
  }

  // Requests arriving while a set downloads wait for it. Nothing is kept
  // once they are answered: the ciphertext may be large, and the next request
  // downloads again.
  let cipherWaiters = null;

  function answerCipher(waiters, files) {
    waiters.forEach((requestId, index) => {
      // A transferred buffer is detached after the post: every waiter but
      // the last gets copies.
      const last = index === waiters.length - 1;
      const sent = files.map((file) => ({
        path: file.path,
        data: last ? file.data : file.data.slice(0)
      }));
      post(
        {
          type: 'exam-cipher',
          contentId: pageContentId,
          requestId,
          vmbExam: exam,
          files: sent
        },
        sent.map((file) => file.data)
      );
    });
  }

  function sendExamCipher(data) {
    const requestId = requestIdOf(data);
    if (!exam) {
      post({
        type: 'exam-cipher-error',
        contentId: pageContentId,
        requestId,
        reason: 'no-exam'
      });
      return;
    }
    if (!cipherWaiters) {
      const waiters = [];
      cipherWaiters = waiters;
      loadCipher()
        .then(
          (files) => {
            cipherWaiters = null;
            answerCipher(waiters, files);
          },
          () => {
            cipherWaiters = null;
            for (const waiting of waiters) {
              post({
                type: 'exam-cipher-error',
                contentId: pageContentId,
                requestId: waiting,
                reason: 'fetch-failed'
              });
            }
          }
        )
        // Posting swallows its own errors; nothing else here may surface as
        // an unhandled rejection on the page.
        .catch(() => {});
    }
    cipherWaiters.push(requestId);
  }

  // ---- Tagging -----------------------------------------------------------
  // The DOM carries no subContentId of its own, so every container a
  // sub-content is attached to gets one. The tag goes on before the library's
  // `attach` runs: a library that attaches a child into the same container
  // from inside its own `attach` would otherwise have the child tag it first.

  function elementOf(target) {
    const element = target && target.jquery ? target[0] : target;
    return element && element.nodeType === 1 ? element : null;
  }

  function tag(target, id, library) {
    const element = elementOf(target);
    // An outer tag set earlier wins.
    if (!element || element.hasAttribute(ID)) {
      return;
    }
    element.setAttribute(ID, id);
    if (library) {
      element.setAttribute(LIBRARY, library);
    }
  }

  // Containers attached later — book chapters, VMB.Column/H5P.Row children —
  // and re-attaches go through the instance's own `attach`.
  function wrapAttach(instance, id, library) {
    if (
      !instance ||
      typeof instance.attach !== 'function' ||
      instance[ATTACH_WRAPPED]
    ) {
      return;
    }
    const attach = instance.attach;
    // A plain assignment, like a library's own: a non-enumerable own `attach`
    // would hide the prototype's from `for…in`. The flag stays out of sight.
    Object.defineProperty(instance, ATTACH_WRAPPED, { value: true });
    instance.attach = function () {
      try {
        tag(arguments[0], id, library);
      } catch (error) {}
      return attach.apply(this, arguments);
    };
  }

  // Wraps whatever `H5P.newRunnable` is at this point: a library may have
  // replaced the core's at load time (VMB.Adapt does), and this script loads
  // after the libraries.
  const newRunnable = H5P.newRunnable;
  if (typeof newRunnable === 'function') {
    H5P.newRunnable = function (library, runnableContentId, $attachTo) {
      let id = null;
      let name = '';
      try {
        if (library && library.subContentId) {
          id = String(library.subContentId);
          name =
            typeof library.library === 'string'
              ? library.library.split(' ')[0]
              : '';
          if ($attachTo !== undefined) {
            tag($attachTo, id, name);
          }
        }
      } catch (error) {
        id = null;
      }
      const instance = newRunnable.apply(this, arguments);
      if (id) {
        try {
          wrapAttach(instance, id, name);
        } catch (error) {}
      }
      return instance;
    };
  }

  // ---- Pick mode ---------------------------------------------------------

  let pickEnabled = false;
  // Lower-cased ids the parent can highlight; null means "any tagged".
  let selectable = null;
  let selected = null;

  function clearSelection() {
    if (selected) {
      selected.classList.remove(SELECTED);
      selected = null;
    }
  }

  function setPickMode(enabled, ids) {
    pickEnabled = enabled;
    selectable = Array.isArray(ids)
      ? new Set(
          ids
            .filter((value) => typeof value === 'string')
            .map((value) => value.toLowerCase())
        )
      : null;
    document.documentElement.classList.toggle(MODE, enabled);
    if (!enabled) {
      clearSelection();
    }
  }

  function isSelectable(id) {
    return selectable === null || selectable.has(String(id).toLowerCase());
  }

  function closestTagged(node) {
    const element =
      node && node.nodeType === 1 ? node : node && node.parentElement;
    return element && element.closest ? element.closest(TAGGED) : null;
  }

  // The tagged ancestors of `node`, innermost first.
  function taggedChain(node) {
    const chain = [];
    let element = closestTagged(node);
    while (element) {
      chain.push(element);
      element = closestTagged(element.parentElement);
    }
    return chain;
  }

  function onClick(event) {
    if (!pickEnabled) {
      return;
    }
    const chain = taggedChain(event.target);
    // The book's own shell (navigation, table of contents, cover button)
    // keeps working, so the user can turn chapters.
    if (chain.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = chain.find((element) =>
      isSelectable(element.getAttribute(ID))
    );
    if (!target) {
      return;
    }
    // The frame goes on the element this click went through, not on a lookup
    // by id: older books can hold copies sharing one subContentId.
    clearSelection();
    target.classList.add(SELECTED);
    selected = target;
    post({
      type: 'picked',
      contentId: contentId(target),
      subContentId: target.getAttribute(ID),
      library: target.getAttribute(LIBRARY) || '',
      path: chain.map((element) => element.getAttribute(ID))
    });
  }

  // Keeps drags, swipes and custom controls inside a tagged element from
  // starting. Never preventDefault here: on a touch it would suppress the
  // synthetic click the pick relies on.
  function onPress(event) {
    if (pickEnabled && closestTagged(event.target)) {
      event.stopImmediatePropagation();
    }
  }

  window.addEventListener('click', onClick, { capture: true });
  for (const type of [
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'touchstart',
    'touchend'
  ]) {
    window.addEventListener(type, onPress, { capture: true, passive: true });
  }

  window.addEventListener('message', (event) => {
    if (
      !parentOrigin ||
      event.origin !== parentOrigin ||
      event.source !== window.parent
    ) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== 'editor-embedder') {
      return;
    }
    if (data.type === 'pick-mode') {
      setPickMode(data.enabled === true, data.selectable);
    } else if (data.type === 'pick-clear') {
      clearSelection();
    } else if (data.type === 'exam-media') {
      receiveExamMedia(data);
    } else if (data.type === 'exam-cipher') {
      sendExamCipher(data);
    }
  });

  // ---- Styles ------------------------------------------------------------
  // `pointer`, not `crosshair`: iOS Safari only synthesizes a click on a tap
  // over a non-interactive element when it shows a pointer cursor.
  const style = document.createElement('style');
  style.textContent = [
    `html.${MODE} ${TAGGED} { cursor: pointer; }`,
    `.${SELECTED} { outline: 3px solid #facc15 !important; outline-offset: -3px; }`,
    `html.${MODE} ${TAGGED} :is(iframe, video, audio, embed, object) { pointer-events: none; }`
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  if (pickParam) {
    setPickMode(true);
  }

  // ---- Readiness ---------------------------------------------------------

  let initialized = false;
  const dispatcher = H5P.externalDispatcher;
  if (dispatcher && typeof dispatcher.on === 'function') {
    // Runs inside the core's `H5P.init`, whose dispatcher does not catch:
    // nothing here may throw into it.
    dispatcher.on('initialized', () => {
      if (initialized) {
        return;
      }
      initialized = true;
      let id = null;
      try {
        id = contentId();
      } catch (error) {}
      post({ type: 'player-ready', contentId: id });
    });
  }
  // jQuery 3 runs ready handlers in order and isolates them, so this one runs
  // after the core's `H5P.init` even if that threw. `H5P.init` triggers
  // 'initialized' synchronously (only the reset-state dialog waits for
  // `H5P.getUserData`), so by now it has fired if it ever will.
  if (typeof H5P.jQuery === 'function') {
    H5P.jQuery(document).ready(() => {
      if (!initialized) {
        post({ type: 'player-error', contentId: contentId() });
      }
    });
  }

  // ---- Resize ------------------------------------------------------------
  // Framed without h5p-resizer at the parent, the core never listens to the
  // window's resize, so content would not reflow when the iframe changes size.
  if (framed) {
    let frame = 0;
    window.addEventListener('resize', () => {
      if (H5P.externalEmbed === false || frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        for (const instance of H5P.instances || []) {
          try {
            H5P.trigger(instance, 'resize');
          } catch (error) {}
        }
      });
    });
  }
})();
