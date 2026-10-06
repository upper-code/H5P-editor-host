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
const {
  assertHardLinks,
  sweepStaleLocks
} = require('../build/src/process-lock');
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

/**
 * Another live process on this machine: the test runner that started this
 * file. This process's own pid will not do — a lock naming it with a token it
 * never issued is an earlier process's that had the same pid.
 */
const livePid = process.ppid;

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

test('ownership is checked immediately, before the first heartbeat', async (t) => {
  const root = tenant(t);
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 1000
  });
  t.after(() => held.release());
  fs.writeFileSync(lockFile(root), owner({ pid: process.pid }));
  await assert.rejects(held.assertOwned(), {
    statusCode: 503,
    code: 'content-lock-lost'
  });
  assert.equal(held.compromised(), true);
});

test('a displaced writer keeps readers and replacement writers out until its task ends', async (t) => {
  const root = tenant(t);
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 1000
  });
  t.after(() => held.release());
  fs.rmSync(lockFile(root));
  for (const mode of ['shared', 'exclusive']) {
    await assert.rejects(
      acquireProcessLock(root, { mode, deadline: Date.now() + 100 }),
      { code: 'content-locked' }
    );
  }
  await held.release();
  const replacement = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 1000
  });
  await replacement.release();
});

test('an old writer pin on another machine is never reclaimed on heartbeat age alone', async (t) => {
  const root = tenant(t);
  const pin = path.join(root, 'locks', 'content.pin');
  fs.mkdirSync(path.dirname(pin), { recursive: true });
  fs.writeFileSync(pin, owner({ hostname: 'another-machine' }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(pin, old, old);
  await assert.rejects(
    acquireProcessLock(root, { mode: 'exclusive', deadline: Date.now() + 100 }),
    { code: 'content-locked' }
  );
  assert.ok(fs.existsSync(pin));
});

test('a reader rechecks the writer pin after registering itself', async (t) => {
  const root = tenant(t);
  const pin = path.join(root, 'locks', 'content.pin');
  const link = fsp.link;
  let installed = false;
  t.mock.method(fsp, 'link', async (source, file) => {
    await link(source, file);
    if (!installed && path.dirname(String(file)) === readersDir(root)) {
      installed = true;
      // A displaced writer pinned its task after the first check. Even if
      // its primary lease disappeared, this reader must still stay out.
      fs.writeFileSync(pin, owner({ pid: livePid }));
    }
  });
  await assert.rejects(
    acquireProcessLock(root, { mode: 'shared', deadline: Date.now() + 100 }),
    { code: 'content-locked' }
  );
  assert.deepEqual(fs.readdirSync(readersDir(root)), []);
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
  fs.writeFileSync(guard, owner({ pid: livePid }));
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
  fs.writeFileSync(lockFile(root), owner({ pid: livePid }));
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

const pinFile = (root) => path.join(root, 'locks', 'content.pin');
const recoveryFlag = (root) => path.join(root, 'locks', 'recovery-required');

function leavePin(root, contents, ageMs = 24 * 60 * 60 * 1000) {
  fs.mkdirSync(path.dirname(pinFile(root)), { recursive: true });
  fs.writeFileSync(pinFile(root), contents);
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(pinFile(root), then, then);
}

test('a pin left by an earlier process with this pid is reclaimed and flags a repair', async (t) => {
  // A restarted container runs as pid 1 again, on the same hostname: the pin
  // its crashed predecessor left names a pid that is alive — this one.
  for (const mode of ['shared', 'exclusive']) {
    const root = tenant(t);
    leavePin(root, owner({ pid: process.pid }));
    const held = await acquireProcessLock(root, {
      mode,
      deadline: Date.now() + 2000
    });
    await held.release();
    assert.ok(fs.existsSync(recoveryFlag(root)), `${mode}: repair flagged`);
  }
});

test('a writer lock left by an earlier process with this pid is broken at once', async (t) => {
  const root = tenant(t);
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
  // Fresh: no waiting out H5P_HOST_LOCK_MAX_HOLD_MS for a proven-dead owner.
  fs.writeFileSync(lockFile(root), owner({ pid: process.pid }));
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 2000
  });
  assert.equal(held.brokeStaleWriter, true);
  await held.release();
});

test('this process never judges its own live pin abandoned', async (t) => {
  const root = tenant(t);
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 1000
  });
  t.after(() => held.release());
  // The lease is gone; the pin, naming this pid with a token it issued, stays.
  fs.rmSync(lockFile(root));
  await assert.rejects(
    acquireProcessLock(root, { mode: 'shared', deadline: Date.now() + 100 }),
    { code: 'content-locked' }
  );
  assert.ok(fs.existsSync(pinFile(root)));
  assert.equal((await sweepStaleLocks(root)).writerBroken, false);
  assert.ok(fs.existsSync(pinFile(root)));
});

