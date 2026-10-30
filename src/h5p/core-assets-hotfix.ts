/**
 * Static hotfix for core assets that `@lumieducation/h5p-server` does not
 * register (issue #3374 in its own tracker, and the 1.28 core it predates).
 *
 * H5P core 1.28 (bundled under `assets/h5p/core`) loads, per `H5PCore::$styles`
 * and `H5PCore::$scripts` in the upstream PHP library, these files that the
 * h5p-server 9.3.3 `playerAssetList.json` / `editorAssetList.json` omit:
 *
 *   - `styles/h5p-fonts.css` — since 1.28 the only place that declares the
 *     `H5P` icon font, Open Sans, Inter and the `h5p-theme` font. Without it
 *     every core and editor icon (fullscreen, action bar, dialog close…) and
 *     all text fonts are gone in both the player and the editor.
 *   - `styles/h5p-theme.css`, `styles/h5p-theme-variables.css` — the 1.28
 *     theme: `--h5p-theme-*` variables and the density classes the themed
 *     content types (Dialogcards, Flashcards, MemoryGame, …) are styled with.
 *   - `styles/h5p-tooltip.css`, `js/h5p-tooltip.js` — `H5P.Tooltip`.
 *   - `styles/h5p-table.css` — table styling; scoped under `.h5p-iframe`, so it
 *     takes effect in the player page only.
 *
 * The fix derives the core asset directory and the cache-buster query from the
 * core entries already present in the rendered model and splices the missing
 * files in directly after the last core entry, in `H5PCore::$styles` order.
 * Their position relative to `h5p.css` is otherwise immaterial
 * (`h5p-fonts.css` holds only `@font-face` rules). This is a purely static
 * rewrite of an asset list that has already been built: it performs no
 * network I/O and adds no runtime fetching — the injected URLs point at the
 * same `assets/h5p/core` files this app already serves.
 *
 * Reconstructed from the public upstream issue in the h5p-server package's own
 * tracker and the public upstream core asset lists.
 */

import type { IIntegration } from '@lumieducation/h5p-server';

/**
 * Core styles h5p-server does not list, in `H5PCore::$styles` order. Every
 * runtime CSS file under `assets/h5p/core/styles` is either in h5p-server's
 * asset lists or here (enforced by test/core-assets-hotfix.test.js).
 */
export const CORE_EXTRA_STYLES: readonly string[] = [
  'h5p-fonts.css',
  'h5p-theme.css',
  'h5p-theme-variables.css',
  'h5p-tooltip.css',
  'h5p-table.css'
];

/**
 * Core scripts h5p-server does not list. The rest of `H5PCore::$scripts` is
 * already in its asset lists (`request-queue.js` only in the player's, which
 * is the only place `H5P.init` needs it).
 */
export const CORE_EXTRA_SCRIPTS: readonly string[] = ['h5p-tooltip.js'];

// Core scripts are served from `<baseUrl>/core/js/...` and core styles from
// `<baseUrl>/core/styles/...`. Matching the path segment (rather than a fixed
// base URL) keeps this correct if the H5P base URL is ever reconfigured.
const CORE_JS_DIR = '/core/js/';
const CORE_STYLES_DIR = '/core/styles/';

function splitQuery(url: string): { path: string; query: string } {
  const i = url.indexOf('?');
  return i === -1
    ? { path: url, query: '' }
    : { path: url.slice(0, i), query: url.slice(i) };
}

// Matches the core directory as well as the file name, so a library asset that
// happens to share a basename (`/h5p/libraries/X-1.0/h5p-table.css`) does not
// suppress the core file.
function alreadyPresent(
  urls: string[],
  dirNeedle: string,
  fileName: string
): boolean {
  return urls.some((url) =>
    splitQuery(url).path.endsWith(`${dirNeedle}${fileName}`)
  );
}

/**
 * Returns a copy of `urls` with `fileName` spliced in directly after the last
 * entry whose path contains `dirNeedle`, reusing that anchor's directory and
 * query so the injected URL is indistinguishable from the other core assets.
 * If the file is already present the list is returned unchanged (idempotent,
 * and forward-compatible with a future h5p-server that ships the fix). If no
 * core asset is found the list is returned unchanged rather than guessing a URL.
 */
