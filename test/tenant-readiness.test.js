const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const TenantManager = require('../build/src/tenant-manager').default;
const { tmpDir, withEnv, writeLibrary } = require('./helpers');

const log = { info() {}, warn() {}, error() {} };

// Builds a TenantManager whose data/library roots point at a fresh temp tree,
// then returns its readiness snapshot. The library directory is populated by
// `seed(librariesPath)` before readiness runs.
async function readinessWith(t, seed) {
  const dataRoot = tmpDir(t, 'host-ready-');
  const librariesPath = path.join(dataRoot, 'libraries');
  fs.mkdirSync(librariesPath, { recursive: true });
  await seed(librariesPath);
  withEnv(t, {
    H5P_HOST_DATA_DIR: dataRoot,
    H5P_LIBRARIES_DIR: librariesPath
  });
  return new TenantManager(dataRoot, log).readiness();
}

/** A library directory the readiness probe should count. */
const library = (root, dir, machineName) =>
  writeLibrary(root, dir, { machineName, majorVersion: 1, minorVersion: 0 });

test('readiness ignores junk: only directories with a valid library.json count', async (t) => {
  const readiness = await readinessWith(t, async (libs) => {
    // A stray file, a half-copied directory with no manifest, a directory with
    // an unparseable manifest, and a hidden staging directory — none are a
    // library, so none must make the service report ready.
    fs.writeFileSync(path.join(libs, 'stray.txt'), 'x');
    fs.mkdirSync(path.join(libs, 'HalfCopied-1.0'));
    fs.mkdirSync(path.join(libs, 'BadJson-1.0'));
    fs.writeFileSync(
      path.join(libs, 'BadJson-1.0', 'library.json'),
      '{not json'
    );
    fs.mkdirSync(path.join(libs, '.provision-tmp-H5P.Demo-1.0'));
  });
  assert.equal(readiness.libraryCount, 0);
  assert.equal(readiness.ready, false);
});

test('readiness counts a genuinely provisioned library', async (t) => {
  const readiness = await readinessWith(t, async (libs) => {
    await library(libs, 'H5P.Demo-1.0', 'H5P.Demo');
    fs.writeFileSync(path.join(libs, 'stray.txt'), 'x'); // still ignored
  });
  assert.equal(readiness.libraryCount, 1);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.storageWritable, true);
});

test('a directory whose library.json has no machineName does not count', async (t) => {
  const readiness = await readinessWith(t, async (libs) => {
    fs.mkdirSync(path.join(libs, 'Nameless-1.0'));
    fs.writeFileSync(
      path.join(libs, 'Nameless-1.0', 'library.json'),
      JSON.stringify({ majorVersion: 1, minorVersion: 0 })
    );
  });
  assert.equal(readiness.libraryCount, 0);
  assert.equal(readiness.ready, false);
});

test('readiness rejects mismatched library names and versions', async (t) => {
  const readiness = await readinessWith(t, async (libs) => {
    await library(libs, 'H5P.Impostor-1.0', 'H5P.Real');
    await library(libs, 'H5P.WrongVersion-2.0', 'H5P.WrongVersion');
    await library(libs, 'NoVersion', 'NoVersion');
  });
  assert.equal(readiness.libraryCount, 0);
  assert.equal(readiness.ready, false);
});
