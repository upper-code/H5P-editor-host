import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import envNumber from './env';
import { ContentLockTimeout } from './errors';

/**
 * A reader/writer lock over a tenant directory that holds across processes.
 *
 * The in-process queue in `content-transactions` serializes this process's own
 * requests, which is all a single service needs. It is not all a *deployment*
 * needs: two units pointed at one data directory, an operator running a script
 * against live data, or a rolling restart whose old process has not exited yet
 * are each two writers with no idea of one another, and a save publishes by
 * renaming directories — interleave two of those and a book loses its content
 * or gains another revision's. The filesystem is the only thing both sides can
 * see, so the lock lives there.
 *
 * The protocol is deliberately small:
 *
 * - a writer holds one file, `locks/content.write`, created `O_EXCL` — the
 *   only atomic "exactly one wins" primitive every filesystem gives us;
 * - a reader holds a file of its own under `locks/readers/`, and a writer waits
 *   for that directory to empty before it touches anything;
 * - a reader checks for a writer, marks itself, then checks again, so a writer
 *   that arrived in between is never missed;
 * - every holder keeps its file's mtime fresh and stamps it with a token of its
 *   own, so a lock whose owner is gone can be recognised, and a holder whose
 *   lock was taken from it can tell.
 *
 * Writers win ties: the writer's file goes up *before* it drains the readers,
 * so readers arriving after it queue behind, and a busy tenant cannot starve a
 * save.
 */

/**
 * How long a lock whose owner is on *another* machine is honoured without a
 * heartbeat. An owner on this machine is judged by whether its process is
 * still there, which is proof rather than a guess, so this window does not
 * apply to it.
 */
export const processLockStaleMs = (): number =>
  envNumber('H5P_HOST_LOCK_STALE_MS', 60_000, { min: 1000 });

/**
 * The longest a lock is honoured on the strength of its owner's pid alone.
 * The escape hatch from a pid that is not the process it looks like.
 */
const maxLockHoldMs = (): number =>
  envNumber('H5P_HOST_LOCK_MAX_HOLD_MS', 60 * 60 * 1000, { min: 60_000 });

/** How often a held lock touches its file. Three beats inside the window. */
const heartbeatMs = (staleMs: number): number =>
  Math.max(200, Math.floor(staleMs / 3));

/** Backoff between attempts. Short enough to feel immediate, long enough not to spin. */
const retryMinMs = 15;
const retryMaxMs = 120;

/**
 * How long the guard that serializes *breaking* is honoured. It is held for
 * the two or three syscalls a break costs, so anything this old was left by a
 * process that died inside them.
 */
const breakGuardStaleMs = (staleMs: number): number =>
  Math.min(staleMs, 10_000);

interface LockOwner {
  pid: number;
  hostname: string;
  startedAt: number;
  /** Unique to one acquisition: what "still ours" means. */
  token: string;
}

export interface HeldProcessLock {
  release: () => Promise<void>;
  /**
   * True when this acquisition had to break a writer's lock whose owner was
   * gone. The owner died holding the tenant, which is exactly the window in
   * which a publication can have been left half-applied, so the caller has to
   * replay the journal before it trusts what is on disk.
   */
  brokeStaleWriter: boolean;
  /**
   * True once this lock's file stopped being ours — taken over by another
   * process, or removed by hand. Whatever ran under it was not, in fact,
   * running alone, and the tenant has to be treated as unrepaired.
   */
  compromised: () => boolean;
}

export interface ProcessLockOptions {
  mode: 'exclusive' | 'shared';
  /** Epoch ms after which acquisition gives up with a 503. */
  deadline: number;
  staleMs?: number;
}

/**
 * A timer that keeps the process alive while it runs.
 *
 * Deliberately *not* unref'd: this is how an acquisition waits, and during a
 * start-up recovery pass there is no server holding the event loop open yet.
 * An unref'd wait there would let Node run out of work and exit — quietly,
 * with a success code, in the middle of taking a lock.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Grows the pause between attempts, with jitter so contenders separate. */
