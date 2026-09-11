/*
 * The half of the content lock that holds between processes.
 *
 * The in-process queue is covered by `content-transactions.test.js`; what is
 * tested here is what that queue cannot do — keep a second *process* pointed at
 * the same data directory out of a tenant, and take a tenant back from one that
 * died holding it.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const acquireProcessLock = require('../build/src/process-lock').default;
const { sweepStaleLocks } = require('../build/src/process-lock');
const {
  mutateContent,
  withContentLock
} = require('../build/src/content-transactions');
const { tmpDir, withEnv } = require('./helpers');

const lockFile = (root) => path.join(root, 'locks', 'content.write');
const readersDir = (root) => path.join(root, 'locks', 'readers');

function tenant(t) {
  const root = tmpDir(t, 'host-lock-');
  fs.mkdirSync(path.join(root, 'content'));
  return root;
}

/** A pid that has certainly exited: spawnSync only returns once it has. */
function deadPid() {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  return pid;
}

/** A lock file's contents, as a holder writes them. */
function owner({ pid = deadPid(), hostname = os.hostname() } = {}) {
  return JSON.stringify({
    pid,
    hostname,
    startedAt: Date.now(),
    token: crypto.randomUUID()
  });
}

/**
 * A second process holding the same tenant, resolved once it says it has.
 * Killed when the test ends, whatever the test did.
 */
async function holder(t, root) {
  const child = spawn(process.execPath, [
    '-e',
    `require(${JSON.stringify(path.resolve(__dirname, '../build/src/process-lock'))})
       .default(process.argv[1], { mode: 'exclusive', deadline: Date.now() + 10000 })
       .then(() => { process.stdout.write('held\\n'); setInterval(() => {}, 1000); })
       .catch((error) => { console.error(error); process.exit(1); });`,
    root
  ]);
  t.after(() => child.kill('SIGKILL'));
  for await (const chunk of child.stdout) {
    if (String(chunk).includes('held')) return child;
  }
  throw new Error('the second process never took the lock');
}

test('a second process cannot write the same tenant, and its lock survives it', async (t) => {
  const root = tenant(t);
  const child = await holder(t, root);
  await assert.rejects(
    acquireProcessLock(root, { mode: 'exclusive', deadline: Date.now() + 300 }),
    (error) => error.statusCode === 503
  );
  // A reader is kept out too: it would otherwise read across the rename that
  // publishes the other process's save.
  await assert.rejects(
    acquireProcessLock(root, { mode: 'shared', deadline: Date.now() + 300 }),
    (error) => error.statusCode === 503
  );
  assert.ok(fs.existsSync(lockFile(root)));

  // The owner dies without releasing. Its pid is this machine's, so the lock is
  // recognisably abandoned at once rather than after the staleness window.
  child.kill('SIGKILL');
  await once(child, 'exit');
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 2000
  });
  assert.equal(held.brokeStaleWriter, true);
  await held.release();
  assert.equal(fs.existsSync(lockFile(root)), false);
});

test('readers share the tenant and a writer waits for them to leave', async (t) => {
  const root = tenant(t);
  const first = await acquireProcessLock(root, {
    mode: 'shared',
    deadline: Date.now() + 1000
  });
  const second = await acquireProcessLock(root, {
    mode: 'shared',
    deadline: Date.now() + 1000
  });
  assert.equal(fs.readdirSync(readersDir(root)).length, 2);
  await assert.rejects(
    acquireProcessLock(root, { mode: 'exclusive', deadline: Date.now() + 200 }),
    (error) => error.statusCode === 503
  );
  // A writer that gave up must not leave its file behind: the readers it was
  // waiting for would then be unable to take the tenant again either.
  assert.equal(fs.existsSync(lockFile(root)), false);
  await first.release();
  await second.release();
  const writer = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 2000
  });
  await writer.release();
});

test('a reader that arrives with a writer waiting queues behind it', async (t) => {
  const root = tenant(t);
  const reader = await acquireProcessLock(root, {
    mode: 'shared',
    deadline: Date.now() + 1000
  });
  // The writer takes its file immediately and only then waits for readers, so
  // a reader arriving now sees it and gives way — no writer starvation.
  const writing = acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 4000
  });
  await assert.rejects(
    acquireProcessLock(root, { mode: 'shared', deadline: Date.now() + 200 }),
    (error) => error.statusCode === 503
  );
  await reader.release();
  const writer = await writing;
  await writer.release();
});