test('an old ownerless pin from before atomic claims is reclaimed', async (t) => {
  // Older hosts must be stopped before upgrading. Current hosts publish a
  // complete owner atomically, so none can still be writing this empty pin.
  const fresh = tenant(t);
  leavePin(fresh, '', 0);
  await assert.rejects(
    acquireProcessLock(fresh, { mode: 'shared', deadline: Date.now() + 100 }),
    { code: 'content-locked' }
  );
  assert.ok(fs.existsSync(pinFile(fresh)), 'a pin being written is honoured');

  const old = tenant(t);
  leavePin(old, '', 60_000);
  const held = await acquireProcessLock(old, {
    mode: 'exclusive',
    deadline: Date.now() + 2000
  });
  await held.release();
  assert.equal(fs.existsSync(pinFile(old)), false, 'the debris was removed');
  assert.ok(fs.existsSync(recoveryFlag(old)));
});

test('the sweep reclaims a pin whose owner is gone', async (t) => {
  const root = tenant(t);
  leavePin(root, owner());
  const sweep = await sweepStaleLocks(root);
  assert.equal(sweep.writerBroken, true);
  assert.equal(fs.existsSync(pinFile(root)), false);
  assert.ok(fs.existsSync(recoveryFlag(root)));
});

test(
  'a pin whose pid now belongs to a process started at another time is reclaimed',
  { skip: process.platform !== 'linux' && 'reads /proc' },
  async (t) => {
    const root = tenant(t);
    const recorded = JSON.parse(owner({ pid: livePid }));
    recorded.bootId = fs
      .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
      .trim();
    recorded.processStart = '1';
    leavePin(root, JSON.stringify(recorded));
    const held = await acquireProcessLock(root, {
      mode: 'exclusive',
      deadline: Date.now() + 2000
    });
    await held.release();

    // Recorded by the runner itself: its pin stands.
    const kept = tenant(t);
    const stat = fs.readFileSync(`/proc/${livePid}/stat`, 'utf8');
    recorded.processStart = stat
      .slice(stat.lastIndexOf(')') + 2)
      .split(' ')[19];
    leavePin(kept, JSON.stringify(recorded));
    await assert.rejects(
      acquireProcessLock(kept, { mode: 'shared', deadline: Date.now() + 100 }),
      { code: 'content-locked' }
    );
  }
);

/** Match the identity write, whether direct or privately staged. */
function isClaimFor(file, target) {
  return (
    file === target ||
    path.basename(String(file)).startsWith(`.claim-${path.basename(target)}-`)
  );
}

test('a sweep during a delayed pin claim cannot leave an acquired writer unpinned', async (t) => {
  const root = tenant(t);
  withEnv(t, { H5P_HOST_LOCK_STALE_MS: '60000' });
  const open = fsp.open;
  let delayed = false;
  t.mock.method(fsp, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!delayed && isClaimFor(file, pinFile(root))) {
      delayed = true;
      // Pause between creation and the first byte. This is older than the
      // 10 s ownerless-pin grace, but inside the staging-file stale window.
      const then = new Date(Date.now() - 20_000);
      await handle.utimes(then, then);
      await sweepStaleLocks(root);
    }
    return handle;
  });

  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 2000
  });
  t.after(() => held.release());
  assert.ok(delayed, 'the pin claim was paused');
  await held.assertOwned();
  assert.ok(fs.existsSync(pinFile(root)), 'success must include a pin');
  const pin = JSON.parse(fs.readFileSync(pinFile(root), 'utf8'));
  assert.equal(pin.pid, process.pid);
  assert.equal(typeof pin.token, 'string');

  // Even if the primary lease disappears later, the writer's task stays
  // fenced until release. Neither a reader nor another writer may enter.
  fs.rmSync(lockFile(root));
  for (const mode of ['shared', 'exclusive']) {
    await assert.rejects(
      acquireProcessLock(root, { mode, deadline: Date.now() + 100 }),
      { code: 'content-locked' }
    );
  }
});