function backoff(attempt: number): Promise<void> {
  const base = Math.min(retryMaxMs, retryMinMs * 2 ** Math.min(attempt, 4));
  return sleep(base / 2 + Math.random() * (base / 2));
}

export function locksRoot(tenantRoot: string): string {
  return path.join(tenantRoot, 'locks');
}

const writerFile = (tenantRoot: string): string =>
  path.join(locksRoot(tenantRoot), 'content.write');

const readersRoot = (tenantRoot: string): string =>
  path.join(locksRoot(tenantRoot), 'readers');

const breakGuard = (tenantRoot: string): string =>
  path.join(locksRoot(tenantRoot), 'content.break');

/**
 * The flag that says a tenant's journal has to be replayed before anything
 * reads it: a publication that failed part way, or a lock taken from an owner
 * that died in the middle of one.
 *
 * On disk rather than in memory because the process that has to act on it is
 * usually not the one that raised it — the one that raised it may not exist
 * any more.
 */
const recoveryFlag = (tenantRoot: string): string =>
  path.join(locksRoot(tenantRoot), 'recovery-required');

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

const pathExists = (target: string): Promise<boolean> =>
  fs.stat(target).then(
    () => true,
    () => false
  );

export async function markRecoveryRequired(tenantRoot: string): Promise<void> {
  await fs.mkdir(locksRoot(tenantRoot), { recursive: true });
  await fs.writeFile(recoveryFlag(tenantRoot), String(Date.now()), {
    mode: 0o600
  });
}

export async function clearRecoveryRequired(tenantRoot: string): Promise<void> {
  await fs.rm(recoveryFlag(tenantRoot), { force: true }).catch(() => undefined);
}

export function recoveryRequiredOnDisk(tenantRoot: string): Promise<boolean> {
  return pathExists(recoveryFlag(tenantRoot));
}

