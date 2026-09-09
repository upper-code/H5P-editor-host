const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { runScript, script, tmpDir, writeLibrary } = require('./helpers');

const execFileAsync = promisify(execFile);
const scriptPath = script('provision-libraries.mjs');

const run = (env) => runScript(scriptPath, [], env);

test('a well-formed library is copied from source into an empty target', async (t) => {
  const source = tmpDir(t, 'h5p-src-');
  const target = tmpDir(t, 'h5p-dst-');
  await writeLibrary(source, 'H5P.ArithmeticQuiz-1.1', {
    machineName: 'H5P.ArithmeticQuiz',
    majorVersion: 1,
    minorVersion: 1
  });

  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  });

  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.ok(
    fsSync.existsSync(
      path.join(target, 'H5P.ArithmeticQuiz-1.1', 'library.json')
    )
  );
});

test('an existing library is kept unless --force is passed', async (t) => {
  const source = tmpDir(t, 'h5p-src-');
  const target = tmpDir(t, 'h5p-dst-');
  await writeLibrary(
    source,
    'H5P.Foo-1.0',
    {
      machineName: 'H5P.Foo',
      majorVersion: 1,
      minorVersion: 0
    },
    { 'marker.txt': 'new' }
  );
  await writeLibrary(
    target,
    'H5P.Foo-1.0',
    {
      machineName: 'H5P.Foo',
      majorVersion: 1,
      minorVersion: 0
    },
    { 'marker.txt': 'old' }
  );

  await run({ H5P_LIBRARY_SOURCE_DIR: source, H5P_LIBRARIES_DIR: target });
  assert.equal(
    await fs.readFile(path.join(target, 'H5P.Foo-1.0', 'marker.txt'), 'utf8'),
    'old',
    'without --force the existing directory must not be touched'
  );

  await execFileAsync(process.execPath, [scriptPath, '--force'], {
    env: {
      ...process.env,
      H5P_LIBRARY_SOURCE_DIR: source,
      H5P_LIBRARIES_DIR: target
    }
  });
  assert.equal(
    await fs.readFile(path.join(target, 'H5P.Foo-1.0', 'marker.txt'), 'utf8'),
    'new',
    '--force must replace the existing directory'
  );
});

test('refuses to provision when source and target overlap', async (t) => {
  const root = tmpDir(t, 'h5p-overlap-');
  const target = path.join(root, 'libraries');
  await fs.mkdir(target, { recursive: true });

  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: root,
    H5P_LIBRARIES_DIR: target
  });

  assert.notEqual(result.code ?? 0, 0);
});

test('a source library containing a symlink is rejected, not copied', async (t) => {
  const source = tmpDir(t, 'h5p-src-');
  const target = tmpDir(t, 'h5p-dst-');
  const libDir = await writeLibrary(source, 'H5P.Linked-1.0', {
    machineName: 'H5P.Linked',
    majorVersion: 1,
    minorVersion: 0
  });
  const outside = tmpDir(t, 'h5p-outside-');
  await fs.writeFile(path.join(outside, 'evil.txt'), 'x');
  await fs.symlink(
    path.join(outside, 'evil.txt'),
    path.join(libDir, 'link.txt')
  );

  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  });

  assert.equal(
    fsSync.existsSync(path.join(target, 'H5P.Linked-1.0')),
    false,
    'a library containing a symlink must never reach the runtime tree'
  );
  assert.notEqual(result.code ?? 0, 0);
});

test('a conforming directory name whose library.json disagrees is rejected', async (t) => {
  const source = tmpDir(t, 'h5p-src-');
  const target = tmpDir(t, 'h5p-dst-');
  await writeLibrary(source, 'H5P.Real-1.0', {
    machineName: 'H5P.Impostor',
    majorVersion: 9,
    minorVersion: 9
  });

  await run({ H5P_LIBRARY_SOURCE_DIR: source, H5P_LIBRARIES_DIR: target });

  assert.equal(
    fsSync.existsSync(path.join(target, 'H5P.Real-1.0')),
    false,
    'a machineName/version mismatch against the directory name must be rejected'
  );
});

