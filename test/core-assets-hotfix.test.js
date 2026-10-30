const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  CORE_EXTRA_STYLES,
  CORE_EXTRA_SCRIPTS,
  withCoreScripts,
  withCoreStyles,
  withCropperStyles,
  withEditorStyles,
  withCoreAssetsIntegration
} = require('../build/src/h5p/core-assets-hotfix');

const appRoot = path.resolve(__dirname, '..');
const coreDir = path.join(appRoot, 'assets/h5p/core');

// Core asset URLs as emitted by h5p-server 9.3.3 (see render probe), i.e. the
// exact list that leaves out the files core 1.28 needs on top of them.
const CORE_SCRIPTS = [
  '/h5p/core/js/jquery.js?version=1.28',
  '/h5p/core/js/h5p.js?version=1.28',
  '/h5p/core/js/h5p-action-bar.js?version=1.28',
  '/h5p/editor/scripts/h5peditor-editor.js?version=1.28'
];
const CORE_STYLES = [
  '/h5p/core/styles/h5p.css?version=1.28',
  '/h5p/core/styles/h5p-core-button.css?version=1.28',
  '/h5p/editor/styles/css/application.css?version=1.28'
];
// What withCoreStyles makes of CORE_STYLES: the five extra core styles in
// H5PCore::$styles order, after the last core entry, with its query.
const PATCHED_STYLES = [
  '/h5p/core/styles/h5p.css?version=1.28',
  '/h5p/core/styles/h5p-core-button.css?version=1.28',
  '/h5p/core/styles/h5p-fonts.css?version=1.28',
  '/h5p/core/styles/h5p-theme.css?version=1.28',
  '/h5p/core/styles/h5p-theme-variables.css?version=1.28',
  '/h5p/core/styles/h5p-tooltip.css?version=1.28',
  '/h5p/core/styles/h5p-table.css?version=1.28',
  '/h5p/editor/styles/css/application.css?version=1.28'
];
const TOOLTIP_JS = '/h5p/core/js/h5p-tooltip.js?version=1.28';

test('tooltip script is injected after the last core js, matching dir and query', () => {
  assert.deepEqual(withCoreScripts(CORE_SCRIPTS), [
    '/h5p/core/js/jquery.js?version=1.28',
    '/h5p/core/js/h5p.js?version=1.28',
    '/h5p/core/js/h5p-action-bar.js?version=1.28',
    TOOLTIP_JS,
    '/h5p/editor/scripts/h5peditor-editor.js?version=1.28'
  ]);
});

test('all extra core styles are injected after the last core css, in order', () => {
  assert.deepEqual(withCoreStyles(CORE_STYLES), PATCHED_STYLES);
});

test('injection is idempotent, also when only some files are present', () => {
  const scripts = withCoreScripts(CORE_SCRIPTS);
  assert.deepEqual(withCoreScripts(scripts), scripts);
  assert.deepEqual(withCoreStyles(PATCHED_STYLES), PATCHED_STYLES);
  // A future h5p-server that registers h5p-fonts.css itself: it is not
  // duplicated, the others still follow the last core entry.
  const partial = [
    '/h5p/core/styles/h5p.css?version=1.28',
    '/h5p/core/styles/h5p-fonts.css?version=1.28'
  ];
  const out = withCoreStyles(partial);
  assert.equal(
    out.filter((url) => url.includes('/h5p-fonts.css')).length,
    1,
    'h5p-fonts.css is not duplicated'
  );
  assert.equal(out.length, 1 + CORE_EXTRA_STYLES.length);
});

test('lists without core assets are returned unchanged rather than guessed', () => {
  const libraryOnly = [
    '/h5p/libraries/H5P.Blanks-1.14/js/blanks.js?version=1.14'
  ];
  assert.deepEqual(withCoreScripts(libraryOnly), libraryOnly);
  assert.deepEqual(withCoreStyles([]), []);
});

