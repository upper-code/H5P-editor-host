/*
 * The player page's stand-in for the CyberShelf viewer global that
 * VMB.SyncLesson waits for. GPL-3.0-or-later; see COPYING.
 *
 * VMB.SyncLesson 1.4 starts its presenter only when `window.ActivePackage`
 * exists; anywhere else it shows "only available in the BookRT environment".
 * It never calls anything on that object: it loads its files through
 * `H5P.getPath`, which this host answers from the unpacked raw archive
 * (src/raw-archives.ts). So an empty object is enough.
 *
 * It must not exist earlier: VMB.Adapt checks for the same global when it
 * loads and only outside the viewer replaces `H5P.newRunnable` with the one
 * these libraries need on an H5P server. renderPlayerHtml therefore loads this
 * classic script after the libraries and before the core's document-ready
 * `H5P.init`, which is when SyncLesson looks. `VMB.isBookRT` stays unset, so
 * VMB.Context keeps resolving its own files through `H5P.getLibraryPath`.
 *
 * Only a page that loaded VMB.SyncLesson gets the global. VMB.EduDict on the
 * same page then names the viewer in the text of its load errors — its only
 * use of the global — and loads its files the same way either way.
 */
(function () {
  'use strict';

  const VMB = window.VMB;
  if (
    !VMB ||
    typeof VMB.SyncLesson !== 'function' ||
    'ActivePackage' in window
  ) {
    return;
  }
  window.ActivePackage = Object.freeze({});
})();