test('a directory name that does not match Machine.Name-major.minor is rejected', async (t) => {
  const source = tmpDir(t, 'h5p-src-');
  const target = tmpDir(t, 'h5p-dst-');
  await writeLibrary(source, 'not-a-library-dir-name', {
    machineName: 'H5P.Anything',
    majorVersion: 1,
    minorVersion: 0
  });

  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  });

  assert.equal(
    fsSync.existsSync(path.join(target, 'not-a-library-dir-name')),
    false,
    'a non-conforming directory name must be rejected'
  );
  assert.notEqual(result.code ?? 0, 0);
});

test('a library.json with no machineName is rejected', async (t) => {
  const source = tmpDir(t, 'h5p-src-');
  const target = tmpDir(t, 'h5p-dst-');
  await writeLibrary(source, 'H5P.NoName-1.0', {
    majorVersion: 1,
    minorVersion: 0
  });

  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  });

  assert.equal(
    fsSync.existsSync(path.join(target, 'H5P.NoName-1.0')),
    false,
    'an absent machineName must be rejected'
  );
  assert.notEqual(result.code ?? 0, 0);
});

test('with no source configured, a corrupt target directory fails the check', async (t) => {
  const target = tmpDir(t, 'h5p-dst-');
  await fs.mkdir(path.join(target, 'garbage-dir'));
  // No library.json at all inside garbage-dir.

  const result = await run({ H5P_LIBRARIES_DIR: target });

  assert.notEqual(
    result.code ?? 0,
    0,
    'an invalid directory must not be treated as a provisioned library'
  );
});

test('with no source configured, a genuinely provisioned target passes the check', async (t) => {
  const target = tmpDir(t, 'h5p-dst-');
  await writeLibrary(target, 'H5P.Good-1.0', {
    machineName: 'H5P.Good',
    majorVersion: 1,
    minorVersion: 0
  });

  const result = await run({ H5P_LIBRARIES_DIR: target });

  assert.equal(result.code ?? 0, 0);
});

test('an existing corrupt library is not silently kept, and --force replaces it', async (t) => {
  const source = tmpDir(t, 'h5p-src-');
  const target = tmpDir(t, 'h5p-dst-');
  await writeLibrary(
    source,
    'H5P.Fixable-1.0',
    {
      machineName: 'H5P.Fixable',
      majorVersion: 1,
      minorVersion: 0
    },
    { 'marker.txt': 'new' }
  );
  // Existing copy on disk is corrupt: no machineName.
  await writeLibrary(target, 'H5P.Fixable-1.0', {
    majorVersion: 1,
    minorVersion: 0
  });

  const withoutForce = await run({
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  });
  assert.notEqual(
    withoutForce.code ?? 0,
    0,
    'a corrupt existing library must be reported, not silently skipped'
  );
  assert.equal(
    fsSync.existsSync(path.join(target, 'H5P.Fixable-1.0', 'marker.txt')),
    false,
    'without --force the corrupt copy is left in place, not overwritten'
  );

  await execFileAsync(process.execPath, [scriptPath, '--force'], {
    env: {
      ...process.env,
      H5P_LIBRARY_SOURCE_DIR: source,
      H5P_LIBRARIES_DIR: target
    }
  });
  assert.equal(
    await fs.readFile(
      path.join(target, 'H5P.Fixable-1.0', 'marker.txt'),
      'utf8'
    ),
    'new',
    '--force must replace the corrupt copy with the valid one'
  );
});