test('taking a tenant from a dead owner replays its journal', async (t) => {
  const root = tenant(t);
  const content = path.join(root, 'content');
  const operations = path.join(root, 'operations');
  const id = '00000000-0000-4000-8000-000000000001';
  // What a process that died between preparing a save and publishing it leaves:
  // the staged revision, a `prepared` record, and its own lock.
  fs.mkdirSync(path.join(operations, id, 'content', '7'), { recursive: true });
  fs.writeFileSync(
    path.join(operations, id, 'content', '7', 'content.json'),
    '{"staged":true}'
  );
  fs.writeFileSync(
    path.join(operations, id, 'record.json'),
    JSON.stringify({
      fingerprint: 'f',
      state: 'prepared',
      reason: 'editor-save',
      deleted: false,
      result: { operationId: id, contentId: '7', savedBytes: 1, deltaBytes: 1 }
    })
  );
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
  fs.writeFileSync(lockFile(root), owner());

  // A *read* finds the abandoned lock. It cannot repair the tenant itself, so
  // it has to come back as a writer — and the caller still gets its answer.
  const seen = await withContentLock(
    content,
    async () =>
      fs.readFileSync(path.join(content, '7', 'content.json'), 'utf8'),
    { mode: 'shared', waitMs: 4000 }
  );
  assert.equal(seen, '{"staged":true}');
  assert.equal(fs.existsSync(path.join(operations, id, 'content')), false);
  assert.equal(fs.existsSync(lockFile(root)), false);
});

test('the sweep clears reader entries and broken locks nobody owns', async (t) => {
  const root = tenant(t);
  withEnv(t, { H5P_HOST_LOCK_STALE_MS: '1000' });
  const live = await acquireProcessLock(root, {
    mode: 'shared',
    deadline: Date.now() + 1000
  });
  const abandoned = path.join(readersDir(root), 'abandoned');
  fs.writeFileSync(abandoned, owner());
  // A process that died inside a break leaves its guard behind.
  const guard = path.join(root, 'locks', 'content.break');
  fs.writeFileSync(guard, String(deadPid()));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(guard, old, old);

  const sweep = await sweepStaleLocks(root);
  assert.equal(sweep.removed, 2);
  assert.equal(sweep.writerBroken, false);
  assert.equal(fs.existsSync(abandoned), false);
  assert.equal(fs.existsSync(guard), false);
  // The live reader is untouched.
  assert.equal(fs.readdirSync(readersDir(root)).length, 1);
  await live.release();
});

test('a lock is honoured for its whole window when the owner is another machine', async (t) => {
  const root = tenant(t);
  withEnv(t, { H5P_HOST_LOCK_STALE_MS: '1000' });
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
  // A pid from another host says nothing about whether it is running, so only
  // the heartbeat can date the lock.
  fs.writeFileSync(lockFile(root), owner({ pid: 1, hostname: 'elsewhere' }));
  await assert.rejects(
    acquireProcessLock(root, { mode: 'exclusive', deadline: Date.now() + 200 }),
    (error) => error.statusCode === 503
  );
  await fsp.utimes(
    lockFile(root),
    new Date(Date.now() - 5000),
    new Date(Date.now() - 5000)
  );
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 2000
  });
  assert.equal(held.brokeStaleWriter, true);
  await held.release();
});

test('a save takes the lock and gives it back', async (t) => {
  const root = tenant(t);
  const content = path.join(root, 'content');
  fs.mkdirSync(path.join(content, '7'));
  fs.writeFileSync(path.join(content, '7', 'h5p.json'), '{"title":"Book"}');
  fs.writeFileSync(path.join(content, '7', 'content.json'), '{"a":1}');
  const result = await mutateContent({
    root: content,
    id: '7',
    fingerprint: 'f',
    reason: 'editor-save',
    save: async () => {
      assert.ok(fs.existsSync(lockFile(root)), 'held for the whole save');
      return { contentId: '7' };
    }
  });
  assert.equal(result.contentId, '7');
  assert.equal(fs.existsSync(lockFile(root)), false);
});

test('a holder that is only stopped keeps its lock', async (t) => {
  const root = tenant(t);
  withEnv(t, { H5P_HOST_LOCK_STALE_MS: '1000' });
  const child = await holder(t, root);
  // Stopped, not gone: the heartbeat is silent and the lock file ages past the
  // window, but the process is still there and still owns the tenant. Age must
  // not be enough to take a lock from a process of this machine — the owner
  // would resume and carry on writing beside whoever took it.
  child.kill('SIGSTOP');
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await assert.rejects(
    acquireProcessLock(root, { mode: 'exclusive', deadline: Date.now() + 300 }),
    (error) => error.statusCode === 503
  );
  assert.ok(fs.existsSync(lockFile(root)));
  child.kill('SIGCONT');
});

