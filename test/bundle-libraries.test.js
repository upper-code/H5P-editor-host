const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { runScript: run, script, tmpDir, writeLibrary } = require('./helpers');

const execFileAsync = promisify(execFile);
const bundleScript = script('bundle-libraries.mjs');
const provisionScript = script('provision-libraries.mjs');

/** The two-library source every bundle here is built from. */
async function fixtureSource(t) {
  const source = tmpDir(t, 'h5p-bundle-src-');
  await writeLibrary(
    source,
    'H5P.Text-1.1',
    {
      machineName: 'H5P.Text',
      majorVersion: 1,
      minorVersion: 1,
      patchVersion: 5,
      title: 'Text',
      license: 'MIT'
    },
    { 'scripts/text.js': 'x', 'README.md': 'MIT License' }
  );
  await writeLibrary(
    source,
    'H5P.Quiz-2.0',
    {
      machineName: 'H5P.Quiz',
      majorVersion: 2,
      minorVersion: 0,
      title: 'Quiz'
    },
    { '.DS_Store': 'junk', '._quiz.js': 'junk' }
  );
  return source;
}

test('the bundle script writes a checksummed archive with a manifest and inventory', async (t) => {
  const source = await fixtureSource(t);
  const out = tmpDir(t, 'h5p-bundle-out-');
  const result = await run(
    bundleScript,
    ['--version', '2026.09-rc1', '--out', out, '--source', source],
    {}
  );
  assert.equal(result.code ?? 0, 0, result.stderr);
  const archive = path.join(out, 'h5p-libraries-2026.09-rc1.tar.gz');
  assert.ok(fsSync.existsSync(archive));
  const sidecar = await fs.readFile(`${archive}.sha256`, 'utf8');
  const digest = crypto
    .createHash('sha256')
    .update(await fs.readFile(archive))
    .digest('hex');
  assert.equal(sidecar, `${digest}  h5p-libraries-2026.09-rc1.tar.gz\n`);

  const listing = (await execFileAsync('tar', ['-tzf', archive])).stdout
    .split('\n')
    .filter(Boolean);
  assert.ok(listing.includes('manifest.json'));
  assert.ok(listing.includes('THIRD-PARTY-LIBRARIES.md'));
  assert.ok(listing.includes('libraries/H5P.Text-1.1/scripts/text.js'));
  assert.ok(
    !listing.some((entry) => /\.DS_Store|\/\._/.test(entry)),
    'macOS metadata is excluded'
  );

  const unpack = tmpDir(t, 'h5p-bundle-unpack-');
  await execFileAsync('tar', ['-xzf', archive, '-C', unpack]);
  const manifest = JSON.parse(
    await fs.readFile(path.join(unpack, 'manifest.json'), 'utf8')
  );
  assert.equal(manifest.format, 'h5p-library-bundle/1');
  assert.equal(manifest.version, '2026.09-rc1');
  assert.equal(manifest.libraryCount, 2);
  assert.deepEqual(
    manifest.libraries.map((l) => l.directory),
    ['H5P.Quiz-2.0', 'H5P.Text-1.1']
  );
  assert.equal(manifest.libraries[1].license, 'MIT');
  assert.equal(manifest.libraries[1].patchVersion, 5);
  assert.equal(manifest.libraries[0].license, null);
  const inventory = await fs.readFile(
    path.join(unpack, 'THIRD-PARTY-LIBRARIES.md'),
    'utf8'
  );
  assert.match(inventory, /Total libraries: \*\*2\*\*/);
});

test('a library whose manifest disagrees with its directory name stops the bundle', async (t) => {
  const source = tmpDir(t, 'h5p-bundle-bad-');
  await writeLibrary(source, 'H5P.Text-1.1', {
    machineName: 'H5P.Other',
    majorVersion: 1,
    minorVersion: 1
  });
  const out = tmpDir(t, 'h5p-bundle-out-');
  const result = await run(
    bundleScript,
    ['--out', out, '--source', source],
    {}
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not match the directory name/);
  assert.equal((await fs.readdir(out)).length, 0);
});

