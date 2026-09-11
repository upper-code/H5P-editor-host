const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TenantManager = require('../build/src/tenant-manager').default;
const { tmpDir, withEnv } = require('./helpers');

const log = { info() {}, warn() {}, error() {} };

async function managerFor(t, settings = {}) {
  const root = tmpDir(t, 'host-lifecycle-');
  withEnv(t, {
    H5P_HOST_DATA_DIR: root,
    H5P_LIBRARIES_DIR: path.join(root, 'libraries'),
    H5P_HOST_UPLOAD_TMP_DIR: path.join(root, 'upload-tmp'),
    H5P_HOST_TENANT_CACHE_MAX: '1',
    H5P_HOST_TENANT_INIT_MAX: '2',
    ...settings
  });
  return new TenantManager(root, log);
}

test('pending tenants are deduplicated separately from the LRU and initialization is bounded', async (t) => {
  const manager = await managerFor(t);
  const a = Promise.withResolvers();
  const b = Promise.withResolvers();
  const c = Promise.withResolvers();
  const builds = [];
  manager.createTenant = (id) => {
    builds.push(id);
    return { a, b, c }[id].promise;
  };
  const first = manager.get('a');
  const second = manager.get('b');
  assert.equal(manager.get('a'), first);
  await assert.rejects(manager.get('c'), { statusCode: 503 });
  b.resolve({ distributorId: 'b' });
  const cachedB = await second;
  assert.equal(await manager.get('b'), cachedB);
  // A ready tenant and new constructions can coexist with a one-item LRU.
  const third = manager.get('c');
  assert.equal(manager.get('a'), first);
  a.resolve({ distributorId: 'a' });
  await first;
  c.resolve({ distributorId: 'c' });
  await third;
  assert.deepEqual(builds, ['a', 'b', 'c']);
  assert.equal(manager.tenants.size, 1);
  assert.equal(manager.pendingTenants.size, 0);
});

test('a failed tenant initialization releases capacity and can be retried', async (t) => {
  const manager = await managerFor(t, { H5P_HOST_TENANT_INIT_MAX: '1' });
  let attempts = 0;
  manager.createTenant = async (id) => {
    if (++attempts === 1) throw new Error('failed construction');
    return { distributorId: id };
  };
  await assert.rejects(manager.get('a'), /failed construction/);
  assert.equal((await manager.get('a')).distributorId, 'a');
  assert.equal(attempts, 2);
});

test('a tenant ID that is not one path segment is refused', async (t) => {
  const manager = await managerFor(t);
  manager.createTenant = async () =>
    assert.fail('must reject before creating storage');
  for (const id of ['../escape', '', 'a/b', '.hidden', 'a b']) {
    await assert.rejects(manager.get(id), { statusCode: 400 });
  }
});

test('a tenant ID that reads like a runtime directory is an ordinary tenant', async (t) => {
  // Nothing is shared between `tenants/` and the runtime directories, so the
  // names that used to collide with them no longer mean anything special.
  const manager = await managerFor(t);
  manager.createTenant = async (id) => ({ distributorId: id });
  for (const id of ['libraries', 'Libraries', 'upload-tmp', 'tenants']) {
    assert.equal((await manager.get(id)).distributorId, id);
  }
});

test('a burst of readiness requests shares one scan and caches its completion', async (t) => {
  const manager = await managerFor(t);
  let scans = 0;
  const scan = Promise.withResolvers();
  manager.countLibraries = async () => {
    scans++;
    return scan.promise;
  };
  const probes = Array.from({ length: 20 }, () => manager.readiness());
  assert.equal(scans, 1);
  scan.resolve(2);
  const results = await Promise.all(probes);
  assert.ok(results.every((value) => value.ready && value.libraryCount === 2));
  await manager.readiness();
  assert.equal(scans, 1);
});

test('a failed readiness scan is retried rather than permanently cached', async (t) => {
  const manager = await managerFor(t);
  let scans = 0;
  manager.countLibraries = async () => {
    if (++scans === 1) throw new Error('temporary failure');
    return 1;
  };
  await assert.rejects(manager.readiness(), /temporary failure/);
  assert.equal((await manager.readiness()).ready, true);
  assert.equal(scans, 2);
});

test('a data root inside the shared library or upload directory is refused at startup', async (t) => {
  // Every tenant directory would overlap the shared one; refusing each request
  // with "invalid distributor id" would hide the misconfiguration.
  await assert.rejects(
    managerFor(t, { H5P_LIBRARIES_DIR: os.tmpdir() }),
    /must not be inside/
  );
  await assert.rejects(
    managerFor(t, { H5P_HOST_UPLOAD_TMP_DIR: os.tmpdir() }),
    /must not be inside/
  );
});