function injectAfterCoreDir(
  urls: string[],
  dirNeedle: string,
  fileName: string
): string[] {
  if (alreadyPresent(urls, dirNeedle, fileName)) {
    return urls;
  }

  let anchorIndex = -1;
  for (let i = 0; i < urls.length; i += 1) {
    if (splitQuery(urls[i]).path.includes(dirNeedle)) {
      anchorIndex = i;
    }
  }
  if (anchorIndex === -1) {
    return urls;
  }

  const { path, query } = splitQuery(urls[anchorIndex]);
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  const next = urls.slice();
  next.splice(anchorIndex + 1, 0, `${dir}${fileName}${query}`);
  return next;
}

// Each injected file becomes the new last core entry, so the next one anchors
// on it and the list order is preserved.
function injectAllAfterCoreDir(
  urls: string[],
  dirNeedle: string,
  fileNames: readonly string[]
): string[] {
  return fileNames.reduce(
    (list, fileName) => injectAfterCoreDir(list, dirNeedle, fileName),
    urls
  );
}

/** Add the unregistered core scripts after the core scripts. */
export function withCoreScripts(scripts: string[]): string[] {
  return injectAllAfterCoreDir(scripts, CORE_JS_DIR, CORE_EXTRA_SCRIPTS);
}

/** Add the unregistered core styles after the core styles. */
export function withCoreStyles(styles: string[]): string[] {
  return injectAllAfterCoreDir(styles, CORE_STYLES_DIR, CORE_EXTRA_STYLES);
}

const DARKROOM_CSS = 'libs/darkroom.css';
const CROPPER_CSS = 'libs/cropper.css';

/**
 * Second asset-list drift between h5p-server 9.3.3 and editor 1.27: the
 * editor replaced Darkroom with Cropper.js (`libs/cropper.{js,css}`; the
 * image popup loads the script itself from `H5PEditor.basePath`), but
 * `editorAssetList.json` still names `libs/darkroom.css`, which the bundled
 * editor no longer ships. The stale entry is a 404 in every editor load and
 * the image-editing popup renders unstyled. Rewrite the file name in place so
 * the list order is preserved; a list without the stale entry is unchanged.
 */
export function withCropperStyles(styles: string[]): string[] {
  return styles.map((url) => {
    const { path, query } = splitQuery(url);
    return path.endsWith(`/${DARKROOM_CSS}`)
      ? `${path.slice(0, -DARKROOM_CSS.length)}${CROPPER_CSS}${query}`
      : url;
  });
}

/** Both editor style fixes (core styles + cropper) for one style list. */
export function withEditorStyles(styles: string[]): string[] {
  return withCropperStyles(withCoreStyles(styles));
}

/**
 * Add the unregistered core assets to the *integration object's* asset lists.
 *
 * The top-level `model.scripts`/`model.styles` only cover the outer document.
 * H5P clients build their runtime iframes from lists carried inside the
 * integration object, which `render()` leaves short of the same files as the
 * top-level lists:
 *
 *   - `integration.editor.assets.{js,css}` — loaded by `H5PEditor.init()` into
 *     the editor's content iframe. This is where the editor *preview* renders,
 *     so without the patch content is unthemed and iconless while editing even
 *     though the saved player page is fine.
 *   - `integration.core.{scripts,styles}` — the list a player uses to build an
 *     `h5p-iframe` via `H5P.getHeadTags`. Inert for the div-embed page this app
 *     serves, but patched too so the fix still holds if an iframe-embed client
 *     is ever added.
 *
 * Returns a shallow clone with only the touched branches replaced; branches
 * that are absent or already complete are left untouched (idempotent). An
 * editor model carries `editor` but no `core`; a player model the reverse —
 * the same call handles both.
 */
export function withCoreAssetsIntegration(
  integration: IIntegration
): IIntegration {
  if (!integration) {
    return integration;
  }
  const next: IIntegration = { ...integration };

  const { editor } = integration;
  if (editor?.assets) {
    next.editor = {
      ...editor,
      assets: {
        ...editor.assets,
        js: withCoreScripts(editor.assets.js || []),
        css: withEditorStyles(editor.assets.css || [])
      }
    };
  }

  const { core } = integration;
  if (core) {
    next.core = {
      ...core,
      scripts: withCoreScripts(core.scripts || []),
      styles: withCoreStyles(core.styles || [])
    };
  }

  return next;
}
