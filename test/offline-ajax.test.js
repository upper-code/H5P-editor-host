const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const createH5PConfig = require('../build/src/h5p/config').default;
const {
  default: createH5PEditor,
  createLibraryStorage
} = require('../build/src/h5p/editor');
const { listSelectableLibraries } = require('../build/src/h5p/offline-ajax');
const { tmpDir, writeLibrary } = require('./helpers');

const user = { id: 'dev1', name: 'dev', type: 'local', email: 'a@b.c' };

/**
 * A real H5PEditor over a provisioned-style library directory: two versions
 * of one content type, an LRS type, and a runtime-only dependency.
 */
async function editorWith(t, config = {}) {
  const root = tmpDir(t, 'offline-ajax-');
  const libs = path.join(root, 'libraries');
  for (const dir of ['content', 'tmp', 'libraries']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const library = (name, machineName, [major, minor], extra = {}) =>
    writeLibrary(libs, name, {
      machineName,
      title: machineName.replace(/^H5P\./, ''),
      majorVersion: major,
      minorVersion: minor,
      patchVersion: 0,
      runnable: 1,
      ...extra
    });
  await library('H5P.Accordion-1.0', 'H5P.Accordion', [1, 0]);
  await library('H5P.Accordion-1.1', 'H5P.Accordion', [1, 1]);
  await library('H5P.Questionnaire-1.3', 'H5P.Questionnaire', [1, 3]);
  await library('FontAwesome-4.5', 'FontAwesome', [4, 5], { runnable: 0 });

  return createH5PEditor(
    createH5PConfig(config),
    createLibraryStorage(libs),
    path.join(root, 'content'),
    path.join(root, 'tmp'),
    (key) => key,
    'http://localhost:8080/editor'
  );
}

const accordion = {
  name: 'H5P.Accordion',
  majorVersion: 1,
  minorVersion: 1,
  title: 'Accordion',
  restricted: false,
  uberName: 'H5P.Accordion 1.1'
};
const questionnaire = {
  name: 'H5P.Questionnaire',
  majorVersion: 1,
  minorVersion: 3,
  title: 'Questionnaire',
  restricted: false,
  uberName: 'H5P.Questionnaire 1.3'
};

test('the selectable list is the newest runnable version of each library', async (t) => {
  const h5pEditor = await editorWith(t);
  const list = await listSelectableLibraries(h5pEditor, user, 'en');
  assert.deepEqual(list, [accordion, questionnaire]);
  // No catalogue links for the selector to render.
  assert.equal('tutorialUrl' in list[0], false);
  assert.equal('exampleUrl' in list[0], false);
});

test('a restricted library stays listed but is marked, as the catalogue client showed it', async (t) => {
  // With LRS types switched off they are restricted; the permission system
  // denies CreateRestricted, so the selector keeps such an entry only for
  // content that already uses it.
  const h5pEditor = await editorWith(t, { enableLrsContentTypes: false });
  const list = await listSelectableLibraries(h5pEditor, user, 'en');
  assert.deepEqual(list, [accordion, { ...questionnaire, restricted: true }]);
});
