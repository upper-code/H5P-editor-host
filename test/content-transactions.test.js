const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

// Every limit this module reads comes from a getter called per request, so a
// test may set the environment after the require; nothing here is captured at
// load time.
const {
  acknowledgeOperation,
  assertContentJournalConfig,
  contentRevision,
  mutateContent,
  pendingOperations,
  pruneOperations,
  readOperation,
  recoverTransactions,
  startJournalJanitor,
  transactionalContentStorage,
  withContentLock
} = require('../build/src/content-transactions');
const { tmpDir, withEnv } = require('./helpers');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tenant(t) {
  const root = tmpDir(t, 'host-tx-');
  const content = path.join(root, 'content');
  const operations = path.join(root, 'operations');
  fs.mkdirSync(content);
  return {
    root,
    content,
    operations,
    /**
     * Publishes content `id` the way a completed save leaves it: its
     * parameters in `content.json` and its metadata in `h5p.json` — the two
     * files a revision is made of. `metadata: null` leaves the item
     * incomplete, which is what a crash mid-write leaves behind.
     */
    publish(id, params, metadata = { title: 'Book' }) {
      const directory = path.join(content, String(id));
      fs.mkdirSync(directory, { recursive: true });
      if (metadata) {
        fs.writeFileSync(
          path.join(directory, 'h5p.json'),
          JSON.stringify(metadata)
        );
      }
      fs.writeFileSync(
        path.join(directory, 'content.json'),
        JSON.stringify(params)
      );
      return directory;
    },
    /** Writes one journal entry, optionally with staged content beside it. */
    record(id, data, staged) {
      fs.mkdirSync(path.join(operations, id), { recursive: true });
      if (data) {
        fs.writeFileSync(
          path.join(operations, id, 'record.json'),
          JSON.stringify(data)
        );
      }
      if (staged) {
        const directory = path.join(operations, id, 'content', staged.id);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, 'content.json'),
          JSON.stringify(staged.params)
        );
      }
    },
    /** Pending usage for this tenant alone: the root holds other tests' too. */
    pending: () => pendingOperations(path.dirname(root), path.basename(root)),
    ids: () => fs.readdirSync(operations).sort()
  };
}

const uuid = (last) => `00000000-0000-4000-8000-00000000000${last}`;
const done = (extra) => ({
  fingerprint: 'f',
  state: 'done',
  reason: 'editor-save',
  deleted: false,
  result: {
    operationId: uuid(1),
    contentId: '7',
    savedBytes: 1,
    deltaBytes: 1
  },
  ...extra
});

test('incomplete content has no valid revision token', async (t) => {
  const store = tenant(t);
  fs.mkdirSync(path.join(store.content, '7'));
  await assert.rejects(() => contentRevision(store.content, '7'), {
    code: 'ENOENT'
  });
  fs.writeFileSync(path.join(store.content, '7', 'content.json'), '{"a":1}');
  await assert.rejects(() => contentRevision(store.content, '7'), {
    code: 'ENOENT'
  });
  fs.writeFileSync(
    path.join(store.content, '7', 'h5p.json'),
    '{"title":"Book"}'
  );
  const complete = await contentRevision(store.content, '7');
  assert.match(complete, /^[0-9a-f]{64}$/);
  assert.equal(await contentRevision(store.content, '7'), complete);
  await assert.rejects(() => contentRevision(store.content, '404'), {
    code: 'ENOENT'
  });
});

test('recovery finishes a prepared transaction and discards what never got that far', async (t) => {
  const store = tenant(t);
  store.publish('7', { old: true }, null);
  store.record(uuid(1), done({ state: 'prepared' }), {
    id: '7',
    params: { fresh: true }
  });
  // Debris: the directory a crash left before the journal existed.
  store.record(uuid(2));

  await recoverTransactions(store.content);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(store.content, '7', 'content.json'), 'utf8')
    ),
    { fresh: true },
    'the staged write is published'
  );
  assert.deepEqual(
    store.ids(),
    [uuid(1)],
    'the record survives for the embedder to acknowledge'
  );
  const record = JSON.parse(
    fs.readFileSync(path.join(store.operations, uuid(1), 'record.json'), 'utf8')
  );
  assert.equal(record.state, 'done');
  assert.ok(record.completedAt > 0);
});

