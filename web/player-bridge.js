/*
 * The H5P preview page's side of the framing parent. GPL-3.0-or-later; see
 * COPYING. Reports readiness and session expiry so the embedder can restore
 * its session and reload the preview, and relays window resizes to content.
 * The postMessage DTOs are in docs/USAGE.md.
 *
 * A classic script, not a module: renderPlayerHtml loads it right after the
 * libraries, so it runs before the core's document-ready `H5P.init`.
 */
(function () {
  'use strict';

  const H5P = window.H5P;
  const query = new URLSearchParams(location.search);
  const framed = window.self !== window.parent;

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

  function post(message) {
    if (!framed || !parentOrigin) {
      return;
    }
    try {
      window.parent.postMessage(
        Object.assign({ source: 'h5p-player-host' }, message),
        parentOrigin
      );
    } catch (error) {}
  }

  function contentId() {
    const content = document.querySelector('.h5p-content');
    return content ? content.getAttribute('data-content-id') : null;
  }

  // ---- Session expiry ----------------------------------------------------
  // A Shelf that serves this page on an origin of its own authorizes the
  // frame with a session of its own, which can lapse, or lose to the cookie
  // of another tab, while the page is open. Its proxy then answers 401, and
  // the content quietly loses files.
  // The parent hears `session-expired` once per series, renews the session,
  // reloads the frame and may send `session-renewed`, which starts a new
  // epoch: a 401 to a request sent before it is not reported.
  //
  // Requests that show a status — fetch and XMLHttpRequest — report a 401
  // to this host directly. Elements (`<img>`, `<script>`, `<link>`, media)
  // show none, so an `error` of one loading from
  // this host asks the embedder's `session/probe` whether the session still
  // holds this content; only its 401 is the signal (204, a 404 where nothing
  // answers the probe, anything else: silence). One probe at a time. The
  // libraries and styles load before this script, so it probes once at the
  // start too — also when the H5P core itself did not load.
  //
  // Only a parent on another origin can hold such a session. One on this
  // page's own origin (the same-origin deployment, also the default without
  // `parentOrigin`) shares its session with the frame, and a lapse of it
  // shows in the parent's own requests. So nothing is watched, wrapped or
  // probed there: a probe would cost a request on every view for nothing,
  // and where nothing answers it, a 404 and a line in the embedder's log.
  // Without a framing parent none of this runs either.

  // `…/` above this script's `web/`: the prefix the page and every URL of
  // this host's go through, as `import.meta.url` gives the editor's bridge.
  function readHostRoot() {
    try {
      const script = document.currentScript;
      if (script && typeof script.src === 'string' && script.src) {
        return new URL('../', script.src).href;
      }
    } catch (error) {}
    const page = /^(.*\/)api\/v1\/content\/[^/]+\/render$/.exec(
      location.pathname
    );
    return page ? location.origin + page[1] : null;
  }

  const sessionWatched =
    framed && !!parentOrigin && parentOrigin !== location.origin;
  const hostRoot = sessionWatched ? readHostRoot() : null;
  let sessionEpoch = 0;
  // The epoch whose `session-expired` went out; one per series.
  let expiredEpoch = -1;

  function sessionExpired(epoch) {
    if (
      !sessionWatched ||
      epoch !== sessionEpoch ||
      expiredEpoch === sessionEpoch
    ) {
      return;
    }
    expiredEpoch = sessionEpoch;
    post({ type: 'session-expired' });
  }

  function isHostUrl(url) {
    if (!hostRoot || typeof url !== 'string' || !url) {
      return false;
    }
    try {
      return new URL(url, location.href).href.startsWith(hostRoot);
    } catch (error) {
      return false;
    }
  }

  // Read before the wrapper below replaces it.
  const pageFetch = typeof window.fetch === 'function' ? window.fetch : null;

  // The content id of this page: its mount point, else its address.
  function probeContentId() {
    try {
      const id = contentId();
      if (id) {
        return id;
      }
    } catch (error) {}
    const page = /\/api\/v1\/content\/([^/]+)\/render$/.exec(location.pathname);
    return page ? decodeURIComponent(page[1]) : null;
  }

  let probing = false;
  // An element failed while a probe ran: ask again once it is done.
  let probeAgain = false;
  // A probe that has not answered by then is abandoned (aborted) and counts
  // as no answer: one that never ends would otherwise hold the slot for the
  // page's life, and no later failure would be asked about.
  const PROBE_TIMEOUT_MS = 15000;

  function probeSession() {
    if (!hostRoot || !pageFetch || expiredEpoch === sessionEpoch) {
      return;
    }
    if (probing) {
      probeAgain = true;
      return;
    }
    const id = probeContentId();
    if (!id) {
      return;
    }
    probing = true;
    const epoch = sessionEpoch;
    const controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    let settled = false;
    let timer = 0;
    const done = (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      probing = false;
      if (status === 401) {
        sessionExpired(epoch);
      }
      if (probeAgain) {
        probeAgain = false;
        probeSession();
      }
    };
    const url =
      hostRoot +
      'session/probe?contentId=' +
      encodeURIComponent(id) +
      '&op=render';
    timer = setTimeout(() => {
      if (controller) {
        controller.abort();
      }
      done(0);
    }, PROBE_TIMEOUT_MS);
    let request;
    try {
      request = pageFetch.call(window, url, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
    } catch (error) {
      done(0);
      return;
    }
    Promise.resolve(request).then(
      (response) => done(response ? response.status : 0),
      () => done(0)
    );
  }

  const RESOURCE_ELEMENTS = [
    'IMG',
    'SCRIPT',
    'LINK',
    'VIDEO',
    'AUDIO',
    'SOURCE',
    'TRACK'
  ];

  // A failed load does not bubble, but passes `window` while capturing.
  function onResourceError(event) {
    const target = event && event.target;
    if (!target || target.nodeType !== 1) {
      return;
    }
    const tag = String(target.tagName || '').toUpperCase();
    if (!RESOURCE_ELEMENTS.includes(tag)) {
      return;
    }
    const url = tag === 'LINK' ? target.href : target.currentSrc || target.src;
    if (isHostUrl(url)) {
      probeSession();
    }
  }

  if (hostRoot) {
    window.addEventListener(
      'message',
      (event) => {
        if (
          event.origin === parentOrigin &&
          event.source === window.parent &&
          event.data &&
          event.data.source === 'editor-embedder' &&
          event.data.type === 'session-renewed'
        ) {
          sessionEpoch += 1;
        }
      },
      false
    );
    window.addEventListener('error', onResourceError, true);

    if (pageFetch) {
      // Transparent: the same `this`, arguments and promise.
      window.fetch = function () {
        const epoch = sessionEpoch;
        const input = arguments[0];
        const result = pageFetch.apply(this, arguments);
        if (result && typeof result.then === 'function') {
          result.then(
            (response) => {
              const url =
                (response && response.url) ||
                (typeof input === 'string' ? input : input && input.url);
              if (response && response.status === 401 && isHostUrl(url)) {
                sessionExpired(epoch);
              }
            },
            () => {}
          );
        }
        return result;
      };
    }

    const xhrPrototype =
      typeof window.XMLHttpRequest === 'function'
        ? window.XMLHttpRequest.prototype
        : null;
    const xhrSend = xhrPrototype && xhrPrototype.send;
    if (typeof xhrSend === 'function') {
      xhrPrototype.send = function () {
        const xhr = this;
        const epoch = sessionEpoch;
        const onLoadEnd = () => {
          xhr.removeEventListener('loadend', onLoadEnd);
          if (xhr.status === 401 && isHostUrl(xhr.responseURL)) {
            sessionExpired(epoch);
          }
        };
        xhr.addEventListener('loadend', onLoadEnd);
        try {
          return xhrSend.apply(xhr, arguments);
        } catch (error) {
          // Refused before it started: the `loadend` that may come is the
          // running request's, not this call's.
          xhr.removeEventListener('loadend', onLoadEnd);
          throw error;
        }
      };
    }

    // The start-up check.
    probeSession();
  }

  // Top-level previews use the core's own lifecycle and resize handling.
  if (!H5P || !framed) {
    return;
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