test('provisioning from a bundle verifies the checksum, installs and records the version', async (t) => {
  const source = await fixtureSource(t);
  const out = tmpDir(t, 'h5p-bundle-out-');
  assert.equal(
    (
      await run(
        bundleScript,
        ['--version', 'v7', '--out', out, '--source', source],
        {}
      )
    ).code ?? 0,
    0
  );
  const archive = path.join(out, 'h5p-libraries-v7.tar.gz');
  const target = tmpDir(t, 'h5p-bundle-dst-');

  // No checksum available: refused.
  const sidecar = `${archive}.sha256`;
  const savedSidecar = await fs.readFile(sidecar, 'utf8');
  await fs.rm(sidecar);
  let result = await run(provisionScript, [], {
    H5P_LIBRARY_SOURCE_BUNDLE: archive,
    H5P_LIBRARIES_DIR: target
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no checksum/);
  assert.equal((await fs.readdir(target)).length, 0, 'nothing installed');

  // Wrong checksum: refused.
  result = await run(provisionScript, [], {
    H5P_LIBRARY_SOURCE_BUNDLE: archive,
    H5P_LIBRARIES_DIR: target,
    H5P_LIBRARY_SOURCE_SHA256: 'deadbeef'.repeat(8)
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not match/);

  // Sidecar restored: installed, with the record the host reports on /ready.
  await fs.writeFile(sidecar, savedSidecar);
  result = await run(provisionScript, [], {
    H5P_LIBRARY_SOURCE_BUNDLE: archive,
    H5P_LIBRARIES_DIR: target
  });
  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(result.stdout, /Installing bundle v7 \(2 libraries/);
  assert.ok(
    fsSync.existsSync(path.join(target, 'H5P.Text-1.1', 'scripts', 'text.js'))
  );
  assert.ok(
    fsSync.existsSync(path.join(target, 'H5P.Quiz-2.0', 'library.json'))
  );
  const record = JSON.parse(
    await fs.readFile(path.join(target, '.bundle.json'), 'utf8')
  );
  assert.equal(record.version, 'v7');
  assert.equal(record.sha256, savedSidecar.slice(0, 64));
  assert.equal(record.libraryCount, 2);

  // Both sources at once is a configuration error.
  result = await run(provisionScript, [], {
    H5P_LIBRARY_SOURCE_BUNDLE: archive,
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not both/);

  // A plain-directory install afterwards drops the record: the target no
  // longer matches any bundle.
  await writeLibrary(source, 'H5P.Extra-1.0', {
    machineName: 'H5P.Extra',
    majorVersion: 1,
    minorVersion: 0
  });
  result = await run(provisionScript, [], {
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  });
  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.ok(!fsSync.existsSync(path.join(target, '.bundle.json')));
});

test('a bundle whose manifest and archive disagree is refused', async (t) => {
  const source = await fixtureSource(t);
  const out = tmpDir(t, 'h5p-bundle-out-');
  assert.equal(
    (
      await run(
        bundleScript,
        ['--version', 'v8', '--out', out, '--source', source],
        {}
      )
    ).code ?? 0,
    0
  );
  const archive = path.join(out, 'h5p-libraries-v8.tar.gz');
  // Rebuild the archive without one library but with the original manifest.
  const unpack = tmpDir(t, 'h5p-bundle-unpack-');
  await execFileAsync('tar', ['-xzf', archive, '-C', unpack]);
  await fs.rm(path.join(unpack, 'libraries', 'H5P.Quiz-2.0'), {
    recursive: true
  });
  const tampered = path.join(out, 'tampered.tar.gz');
  await execFileAsync('tar', [
    '-czf',
    tampered,
    '-C',
    unpack,
    'manifest.json',
    'THIRD-PARTY-LIBRARIES.md',
    'libraries'
  ]);
  const digest = crypto
    .createHash('sha256')
    .update(await fs.readFile(tampered))
    .digest('hex');
  const target = tmpDir(t, 'h5p-bundle-dst-');
  const result = await run(provisionScript, [], {
    H5P_LIBRARY_SOURCE_BUNDLE: tampered,
    H5P_LIBRARIES_DIR: target,
    H5P_LIBRARY_SOURCE_SHA256: digest
  });
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /manifest and the archive disagree.*H5P\.Quiz-2\.0/
  );
  assert.equal((await fs.readdir(target)).length, 0);
});

test('a bundle cannot relabel different installed bytes, including changes with identical metadata', async (t) => {
  const root = tmpDir(t, 'h5p-bundle-upgrade-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const out = path.join(root, 'bundles');
  const meta = {
    machineName: 'H5P.Text',
    majorVersion: 1,
    minorVersion: 1,
    patchVersion: 5,
    license: 'MIT'
  };
  await writeLibrary(source, 'H5P.Text-1.1', meta, { 'text.js': 'new code' });
  await writeLibrary(target, 'H5P.Text-1.1', meta, { 'text.js': 'old code' });
  await fs.writeFile(
    path.join(target, '.bundle.json'),
    JSON.stringify({ version: 'old' })
  );
  assert.equal(
    (
      await run(
        bundleScript,
        ['--version', 'new', '--source', source, '--out', out],
        {}
      )
    ).code ?? 0,
    0
  );
  const env = {
    H5P_LIBRARY_SOURCE_DIR: '',
    H5P_LIBRARY_SOURCE_BUNDLE: path.join(out, 'h5p-libraries-new.tar.gz'),
    H5P_LIBRARIES_DIR: target
  };
  const refused = await run(provisionScript, [], env);
  assert.notEqual(refused.code ?? 0, 0);
  assert.match(refused.stderr, /differs from the bundle/);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(target, '.bundle.json'), 'utf8'))
      .version,
    'old'
  );
  assert.equal(
    await fs.readFile(path.join(target, 'H5P.Text-1.1/text.js'), 'utf8'),
    'old code'
  );
  const installed = await run(provisionScript, ['--force'], env);
  assert.equal(installed.code ?? 0, 0, installed.stderr);
  assert.equal(
    await fs.readFile(path.join(target, 'H5P.Text-1.1/text.js'), 'utf8'),
    'new code'
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(target, '.bundle.json'), 'utf8'))
      .version,
    'new'
  );
  assert.equal(
    (await run(provisionScript, [], env)).code ?? 0,
    0,
    'identical installations can be repeated'
  );
  await writeLibrary(target, 'H5P.Other-1.0', {
    machineName: 'H5P.Other',
    majorVersion: 1,
    minorVersion: 0
  });
  const extra = await run(provisionScript, ['--force'], env);
  assert.notEqual(extra.code ?? 0, 0);
  assert.match(extra.stderr, /outside the bundle/);
  assert.ok(
    fsSync.existsSync(path.join(target, 'H5P.Other-1.0')),
    'do not delete libraries that saved content may still need'
  );
});