test('a library file sharing a basename does not suppress the core file', () => {
  const styles = [
    '/h5p/core/styles/h5p.css?version=1.28',
    '/h5p/libraries/X-1.0/h5p-table.css?version=1.0',
    '/h5p/libraries/X-1.0/h5p-tooltip.css?version=1.0'
  ];
  const out = withCoreStyles(styles);
  assert.ok(out.includes('/h5p/core/styles/h5p-table.css?version=1.28'));
  assert.ok(out.includes('/h5p/core/styles/h5p-tooltip.css?version=1.28'));
  // Library entries stay after the core block, untouched.
  assert.deepEqual(out.slice(-2), styles.slice(1));
  const scripts = [
    '/h5p/core/js/h5p.js',
    '/h5p/libraries/X-1.0/h5p-tooltip.js'
  ];
  assert.deepEqual(withCoreScripts(scripts), [
    '/h5p/core/js/h5p.js',
    '/h5p/core/js/h5p-tooltip.js',
    '/h5p/libraries/X-1.0/h5p-tooltip.js'
  ]);
});

// The editor renders its content preview inside an iframe built from
// integration.editor.assets, so that list has to carry the core files too.
test('editor integration: core assets are added to integration.editor.assets', () => {
  const integration = {
    editor: {
      nodeVersionId: 'new',
      assets: { js: CORE_SCRIPTS.slice(), css: CORE_STYLES.slice() }
    }
  };
  const out = withCoreAssetsIntegration(integration);

  assert.ok(out.editor.assets.js.includes(TOOLTIP_JS));
  assert.deepEqual(out.editor.assets.css, PATCHED_STYLES);
  // Non-asset editor fields are preserved.
  assert.equal(out.editor.nodeVersionId, 'new');
  // The input is not mutated.
  assert.equal(integration.editor.assets.js.length, CORE_SCRIPTS.length);
  assert.equal(integration.editor.assets.css.length, CORE_STYLES.length);
});

// A player model carries integration.core (used to build an h5p-iframe via
// H5P.getHeadTags) instead of integration.editor.
test('player integration: core assets are added to integration.core', () => {
  const integration = {
    core: { scripts: CORE_SCRIPTS.slice(), styles: CORE_STYLES.slice() }
  };
  const out = withCoreAssetsIntegration(integration);

  assert.ok(out.core.scripts.includes(TOOLTIP_JS));
  assert.deepEqual(out.core.styles, PATCHED_STYLES);
  assert.equal(integration.core.scripts.length, CORE_SCRIPTS.length);
});

test('integration patch is idempotent and leaves absent branches alone', () => {
  const editorOnly = {
    editor: { assets: { js: CORE_SCRIPTS.slice(), css: CORE_STYLES.slice() } }
  };
  const once = withCoreAssetsIntegration(editorOnly);
  const twice = withCoreAssetsIntegration(once);
  assert.deepEqual(twice, once);
  // No core branch was invented.
  assert.equal(once.core, undefined);
});

test('the stale darkroom.css entry is rewritten to cropper.css in place', () => {
  // h5p-server 9.3.3 still lists Darkroom; editor 1.27 ships Cropper instead.
  const styles = [
    '/h5p/core/styles/h5p.css?version=1.28',
    '/h5p/editor/libs/darkroom.css?version=1.28',
    '/h5p/editor/styles/css/application.css?version=1.28'
  ];
  assert.deepEqual(withCropperStyles(styles), [
    '/h5p/core/styles/h5p.css?version=1.28',
    '/h5p/editor/libs/cropper.css?version=1.28',
    '/h5p/editor/styles/css/application.css?version=1.28'
  ]);
  // Idempotent, and a list without the stale entry is untouched.
  assert.deepEqual(
    withCropperStyles(withCropperStyles(styles)),
    withCropperStyles(styles)
  );
  assert.deepEqual(withCropperStyles(CORE_STYLES), CORE_STYLES);
  // The combined editor fix applies both rewrites.
  const combined = withEditorStyles(styles);
  for (const file of CORE_EXTRA_STYLES) {
    assert.ok(combined.includes(`/h5p/core/styles/${file}?version=1.28`));
  }
  assert.ok(combined.some((url) => url.includes('/editor/libs/cropper.css')));
  assert.ok(!combined.some((url) => url.includes('darkroom')));
  // ...and reaches the editor iframe's own list through the integration.
  const integration = withCoreAssetsIntegration({
    editor: { assets: { js: [], css: styles } }
  });
  assert.ok(
    !integration.editor.assets.css.some((url) => url.includes('darkroom'))
  );
});