test('concurrent writers cannot commit over the same revision even without an HTTP lock', async (t) => {
  const store = tenant(t);
  store.publish('7', { text: 'original' });
  const revision = await contentRevision(store.content, '7');
  const storage = transactionalContentStorage(store.content);
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const write = (text) =>
    storage
      .addContent({ title: 'Book' }, { text }, { id: 'd1' }, '7')
      .then((id) => ({ contentId: id }));
  const first = mutateContent({
    root: store.content,
    id: '7',
    operationId: uuid(7),
    fingerprint: 'first',
    revision,
    reason: 'editor-save',
    save: async () => {
      started.resolve();
      await gate.promise;
      return write('first');
    }
  });
  await started.promise;
  const second = assert.rejects(
    () =>
      mutateContent({
        root: store.content,
        id: '7',
        operationId: uuid(8),
        fingerprint: 'second',
        revision,
        reason: 'editor-save',
        save: () => write('second')
      }),
    (error) => error.statusCode === 409
  );
  gate.resolve();
  await first;
  await second;
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(store.content, '7', 'content.json'), 'utf8')
    ),
    { text: 'first' }
  );
});

for (const failure of ['move-live', 'publish-stage', 'mark-done', 'cleanup']) {
  test(`a failed ${failure} is recovered before another read or save`, async (t) => {
    const store = tenant(t);
    store.publish('7', { text: 'original' });
    const revision = await contentRevision(store.content, '7');
    const storage = transactionalContentStorage(store.content);
    const operation = (n, text, base = revision) => ({
      root: store.content,
      id: '7',
      operationId: uuid(n),
      fingerprint: text,
      revision: base,
      reason: 'editor-save',
      save: async () => ({
        contentId: await storage.addContent(
          { title: 'Book' },
          { text },
          { id: 'd1' },
          '7'
        )
      })
    });
    const originalRename = fsp.rename;
    const originalRm = fsp.rm;
    let failed = false;
    const fail = () => {
      failed = true;
      throw Object.assign(new Error('injected publication failure'), {
        code: 'EIO'
      });
    };
    t.mock.method(fsp, 'rename', async (from, to) => {
      if (
        !failed &&
        ((failure === 'move-live' && from === path.join(store.content, '7')) ||
          (failure === 'publish-stage' &&
            to === path.join(store.content, '7')) ||
          (failure === 'mark-done' &&
            to.endsWith('record.json') &&
            JSON.parse(await fsp.readFile(from, 'utf8')).state === 'done'))
      )
        fail();
      return originalRename(from, to);
    });
    t.mock.method(fsp, 'rm', async (file, options) => {
      if (!failed && failure === 'cleanup' && file.endsWith('previous')) fail();
      return originalRm(file, options);
    });
    const first = operation(1, 'first');
    await assert.rejects(mutateContent(first), { code: 'EIO' });
    assert.equal(failed, true);
    // The next mutation has to finish A, then reject the stale authored revision.
    await assert.rejects(
      mutateContent(operation(2, 'second')),
      (e) => e.statusCode === 409
    );
    const recovered = await withContentLock(store.content, () =>
      contentRevision(store.content, '7')
    );
    await mutateContent(operation(2, 'second', recovered));
    await mutateContent(first);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(store.content, '7', 'content.json'), 'utf8')
      ),
      { text: 'second' }
    );
  });
}

test('unrecoverable publication blocks queued work and keeps the journal for retry', async (t) => {
  const store = tenant(t);
  const storage = transactionalContentStorage(store.content);
  const rename = fsp.rename;
  const mock = t.mock.method(fsp, 'rename', async (from, to) => {
    if (path.dirname(to) === store.content)
      throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
    return rename(from, to);
  });
  const save = () =>
    mutateContent({
      root: store.content,
      operationId: uuid(1),
      fingerprint: 'new',
      reason: 'editor-save',
      save: async () => ({
        contentId: await storage.addContent(
          { title: 'Book' },
          { text: 'first' },
          { id: 'd1' }
        )
      })
    });
  await assert.rejects(save(), { code: 'EIO' });
  let entered = false;
  await assert.rejects(
    withContentLock(store.content, async () => {
      entered = true;
    }),
    { code: 'EIO' }
  );
  assert.equal(entered, false);
  mock.mock.restore();
  await withContentLock(store.content, async () => {
    entered = true;
  });
  assert.equal(entered, true);
  const result = await save();
  assert.equal(
    fs.existsSync(path.join(store.content, result.contentId, 'content.json')),
    true
  );
});

