const assert = require('node:assert/strict');
const test = require('node:test');
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