// Completeness: the next core or h5p-server update must not silently drop a
// file again (the 1.28 h5p.css no longer declares any @font-face, so a missing
// h5p-fonts.css would take every icon with it). The asset lists are read from
// the installed h5p-server, so a dependency bump is checked too.
function serverAssetLists() {
  // The package entry is build/src/index.js, next to the two lists.
  const dir = path.dirname(require.resolve('@lumieducation/h5p-server'));
  return ['playerAssetList.json', 'editorAssetList.json'].map((name) =>
    JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
  );
}

// Admin and hub styles belong to pages this host does not serve (the hub is
// disabled); they are neither registered nor injected.
const NOT_SERVED_STYLES = /^(h5p-admin|h5p-hub-.*)\.css$/;

test('every runtime core style is registered by h5p-server or injected here', () => {
  const registered = new Set(
    serverAssetLists().flatMap((list) =>
      Object.values(list.styles)
        .flat()
        .map((entry) => path.basename(entry))
    )
  );
  const extra = new Set(CORE_EXTRA_STYLES);
  const missing = fs
    .readdirSync(path.join(coreDir, 'styles'))
    .filter((file) => file.endsWith('.css') && !NOT_SERVED_STYLES.test(file))
    .filter((file) => !registered.has(file) && !extra.has(file));
  assert.deepEqual(missing, [], 'unregistered core styles');
});

// Core scripts outside `H5PCore::$scripts`: the admin pages (content upgrade,
// library list/details, data views, display options), the hub, the embed and
// resizer scripts for third-party sites, and helpers only those pages load.
// A core update that adds any other script fails the test below until it is
// either registered by h5p-server, added to CORE_EXTRA_SCRIPTS or listed here.
const NOT_SERVED_SCRIPTS = new Set([
  'h5p-content-upgrade.js',
  'h5p-content-upgrade-process.js',
  'h5p-content-upgrade-worker.js',
  'h5p-data-view.js',
  'h5p-display-options.js',
  'h5p-embed.js',
  'h5p-hub-registration.js',
  'h5p-hub-sharing.js',
  'h5p-library-details.js',
  'h5p-library-list.js',
  'h5p-resizer.js',
  'h5p-utils.js',
  'h5p-version.js'
]);

test('every runtime core script is registered by h5p-server or injected here', () => {
  const registered = new Set(
    serverAssetLists().flatMap((list) =>
      Object.values(list.scripts)
        .flat()
        .map((entry) => path.basename(entry))
    )
  );
  const extra = new Set(CORE_EXTRA_SCRIPTS);
  const missing = fs
    .readdirSync(path.join(coreDir, 'js'))
    .filter((file) => file.endsWith('.js') && !NOT_SERVED_SCRIPTS.has(file))
    .filter((file) => !registered.has(file) && !extra.has(file));
  assert.deepEqual(missing, [], 'unregistered core scripts');
});

test('every injected core file exists', () => {
  for (const file of CORE_EXTRA_STYLES) {
    assert.ok(fs.existsSync(path.join(coreDir, 'styles', file)), file);
  }
  for (const file of CORE_EXTRA_SCRIPTS) {
    assert.ok(fs.existsSync(path.join(coreDir, 'js', file)), file);
  }
});

test('every url() in the core stylesheets resolves to a file', () => {
  const stylesDir = path.join(coreDir, 'styles');
  const broken = [];
  for (const file of fs.readdirSync(stylesDir)) {
    if (!file.endsWith('.css')) continue;
    const css = fs.readFileSync(path.join(stylesDir, file), 'utf8');
    for (const [, raw] of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (/^(data:|https?:|\/\/|#)/.test(raw)) continue;
      const target = raw.split(/[?#]/)[0];
      if (!fs.existsSync(path.resolve(stylesDir, target))) {
        broken.push(`${file}: ${raw}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