test('an acknowledged receipt leaves the pending scan but still answers its key', async (t) => {
  const store = tenant(t);
  const storage = transactionalContentStorage(store.content);
  const save = (n) =>
    mutateContent({
      root: store.content,
      operationId: uuid(n),
      fingerprint: `body-${n}`,
      reason: 'editor-save',
      save: async () => ({
        contentId: await storage.addContent(
          { title: 'Book' },
          { text: `n${n}` },
          { id: 'd1' }
        )
      })
    });
  const first = await save(1);
  const second = await save(2);
  assert.deepEqual(
    (await store.pending()).map((p) => p.operationId).sort(),
    [uuid(1), uuid(2)].sort()
  );

  await acknowledgeOperation(
    store.content,
    uuid(1),
    await readOperation(store.content, uuid(1))
  );
  assert.deepEqual(
    (await store.pending()).map((p) => p.operationId),
    [uuid(2)]
  );
  // Moved aside, not deleted: the scans stay proportional to the unsettled
  // writes, and the receipt still answers a replayed key with the first result.
  assert.deepEqual(store.ids(), [uuid(2), 'acked']);
  assert.deepEqual(fs.readdirSync(path.join(store.operations, 'acked')), [
    uuid(1)
  ]);
  assert.equal(
    (await readOperation(store.content, uuid(1))).acknowledged,
    true
  );
  assert.deepEqual(
    await save(1),
    first,
    'the replay repeats the recorded answer'
  );
  assert.equal(
    fs.readdirSync(store.content).length,
    2,
    'and writes nothing new'
  );
  assert.notEqual(first.contentId, second.contentId);
});

test('acknowledging twice is not an error and a repeat does not resurrect the entry', async (t) => {
  const store = tenant(t);
  const storage = transactionalContentStorage(store.content);
  await mutateContent({
    root: store.content,
    operationId: uuid(1),
    fingerprint: 'body',
    reason: 'editor-save',
    save: async () => ({
      contentId: await storage.addContent(
        { title: 'Book' },
        { text: 'x' },
        { id: 'd1' }
      )
    })
  });
  const record = await readOperation(store.content, uuid(1));
  await acknowledgeOperation(store.content, uuid(1), record);
  await acknowledgeOperation(
    store.content,
    uuid(1),
    await readOperation(store.content, uuid(1))
  );
  assert.deepEqual(store.ids(), ['acked']);
  assert.deepEqual(await store.pending(), []);
});

test('pending usage can be asked for one tenant instead of every tenant', async (t) => {
  const store = tenant(t);
  const other = path.join(
    store.root,
    '..',
    path.basename(store.root) + '-other'
  );
  fs.mkdirSync(path.join(other, 'content'), { recursive: true });
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const dataRoot = path.dirname(store.root);
  for (const root of [store.content, path.join(other, 'content')]) {
    const storage = transactionalContentStorage(root);
    await mutateContent({
      root,
      operationId: uuid(1),
      fingerprint: 'body',
      reason: 'editor-save',
      save: async () => ({
        contentId: await storage.addContent(
          { title: 'Book' },
          { text: 'x' },
          { id: 'd1' }
        )
      })
    });
  }
  const mine = path.basename(store.root);
  assert.deepEqual(
    (await pendingOperations(dataRoot, mine)).map((p) => p.distributorId),
    [mine]
  );
  assert.ok((await pendingOperations(dataRoot)).length >= 2);
});

test('only settled receipts and abandoned staging expire; uncharged writes never do', async (t) => {
  const store = tenant(t);
  const now = Date.now();
  const age = (dir, ms) =>
    fs.utimesSync(dir, new Date(now - ms), new Date(now - ms));
  // Acknowledged, past retention: the receipt has done its job.
  store.record(
    uuid(1),
    done({ acknowledged: true, acknowledgedAt: now - 8 * DAY })
  );
  fs.mkdirSync(path.join(store.operations, 'acked'), { recursive: true });
  fs.renameSync(
    path.join(store.operations, uuid(1)),
    path.join(store.operations, 'acked', uuid(1))
  );
  age(path.join(store.operations, 'acked', uuid(1)), 8 * DAY);
  // Acknowledged, still inside the window.
  store.record(
    uuid(2),
    done({ acknowledged: true, acknowledgedAt: now - 2 * HOUR })
  );
  fs.renameSync(
    path.join(store.operations, uuid(2)),
    path.join(store.operations, 'acked', uuid(2))
  );
  // A crash between writing the receipt and moving it aside: only age clears it.
  store.record(
    uuid(3),
    done({ acknowledged: true, acknowledgedAt: now - 8 * DAY })
  );
  age(path.join(store.operations, uuid(3)), 8 * DAY);
  // Written, never charged: kept whatever its age, or the bytes go unbilled.
  store.record(uuid(4), done({ completedAt: now - 30 * DAY }));
  age(path.join(store.operations, uuid(4)), 30 * DAY);
  // Still preparing, or waiting for recovery to finish its rename.
  store.record(uuid(5), {
    ...done(),
    state: 'prepared',
    completedAt: undefined
  });
  // Staging a crash abandoned before any record existed.
  store.record(uuid(6));
  age(path.join(store.operations, uuid(6)), 8 * DAY);
  store.record('not-an-operation');

  assert.equal(await pruneOperations(store.content, now), 3);
  assert.deepEqual(
    store.ids(),
    [uuid(4), uuid(5), 'acked', 'not-an-operation'].sort()
  );
  assert.deepEqual(fs.readdirSync(path.join(store.operations, 'acked')), [
    uuid(2)
  ]);
});