test('a delayed claim write failure cannot unlink a competing writer', async (t) => {
  const root = tenant(t);
  const open = fsp.open;
  const failure = Object.assign(new Error('delayed write failed'), {
    code: 'EIO'
  });
  let delayed = false;
  let competing;
  t.mock.method(fsp, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!delayed && isClaimFor(file, lockFile(root))) {
      delayed = true;
      const then = new Date(Date.now() - 60_000);
      await handle.utimes(then, then);
      handle.writeFile = async () => {
        competing = await acquireProcessLock(root, {
          mode: 'exclusive',
          deadline: Date.now() + 2000,
          staleMs: 1000
        });
        t.after(() => competing.release());
        await competing.assertOwned();
        throw failure;
      };
    }
    return handle;
  });

  await assert.rejects(
    acquireProcessLock(root, {
      mode: 'exclusive',
      deadline: Date.now() + 2000,
      staleMs: 1000
    }),
    (error) => error === failure
  );
  assert.ok(competing, 'another writer acquired while the claim was paused');
  await competing.assertOwned();
  assert.ok(fs.existsSync(pinFile(root)));
});

for (const phase of ['write', 'close', 'link']) {
  test(`a pin ${phase} failure leaves no held lock or staging file`, async (t) => {
    const root = tenant(t);
    const failure = Object.assign(new Error(`pin ${phase} failed`), {
      code: 'EIO'
    });
    let injected = false;
    if (phase === 'link') {
      const link = fsp.link;
      t.mock.method(fsp, 'link', async (source, file) => {
        if (!injected && file === pinFile(root)) {
          injected = true;
          throw failure;
        }
        return link(source, file);
      });
    } else {
      const open = fsp.open;
      t.mock.method(fsp, 'open', async (file, ...args) => {
        const handle = await open(file, ...args);
        if (!injected && isClaimFor(file, pinFile(root))) {
          injected = true;
          const method = phase === 'write' ? 'writeFile' : 'close';
          const original = handle[method].bind(handle);
          handle[method] = async () => {
            // A close error can arrive after the identity was fully written.
            if (phase === 'close') await original();
            else await original('{');
            throw failure;
          };
        }
        return handle;
      });
    }

    await assert.rejects(
      acquireProcessLock(root, {
        mode: 'exclusive',
        deadline: Date.now() + 2000
      }),
      (error) => error === failure
    );
    assert.ok(injected);
    assert.deepEqual(fs.readdirSync(path.join(root, 'locks')), []);
    const held = await acquireProcessLock(root, {
      mode: 'exclusive',
      deadline: Date.now() + 1000
    });
    await held.release();
  });
}

test('the sweep removes abandoned claim staging files without removing their live hard links', async (t) => {
  const root = tenant(t);
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 1000
  });
  t.after(() => held.release());
  const directory = path.join(root, 'locks');
  const live = path.join(
    directory,
    `.claim-content.write-${crypto.randomUUID()}`
  );
  fs.linkSync(lockFile(root), live);
  const abandoned = path.join(
    directory,
    `.claim-content.pin-${crypto.randomUUID()}`
  );
  fs.writeFileSync(abandoned, owner());
  const empty = path.join(
    directory,
    `.claim-content.write-${crypto.randomUUID()}`
  );
  fs.writeFileSync(empty, '');
  const then = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(empty, then, then);

  const sweep = await sweepStaleLocks(root);
  assert.equal(sweep.removed, 2);
  assert.equal(sweep.writerBroken, false);
  assert.ok(fs.existsSync(live), 'a live claim is kept');
  assert.equal(fs.existsSync(abandoned), false);
  assert.equal(fs.existsSync(empty), false);
  await held.assertOwned();

  // Only the private name was left behind at release. It is now abandoned,
  // but reclaiming it must not touch the next holder's published lock.
  await held.release();
  const next = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 1000
  });
  t.after(() => next.release());
  assert.equal((await sweepStaleLocks(root)).removed, 1);
  assert.equal(fs.existsSync(live), false);
  await next.assertOwned();
});

test('a claim swept before publication is made again, and acquires with a pin', async (t) => {
  const root = tenant(t);
  const open = fsp.open;
  let delayed = false;
  t.mock.method(fsp, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!delayed && isClaimFor(file, pinFile(root))) {
      delayed = true;
      const then = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await handle.utimes(then, then);
      await sweepStaleLocks(root);
    }
    return handle;
  });
  // Nothing was published when the private file went, so this is not a
  // failure of the request: the claim comes round again inside its budget.
  const held = await acquireProcessLock(root, {
    mode: 'exclusive',
    deadline: Date.now() + 2000
  });
  t.after(() => held.release());
  assert.ok(delayed, 'the pin claim was swept');
  await held.assertOwned();
  assert.equal(
    JSON.parse(fs.readFileSync(pinFile(root), 'utf8')).pid,
    process.pid
  );
  assert.deepEqual(fs.readdirSync(path.join(root, 'locks')).sort(), [
    'content.pin',
    'content.write'
  ]);
});

