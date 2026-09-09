const assert = require('node:assert/strict');
const test = require('node:test');

const {
  withTooltipScripts,
  withTooltipStyles,
  withCropperStyles,
  withEditorStyles,
  withTooltipIntegration
} = require('../build/src/h5p/tooltip-hotfix');

// Core asset URLs as emitted by h5p-server 9.3.3 (see render probe), i.e. the
// exact list that upstream issue #3374 leaves the tooltip files out of.
const CORE_SCRIPTS = [
  '/h5p/core/js/jquery.js?version=1.27',
  '/h5p/core/js/h5p.js?version=1.27',
  '/h5p/core/js/h5p-action-bar.js?version=1.27',
  '/h5p/editor/scripts/h5peditor-editor.js?version=1.27'
];
const CORE_STYLES = [
  '/h5p/core/styles/h5p.css?version=1.27',
  '/h5p/core/styles/h5p-core-button.css?version=1.27',
  '/h5p/editor/styles/css/application.css?version=1.27'
];

test('tooltip script is injected after the last core js, matching dir and query', () => {
  const out = withTooltipScripts(CORE_SCRIPTS);
  assert.equal(out.length, CORE_SCRIPTS.length + 1);
  // Spliced in right after the last /core/js/ entry, before the editor script.
  assert.deepEqual(out, [
    '/h5p/core/js/jquery.js?version=1.27',
    '/h5p/core/js/h5p.js?version=1.27',
    '/h5p/core/js/h5p-action-bar.js?version=1.27',
    '/h5p/core/js/h5p-tooltip.js?version=1.27',
    '/h5p/editor/scripts/h5peditor-editor.js?version=1.27'
  ]);
});

test('tooltip style is injected after the last core css, matching dir and query', () => {
  const out = withTooltipStyles(CORE_STYLES);
  assert.deepEqual(out, [
    '/h5p/core/styles/h5p.css?version=1.27',
    '/h5p/core/styles/h5p-core-button.css?version=1.27',
    '/h5p/core/styles/h5p-tooltip.css?version=1.27',
    '/h5p/editor/styles/css/application.css?version=1.27'
  ]);
});

test('injection is idempotent when the tooltip file is already present', () => {
  const withTooltip = withTooltipScripts(CORE_SCRIPTS);
  assert.deepEqual(withTooltipScripts(withTooltip), withTooltip);
});

test('lists without core assets are returned unchanged rather than guessed', () => {
  const libraryOnly = [
    '/h5p/libraries/H5P.Blanks-1.14/js/blanks.js?version=1.14'
  ];
  assert.deepEqual(withTooltipScripts(libraryOnly), libraryOnly);
  assert.deepEqual(withTooltipStyles([]), []);
});

// The editor renders its content preview inside an iframe built from
// integration.editor.assets, so that list has to carry the tooltip files too.
test('editor integration: tooltip is added to integration.editor.assets', () => {
  const integration = {
    editor: {
      nodeVersionId: 'new',
      assets: { js: CORE_SCRIPTS.slice(), css: CORE_STYLES.slice() }
    }
  };
  const out = withTooltipIntegration(integration);

  assert.ok(
    out.editor.assets.js.includes('/h5p/core/js/h5p-tooltip.js?version=1.27')
  );
  assert.ok(
    out.editor.assets.css.includes(
      '/h5p/core/styles/h5p-tooltip.css?version=1.27'
    )
  );
  // Non-asset editor fields are preserved.
  assert.equal(out.editor.nodeVersionId, 'new');
  // The input is not mutated.
  assert.equal(integration.editor.assets.js.length, CORE_SCRIPTS.length);
});

// A player model carries integration.core (used to build an h5p-iframe via
// H5P.getHeadTags) instead of integration.editor.
test('player integration: tooltip is added to integration.core', () => {
  const integration = {
    core: { scripts: CORE_SCRIPTS.slice(), styles: CORE_STYLES.slice() }
  };
  const out = withTooltipIntegration(integration);

  assert.ok(
    out.core.scripts.includes('/h5p/core/js/h5p-tooltip.js?version=1.27')
  );
  assert.ok(
    out.core.styles.includes('/h5p/core/styles/h5p-tooltip.css?version=1.27')
  );
  assert.equal(integration.core.scripts.length, CORE_SCRIPTS.length);
});

test('integration patch is idempotent and leaves absent branches alone', () => {
  const editorOnly = {
    editor: { assets: { js: CORE_SCRIPTS.slice(), css: CORE_STYLES.slice() } }
  };
  const once = withTooltipIntegration(editorOnly);
  const twice = withTooltipIntegration(once);
  assert.deepEqual(twice, once);
  // No core branch was invented.
  assert.equal(once.core, undefined);
});

test('the stale darkroom.css entry is rewritten to cropper.css in place', () => {
  // h5p-server 9.3.3 still lists Darkroom; editor 1.27 ships Cropper instead.
  const styles = [
    '/h5p/core/styles/h5p.css?version=1.27',
    '/h5p/editor/libs/darkroom.css?version=1.27',
    '/h5p/editor/styles/css/application.css?version=1.27'
  ];
  assert.deepEqual(withCropperStyles(styles), [
    '/h5p/core/styles/h5p.css?version=1.27',
    '/h5p/editor/libs/cropper.css?version=1.27',
    '/h5p/editor/styles/css/application.css?version=1.27'
  ]);
  // Idempotent, and a list without the stale entry is untouched.
  assert.deepEqual(
    withCropperStyles(withCropperStyles(styles)),
    withCropperStyles(styles)
  );
  assert.deepEqual(withCropperStyles(CORE_STYLES), CORE_STYLES);
  // The combined editor fix applies both rewrites.
  const combined = withEditorStyles(styles);
  assert.ok(
    combined.some((url) => url.includes('/core/styles/h5p-tooltip.css'))
  );
  assert.ok(combined.some((url) => url.includes('/editor/libs/cropper.css')));
  assert.ok(!combined.some((url) => url.includes('darkroom')));
  // ...and reaches the editor iframe's own list through the integration.
  const integration = withTooltipIntegration({
    editor: { assets: { js: [], css: styles } }
  });
  assert.ok(
    !integration.editor.assets.css.some((url) => url.includes('darkroom'))
  );
});