test('reads share the lock with each other and exclude a write', async (t) => {
  const store = tenant(t);
  const order = [];
  const both = Promise.withResolvers();
  let readers = 0;
  const read = (name) =>
    withContentLock(
      store.content,
      async () => {
        order.push(name);
        readers += 1;
        // A shared holder cannot finish until the other one has started too, so
        // this only completes if the two really do run at the same time.
        if (readers === 2) both.resolve();
        await both.promise;
      },
      { mode: 'shared' }
    );
  const readers2 = Promise.all([read('read-a'), read('read-b')]);
  const write = withContentLock(store.content, async () => {
    order.push('write');
  });
  await readers2;
  await write;
  // Which of the two readers starts first is not something the lock promises:
  // both take a file of their own under `locks/readers/`, and that is IO. That
  // they overlap (`both.promise` above) and that the write follows them is.
  assert.deepEqual(order.slice(0, 2).sort(), ['read-a', 'read-b']);
  assert.equal(order[2], 'write');
});

test('a write that cannot get the lock in time is answered 503 and the queue keeps moving', async (t) => {
  const store = tenant(t);
  const held = Promise.withResolvers();
  const holder = withContentLock(store.content, () => held.promise, {
    mode: 'shared'
  });
  await assert.rejects(
    withContentLock(store.content, async () => 'never', { waitMs: 20 }),
    (error) => error.statusCode === 503
  );
  held.resolve();
  await holder;
  assert.equal(
    await withContentLock(store.content, async () => 'after', { waitMs: 1000 }),
    'after'
  );
});

test('a mutation draws its lock wait from the budget it is handed', async (t) => {
  // The HTTP queue in `app.ts` starts one budget when a request arrives and
  // hands on what is left of it as `waitMs`. Both ends of that hand-off matter:
  // a budget already spent must be a 503 now (not a fresh wait), and one with
  // time left must bound the acquisition by exactly that time (not the module
  // default a dropped hand-off would fall back to). A generous default here is
  // what makes the second regression observable rather than a 40 ms timeout.
  withEnv(t, { H5P_HOST_MUTATION_WAIT_MS: '5000' });
  const store = tenant(t);
  const held = Promise.withResolvers();
  const holding = Promise.withResolvers();
  const holder = withContentLock(
    store.content,
    () => {
      holding.resolve();
      return held.promise;
    },
    { mode: 'shared' }
  );
  await holding.promise;
  const save = () => Promise.resolve({ contentId: '7' });

  const spentAt = Date.now();
  await assert.rejects(
    mutateContent({
      root: store.content,
      operationId: uuid(1),
      fingerprint: 'a',
      reason: 'editor-save',
      save,
      waitMs: 0
    }),
    (error) => error.statusCode === 503
  );
  assert.ok(
    Date.now() - spentAt < 100,
    'an exhausted budget is refused at once, not waited out afresh'
  );

  const boundedAt = Date.now();
  await assert.rejects(
    mutateContent({
      root: store.content,
      operationId: uuid(2),
      fingerprint: 'b',
      reason: 'editor-save',
      save,
      waitMs: 40
    }),
    (error) => error.statusCode === 503
  );
  const waited = Date.now() - boundedAt;
  assert.ok(
    waited >= 30 && waited < 1000,
    `waited ${waited}ms for the lock instead of its 40ms budget`
  );

  held.resolve();
  await holder;
});

