const fs = require('node:fs');
const path = require('node:path');

// One walk loads Item 1.2, then Item 1.1, then returns to cached Item 1.2.
// Both versions define 1.1 differently; only the newer one defines 1.2.
// No provisioned library bundle is needed to exercise the real core/editor.
function mixedUpgradeVersions(middle = 'upgraded-leaf') {
  const libraryField = (name, version) => ({
    name,
    type: 'library',
    options: [`H5P.Item ${version}`]
  });
  const item = () => ({ library: 'H5P.Item 1.0', params: {} });
  const params = { first: item(), middle: item(), last: item() };
  if (middle.startsWith('unchanged-')) {
    params.middle.library = 'H5P.Item 1.1';
  }
  if (middle === 'unchanged-container') {
    params.middle.params.child = { library: 'H5P.Text 1.0', params: {} };
  }
  const libraries = {
    'H5P.Book 1.2': {
      name: 'H5P.Book',
      version: { major: 1, minor: 2 },
      semantics: [
        libraryField('first', '1.2'),
        libraryField('middle', '1.1'),
        libraryField('last', '1.2')
      ],
      upgradesScript: null
    },
    'H5P.Text 1.1': {
      name: 'H5P.Text',
      version: { major: 1, minor: 1 },
      semantics: [],
      upgradesScript: null
    }
  };
  const scripts = {};
  for (const minor of [1, 2]) {
    const url = `/h5p/libraries/H5P.Item-1.${minor}/upgrades.js`;
    libraries[`H5P.Item 1.${minor}`] = {
      name: 'H5P.Item',
      version: { major: 1, minor },
      semantics: [
        { name: 'child', type: 'library', options: ['H5P.Text 1.1'] }
      ],
      upgradesScript: minor === 1 && middle === 'no-script' ? null : url
    };
    scripts[url] = `
      var H5PUpgrades = H5PUpgrades || {};
      H5PUpgrades['H5P.Item'] = { 1: {
        1: function (params, done) {
          params.steps = ['${minor === 2 ? 'new' : 'old'} 1.1'];
          done(null, params);
        }
        ${
          minor === 2
            ? `,
        2: function (params, done, extras) {
          params.steps.push('new 1.2');
          done(null, params, {metadata: {...extras.metadata, migrated: true}});
        }`
            : ''
        }
      }};
    `;
  }
  if (middle === 'mutating-script') {
    scripts['/h5p/libraries/H5P.Item-1.1/upgrades.js'] = `
      H5PUpgrades['H5P.Item'][1][1] = function (params, done) {
        params.steps = ['old 1.1'];
        done(null, params);
      };
      delete H5PUpgrades['H5P.Item'][1][2];
    `;
  }
  for (const name of ['h5p-version.js', 'h5p-content-upgrade-process.js']) {
    scripts[`/h5p/core/js/${name}?v=1`] = fs.readFileSync(
      path.join(__dirname, '../../assets/h5p/core/js', name),
      'utf8'
    );
  }
  return {
    contentId: '7',
    expectReady: false,
    editModel: {
      h5p: {
        integration: {
          libraryUrl: '/h5p/core/js',
          pluginCacheBuster: '?v=1',
          editor: { assets: {}, ajaxPath: '/h5p/ajax?action=' }
        },
        library: 'H5P.Book 1.0',
        params,
        metadata: { title: 'Book' }
      },
      missingLibraries: [{ library: 'H5P.Book 1.0', upgrade: 'H5P.Book 1.2' }]
    },
    libraries,
    scripts
  };
}

module.exports = { mixedUpgradeVersions };
