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

/**
 * Runs the inventory over `librariesDir` and returns the report it wrote.
 * The curated evidence file defaults to a path that does not exist, so a
 * fixture's machine name can never pick up an entry from the tracked file.
 */
async function runInventory(librariesDir, { evidenceFile } = {}) {
  const dataRoot = path.dirname(librariesDir);
  const outFile = path.join(dataRoot, 'THIRD-PARTY-LIBRARIES.md');
  const result = await runScript(scriptPath, [], {
    H5P_HOST_DATA_DIR: dataRoot,
    H5P_LIBRARIES_DIR: librariesDir,
    LICENSE_INVENTORY_OUT: outFile,
    LICENSE_EVIDENCE_FILE:
      evidenceFile ?? path.join(dataRoot, 'no-such-evidence.json')
  });
  if (result.code) {
    return { code: result.code, stderr: result.stderr };
  }
  return fs.readFile(outFile, 'utf8');
}

const joubelUiEvidence = {
  license: 'MIT',
  holder: 'Joubel AS',
  upstream: 'https://github.com/h5p/h5p-joubel-ui',
  evidence: 'https://github.com/h5p/h5p-joubel-ui/blob/master/README.md',
  checked: '2026-09-21'
};

/** Writes an evidence file with the given `libraries` map and returns its path. */
async function writeEvidence(dataRoot, libraries) {
  const file = path.join(dataRoot, 'evidence.json');
  await fs.writeFile(file, JSON.stringify({ libraries }));
  return file;
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

test('a library without a declared license is reported with its curated upstream evidence', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.JoubelUI-1.3/library.json',
    JSON.stringify({ title: 'Joubel UI', machineName: 'H5P.JoubelUI' })
  );
  const evidenceFile = await writeEvidence(dataRoot, {
    'H5P.JoubelUI': joubelUiEvidence
  });

  const report = await runInventory(librariesDir, { evidenceFile });

  assert.match(report, /\| MIT \(upstream evidence\) \| 1 \|/);
  assert.match(
    report,
    /H5P\.JoubelUI-1\.3.*MIT \(upstream evidence\).*h5p-joubel-ui\/blob\/master\/README\.md — © Joubel AS, checked 2026-09-21/
  );
  assert.doesNotMatch(report, /\| \(none\) \|/);
});

test('without curated evidence an undeclared license still reads (none)', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.JoubelUI-1.3/library.json',
    JSON.stringify({ title: 'Joubel UI', machineName: 'H5P.JoubelUI' })
  );

  const report = await runInventory(librariesDir);

  assert.match(report, /\| \(none\) \| 1 \|/);
});

test('curated evidence never overrides a license the library declares itself', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.JoubelUI-1.3/library.json',
    JSON.stringify({
      title: 'Joubel UI',
      machineName: 'H5P.JoubelUI',
      license: 'GPL3'
    })
  );
  const evidenceFile = await writeEvidence(dataRoot, {
    'H5P.JoubelUI': joubelUiEvidence
  });

  const report = await runInventory(librariesDir, { evidenceFile });

  assert.match(report, /\| GPL3 \| 1 \|/);
  assert.doesNotMatch(report, /upstream evidence\) \| 1/);
  // The declared license stands; the entry only adds the source pointer.
  assert.match(
    report,
    /H5P\.JoubelUI-1\.3.*\| GPL3 \| library\.json · upstream MIT: https:\/\/github\.com\/h5p\/h5p-joubel-ui\/blob\/master\/README\.md \(checked 2026-09-21\)/
  );
});