test('an interrupted replacement is recovered even without a configured source', async (t) => {
  const target = tmpDir(t, 'h5p-recover-');
  await writeLibrary(
    target,
    '.provision-backup-H5P.Foo-1.0',
    {
      machineName: 'H5P.Foo',
      majorVersion: 1,
      minorVersion: 0
    },
    { 'marker.txt': 'old' }
  );
  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: '',
    H5P_LIBRARIES_DIR: target
  });
  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.equal(
    await fs.readFile(path.join(target, 'H5P.Foo-1.0/marker.txt'), 'utf8'),
    'old'
  );
});

test('a failed replacement restores the previous library and preserves it if rollback also fails', async (t) => {
  const root = tmpDir(t, 'h5p-rollback-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const meta = { machineName: 'H5P.Foo', majorVersion: 1, minorVersion: 0 };
  await writeLibrary(source, 'H5P.Foo-1.0', meta, { 'marker.txt': 'new' });
  await writeLibrary(target, 'H5P.Foo-1.0', meta, { 'marker.txt': 'old' });
  const hook = path.join(root, 'fail-rename.cjs');
  await fs.writeFile(
    hook,
    `
    const fs = require('node:fs/promises');
    const original = fs.rename;
    fs.rename = async (from, to) => {
      if (from.includes('.provision-tmp-') ||
        (process.env.FAIL_ROLLBACK === '1' && from.includes('.provision-backup-'))) {
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      return original(from, to);
    };
  `
  );
  for (const failRollback of ['0', '1']) {
    const result = await execFileAsync(
      process.execPath,
      ['--require', hook, scriptPath, '--force'],
      {
        env: {
          ...process.env,
          H5P_LIBRARY_SOURCE_DIR: source,
          H5P_LIBRARIES_DIR: target,
          FAIL_ROLLBACK: failRollback
        }
      }
    ).catch((error) => error);
    assert.notEqual(result.code ?? 0, 0);
    const surviving =
      failRollback === '1' ? '.provision-backup-H5P.Foo-1.0' : 'H5P.Foo-1.0';
    assert.equal(
      await fs.readFile(path.join(target, surviving, 'marker.txt'), 'utf8'),
      'old'
    );
  }
  const recovered = await run({
    H5P_LIBRARY_SOURCE_DIR: '',
    H5P_LIBRARIES_DIR: target
  });
  assert.equal(recovered.code ?? 0, 0, recovered.stderr);
  assert.equal(
    await fs.readFile(path.join(target, 'H5P.Foo-1.0/marker.txt'), 'utf8'),
    'old'
  );
});

test('a stale backup beside a completed replacement is removed only when the installed copy is valid', async (t) => {
  const target = tmpDir(t, 'h5p-stale-');
  const meta = { machineName: 'H5P.Foo', majorVersion: 1, minorVersion: 0 };
  await writeLibrary(target, 'H5P.Foo-1.0', meta, { 'marker.txt': 'new' });
  await writeLibrary(target, '.provision-backup-H5P.Foo-1.0', meta, {
    'marker.txt': 'old'
  });
  const settled = await run({
    H5P_LIBRARY_SOURCE_DIR: '',
    H5P_LIBRARIES_DIR: target
  });
  assert.equal(settled.code ?? 0, 0, settled.stderr);
  assert.equal(
    await fs.readFile(path.join(target, 'H5P.Foo-1.0/marker.txt'), 'utf8'),
    'new'
  );
  assert.equal(
    fsSync.existsSync(path.join(target, '.provision-backup-H5P.Foo-1.0')),
    false
  );

  // An installed copy with no manifest: the backup may be the only good copy.
  await fs.mkdir(path.join(target, 'H5P.Bar-1.0'));
  await writeLibrary(
    target,
    '.provision-backup-H5P.Bar-1.0',
    { ...meta, machineName: 'H5P.Bar' },
    { 'marker.txt': 'old' }
  );
  const broken = await run({
    H5P_LIBRARY_SOURCE_DIR: '',
    H5P_LIBRARIES_DIR: target
  });
  assert.notEqual(broken.code ?? 0, 0);
  assert.equal(
    await fs.readFile(
      path.join(target, '.provision-backup-H5P.Bar-1.0/marker.txt'),
      'utf8'
    ),
    'old'
  );
});

test('a manifest whose version fields are not integers is rejected, as readiness would not count it', async (t) => {
  const root = tmpDir(t, 'h5p-intver-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await writeLibrary(source, 'H5P.Foo-1.0', {
    machineName: 'H5P.Foo',
    majorVersion: '1',
    minorVersion: 0
  });
  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  });
  assert.notEqual(result.code ?? 0, 0);
  assert.match(
    result.stderr,
    /majorVersion and minorVersion must be non-negative integers/
  );
  assert.equal(fsSync.existsSync(path.join(target, 'H5P.Foo-1.0')), false);
});

