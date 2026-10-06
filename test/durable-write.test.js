const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const syncDirectory = require('../build/src/durable-write').default;
const { makeDirectory } = require('../build/src/durable-write');
const {
  mutateContent,
  readOperation,
  transactionalContentStorage,
  withContentLock
} = require('../build/src/content-transactions');
const { tmpDir } = require('./helpers');

async function fixture(t) {
  const tenant = tmpDir(t, 'host-durable-');
  const root = path.join(tenant, 'content');
  await fs.mkdir(root);
  const storage = transactionalContentStorage(root);
  await storage.addContent(
    { title: 'Before' },
    { text: 'before' },
    { id: 'u' },
    '7'
  );
  const operationId = '00000000-0000-4000-8000-000000000001';
  return {
    tenant,
    root,
    operationId,
    save: () =>
      mutateContent({
        root,
        id: '7',
        operationId,
        fingerprint: 'after',
        reason: 'editor-save',
        save: async () => ({
          contentId: await storage.addContent(
            { title: 'After' },
            { text: 'after' },
            { id: 'u' },
            '7'
          )
        })
      })
  };
}

// Intercept the real handles, preserving all other filesystem behaviour.
function watchSync(t, onSync) {
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await onSync(String(args[0]));
      return sync();
    };
    return handle;
  });
}

test('new tenant directories are synced through their existing parent', async (t) => {
  const root = tmpDir(t, 'host-durable-mkdir-');
  const synced = [];
  watchSync(t, async (file) => {
    synced.push(file);
  });
  await makeDirectory(path.join(root, 'tenant', 'content'));
  assert.deepEqual(synced, [
    path.join(root, 'tenant', 'content'),
    path.join(root, 'tenant'),
    root
  ]);
});

test('content data reaches fsync before prepare, and directory moves before done', async (t) => {
  const store = await fixture(t);
  const events = [];
  watchSync(t, async (file) => {
    events.push(['sync', file]);
  });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to) === 'record.json') {
      events.push([JSON.parse(await fs.readFile(from, 'utf8')).state, to]);
    } else if (to === path.join(store.root, '7')) {
      events.push(['publish', to]);
    }
    return rename(from, to);
  });
  await store.save();
  const prepared = events.findIndex(([event]) => event === 'prepared');
  const published = events.findIndex(([event]) => event === 'publish');
  const done = events.findIndex(([event]) => event === 'done');
  const dir = path.join(store.tenant, 'operations', store.operationId);
  for (const filename of ['content.json', 'h5p.json']) {
    assert.ok(
      events
        .slice(0, prepared)
        .some(
          ([event, file]) =>
            event === 'sync' &&
            file === path.join(dir, 'content', '7', filename)
        )
    );
  }
  for (const directory of [store.root, dir, path.join(dir, 'content')]) {
    assert.ok(
      events
        .slice(published + 1, done)
        .some(([event, file]) => event === 'sync' && file === directory)
    );
  }
});

test('a staged file fsync failure rejects the save and preserves the published version', async (t) => {
  const store = await fixture(t);
  watchSync(t, async (file) => {
    if (file.includes(store.operationId) && file.endsWith('content.json')) {
      throw Object.assign(new Error('device failed'), { code: 'EIO' });
    }
  });
  await assert.rejects(store.save(), { code: 'EIO' });
  assert.equal(await readOperation(store.root, store.operationId), undefined);
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(store.root, '7', 'content.json'), 'utf8')
    ).text,
    'before'
  );
});

test('a directory fsync failure leaves the transaction prepared for recovery', async (t) => {
  const store = await fixture(t);
  let failed = false;
  watchSync(t, async (file) => {
    if (file === store.root && !failed) {
      failed = true;
      throw Object.assign(new Error('device failed'), { code: 'EIO' });
    }
  });
  await assert.rejects(store.save(), { code: 'EIO' });
  assert.equal(
    (await readOperation(store.root, store.operationId)).state,
    'prepared'
  );
  await withContentLock(store.root, async () => {});
  assert.equal(
    (await readOperation(store.root, store.operationId)).state,
    'done'
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(store.root, '7', 'content.json'), 'utf8')
    ).text,
    'after'
  );
});

test('unsupported directory fsync is tolerated, but real filesystem errors propagate', async (t) => {
  const directory = tmpDir(t, 'host-dir-sync-');
  let code = 'EINVAL';
  watchSync(t, async () => {
    throw Object.assign(new Error('sync failure'), { code });
  });
  await syncDirectory(directory);
  code = 'EIO';
  await assert.rejects(syncDirectory(directory), { code: 'EIO' });
  await assert.rejects(syncDirectory(path.join(directory, 'missing')), {
    code: 'ENOENT'
  });
});