test("an earlier layout's tenant directories are gathered under tenants/", async (t) => {
  const manager = await managerFor(t);
  const root = manager.dataRoot;
  // Two tenants as an older release left them, beside the shared directories
  // and beside something that was never ours.
  fs.mkdirSync(path.join(root, 'dev1', 'content'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dev1', 'content', 'marker'), 'kept');
  fs.mkdirSync(path.join(root, 'dev2', 'operations'), { recursive: true });
  fs.mkdirSync(path.join(root, 'libraries', 'H5P.Book-1.0'), {
    recursive: true
  });
  fs.mkdirSync(path.join(root, 'upload-tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'operator-notes'), { recursive: true });

  await manager.initialize();

  assert.equal(
    fs.readFileSync(
      path.join(root, 'tenants', 'dev1', 'content', 'marker'),
      'utf8'
    ),
    'kept'
  );
  assert.ok(fs.existsSync(path.join(root, 'tenants', 'dev2', 'operations')));
  assert.equal(fs.existsSync(path.join(root, 'dev1')), false);
  // Everything that is not a tenant of ours stays exactly where it was.
  assert.ok(fs.existsSync(path.join(root, 'libraries', 'H5P.Book-1.0')));
  assert.ok(fs.existsSync(path.join(root, 'upload-tmp')));
  assert.ok(fs.existsSync(path.join(root, 'operator-notes')));

  // A second start has nothing left to move and must not disturb the layout.
  await manager.initialize();
  assert.ok(fs.existsSync(path.join(root, 'tenants', 'dev1', 'content')));
});

test('a tenant that exists in both layouts is left for a human', async (t) => {
  const manager = await managerFor(t);
  const root = manager.dataRoot;
  fs.mkdirSync(path.join(root, 'dev1', 'content'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dev1', 'content', 'old'), 'old');
  fs.mkdirSync(path.join(root, 'tenants', 'dev1', 'content'), {
    recursive: true
  });
  fs.writeFileSync(path.join(root, 'tenants', 'dev1', 'content', 'new'), 'new');

  await manager.initialize();

  // Merging two histories is not a decision a start-up sweep gets to take.
  assert.ok(fs.existsSync(path.join(root, 'dev1', 'content', 'old')));
  assert.ok(
    fs.existsSync(path.join(root, 'tenants', 'dev1', 'content', 'new'))
  );
  assert.equal(
    fs.existsSync(path.join(root, 'tenants', 'dev1', 'content', 'old')),
    false
  );
});

test('a distributor that was called "tenants" is moved inside, not shadowed', async (t) => {
  // `tenants` was a valid distributor id under the old layout, and it is the
  // directory the new one wants. Skipping it would leave its books stranded at
  // a path nothing reads any more.
  const manager = await managerFor(t);
  const root = manager.dataRoot;
  fs.mkdirSync(path.join(root, 'tenants', 'content', '7'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tenants', 'content', '7', 'content.json'),
    '{"kept":true}'
  );

  await manager.initialize();

  assert.equal(
    fs.readFileSync(
      path.join(root, 'tenants', 'tenants', 'content', '7', 'content.json'),
      'utf8'
    ),
    '{"kept":true}'
  );
  assert.equal(
    (await manager.get('tenants')).rootPath,
    path.join(root, 'tenants', 'tenants')
  );

  // A second start sees a marked container, not a tenant of that name again.
  await manager.initialize();
  assert.equal(
    fs.existsSync(path.join(root, 'tenants', 'tenants', 'tenants')),
    false
  );
});

test('a container is not mistaken for a tenant by a distributor named "content"', async (t) => {
  const manager = await managerFor(t);
  const root = manager.dataRoot;
  await manager.initialize();
  // The container now holds a distributor whose own name is one of the marker
  // directories. Without the container marker the next start would read the
  // container itself as a tenant and nest the whole layout again.
  fs.mkdirSync(path.join(root, 'tenants', 'content', 'content'), {
    recursive: true
  });
  await manager.initialize();
  assert.ok(fs.existsSync(path.join(root, 'tenants', 'content', 'content')));
  assert.equal(fs.existsSync(path.join(root, 'tenants', 'tenants')), false);
});

test('a container move interrupted by a crash is finished, not built over', async (t) => {
  // The move of a tenant named "tenants" is two renames with the directory at
  // a temporary name in between. A start that ignored that name would create
  // an empty container over the top and hand the distributor a blank shelf.
  const manager = await managerFor(t);
  const root = manager.dataRoot;
  fs.mkdirSync(path.join(root, 'tenants.legacy', 'content', '7'), {
    recursive: true
  });
  fs.writeFileSync(
    path.join(root, 'tenants.legacy', 'content', '7', 'content.json'),
    '{"kept":true}'
  );

  await manager.initialize();

  assert.equal(
    fs.readFileSync(
      path.join(root, 'tenants', 'tenants', 'content', '7', 'content.json'),
      'utf8'
    ),
    '{"kept":true}'
  );
  assert.equal(fs.existsSync(path.join(root, 'tenants.legacy')), false);
});

test('two copies of the tenant named "tenants" stop the start', async (t) => {
  const manager = await managerFor(t);
  const root = manager.dataRoot;
  fs.mkdirSync(path.join(root, 'tenants.legacy', 'content'), {
    recursive: true
  });
  fs.mkdirSync(path.join(root, 'tenants', 'tenants', 'content'), {
    recursive: true
  });
  await assert.rejects(manager.initialize(), /two copies/);
});

test('a reserved directory that happens to sit at the migration name is left alone', async (t) => {
  // `tenants.legacy` is this service's name by convention, not by right; a
  // deployment may have pointed a runtime directory at it, and moving that
  // into a tenant would take every content type with it.
  const root = tmpDir(t, 'host-lifecycle-');
  withEnv(t, {
    H5P_HOST_DATA_DIR: root,
    H5P_LIBRARIES_DIR: path.join(root, 'tenants.legacy'),
    H5P_HOST_UPLOAD_TMP_DIR: path.join(root, 'upload-tmp')
  });
  fs.mkdirSync(path.join(root, 'tenants.legacy', 'H5P.Book-1.0'), {
    recursive: true
  });
  fs.writeFileSync(
    path.join(root, 'tenants.legacy', 'H5P.Book-1.0', 'library.json'),
    '{}'
  );

  await new TenantManager(root, log).initialize();

  assert.ok(
    fs.existsSync(
      path.join(root, 'tenants.legacy', 'H5P.Book-1.0', 'library.json')
    )
  );
  assert.equal(fs.existsSync(path.join(root, 'tenants', 'tenants')), false);
});