test('staging shares the published bytes but never writes through them', async (t) => {
  const store = tenant(t);
  const dir = store.publish('7', { text: 'original' });
  fs.mkdirSync(path.join(dir, 'images'));
  fs.writeFileSync(path.join(dir, 'images', 'kept.png'), 'PNGDATA');
  const storage = transactionalContentStorage(store.content);
  const staged = Promise.withResolvers();
  const run = mutateContent({
    root: store.content,
    id: '7',
    operationId: uuid(1),
    fingerprint: 'body',
    reason: 'editor-save',
    save: async () => {
      const stage = path.join(store.operations, uuid(1), 'content', '7');
      // The previous revision is present in the stage without a byte copy.
      assert.equal(
        fs.readFileSync(path.join(stage, 'images', 'kept.png'), 'utf8'),
        'PNGDATA'
      );
      staged.resolve(fs.statSync(path.join(stage, 'images', 'kept.png')).nlink);
      const id = await storage.addContent(
        { title: 'Book' },
        { text: 'edited' },
        { id: 'd1' },
        '7'
      );
      await storage.addFile(
        '7',
        'images/kept.png',
        Readable.from(['REPLACED']),
        { id: 'd1' }
      );
      // Both writes landed in the stage, and neither reached the live copy.
      assert.equal(
        fs.readFileSync(path.join(store.content, '7', 'content.json'), 'utf8'),
        '{"text":"original"}'
      );
      assert.equal(
        fs.readFileSync(
          path.join(store.content, '7', 'images', 'kept.png'),
          'utf8'
        ),
        'PNGDATA'
      );
      return { contentId: id };
    }
  });
  assert.ok((await staged.promise) >= 1);
  await run;
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, 'content.json'), 'utf8')),
    { text: 'edited' }
  );
  assert.equal(
    fs.readFileSync(path.join(dir, 'images', 'kept.png'), 'utf8'),
    'REPLACED'
  );
});

test('with no reflink the stage is hardlinked, and writing it still leaves the published copy alone', async (t) => {
  const store = tenant(t);
  const dir = store.publish('7', { text: 'original' });
  fs.mkdirSync(path.join(dir, 'images'));
  fs.writeFileSync(path.join(dir, 'images', 'kept.png'), 'PNGDATA');
  const original = fs.statSync(path.join(dir, 'images', 'kept.png'));
  // ext4 and friends: no reflink, so the clone has to fall back to links.
  const cp = fsp.cp;
  t.mock.method(fsp, 'cp', async (from, to, options) => {
    if (options?.mode)
      throw Object.assign(new Error('no reflink here'), { code: 'ENOTSUP' });
    return cp(from, to, options);
  });
  const storage = transactionalContentStorage(store.content);
  const stage = path.join(store.operations, uuid(1), 'content', '7');
  let linked;
  await mutateContent({
    root: store.content,
    id: '7',
    operationId: uuid(1),
    fingerprint: 'body',
    reason: 'editor-save',
    save: async () => {
      // Shared inode: the previous revision cost directory entries, not bytes.
      linked = fs.statSync(path.join(stage, 'images', 'kept.png'));
      assert.equal(linked.ino, original.ino);
      assert.equal(linked.nlink, 2);
      const id = await storage.addContent(
        { title: 'Book' },
        { text: 'edited' },
        { id: 'd1' },
        '7'
      );
      await storage.addFile(
        '7',
        'images/kept.png',
        Readable.from(['REPLACED']),
        { id: 'd1' }
      );
      // The link was broken before the write, so the published bytes are intact
      // while the transaction is still undecided.
      assert.equal(
        fs.readFileSync(path.join(dir, 'images', 'kept.png'), 'utf8'),
        'PNGDATA'
      );
      assert.equal(
        fs.readFileSync(path.join(dir, 'content.json'), 'utf8'),
        '{"text":"original"}'
      );
      assert.notEqual(
        fs.statSync(path.join(stage, 'images', 'kept.png')).ino,
        original.ino
      );
      return { contentId: id };
    }
  });
  assert.equal(
    fs.readFileSync(path.join(dir, 'images', 'kept.png'), 'utf8'),
    'REPLACED'
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, 'content.json'), 'utf8')),
    { text: 'edited' }
  );
});

test('a rejected transaction leaves every published byte where it was', async (t) => {
  const store = tenant(t);
  const dir = store.publish('7', { text: 'original' });
  fs.mkdirSync(path.join(dir, 'images'));
  fs.writeFileSync(path.join(dir, 'images', 'kept.png'), 'PNGDATA');
  const cp = fsp.cp;
  t.mock.method(fsp, 'cp', async (from, to, options) => {
    if (options?.mode)
      throw Object.assign(new Error('no reflink here'), { code: 'ENOTSUP' });
    return cp(from, to, options);
  });
  const storage = transactionalContentStorage(store.content);
  await assert.rejects(
    mutateContent({
      root: store.content,
      id: '7',
      operationId: uuid(1),
      fingerprint: 'body',
      reason: 'editor-save',
      maxDeltaBytes: 0,
      save: async () => {
        const id = await storage.addContent(
          { title: 'Book' },
          { text: 'x'.repeat(5000) },
          { id: 'd1' },
          '7'
        );
        await storage.addFile(
          '7',
          'images/kept.png',
          Readable.from(['REPLACED']),
          { id: 'd1' }
        );
        return { contentId: id };
      }
    }),
    (error) => error.statusCode === 413
  );
  assert.equal(
    fs.readFileSync(path.join(dir, 'images', 'kept.png'), 'utf8'),
    'PNGDATA'
  );
  assert.equal(
    fs.readFileSync(path.join(dir, 'content.json'), 'utf8'),
    '{"text":"original"}'
  );
});