test('a failed library replacement clears the old bundle identity until verification succeeds', async (t) => {
  const root = tmpDir(t, 'h5p-bundle-failure-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const out = path.join(root, 'bundles');
  const meta = {
    machineName: 'H5P.Text',
    majorVersion: 1,
    minorVersion: 1,
    license: 'MIT'
  };
  await writeLibrary(source, 'H5P.Text-1.1', meta, { 'text.js': 'new' });
  await writeLibrary(target, 'H5P.Text-1.1', meta, { 'text.js': 'old' });
  await fs.writeFile(path.join(target, '.bundle.json'), '{"version":"old"}');
  await run(
    bundleScript,
    ['--version', 'new', '--source', source, '--out', out],
    {}
  );
  const hook = path.join(root, 'fail.cjs');
  await fs.writeFile(
    hook,
    `const fs=require('node:fs/promises'); const rename=fs.rename;
    fs.rename=async (from,to)=>{if(from.includes('.provision-tmp-')) throw new Error('injected publish failure'); return rename(from,to);};`
  );
  const failed = await execFileAsync(
    process.execPath,
    ['--require', hook, provisionScript, '--force'],
    {
      env: {
        ...process.env,
        H5P_LIBRARY_SOURCE_DIR: '',
        H5P_LIBRARY_SOURCE_BUNDLE: path.join(out, 'h5p-libraries-new.tar.gz'),
        H5P_LIBRARIES_DIR: target
      }
    }
  ).catch((error) => error);
  assert.notEqual(failed.code ?? 0, 0);
  assert.equal(fsSync.existsSync(path.join(target, '.bundle.json')), false);
  assert.equal(
    await fs.readFile(path.join(target, 'H5P.Text-1.1/text.js'), 'utf8'),
    'old'
  );
});