test('macOS metadata in the target is removed during the check, and the check passes', async (t) => {
  const target = tmpDir(t, 'h5p-macos-');
  await writeLibrary(
    target,
    'H5P.Good-1.0',
    {
      machineName: 'H5P.Good',
      majorVersion: 1,
      minorVersion: 0
    },
    {
      'js/good.js': '',
      'js/._good.js': 'AppleDouble',
      '._library.json': 'AppleDouble'
    }
  );
  // The twin h5p-server mistakes for a library: same name, but a file.
  await fs.writeFile(path.join(target, '._H5P.Good-1.0'), 'AppleDouble');
  await fs.writeFile(path.join(target, '.DS_Store'), '');
  await fs.mkdir(path.join(target, '__MACOSX'));
  await fs.writeFile(path.join(target, '__MACOSX', '._x'), '');

  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: '',
    H5P_LIBRARIES_DIR: target
  });

  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(result.stderr, /Removed 5 macOS metadata entries/);
  for (const gone of [
    '._H5P.Good-1.0',
    '.DS_Store',
    '__MACOSX',
    'H5P.Good-1.0/._library.json',
    'H5P.Good-1.0/js/._good.js'
  ]) {
    assert.equal(
      fsSync.existsSync(path.join(target, gone)),
      false,
      `${gone} must be removed`
    );
  }
  assert.ok(
    fsSync.existsSync(path.join(target, 'H5P.Good-1.0/js/good.js')),
    'real files stay'
  );
});

test('macOS metadata in the source never reaches the target', async (t) => {
  const root = tmpDir(t, 'h5p-macos-src-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await writeLibrary(
    source,
    'H5P.Foo-1.0',
    {
      machineName: 'H5P.Foo',
      majorVersion: 1,
      minorVersion: 0
    },
    { 'foo.js': '', '._foo.js': 'AppleDouble', '.DS_Store': '' }
  );
  await fs.writeFile(path.join(source, '._H5P.Foo-1.0'), 'AppleDouble');
  await fs.mkdir(path.join(source, '__MACOSX', 'H5P.Foo-1.0'), {
    recursive: true
  });
  await fs.writeFile(
    path.join(source, '__MACOSX', 'H5P.Foo-1.0', '._foo.js'),
    ''
  );

  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  });

  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(result.stdout, /1 copied, .*2 macOS metadata entries stripped/);
  assert.ok(fsSync.existsSync(path.join(target, 'H5P.Foo-1.0/foo.js')));
  assert.equal(
    fsSync.existsSync(path.join(target, 'H5P.Foo-1.0/._foo.js')),
    false
  );
  assert.equal(
    fsSync.existsSync(path.join(target, 'H5P.Foo-1.0/.DS_Store')),
    false
  );
  assert.equal(
    fsSync.existsSync(path.join(target, '__MACOSX')),
    false,
    '__MACOSX is not a library'
  );
  assert.deepEqual(
    (await fs.readdir(target)).sort(),
    ['H5P.Foo-1.0'],
    'only the library directory is installed'
  );
});