test('a shared phase behind a failed publication recovers once, exclusively', async (t) => {
  const store = tenant(t);
  store.publish('7', { text: 'original' });
  const revision = await contentRevision(store.content, '7');
  const storage = transactionalContentStorage(store.content);
  const rename = fsp.rename;
  let failed = false;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (!failed && to === path.join(store.content, '7')) {
      failed = true;
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const write = mutateContent({
    root: store.content,
    id: '7',
    operationId: uuid(1),
    fingerprint: 'body',
    revision,
    reason: 'editor-save',
    save: async () => {
      started.resolve();
      await gate.promise;
      return {
        contentId: await storage.addContent(
          { title: 'Book' },
          { text: 'first' },
          { id: 'd1' },
          '7'
        )
      };
    }
  });
  await started.promise;
  // Queued behind the writer as one shared phase: when it fails to publish,
  // all of them find the repair outstanding at the same moment.
  let overlapping = 0;
  let peak = 0;
  const read = () =>
    withContentLock(
      store.content,
      async () => {
        overlapping += 1;
        peak = Math.max(peak, overlapping);
        const text = JSON.parse(
          fs.readFileSync(path.join(store.content, '7', 'content.json'), 'utf8')
        ).text;
        await new Promise((resolve) => setTimeout(resolve, 5));
        overlapping -= 1;
        return text;
      },
      { mode: 'shared' }
    );
  const readers = [read(), read(), read()];
  gate.resolve();
  await assert.rejects(write, { code: 'EIO' });
  const seen = await Promise.all(readers);
  // The repair ran under exclusivity, so no reader observed a half-published
  // directory, and every one of them read the recovered revision.
  assert.deepEqual(seen, ['first', 'first', 'first']);
  assert.ok(peak >= 1);
  assert.equal(
    fs.existsSync(path.join(store.operations, uuid(1), 'previous')),
    false
  );
});

test('a replayed key that fails to publish leaves the repair for the next turn', async (t) => {
  const store = tenant(t);
  store.publish('7', { text: 'old' }, null);
  // The journal a crash left behind: prepared, staged, never published. The
  // fingerprint is the one `mutateContent` derives, so the same key replays
  // instead of being refused as a different save.
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify(['7', 'editor-save', 'body', undefined]))
    .digest('hex');
  store.record(
    uuid(1),
    done({ state: 'prepared', fingerprint, result: { contentId: '7' } }),
    { id: '7', params: { text: 'staged' } }
  );
  const rename = fsp.rename;
  let failed = false;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (!failed && to === path.join(store.content, '7')) {
      failed = true;
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  const replay = () =>
    mutateContent({
      root: store.content,
      id: '7',
      operationId: uuid(1),
      fingerprint: 'body',
      reason: 'editor-save',
      save: async () => assert.fail('a replay must not save again')
    });
  await assert.rejects(replay(), { code: 'EIO' });
  assert.equal(
    fs.existsSync(path.join(store.content, '7')),
    false,
    'the failure left the tenant mid-publication'
  );
  // A reader is enough to notice it: the flag the replay raised turns the next
  // acquisition into an exclusive repair.
  const text = await withContentLock(
    store.content,
    async () =>
      JSON.parse(
        fs.readFileSync(path.join(store.content, '7', 'content.json'), 'utf8')
      ).text,
    { mode: 'shared' }
  );
  assert.equal(text, 'staged');
  assert.equal((await replay()).contentId, '7', 'the key still answers');
});

test('a staged write cannot delete a file outside its transaction', async (t) => {
  const store = tenant(t);
  store.publish('7', { text: 'published' }, { title: 'B' });
  const storage = transactionalContentStorage(store.content);
  const revision = await contentRevision(store.content, '7');
  await assert.rejects(
    mutateContent({
      root: store.content,
      id: '7',
      operationId: uuid(1),
      fingerprint: 'body',
      revision,
      reason: 'editor-save',
      // The staged name is unlinked before it is written, so a filename that
      // climbs out of the staging area would delete the published file.
      save: () =>
        storage.addFile(
          '7',
          '../../../content/7/content.json',
          Readable.from(['x']),
          { id: 'd1' }
        )
    }),
    (error) => error.statusCode === 400
  );
  assert.equal(
    fs.readFileSync(path.join(store.content, '7', 'content.json'), 'utf8'),
    '{"text":"published"}'
  );
});

test('a mistyped limit is refused where an operator can see it', (t) => {
  withEnv(t, { H5P_HOST_MUTATION_WAIT_MS: '30_000' });
  assert.throws(
    () => assertContentJournalConfig(),
    /H5P_HOST_MUTATION_WAIT_MS must be a number/
  );
});

test('the documented defaults pass the same check', () => {
  assert.doesNotThrow(() => assertContentJournalConfig());
});

test('a recovery pass that dies half way leaves the repair for the next request', async (t) => {
  const store = tenant(t);
  // Two crashes' worth of journal: both prepared, both staged, neither
  // published. Which one the walk reaches first is the filesystem's business.
  for (const id of ['7', '8']) {
    store.publish(id, { text: 'old' }, null);
  }
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify(['7', 'editor-save', 'body', undefined]))
    .digest('hex');
  store.record(
    uuid(1),
    done({ state: 'prepared', fingerprint, result: { contentId: '7' } }),
    { id: '7', params: { text: 'staged-7' } }
  );
  store.record(
    uuid(2),
    done({ state: 'prepared', result: { contentId: '8' } }),
    {
      id: '8',
      params: { text: 'staged-8' }
    }
  );
  // A replay that fails to publish is what raises the repair flag.
  const rename = fsp.rename;
  let failed = false;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (!failed && to === path.join(store.content, '7')) {
      failed = true;
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(
    mutateContent({
      root: store.content,
      id: '7',
      operationId: uuid(1),
      fingerprint: 'body',
      reason: 'editor-save',
      save: async () => assert.fail('a replay must not save again')
    }),
    { code: 'EIO' }
  );

  // The repair now walks both entries, and the device goes away between them.
  const readFile = fsp.readFile;
  let records = 0;
  const unreadable = t.mock.method(fsp, 'readFile', async (file, ...rest) => {
    if (String(file).endsWith('record.json') && ++records === 2) {
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    }
    return readFile(file, ...rest);
  });
  let entered = false;
  await assert.rejects(
    withContentLock(store.content, async () => {
      entered = true;
    }),
    { code: 'EIO' }
  );
  assert.equal(
    entered,
    false,
    'the request is refused, not served half-repaired'
  );
  unreadable.mock.restore();

  // One entry was published, the other was not: the pass never settled the
  // journal, so the next turn has to run it again.
  const published = await withContentLock(
    store.content,
    async () =>
      ['7', '8'].map(
        (id) =>
          JSON.parse(
            fs.readFileSync(
              path.join(store.content, id, 'content.json'),
              'utf8'
            )
          ).text
      ),
    { mode: 'shared' }
  );
  assert.deepEqual(published, ['staged-7', 'staged-8']);
});

test('a clone that fails for want of space does not cost every later save its links', async (t) => {
  const store = tenant(t);
  const dir = store.publish('7', { text: 'original' });
  fs.writeFileSync(path.join(dir, 'kept.png'), 'PNGDATA');
  // An ordinary Linux deployment: no reflink, so the ladder settles on links.
  const cp = fsp.cp;
  t.mock.method(fsp, 'cp', async (from, to, options) => {
    if (options?.mode)
      throw Object.assign(new Error('no reflink here'), { code: 'ENOTSUP' });
    return cp(from, to, options);
  });
  // The first save runs out of space part way through the link farm, which
  // says nothing about what this filesystem can do.
  const link = fsp.link;
  let full = false;
  t.mock.method(fsp, 'link', async (from, to) => {
    if (!full) {
      full = true;
      throw Object.assign(new Error('no space left on device'), {
        code: 'ENOSPC'
      });
    }
    return link(from, to);
  });
  const storage = transactionalContentStorage(store.content);
  const staged = (n) =>
    fs.statSync(
      path.join(store.operations, uuid(n), 'content', '7', 'kept.png')
    );
  const save = (n, check) =>
    mutateContent({
      root: store.content,
      id: '7',
      operationId: uuid(n),
      fingerprint: `body-${n}`,
      reason: 'editor-save',
      save: async () => {
        check(staged(n));
        return {
          contentId: await storage.addContent(
            { title: 'Book' },
            { text: `v${n}` },
            { id: 'd1' },
            '7'
          )
        };
      }
    });
  const before = fs.statSync(path.join(dir, 'kept.png'));
  await save(1, (copied) =>
    assert.notEqual(
      copied.ino,
      before.ino,
      'the failed farm fell back to bytes'
    )
  );
  const published = fs.statSync(path.join(dir, 'kept.png'));
  await save(2, (linked) =>
    assert.equal(
      linked.ino,
      published.ino,
      'the next save shares the published inode again'
    )
  );
  assert.equal(
    fs.readFileSync(path.join(dir, 'kept.png'), 'utf8'),
    'PNGDATA',
    'the media survived both transactions'
  );
});

test('the sweep reaches a tenant that nobody writes to any more', async (t) => {
  // Pruning otherwise only ever happens on the back of an acknowledgement, so
  // the last receipts of a tenant that has gone quiet — and the lock file a
  // crash left in it — would sit there for the life of the deployment.
  const dataRoot = tmpDir(t, 'host-sweep-');
  const quiet = path.join(dataRoot, 'dev1');
  const operations = path.join(quiet, 'operations');
  const now = Date.now();
  fs.mkdirSync(path.join(operations, uuid(1)), { recursive: true });
  fs.writeFileSync(
    path.join(operations, uuid(1), 'record.json'),
    JSON.stringify(done({ acknowledged: true, acknowledgedAt: now - 8 * DAY }))
  );
  fs.utimesSync(
    path.join(operations, uuid(1)),
    new Date(now - 8 * DAY),
    new Date(now - 8 * DAY)
  );
  fs.mkdirSync(path.join(quiet, 'locks'), { recursive: true });
  // A process that died inside a break leaves its guard behind, and nothing
  // else would ever remove it.
  const abandoned = path.join(quiet, 'locks', 'content.break');
  fs.writeFileSync(abandoned, '1');
  const long = new Date(Date.now() - 60_000);
  fs.utimesSync(abandoned, long, long);

  const stop = startJournalJanitor({
    dataRoot,
    intervalMs: HOUR,
    log: { info() {}, warn() {} }
  });
  t.after(stop);
  const deadline = Date.now() + 4000;
  while (fs.existsSync(path.join(operations, uuid(1)))) {
    assert.ok(Date.now() < deadline, 'the first sweep never ran');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(abandoned), false);
});

/** A lock file's contents, as a holder writes them. */
function lockOwner(pid) {
  return JSON.stringify({
    pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    token: crypto.randomUUID()
  });
}

test('a publication that fails leaves a flag every process can see', async (t) => {
  // The in-memory flag warns this process and nobody else. A tenant left
  // half-published has to be recognisable to the next process to arrive —
  // including this one after a restart — or a locked read answers with content
  // that is still moved aside.
  const store = tenant(t);
  store.record(uuid(1), { ...done(), state: 'prepared' });
  await assert.rejects(
    withContentLock(store.content, () => recoverTransactions(store.content)),
    /Incomplete content transaction/
  );
  assert.ok(
    fs.existsSync(path.join(store.root, 'locks', 'recovery-required')),
    'the flag outlives the process that raised it'
  );

  // With the entry gone the repair succeeds, and the flag comes down with it.
  fs.rmSync(path.join(store.operations, uuid(1)), { recursive: true });
  await withContentLock(store.content, async () => undefined);
  assert.equal(
    fs.existsSync(path.join(store.root, 'locks', 'recovery-required')),
    false
  );
});

test('the sweep repairs a tenant whose writer did not survive', async (t) => {
  const dataRoot = tmpDir(t, 'host-sweep-lock-');
  const quiet = path.join(dataRoot, 'dev1');
  const content = path.join(quiet, 'content');
  const operations = path.join(quiet, 'operations');
  fs.mkdirSync(content, { recursive: true });
  // A save that was interrupted between its record and its publication, and
  // the lock of the process that never came back.
  fs.mkdirSync(path.join(operations, uuid(1), 'content', '7'), {
    recursive: true
  });
  fs.writeFileSync(
    path.join(operations, uuid(1), 'content', '7', 'content.json'),
    '{"staged":true}'
  );
  fs.writeFileSync(
    path.join(operations, uuid(1), 'record.json'),
    JSON.stringify({ ...done(), state: 'prepared', completedAt: undefined })
  );
  fs.mkdirSync(path.join(quiet, 'locks'), { recursive: true });
  const { pid } = require('node:child_process').spawnSync(process.execPath, [
    '-e',
    ''
  ]);
  fs.writeFileSync(path.join(quiet, 'locks', 'content.write'), lockOwner(pid));

  const stop = startJournalJanitor({
    dataRoot,
    intervalMs: HOUR,
    log: { info() {}, warn() {} }
  });
  t.after(stop);
  // Clearing the abandoned lock without replaying the journal would leave the
  // tenant looking free with its save still unpublished.
  const deadline = Date.now() + 4000;
  while (!fs.existsSync(path.join(content, '7', 'content.json'))) {
    assert.ok(Date.now() < deadline, 'the sweep never repaired the tenant');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    fs.existsSync(path.join(quiet, 'locks', 'content.write')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(quiet, 'locks', 'recovery-required')),
    false
  );
});