async function readOwner(file: string): Promise<LockOwner | undefined> {
  try {
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof owner?.pid === 'number' &&
      typeof owner.hostname === 'string' &&
      typeof owner.startedAt === 'number' &&
      typeof owner.token === 'string'
      ? (owner as LockOwner)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a pid on this machine is still running. `EPERM` is another user's. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

interface Judgement {
  /** Whether the lock may be taken from its owner. */
  breakable: boolean;
  /** The token the verdict was about; what "the same lock" means later. */
  token?: string;
}

/**
 * Judges one lock file, from a single read of it.
 *
 * For an owner on this machine the pid is the answer, and age is very nearly
 * not consulted at all: a process that still exists is still holding the
 * tenant, even if it has been stopped, swapped out or is simply slow enough to
 * miss a heartbeat — and taking a lock from a live writer is how two processes
 * end up publishing into the same directory. The cost of being strict is a
 * tenant that answers 503 until someone deals with the stuck process, which is
 * the failure worth having.
 *
 * `H5P_HOST_LOCK_MAX_HOLD_MS` is the one thing that overrides it, because a pid
 * is not an identity: a machine that comes back with the same hostname and
 * hands the same number to an unrelated process turns "the owner is alive" into
 * a lock nothing can ever take, and a tenant nothing can ever serve. No save
 * runs for an hour, so a lock that has gone that long unrefreshed is taken —
 * and, being a break, its journal is replayed before anything reads it.
 *
 * A pid from another machine says nothing here, so those fall back to the
 * heartbeat: nothing has touched the file for the whole window, so nothing is
 * holding it. A file that cannot be read is not evidence of anything — a holder
 * that crashed between creating it and writing itself into it leaves exactly
 * that — so age decides those too.
 *
 * The verdict and the token come from the same read on purpose. Reading the
 * owner twice would let the file be replaced in between, and the caller would
 * then hold a verdict about one lock and a token from another.
 */
async function judge(
  file: string,
  staleMs: number,
  now: number
): Promise<Judgement> {
  const stats = await fs.stat(file).catch(() => undefined);
  if (!stats) return { breakable: false };
  const owner = await readOwner(file);
  const token = owner?.token;
  if (owner && owner.hostname === os.hostname()) {
    return {
      token,
      breakable: processAlive(owner.pid)
        ? now - stats.mtimeMs > maxLockHoldMs()
        : true
    };
  }
  return { token, breakable: now - stats.mtimeMs > staleMs };
}

const breakable = (
  file: string,
  staleMs: number,
  now: number
): Promise<boolean> => judge(file, staleMs, now).then((v) => v.breakable);

/**
 * Runs `attempt` while holding the break guard, or not at all.
 *
 * Breaking is the one part of the protocol that removes a file somebody else
 * created, and `rename` alone does not make that safe: two processes can each
 * judge the same lock abandoned, and the slower one then renames away the
 * *fresh* lock the faster one had already put in its place — two writers, both
 * convinced they are alone. Serializing the judgement and the removal behind a
 * guard of their own leaves only one process able to act on a verdict, and it
 * re-checks that verdict inside the guard, where nothing can have changed
 * since.
 *
 * A process that dies mid-break leaves the guard behind; it is held for a
 * couple of syscalls, so anything older than `breakGuardStaleMs` is debris and
 * is removed.
 */
async function underBreakGuard<T>(
  tenantRoot: string,
  staleMs: number,
  attempt: () => Promise<T>
): Promise<T | undefined> {
  const guard = breakGuard(tenantRoot);
  await fs.mkdir(locksRoot(tenantRoot), { recursive: true });
  const owner = await claim(guard);
  if (!owner) {
    // Somebody else is breaking. Their guard is judged exactly as a lock is —
    // a guard whose owner is a live process of this machine is never expired,
    // however long it has been held. Expiring one that is merely slow would
    // let this call and the paused one both act on a verdict, which is the
    // race the guard exists to remove.
    const verdict = await judge(guard, breakGuardStaleMs(staleMs), Date.now());
    if (verdict.breakable) {
      // Conditional on the token, like every other removal here: two callers
      // can judge the same abandoned guard, and the second must not delete the
      // fresh guard the first put in its place.
      await removeJudged(guard, verdict.token);
    }
    // Either way this call breaks nothing: the caller waits and comes round.
    return undefined;
  }
  try {
    return await attempt();
  } finally {
    await releaseOwn(guard, owner.token);
  }
}

/**
 * Removes a file only while it is still the one that was judged.
 *
 * The token a holder stamps into its lock is what "the same lock" means: a
 * file that now carries a different one is a *new* holder's, and removing it
 * would hand the tenant to a third process while they are still writing. A
 * file that had no readable token was judged by age alone; if it has one now,
 * somebody has replaced it since, and the verdict no longer applies.
 */
async function removeJudged(
  file: string,
  judged: string | undefined
): Promise<boolean> {
  const owner = await readOwner(file);
  if (owner?.token !== judged) return false;
  await fs.rm(file, { force: true });
  return true;
}

/**
 * Takes an abandoned writer's lock out of the way, and says whether this call
 * is what did it. Runs under the break guard, so the verdict it acts on is the
 * one it took a moment ago and nobody else is acting on another.
 */
async function breakWriterLock(
  tenantRoot: string,
  file: string,
  staleMs: number
): Promise<boolean> {
  const broke = await underBreakGuard(tenantRoot, staleMs, async () => {
    const verdict = await judge(file, staleMs, Date.now());
    if (!verdict.breakable) return false;
    // The flag goes up *before* the lock comes down. In the other order there
    // is a moment when the tenant looks free and unrepaired: another process
    // could take it and save, and the repair this break owes would then
    // publish the dead owner's older transaction over that save.
    await markRecoveryRequired(tenantRoot);
    return removeJudged(file, verdict.token);
  });
  return broke === true;
}

/** Writes the holder's identity, creating the file only if it is free. */
async function claim(file: string): Promise<LockOwner | undefined> {
  const owner: LockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    token: crypto.randomUUID()
  };
  try {
    await fs.writeFile(file, JSON.stringify(owner), {
      flag: 'wx',
      mode: 0o600
    });
    return owner;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return undefined;
    throw error;
  }
}

/**
 * Keeps a held lock's mtime fresh, and notices if the lock stops being ours.
 *
 * A save can legitimately run for minutes — a large import, a book whose
 * previous revision has to be copied on a filesystem without reflinks — and
 * without the heartbeat the staleness window would have to be longer than the
 * longest write anyone ever performs.
 *
 * The same beat is where a holder finds out it has been displaced. That should
 * not be able to happen (a live process on this machine is never judged
 * abandoned, and breaking is serialized), but "should not" is not "cannot":
 * somebody can always delete the file by hand. Whatever ran under a lock that
 * is no longer ours ran without one, so the caller is told, and it marks the
 * tenant for repair rather than trusting what it just did.
 */
function startHeartbeat(
  file: string,
  token: string,
  staleMs: number
): { stop: () => void; compromised: () => boolean } {
  let compromised = false;
  const timer = setInterval(() => {
    void (async () => {
      const owner = await readOwner(file);
      if (!owner || owner.token !== token) {
        compromised = true;
        clearInterval(timer);
        return;
      }
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => undefined);
    })();
  }, heartbeatMs(staleMs));
  timer.unref?.();
  return { stop: () => clearInterval(timer), compromised: () => compromised };
}

