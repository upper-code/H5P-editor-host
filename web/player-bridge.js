/*
 * Pick mode for the H5P player page. GPL-3.0-or-later; see COPYING.
 * An embedder that frames `GET …/api/v1/content/:id/render` can let the user
 * click an element of the content and receive its `subContentId`; the
 * postMessage DTOs are in docs/USAGE.md.
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

  function contentId(from) {
    const content =
      (from && from.closest && from.closest('.h5p-content')) ||
      document.querySelector('.h5p-content');
    return content ? content.getAttribute('data-content-id') : null;
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