test('a reader whose claim was swept claims again, but not past its budget', async (t) => {
  const root = tenant(t);
  const open = fsp.open;
  let swept = 0;
  t.mock.method(fsp, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (swept < 2 && path.basename(String(file)).startsWith('.claim-')) {
      swept += 1;
      const then = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await handle.utimes(then, then);
      await sweepStaleLocks(root);
    }
    return handle;
  });
  // Out of time: the swept claim is the caller's 503, like any other wait.
  await assert.rejects(
    acquireProcessLock(root, { mode: 'shared', deadline: Date.now() - 1 }),
    { code: 'content-locked' }
  );
  assert.equal(swept, 1);
  assert.deepEqual(fs.readdirSync(readersDir(root)), []);
  // Inside its budget it simply comes round again.
  const held = await acquireProcessLock(root, {
    mode: 'shared',
    deadline: Date.now() + 2000
  });
  assert.equal(swept, 2);
  await held.assertOwned();
  assert.equal(fs.readdirSync(readersDir(root)).length, 1);
  await held.release();
  assert.deepEqual(fs.readdirSync(path.join(root, 'locks')), ['readers']);
});

test('a lock directory that vanished is an error, not a claim to make again', async (t) => {
  // `link` answers ENOENT for a missing target directory as it does for a
  // swept private file. Only the second is worth another attempt: taking the
  // first for it would have a reader claim for ever.
  const root = tenant(t);
  const link = fsp.link;
  let removed = false;
  t.mock.method(fsp, 'link', async (source, file) => {
    if (!removed && path.dirname(String(file)) === readersDir(root)) {
      removed = true;
      fs.rmSync(readersDir(root), { recursive: true });
    }
    return link(source, file);
  });
  await assert.rejects(
    acquireProcessLock(root, { mode: 'shared', deadline: Date.now() + 1000 }),
    { code: 'ENOENT' }
  );
  assert.ok(removed);
  assert.deepEqual(fs.readdirSync(path.join(root, 'locks')), []);
});

test('a claim file the sweep cannot remove does not stop the sweep', async (t) => {
  const root = tenant(t);
  const directory = path.join(root, 'locks');
  fs.mkdirSync(directory);
  const stuck = path.join(
    directory,
    `.claim-content.pin-${crypto.randomUUID()}`
  );
  const loose = path.join(
    directory,
    `.claim-content.pin-${crypto.randomUUID()}`
  );
  fs.writeFileSync(stuck, owner());
  fs.writeFileSync(loose, owner());
  const rm = fsp.rm;
  t.mock.method(fsp, 'rm', async (file, ...args) => {
    if (file === stuck) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return rm(file, ...args);
  });
  const sweep = await sweepStaleLocks(root);
  assert.equal(sweep.removed, 1, 'only what was actually removed is counted');
  assert.ok(fs.existsSync(stuck));
  assert.equal(fs.existsSync(loose), false);
});

for (const code of ['EPERM', 'ENOTSUP']) {
  test(`a data directory without hard links (${code}) stops the start`, async (t) => {
    const directory = tmpDir(t, 'host-links-');
    t.mock.method(fsp, 'link', async () => {
      throw Object.assign(new Error('operation not supported'), { code });
    });
    await assert.rejects(assertHardLinks(directory), (error) => {
      assert.match(error.message, /does not support hard links/);
      assert.ok(error.message.includes(directory));
      assert.equal(error.cause.code, code);
      return true;
    });
    assert.deepEqual(fs.readdirSync(directory), [], 'the probe cleans up');
  });
}

test('the hard link probe passes where links work and leaves nothing behind', async (t) => {
  const directory = tmpDir(t, 'host-links-');
  await assertHardLinks(directory);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('the hard link probe blames only a filesystem that cannot link at all', async (t) => {
  // A full disk or a directory that cannot be written to says nothing about
  // what the mount can do; neither is this probe's report to make.
  const directory = tmpDir(t, 'host-links-');
  t.mock.method(fsp, 'link', async () => {
    throw Object.assign(new Error('no space left on device'), {
      code: 'ENOSPC'
    });
  });
  await assertHardLinks(directory);
  assert.deepEqual(fs.readdirSync(directory), []);
  await assertHardLinks(path.join(directory, 'missing'));
});