/**
 * Gives a lock file up, but only while it is still ours: a file that now
 * carries somebody else's token belongs to them, and removing it would hand
 * the tenant to a third process while they are still writing.
 */
async function releaseOwn(file: string, token: string): Promise<void> {
  const owner = await readOwner(file);
  if (owner && owner.token !== token) return;
  await fs.rm(file, { force: true }).catch(() => undefined);
}

/** Reader entries with a live owner; the rest are removed on the way past. */
async function liveReaders(
  tenantRoot: string,
  staleMs: number
): Promise<number> {
  const directory = readersRoot(tenantRoot);
  const entries = await fs.readdir(directory).catch(() => [] as string[]);
  let live = 0;
  const now = Date.now();
  for (const name of entries) {
    const file = path.join(directory, name);
    const verdict = await judge(file, staleMs, now);
    // A removal that was refused means the entry is not the one that was
    // judged: somebody fresh is reading through it, and a writer has to wait
    // for them like any other.
    const gone =
      verdict.breakable &&
      (await removeJudged(file, verdict.token).catch(() => false));
    if (!gone) live += 1;
  }
  return live;
}

async function acquireExclusive(
  tenantRoot: string,
  deadline: number,
  staleMs: number
): Promise<HeldProcessLock> {
  const file = writerFile(tenantRoot);
  await fs.mkdir(locksRoot(tenantRoot), { recursive: true });
  let brokeStaleWriter = false;
  let owner: LockOwner | undefined;
  for (let attempt = 0; ; attempt += 1) {
    owner = await claim(file);
    if (owner) break;
    if (await breakable(file, staleMs, Date.now())) {
      // Only the process whose break went through treats the tenant as
      // unrepaired: it is the one that took over from an owner that died
      // mid-write. A break that did not go through — another process is
      // breaking, or the lock stopped being abandoned — made no progress, so
      // it waits like any other contender rather than spinning past its
      // budget.
      if (await breakWriterLock(tenantRoot, file, staleMs)) {
        brokeStaleWriter = true;
        continue;
      }
    }
    if (Date.now() >= deadline) throw new ContentLockTimeout();
    await backoff(attempt);
  }
  const beat = startHeartbeat(file, owner.token, staleMs);
  const release = async (): Promise<void> => {
    beat.stop();
    await releaseOwn(file, owner!.token);
  };
  // The writer's file is up, so no new reader can start. Wait out the ones
  // that were already reading — and hand the lock back if they outlast the
  // budget, rather than holding a tenant hostage behind a queue we gave up on.
  for (let attempt = 0; ; attempt += 1) {
    if ((await liveReaders(tenantRoot, staleMs)) === 0) break;
    if (Date.now() >= deadline) {
      await release();
      throw new ContentLockTimeout();
    }
    await backoff(attempt);
  }
  return { release, brokeStaleWriter, compromised: beat.compromised };
}

