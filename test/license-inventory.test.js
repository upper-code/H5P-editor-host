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
 * Runs the inventory over `librariesDir` and returns the process result plus
 * the path it was told to write: `args` and `env` are what a test needs to
 * drive `--strict` and the staleness threshold, and the warnings live on
 * stderr rather than in the report. The curated evidence file defaults to a
 * path that does not exist, so a fixture's machine name can never pick up an
 * entry from the tracked file.
 */
async function runInventoryRun(
  librariesDir,
  { evidenceFile, args = [], env = {} } = {}
) {
  const dataRoot = path.dirname(librariesDir);
  const outFile = path.join(dataRoot, 'THIRD-PARTY-LIBRARIES.md');
  const result = await runScript(scriptPath, args, {
    H5P_HOST_DATA_DIR: dataRoot,
    H5P_LIBRARIES_DIR: librariesDir,
    LICENSE_INVENTORY_OUT: outFile,
    LICENSE_EVIDENCE_FILE:
      evidenceFile ?? path.join(dataRoot, 'no-such-evidence.json'),
    ...env
  });
  return { code: result.code ?? 0, stderr: result.stderr, outFile };
}

/** The report the inventory wrote, or `{ code, stderr }` if the run failed. */
async function runInventory(librariesDir, options) {
  const run = await runInventoryRun(librariesDir, options);
  if (run.code) {
    return { code: run.code, stderr: run.stderr };
  }
  return fs.readFile(run.outFile, 'utf8');
}

/** An ISO date `days` before now, for an evidence entry of a chosen age. */
function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
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

// A gap between the tracked evidence file and one deployment's library set:
// the file is only ever complete for the sets it has been filled against, so
// the run has to name what it could not resolve.

test('a provisioned library with no declared license and no evidence entry is named as a coverage gap', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'VMB.Adapt-1.0/library.json',
    JSON.stringify({ title: 'Adapt', machineName: 'VMB.Adapt' })
  );
  await writeFile(
    librariesDir,
    'H5P.Text-1.1/library.json',
    JSON.stringify({ title: 'Text', machineName: 'H5P.Text', license: 'MIT' })
  );

  const run = await runInventoryRun(librariesDir);

  assert.equal(run.code, 0, 'a gap is a warning, not a failed run');
  assert.match(run.stderr, /Unrecorded terms/);
  assert.match(run.stderr, /VMB\.Adapt-1\.0/);
  assert.doesNotMatch(
    run.stderr,
    /H5P\.Text-1\.1/,
    'a library that declares its own license is not a gap'
  );
});

test('a curated evidence entry keeps an undeclared library out of the coverage gaps', async (t) => {
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

  const run = await runInventoryRun(librariesDir, { evidenceFile });

  assert.equal(run.code, 0);
  assert.doesNotMatch(run.stderr, /Unrecorded terms/);
});

test('--strict fails the run on a coverage gap and writes the inventory anyway', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'VMB.Adapt-1.0/library.json',
    JSON.stringify({ title: 'Adapt', machineName: 'VMB.Adapt' })
  );

  const run = await runInventoryRun(librariesDir, { args: ['--strict'] });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /--strict/);
  const report = await fs.readFile(run.outFile, 'utf8');
  assert.match(
    report,
    /VMB\.Adapt-1\.0/,
    'the inventory is still on disk, so the gap can be read in context'
  );
});

test('--strict passes when every provisioned library has recorded terms', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.Text-1.1/library.json',
    JSON.stringify({ title: 'Text', machineName: 'H5P.Text', license: 'MIT' })
  );

  const run = await runInventoryRun(librariesDir, { args: ['--strict'] });

  assert.equal(run.code, 0);
  assert.doesNotMatch(run.stderr, /Unrecorded terms/);
});

test('an evidence entry checked longer ago than the threshold is reported as stale, with what it covers', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  for (const dir of ['H5P.JoubelUI-1.3', 'H5P.JoubelUI-1.4']) {
    await writeFile(
      librariesDir,
      `${dir}/library.json`,
      JSON.stringify({ title: 'Joubel UI', machineName: 'H5P.JoubelUI' })
    );
  }
  const evidenceFile = await writeEvidence(dataRoot, {
    'H5P.JoubelUI': { ...joubelUiEvidence, checked: daysAgo(400) }
  });

  const run = await runInventoryRun(librariesDir, { evidenceFile });

  assert.equal(run.code, 0, 'stale evidence is a prompt, not a failed run');
  assert.match(run.stderr, /H5P\.JoubelUI.*checked/);
  assert.match(run.stderr, /400 days ago/);
  assert.match(
    run.stderr,
    /H5P\.JoubelUI-1\.3, H5P\.JoubelUI-1\.4/,
    'one entry is reported once, naming every version it covers'
  );
});

test('a freshly checked entry is not stale, and a zero threshold turns the age check off', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.JoubelUI-1.3/library.json',
    JSON.stringify({ title: 'Joubel UI', machineName: 'H5P.JoubelUI' })
  );

  const fresh = await writeEvidence(dataRoot, {
    'H5P.JoubelUI': { ...joubelUiEvidence, checked: daysAgo(10) }
  });
  const recent = await runInventoryRun(librariesDir, { evidenceFile: fresh });
  assert.doesNotMatch(recent.stderr, /days ago/);

  const old = await writeEvidence(dataRoot, {
    'H5P.JoubelUI': { ...joubelUiEvidence, checked: daysAgo(400) }
  });
  const disabled = await runInventoryRun(librariesDir, {
    evidenceFile: old,
    env: { LICENSE_EVIDENCE_MAX_AGE_DAYS: '0' }
  });
  assert.doesNotMatch(disabled.stderr, /days ago/);
});

test('a malformed age threshold fails the run instead of reverting to the default', async (t) => {
  const dataRoot = tmpDir(t, 'h5p-lic-');
  const librariesDir = path.join(dataRoot, 'libraries');
  await writeFile(
    librariesDir,
    'H5P.Text-1.1/library.json',
    JSON.stringify({ title: 'Text', machineName: 'H5P.Text', license: 'MIT' })
  );

  const run = await runInventoryRun(librariesDir, {
    env: { LICENSE_EVIDENCE_MAX_AGE_DAYS: 'soon' }
  });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /LICENSE_EVIDENCE_MAX_AGE_DAYS/);
});

test('every entry in the tracked evidence file is complete: license, holder, upstream, dated evidence link', async () => {
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
