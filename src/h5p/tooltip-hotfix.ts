/**
 * Static hotfix for issue #3374 in the h5p-server package's own issue tracker.
 *
 * H5P core (v1.27, bundled under `assets/h5p/core`) ships `js/h5p-tooltip.js`
 * and `styles/h5p-tooltip.css`, but `@lumieducation/h5p-server` does not register
 * them in `playerAssetList.json` / `editorAssetList.json` (still true as of
 * 9.3.3). Consequently the editor and player models produced by `render()` omit
 * both files, and any content that relies on `H5P.Tooltip` renders without its
 * tooltip behaviour and styling.
 *
 * The fix re-adds the two files by deriving the core asset directory and the
 * cache-buster query from the core entries already present in the rendered
 * model, then splicing the tooltip files in immediately after the last core
 * entry. This is a purely static rewrite of an asset list that has already been
 * built: it performs no network I/O and adds no runtime fetching — the injected
 * URLs point at the same `assets/h5p/core` files this app already serves.
 *
 * Reconstructed from the public upstream issue in the h5p-server package's own
 * tracker.
 */

import type { IIntegration } from '@lumieducation/h5p-server';

const TOOLTIP_JS = 'h5p-tooltip.js';
const TOOLTIP_CSS = 'h5p-tooltip.css';

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

function alreadyPresent(urls: string[], fileName: string): boolean {
  return urls.some((url) => splitQuery(url).path.endsWith(`/${fileName}`));
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
  if (alreadyPresent(urls, fileName)) {
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

/** Re-add `h5p-tooltip.js` after the core scripts (see module docs). */
export function withTooltipScripts(scripts: string[]): string[] {
  return injectAfterCoreDir(scripts, CORE_JS_DIR, TOOLTIP_JS);
}

/** Re-add `h5p-tooltip.css` after the core styles (see module docs). */
export function withTooltipStyles(styles: string[]): string[] {
  return injectAfterCoreDir(styles, CORE_STYLES_DIR, TOOLTIP_CSS);
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

/** Both editor style fixes (tooltip + cropper) for one style list. */
export function withEditorStyles(styles: string[]): string[] {
  return withCropperStyles(withTooltipStyles(styles));
}

/**
 * Re-add the tooltip assets to the *integration object's* asset lists.
 *
 * The top-level `model.scripts`/`model.styles` only cover the outer document.
 * H5P clients build their runtime iframes from lists carried inside the
 * integration object, which `render()` leaves short of the tooltip files just
 * like the top-level lists:
 *
 *   - `integration.editor.assets.{js,css}` — loaded by `H5PEditor.init()` into
 *     the editor's content iframe. This is where the editor *preview* renders,
 *     so without the patch `H5P.Tooltip` content is unstyled while editing even
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
export function withTooltipIntegration(
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
        js: withTooltipScripts(editor.assets.js || []),
        css: withEditorStyles(editor.assets.css || [])
      }
    };
  }

  const { core } = integration;
  if (core) {
    next.core = {
      ...core,
      scripts: withTooltipScripts(core.scripts || []),
      styles: withTooltipStyles(core.styles || [])
    };
  }

  return next;
}
