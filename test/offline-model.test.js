const assert = require('node:assert/strict');
const test = require('node:test');

const {
  withoutRemoteCatalogueAssets,
  withRemoteCatalogueDisabled,
  withRemoteCatalogueDisabledInEditor
} = require('../build/src/h5p/offline-model');
const { renderPlayerHtml } = require('../build/src/routes/player-html');

const HUB_JS = '/h5p/editor/scripts/h5p-hub-client.js?version=1.27';
const HUB_SELECTOR =
  '/h5p/editor/scripts/h5peditor-selector-hub.js?version=1.27';
const HUB_CSS = '/h5p/editor/styles/css/h5p-hub-client.css?version=1.27';
const LOCAL_JS =
  '/h5p/editor/scripts/h5peditor-selector-legacy.js?version=1.27';
const LOCAL_CSS = '/h5p/editor/styles/css/application.css?version=1.27';

function integration() {
  return {
    ajax: { contentUserData: '/state', setFinished: '/finished' },
    ajaxPath: '/h5p/ajax?action=',
    editor: {
      ajaxPath: '/h5p/ajax?action=',
      apiVersion: { majorVersion: 1, minorVersion: 27 },
      assets: {
        js: [HUB_JS, LOCAL_JS, HUB_SELECTOR],
        css: [HUB_CSS, LOCAL_CSS]
      },
      enableContentHub: true,
      filesPath: '/h5p/temp-files',
      hub: { contentSearchUrl: 'https://hub-api.h5p.org/v1/contents/search' },
      libraryUrl: '/h5p/editor',
      nodeVersionId: 'new'
    },
    hubIsEnabled: true,
    Hub: { contentSearchUrl: 'https://hub-api.h5p.org/v1/contents/search' },
    l10n: {},
    postUserStatistics: false,
    saveFreq: false,
    url: '/h5p',
    user: { id: 'tenant', mail: 'a@b.c', name: 'Tenant' },
    contents: {
      'cid-7': {
        displayOptions: {
          copy: false,
          copyright: false,
          embed: false,
          export: false,
          frame: true,
          icon: true
        },
        fullScreen: '0',
        jsonContent: '{}',
        library: 'H5P.Column 1.18'
      }
    }
  };
}

test('remote catalogue scripts and styles are removed without disturbing local assets', () => {
  const input = [HUB_JS, LOCAL_JS, HUB_SELECTOR, HUB_CSS, LOCAL_CSS];
  assert.deepEqual(withoutRemoteCatalogueAssets(input), [LOCAL_JS, LOCAL_CSS]);
  assert.equal(input.length, 5, 'the source list is not mutated');
});

test('editor models expose only the local selector and no remote endpoint', () => {
  const sourceIntegration = integration();
  const source = {
    integration: sourceIntegration,
    scripts: [HUB_JS, LOCAL_JS, HUB_SELECTOR],
    styles: [HUB_CSS, LOCAL_CSS],
    urlGenerator: {}
  };
  const result = withRemoteCatalogueDisabledInEditor(source);

  assert.deepEqual(result.scripts, [LOCAL_JS]);
  assert.deepEqual(result.styles, [LOCAL_CSS]);
  assert.deepEqual(result.integration.editor.assets.js, [LOCAL_JS]);
  assert.deepEqual(result.integration.editor.assets.css, [LOCAL_CSS]);
  assert.equal(result.integration.hubIsEnabled, false);
  assert.equal(result.integration.editor.enableContentHub, false);
  assert.equal(result.integration.Hub, undefined);
  assert.equal(result.integration.editor.hub, undefined);
  assert.doesNotMatch(JSON.stringify(result), /hub-api\.h5p\.org/i);

  assert.equal(sourceIntegration.hubIsEnabled, true, 'the source is unchanged');
  assert.equal(sourceIntegration.editor.assets.js.length, 3);
});

test('player HTML suppresses the vendor icon/link and strips remote endpoints', () => {
  const source = integration();
  const clean = withRemoteCatalogueDisabled(source);
  assert.equal(clean.contents['cid-7'].displayOptions.icon, false);
  assert.equal(source.contents['cid-7'].displayOptions.icon, true);

  const html = renderPlayerHtml({
    contentId: '7',
    embedTypes: ['div'],
    integration: source,
    scripts: [],
    styles: [],
    translations: {},
    user: source.user
  });
  assert.doesNotMatch(html, /hub-api\.h5p\.org/i);
  assert.match(html, /"icon":false/);
  assert.match(html, /"hubIsEnabled":false/);
});
