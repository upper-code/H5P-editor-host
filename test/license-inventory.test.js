const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');

const { runScript, script, tmpDir } = require('./helpers');

const scriptPath = script('library-license-inventory.mjs');

async function writeFile(root, relPath, content) {
  const filePath = path.join(root, relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

/** Runs the inventory over `librariesDir` and returns the report it wrote. */
async function runInventory(librariesDir) {
  const dataRoot = path.dirname(librariesDir);
  const outFile = path.join(dataRoot, 'THIRD-PARTY-LIBRARIES.md');
  const result = await runScript(scriptPath, [], {
    H5P_HOST_DATA_DIR: dataRoot,
    H5P_LIBRARIES_DIR: librariesDir,
    LICENSE_INVENTORY_OUT: outFile
  });
  assert.equal(result.code ?? 0, 0, result.stderr);
  return fs.readFile(outFile, 'utf8');
}

test('a GPL header bundled inside a permissively-declared library is surfaced as bundled copyleft', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.Flowplayer-1.0/library.json',
    JSON.stringify({ title: 'Flowplayer', machineName: 'H5P.Flowplayer' })
  );
  await writeFile(
    librariesDir,
    'H5P.Flowplayer-1.0/js/flowplayer.js',
    '/* Licensed under the GNU General Public License v3 */\nconsole.log(1);'
  );

  const report = await runInventory(librariesDir);

  assert.match(report, /bundled copyleft/);
  assert.match(report, /flowplayer\.js/);
});

test('a copyleft-licensed dependency pinned in package-lock.json is detected', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.CKEditor-1.0/library.json',
    JSON.stringify({ title: 'CKEditor', machineName: 'H5P.CKEditor' })
  );
  await writeFile(
    librariesDir,
    'H5P.CKEditor-1.0/package-lock.json',
    JSON.stringify({
      packages: {
        'node_modules/some-widget': { license: 'LGPL-2.1-only' }
      }
    })
  );

  const report = await runInventory(librariesDir);

  assert.match(report, /LGPL-2\.1-only/);
});

test('content-license labels inside semantics.json are not mistaken for the library license', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.Clean-1.0/library.json',
    JSON.stringify({
      title: 'Clean',
      machineName: 'H5P.Clean',
      license: 'MIT'
    })
  );
  await writeFile(
    librariesDir,
    'H5P.Clean-1.0/semantics.json',
    JSON.stringify([
      {
        options: [
          { value: 'GPL', label: 'General Public License' },
          { value: 'GPL-3.0', label: 'GNU General Public License v3' }
        ]
      }
    ])
  );

  const report = await runInventory(librariesDir);

  assert.doesNotMatch(report, /H5P\.Clean-1\.0.*bundled copyleft/s);
  assert.match(report, /\| MIT \| 1 \|/);
});

test('a GPL notice embedded in an .svg file is detected', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.IconPack-1.0/library.json',
    JSON.stringify({ title: 'IconPack', machineName: 'H5P.IconPack' })
  );
  await writeFile(
    librariesDir,
    'H5P.IconPack-1.0/icons/logo.svg',
    '<!-- Licensed under the GNU General Public License v2 --><svg></svg>'
  );

  const report = await runInventory(librariesDir);

  assert.match(report, /H5P\.IconPack-1\.0.*bundled copyleft/s);
  assert.match(report, /logo\.svg/);
});

test('a GPL notice embedded in a .ts source file is detected', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.Widget-1.0/library.json',
    JSON.stringify({ title: 'Widget', machineName: 'H5P.Widget' })
  );
  await writeFile(
    librariesDir,
    'H5P.Widget-1.0/src/widget.ts',
    '// Licensed under the GNU General Public License v3\nexport {};'
  );

  const report = await runInventory(librariesDir);

  assert.match(report, /H5P\.Widget-1\.0.*bundled copyleft/s);
  assert.match(report, /widget\.ts/);
});

test('bundled-copyleft review notes describe evidence requiring review, not a verdict', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.Flowplayer-1.0/library.json',
    JSON.stringify({ title: 'Flowplayer', machineName: 'H5P.Flowplayer' })
  );
  await writeFile(
    librariesDir,
    'H5P.Flowplayer-1.0/js/flowplayer.js',
    '/* Licensed under the GNU General Public License v3 */\nconsole.log(1);'
  );

  const report = await runInventory(librariesDir);

  assert.match(report, /requires composition and distribution-terms\s+review/);
  assert.doesNotMatch(report, /treat the whole library as copyleft-encumbered/);
});