test('an MPL library is marked file-level copyleft and listed with its Source Code Form', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'TimelineJS-1.1/library.json',
    JSON.stringify({
      title: 'TimelineJS',
      machineName: 'TimelineJS',
      license: 'MPL2'
    })
  );
  const evidenceFile = await writeEvidence(dataRoot, {
    TimelineJS: {
      license: 'MPL-2.0',
      holder: 'Northwestern University Knight Lab',
      upstream: 'https://github.com/h5p/timelinejs',
      evidence:
        'https://github.com/h5p/timelinejs/blob/master/css/timeline.css',
      checked: '2026-09-21',
      note: 'minified in the package'
    }
  });

  const report = await runInventory(librariesDir, { evidenceFile });

  assert.match(report, /\| MPL2 \(file-level copyleft\) \| 1 \|/);
  assert.match(report, /TimelineJS-1\.1.*MPL2 · file-level copyleft/);
  assert.match(
    report,
    /## File-level copyleft \(MPL\) components[\s\S]*\| `TimelineJS-1\.1` \| MPL2 \| https:\/\/github\.com\/h5p\/timelinejs \(MPL-2\.0, © Northwestern University Knight Lab\) \| minified in the package \|/
  );
  assert.match(report, /Larger Work/);
});

test('an MPL library without an evidence entry is still marked, with the missing source pointer flagged', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.Juxta-1.0/library.json',
    JSON.stringify({ title: 'Juxta', machineName: 'H5P.Juxta', license: 'MPL' })
  );

  const report = await runInventory(librariesDir);

  assert.match(report, /\| MPL \(file-level copyleft\) \| 1 \|/);
  assert.match(
    report,
    /\| `H5P\.Juxta-1\.0` \| MPL \| \*\*not recorded\*\* — add the upstream repository to the evidence file \|\s*\|/
  );
});

test('a permissive declaration is not marked file-level copyleft', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.Plain-1.0/library.json',
    JSON.stringify({ title: 'Plain', machineName: 'H5P.Plain', license: 'MIT' })
  );

  const report = await runInventory(librariesDir);

  assert.doesNotMatch(report, /file-level copyleft\) \|/);
  assert.match(
    report,
    /## File-level copyleft \(MPL\) components[\s\S]*\| _none_ \|/
  );
});

test('curated evidence does not silence the bundled-copyleft scan', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.JoubelUI-1.3/library.json',
    JSON.stringify({ title: 'Joubel UI', machineName: 'H5P.JoubelUI' })
  );
  await writeFile(
    librariesDir,
    'H5P.JoubelUI-1.3/css/icons.css',
    '/* IcoMoon font licensed under the GNU General Public License */'
  );
  const evidenceFile = await writeEvidence(dataRoot, {
    'H5P.JoubelUI': joubelUiEvidence
  });

  const report = await runInventory(librariesDir, { evidenceFile });

  assert.match(report, /\| bundled copyleft \(see notes\) \| 1 \|/);
  assert.match(
    report,
    /H5P\.JoubelUI-1\.3.*MIT \(upstream evidence\) · bundled copyleft/
  );
});

test('an evidence entry missing a field fails the run instead of degrading to (none)', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.JoubelUI-1.3/library.json',
    JSON.stringify({ title: 'Joubel UI', machineName: 'H5P.JoubelUI' })
  );
  const incomplete = { ...joubelUiEvidence };
  delete incomplete.checked;
  const evidenceFile = await writeEvidence(dataRoot, {
    'H5P.JoubelUI': incomplete
  });

  const result = await runInventory(librariesDir, { evidenceFile });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /H5P\.JoubelUI lacks a non-empty "checked"/);
});

test('the tracked evidence file is complete: every entry names a license, holder, upstream, dated evidence link', async () => {
  const file = path.join(
    path.dirname(scriptPath),
    'library-license-evidence.json'
  );
  const { libraries } = JSON.parse(await fs.readFile(file, 'utf8'));
  const names = Object.keys(libraries);

  assert.ok(names.length > 0);
  for (const name of names) {
    const entry = libraries[name];
    assert.match(
      name,
      /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?$/,
      `${name}: machineName`
    );
    assert.match(
      entry.license,
      /^(MIT|BSD-[23]-Clause|Apache-2\.0|MPL-2\.0|WTFPL|GPL-[23]\.0(-or-later|-only)?)$/,
      `${name}: license id`
    );
    assert.ok(entry.holder.trim(), `${name}: holder`);
    assert.match(entry.upstream, /^https:\/\//, `${name}: upstream`);
    assert.ok(
      entry.evidence.startsWith(entry.upstream),
      `${name}: evidence link under upstream`
    );
    assert.match(entry.checked, /^\d{4}-\d{2}-\d{2}$/, `${name}: checked date`);
  }
});