test('a stray file named like a library fails the run and is left in place', async (t) => {
  const target = tmpDir(t, 'h5p-stray-');
  await writeLibrary(target, 'H5P.Good-1.0', {
    machineName: 'H5P.Good',
    majorVersion: 1,
    minorVersion: 0
  });
  // Not macOS metadata, so the script must not delete it, only report it.
  await fs.writeFile(path.join(target, 'H5P.Stray-2.3'), 'not a directory');

  const result = await run({
    H5P_LIBRARY_SOURCE_DIR: '',
    H5P_LIBRARIES_DIR: target
  });

  assert.notEqual(result.code ?? 0, 0);
  assert.match(
    result.stderr,
    /would be listed as libraries by h5p-server.*H5P\.Stray-2\.3/
  );
  assert.ok(
    fsSync.existsSync(path.join(target, 'H5P.Stray-2.3')),
    'an unknown file is never deleted'
  );
});

test('--force keeps a valid backup as the rollback target when the installed copy is corrupt', async (t) => {
  const root = tmpDir(t, 'h5p-backup-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const meta = { machineName: 'H5P.Foo', majorVersion: 1, minorVersion: 0 };
  await writeLibrary(source, 'H5P.Foo-1.0', meta, { 'marker.txt': 'new' });
  const hook = path.join(root, 'fail-rename.cjs');
  await fs.writeFile(
    hook,
    `
    const fs = require('node:fs/promises');
    const original = fs.rename;
    fs.rename = async (from, to) => {
      if (from.includes('.provision-tmp-') ||
        (process.env.FAIL_ROLLBACK === '1' && from.includes('.provision-backup-'))) {
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      return original(from, to);
    };
  `
  );
  const env = {
    ...process.env,
    H5P_LIBRARY_SOURCE_DIR: source,
    H5P_LIBRARIES_DIR: target
  };
  for (const failRollback of ['0', '1']) {
    // An earlier run left a good backup beside a copy with no machineName.
    await fs.rm(target, { recursive: true, force: true });
    await writeLibrary(target, '.provision-backup-H5P.Foo-1.0', meta, {
      'marker.txt': 'old'
    });
    await writeLibrary(
      target,
      'H5P.Foo-1.0',
      { majorVersion: 1, minorVersion: 0 },
      { 'marker.txt': 'corrupt' }
    );
    const result = await execFileAsync(
      process.execPath,
      ['--require', hook, scriptPath, '--force'],
      {
        env: { ...env, FAIL_ROLLBACK: failRollback }
      }
    ).catch((error) => error);
    assert.notEqual(result.code ?? 0, 0);
    const surviving =
      failRollback === '1' ? '.provision-backup-H5P.Foo-1.0' : 'H5P.Foo-1.0';
    assert.equal(
      await fs.readFile(path.join(target, surviving, 'marker.txt'), 'utf8'),
      'old',
      'the good copy survives the failed swap; the corrupt one is what goes'
    );
    assert.equal(
      fsSync.existsSync(
        path.join(
          target,
          surviving === 'H5P.Foo-1.0'
            ? '.provision-backup-H5P.Foo-1.0'
            : 'H5P.Foo-1.0'
        )
      ),
      false
    );
    const recovered = await run({
      H5P_LIBRARY_SOURCE_DIR: '',
      H5P_LIBRARIES_DIR: target
    });
    assert.equal(recovered.code ?? 0, 0, recovered.stderr);
    assert.equal(
      await fs.readFile(path.join(target, 'H5P.Foo-1.0/marker.txt'), 'utf8'),
      'old'
    );
  }
  await execFileAsync(process.execPath, [scriptPath, '--force'], { env });
  assert.equal(
    await fs.readFile(path.join(target, 'H5P.Foo-1.0/marker.txt'), 'utf8'),
    'new'
  );
  assert.equal(
    fsSync.existsSync(path.join(target, '.provision-backup-H5P.Foo-1.0')),
    false
  );
});