async function acquireShared(
  tenantRoot: string,
  deadline: number,
  staleMs: number
): Promise<HeldProcessLock> {
  const directory = readersRoot(tenantRoot);
  const writer = writerFile(tenantRoot);
  await fs.mkdir(directory, { recursive: true });
  let brokeStaleWriter = false;
  for (let attempt = 0; ; attempt += 1) {
    // A writer's file is in the way whatever state its owner is in. Reading
    // past an *abandoned* one is the dangerous case, not the safe one: its
    // owner died holding the tenant, possibly mid-publication, so the file has
    // to be broken deliberately — and the break reported — rather than
    // stepped over as if the tenant were free.
    if (await pathExists(writer)) {
      if (
        (await breakable(writer, staleMs, Date.now())) &&
        (await breakWriterLock(tenantRoot, writer, staleMs))
      ) {
        brokeStaleWriter = true;
        continue;
      }
      if (Date.now() >= deadline) throw new ContentLockTimeout();
      await backoff(attempt);
      continue;
    }
    const file = path.join(directory, crypto.randomUUID());
    const owner = await claim(file);
    if (!owner) continue;
    // Mark first, then look again: a writer that took its file between the
    // check above and this line would otherwise never see this reader, and
    // would publish a rename underneath a read that spans two files.
    if (await pathExists(writer)) {
      await releaseOwn(file, owner.token);
      if (Date.now() >= deadline) throw new ContentLockTimeout();
      await backoff(attempt);
      continue;
    }
    const beat = startHeartbeat(file, owner.token, staleMs);
    return {
      brokeStaleWriter,
      compromised: beat.compromised,
      release: async () => {
        beat.stop();
        await releaseOwn(file, owner.token);
      }
    };
  }
}

/**
 * Acquires the cross-process lock for one tenant, or throws
 * `ContentLockTimeout` (503) once `deadline` has passed.
 *
 * `tenantRoot` is the directory holding `content` and `operations` — the unit
 * a save publishes atomically, and so the unit the lock covers.
 */
export default function acquireProcessLock(
  tenantRoot: string,
  options: ProcessLockOptions
): Promise<HeldProcessLock> {
  const staleMs = options.staleMs ?? processLockStaleMs();
  return options.mode === 'shared'
    ? acquireShared(tenantRoot, options.deadline, staleMs)
    : acquireExclusive(tenantRoot, options.deadline, staleMs);
}

export interface LockSweep {
  /** Entries removed: abandoned readers, the writer, break debris. */
  removed: number;
  /**
   * Whether an abandoned *writer* was among them. Its owner died holding the
   * tenant, so the journal has to be replayed before anything reads it — the
   * sweep raises the on-disk flag for that, and the caller is told so it can
   * do the repair now rather than leave it to the next request.
   */
  writerBroken: boolean;
}

/**
 * Drops the debris a crash can leave in a tenant's lock directory: entries
 * whose owner is gone, and a break guard nobody released. Called from the
 * periodic journal sweep, because a tenant nobody writes to any more is
 * exactly the one where nothing else would.
 */
export async function sweepStaleLocks(tenantRoot: string): Promise<LockSweep> {
  const staleMs = processLockStaleMs();
  const before = await fs
    .readdir(readersRoot(tenantRoot))
    .catch(() => [] as string[]);
  const live = await liveReaders(tenantRoot, staleMs);
  let removed = before.length - live;
  const writer = writerFile(tenantRoot);
  let writerBroken = false;
  if (
    (await breakable(writer, staleMs, Date.now())) &&
    (await breakWriterLock(tenantRoot, writer, staleMs))
  ) {
    // `breakWriterLock` has raised the repair flag: a reader arriving between
    // this sweep and the repair must still know to repair first.
    writerBroken = true;
    removed += 1;
  }
  const guard = breakGuard(tenantRoot);
  // Conditional on the token, like every other removal here: between judging
  // the guard and removing it another process can break it and put its own
  // fresh guard in place, and an unconditional `rm` would delete that one —
  // letting this sweep and that breaker both act while a break is in flight,
  // the very race the guard exists to prevent.
  const guardVerdict = await judge(
    guard,
    breakGuardStaleMs(staleMs),
    Date.now()
  );
  if (
    guardVerdict.breakable &&
    (await removeJudged(guard, guardVerdict.token).catch(() => false))
  ) {
    removed += 1;
  }
  return { removed, writerBroken };
}