test('a holder whose lock was taken does not take the new one, and says so', async (t) => {
  const root = tenant(t);
  withEnv(t, { H5P_HOST_LOCK_STALE_MS: '1000' });
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 1000
  });
  // However it happened — an operator with rm, a filesystem that lost the
  // file — the lock now belongs to somebody else.
  fs.writeFileSync(lockFile(root), owner({ pid: process.pid }));
  const deadline = Date.now() + 3000;
  while (!held.compromised()) {
    assert.ok(Date.now() < deadline, 'the heartbeat never noticed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await held.release();
  assert.ok(
    fs.existsSync(lockFile(root)),
    'releasing must not remove a lock that is no longer ours'
  );
});

test('waiting for a busy tenant keeps the process alive', async (t) => {
  const root = tenant(t);
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 1000
  });
  t.after(() => held.release());
  const started = Date.now();
  // A start-up recovery pass waits before any server is listening, so nothing
  // else is holding the event loop open. An unref'd wait would let Node run
  // out of work and exit — quietly, successfully, mid-acquisition.
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(path.resolve(__dirname, '../build/src/process-lock'))})
         .default(process.argv[1], { mode: 'exclusive', deadline: Date.now() + 1200 })
         .then(() => console.log('acquired'), (error) => console.log('refused:' + error.statusCode));`,
      root
    ],
    { encoding: 'utf8' }
  );
  assert.match(child.stdout, /refused:503/);
  assert.ok(
    Date.now() - started >= 1000,
    `gave up after ${Date.now() - started}ms instead of waiting its budget`
  );
});

test('a break that cannot proceed waits its budget and leaves the breaker alone', async (t) => {
  const root = tenant(t);
  withEnv(t, { H5P_HOST_LOCK_STALE_MS: '1000' });
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
  // An abandoned writer, and another process already part way through taking
  // it: its guard is old, but its process is this machine's and is alive.
  fs.writeFileSync(lockFile(root), owner());
  const guard = path.join(root, 'locks', 'content.break');
  fs.writeFileSync(guard, owner({ pid: process.pid }));
  const ancient = new Date(Date.now() - 600_000);
  fs.utimesSync(guard, ancient, ancient);

  const started = Date.now();
  await assert.rejects(
    acquireProcessLock(root, { mode: 'exclusive', deadline: Date.now() + 200 }),
    (error) => error.statusCode === 503
  );
  // Expiring the guard of a breaker that is merely slow would let two
  // processes act on the same verdict — and the slow one would then remove
  // whatever lock the fast one had put in place.
  assert.ok(Date.now() - started >= 200, 'gave up before its budget');
  assert.ok(fs.existsSync(guard), 'a live breaker keeps its guard');
  assert.ok(
    fs.existsSync(lockFile(root)),
    'and nothing else removes the lock it is judging'
  );
});

test('a break flags the repair before the lock is gone', async (t) => {
  const root = tenant(t);
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
  fs.writeFileSync(lockFile(root), owner());
  // In the other order there is a moment where the tenant looks free and
  // unrepaired, and a save that lands in it would be published over by the
  // dead owner's older transaction.
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 2000
  });
  assert.equal(held.brokeStaleWriter, true);
  assert.ok(fs.existsSync(path.join(root, 'locks', 'recovery-required')));
  await held.release();
});

test('a lock is taken from an owner that only looks alive, eventually', async (t) => {
  // A pid is not an identity: a machine that comes back with the same hostname
  // and hands the same number to an unrelated process would otherwise leave a
  // lock nothing can ever take, and a tenant nothing can ever serve.
  const root = tenant(t);
  withEnv(t, {
    H5P_HOST_LOCK_STALE_MS: '1000',
    H5P_HOST_LOCK_MAX_HOLD_MS: '60000'
  });
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
  fs.writeFileSync(lockFile(root), owner({ pid: process.pid }));
  // Inside the ceiling the live pid wins, however silent the lock has been.
  const recent = new Date(Date.now() - 30_000);
  fs.utimesSync(lockFile(root), recent, recent);
  await assert.rejects(
    acquireProcessLock(root, { mode: 'exclusive', deadline: Date.now() + 100 }),
    (error) => error.statusCode === 503
  );
  // Past it, no save could still be running, so the lock is taken — and the
  // tenant is flagged for repair, because a break is what this is.
  const ancient = new Date(Date.now() - 120_000);
  fs.utimesSync(lockFile(root), ancient, ancient);
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 2000
  });
  assert.equal(held.brokeStaleWriter, true);
  await held.release();
});
