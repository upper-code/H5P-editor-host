import crypto from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import syncDirectory from './durable-write';
import envNumber, { maxTimerMs } from './env';
import HostError, { ContentLockTimeout } from './errors';

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
 * - a writer holds one file, `locks/content.write`, linked into place only
 *   after its owner has been written — an atomic "exactly one wins" claim;
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
  envNumber('H5P_HOST_LOCK_STALE_MS', 60_000, {
    min: 1000,
    // Three heartbeats per window; each interval must fit a Node timer.
    max: 3 * maxTimerMs
  });

/**
 * The longest a lock is honoured on the strength of its owner's pid alone.
 * The escape hatch from a pid that is not the process it looks like.
 */
const maxLockHoldMs = (): number =>
  envNumber('H5P_HOST_LOCK_MAX_HOLD_MS', 60 * 60 * 1000, { min: 60_000 });

/** Reads both lock settings, so a typo stops the start rather than a save. */
export function assertProcessLockConfig(): void {
  processLockStaleMs();
  maxLockHoldMs();
}

/** What a filesystem answers when it has no hard links to give at all. */
const linkUnsupported = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'];

/**
 * Refuses a data directory whose filesystem has no hard links.
 *
 * Every lock is published with one (`claim`), reads included, so on such a
 * mount no request could ever be served — and each would say so with a bare
 * `EPERM`. Probed at start, so the answer names the directory and the reason
 * instead.
 *
 * Only a filesystem that cannot do the operation at all stops the start. A
 * directory that cannot be written to, a full disk or a device that hiccupped
 * says nothing about what the mount can do, and is somebody else's report to
 * make.
 */
export async function assertHardLinks(directory: string): Promise<void> {
  const probe = path.join(directory, `.link-probe-${crypto.randomUUID()}`);
  const linked = `${probe}.link`;
  try {
    await fs.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
  } catch {
    return;
  }
  try {
    await fs.link(probe, linked);
  } catch (error) {
    const code = errorCode(error);
    if (!code || !linkUnsupported.includes(code)) return;
    throw new Error(
      `The data directory (${directory}) does not support hard links ` +
        `(${code}). Content locks are published with one; move the data to ` +
        'a filesystem that has them.',
      { cause: error }
    );
  } finally {
    await fs.rm(linked, { force: true }).catch(() => undefined);
    await fs.rm(probe, { force: true }).catch(() => undefined);
  }
}

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
  /** Linux only: the boot the owner ran in, and its start time in that boot. */
  bootId?: string;
  processStart?: string;
}

/**
 * Tokens of the lock files this process has claimed and not yet given up.
 *
 * A file that names this process's pid with any other token was left by an
 * earlier process that had the same number — a restarted container runs as
 * pid 1 again, on the same hostname — and that process is certainly gone.
 *
 * Kept on the process rather than in this module: a second copy of the module
 * loaded into the same process must see these tokens too, or it would judge
 * the first copy's live locks abandoned.
 */
const heldTokensKey = Symbol.for('h5p-editor-host.process-lock.held-tokens');
const heldTokens = ((globalThis as Record<symbol, unknown>)[heldTokensKey] ??=
  new Set<string>()) as Set<string>;

function readLinuxFile(file: string): string | undefined {
  try {
    return fsSync.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Field 22 of `/proc/<pid>/stat`, the process's start time in clock ticks since
 * boot. Counted from the last `)`, because the command name before it may
 * itself contain spaces and parentheses.
 */
function processStartOf(stat: string | undefined): string | undefined {
  if (!stat) return undefined;
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || undefined;
}

const bootId = readLinuxFile('/proc/sys/kernel/random/boot_id')?.trim();
const ownProcessStart = processStartOf(readLinuxFile('/proc/self/stat'));

export interface HeldProcessLock {
  release: () => Promise<void>;
  /** Checks the on-disk owner now, independently of the heartbeat timer. */
  assertOwned: () => Promise<void>;
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

const claimPrefix = '.claim-';

// A writer pins its entire task, including staging and journal cleanup. A
// lease alone cannot fence a paused process: it can resume after expiry and
// still have filesystem write access. This pin is only reclaimed when its
// local owner is proven gone (see `ownerGone`) or it names no owner at all,
// never just because a heartbeat is old. A pin from another machine requires
// operator recovery.
const writerPin = (tenantRoot: string): string =>
  path.join(locksRoot(tenantRoot), 'content.pin');

/**
 * Legacy or crash debris that can be read but names nobody. Claims publish
 * their complete identity atomically, so an empty published file cannot be
 * a claim still being written by this protocol. Older hosts must be stopped
 * before upgrading: age alone cannot distinguish their incomplete claim
 * from a paused creator. An unreadable file may be another user's and stays.
 */
async function ownerlessDebris(
  file: string,
  staleMs: number
): Promise<boolean> {
  try {
    const stats = await fs.stat(file);
    await fs.readFile(file);
    return Date.now() - stats.mtimeMs > breakGuardStaleMs(staleMs);
  } catch {
    return false;
  }
}

/**
 * Removes a pin whose owner is proven gone, and says whether this call did.
 * The tenant is flagged for repair first: the owner may have died part way
 * through publishing.
 */
async function reclaimWriterPin(
  tenantRoot: string,
  staleMs: number
): Promise<boolean> {
  const file = writerPin(tenantRoot);
  const reclaimed = await underBreakGuard(tenantRoot, staleMs, async () => {
    const owner = await readOwner(file);
    const abandoned = owner
      ? owner.hostname === os.hostname() && (await ownerGone(owner))
      : await ownerlessDebris(file, staleMs);
    if (!abandoned) return false;
    await markRecoveryRequired(tenantRoot);
    return removeJudged(file, owner?.token);
  });
  return reclaimed === true;
}

async function waitForWriterPin(
  tenantRoot: string,
  deadline: number,
  staleMs: number
): Promise<void> {
  const file = writerPin(tenantRoot);
  for (let attempt = 0; await pathExists(file); attempt += 1) {
    if (await reclaimWriterPin(tenantRoot, staleMs)) continue;
    if (Date.now() >= deadline) throw new ContentLockTimeout();
    await backoff(attempt);
  }
}

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

/**
 * Raises the flag durably. A save raises it before its prepared record, and
 * the record is fsynced; a flag that a power loss could still take away would
 * leave that record standing without it.
 */
export async function markRecoveryRequired(tenantRoot: string): Promise<void> {
  await fs.mkdir(locksRoot(tenantRoot), { recursive: true });
  const handle = await fs.open(recoveryFlag(tenantRoot), 'w', 0o600);
  try {
    await handle.writeFile(String(Date.now()));
    await handle.sync();
  } finally {
    await handle.close();
  }
  // The lock directory may itself be new, so its entry is synced too.
  await syncDirectory(locksRoot(tenantRoot));
  await syncDirectory(tenantRoot);
}

export async function clearRecoveryRequired(tenantRoot: string): Promise<void> {
  await fs.rm(recoveryFlag(tenantRoot), { force: true }).catch(() => undefined);
}

export function recoveryRequiredOnDisk(tenantRoot: string): Promise<boolean> {
  return pathExists(recoveryFlag(tenantRoot));
}

function parseOwner(text: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(text);
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

async function readOwner(file: string): Promise<LockOwner | undefined> {
  const text = await fs.readFile(file, 'utf8').catch(() => undefined);
  return text === undefined ? undefined : parseOwner(text);
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

/**
 * Whether the owner a lock file names on this machine is certainly gone.
 *
 * A pid alone is not an identity: after a restart or a reboot the same number
 * can belong to another process — to this one, in a container, where the
 * service is always pid 1. So an owner is gone when its pid has exited, when
 * it is this process's pid but not one of this process's locks, or (on Linux,
 * where the owner recorded them) when the machine has booted since or the pid
 * now belongs to a process that started at another time.
 */
async function ownerGone(owner: LockOwner): Promise<boolean> {
  if (owner.pid === process.pid) return !heldTokens.has(owner.token);
  if (!processAlive(owner.pid)) return true;
  if (owner.bootId && bootId && owner.bootId !== bootId) return true;
  if (owner.processStart) {
    const current = processStartOf(
      await fs
        .readFile(`/proc/${owner.pid}/stat`, 'utf8')
        .catch(() => undefined)
    );
    if (current && current !== owner.processStart) return true;
  }
  return false;
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
 * For an owner on this machine its process is the answer (`ownerGone`), and age
 * is very nearly not consulted at all: a process that still exists is still holding the
 * tenant, even if it has been stopped, swapped out or is simply slow enough to
 * miss a heartbeat — and taking a lock from a live writer is how two processes
 * end up publishing into the same directory. The cost of being strict is a
 * tenant that answers 503 until someone deals with the stuck process, which is
 * the failure worth having.
 *
 * `H5P_HOST_LOCK_MAX_HOLD_MS` is the one thing that overrides it, because
 * `ownerGone` cannot always tell a reused pid from its owner (off Linux, or for
 * an owner that recorded no start time): a machine that comes back with the
 * same hostname and hands the same number to an unrelated process would turn
 * "the owner is alive" into a lock nothing can ever take. No save
 * runs for an hour, so a lock that has gone that long unrefreshed is taken —
 * and, being a break, its journal is replayed before anything reads it.
 *
 * A pid from another machine says nothing here, so those fall back to the
 * heartbeat: nothing has touched the file for the whole window, so nothing is
 * holding it. A file that names nobody is not evidence of anything either — a
 * claim's private file whose writer stopped part way leaves exactly that, as
 * does a lock an older host or a storage crash left empty — so age decides
 * those too.
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
      breakable:
        (await ownerGone(owner)) || now - stats.mtimeMs > maxLockHoldMs()
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
  const owner = await claim(tenantRoot, guard);
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

/**
 * Publishes a complete identity without replacing an existing lock.
 *
 * Answers nothing when the claim did not go through and is worth making
 * again: the path is held, or this claim's private file was swept before it
 * could be published.
 */
async function claim(
  tenantRoot: string,
  file: string
): Promise<LockOwner | undefined> {
  const owner: LockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    token: crypto.randomUUID(),
    ...(bootId && ownProcessStart
      ? { bootId, processStart: ownProcessStart }
      : {})
  };
  // The private file is in the lock directory, outside readers/, so a slow
  // write cannot be mistaken for either a held reader or an ownerless pin.
  const pending = path.join(
    locksRoot(tenantRoot),
    `${claimPrefix}${path.basename(file)}-${owner.token}`
  );
  // Registered before publication: from its first visible byte, it is ours.
  heldTokens.add(owner.token);
  let created = false;
  let linking = false;
  let published = false;
  try {
    const handle = await fs.open(pending, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(owner));
    } finally {
      await handle.close();
    }
    // A rename would overwrite another holder. link() either publishes the
    // fully written inode or fails with EEXIST, leaving that holder alone.
    linking = true;
    await fs.link(pending, file);
    published = true;
    return owner;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return undefined;
    // This claim stood still long enough for a sweep to take its private
    // file for debris. Nothing was published, so the caller simply claims
    // again. A lock directory that has gone missing answers `ENOENT` too,
    // but leaves the private file where it was — and that is not something
    // another attempt would mend.
    if (
      linking &&
      errorCode(error) === 'ENOENT' &&
      !(await pathExists(pending))
    ) {
      return undefined;
    }
    throw error;
  } finally {
    // Never remove `file` here: a failed or delayed claim has no authority
    // over the current holder. This unique staging name is all it owns.
    if (created) await fs.rm(pending, { force: true }).catch(() => undefined);
    if (!published) heldTokens.delete(owner.token);
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
): {
  stop: () => void;
  compromised: () => boolean;
  assertOwned: () => Promise<void>;
} {
  let compromised = false;
  const assertOwned = async (): Promise<void> => {
    const owner = await readOwner(file);
    if (!owner || owner.token !== token) compromised = true;
    if (compromised) {
      throw new HostError(
        'The lock on this content was lost while saving. Retry.',
        503,
        {
          code: 'content-lock-lost'
        }
      );
    }
  };
  const timer = setInterval(() => {
    void (async () => {
      // Read and touched through one descriptor. By path, the file could be
      // replaced between the two, and the beat would refresh the new holder's
      // lock while telling this one nothing. Through the descriptor, a file
      // replaced before the open shows the other token, and one replaced after
      // it only has its unlinked inode touched — the next beat sees the rest.
      let handle;
      try {
        handle = await fs.open(file, 'r');
      } catch {
        compromised = true;
        clearInterval(timer);
        return;
      }
      try {
        const owner = parseOwner(await handle.readFile('utf8').catch(() => ''));
        if (!owner || owner.token !== token) {
          compromised = true;
          clearInterval(timer);
          return;
        }
        // No fsync: the new mtime only has to be visible to other users of
        // the mount, which utimes already gives them; durability across a
        // crash is not wanted (a crashed owner's lock is meant to go stale),
        // and an owner on this machine is judged by its pid, not by this
        // mtime.
        const now = new Date();
        await handle.utimes(now, now).catch(() => undefined);
      } finally {
        await handle.close().catch(() => undefined);
      }
    })();
  }, heartbeatMs(staleMs));
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    compromised: () => compromised,
    assertOwned
  };
}

/**
 * Gives a lock file up, but only while it is still ours: a file that now
 * carries somebody else's token belongs to them, and removing it would hand
 * the tenant to a third process while they are still writing.
 */
async function releaseOwn(file: string, token: string): Promise<void> {
  try {
    const owner = await readOwner(file);
    if (owner && owner.token !== token) return;
    await fs.rm(file, { force: true }).catch(() => undefined);
  } finally {
    // After the removal: until then the file is still ours to anyone judging it.
    heldTokens.delete(token);
  }
}

/**
 * Reader entries with a live owner, and how many of the rest this call
 * removed on the way past. Counted removal by removal: a reader that arrives
 * or leaves during the walk is nobody's removal.
 */
async function liveReaders(
  tenantRoot: string,
  staleMs: number
): Promise<{ live: number; removed: number }> {
  const directory = readersRoot(tenantRoot);
  const entries = await fs.readdir(directory).catch(() => [] as string[]);
  let live = 0;
  let removed = 0;
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
    if (gone) removed += 1;
    else live += 1;
  }
  return { live, removed };
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
    owner = await claim(tenantRoot, file);
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
  let pin: LockOwner | undefined;
  const release = async (): Promise<void> => {
    beat.stop();
    if (pin) await releaseOwn(writerPin(tenantRoot), pin.token);
    await releaseOwn(file, owner!.token);
  };
  // The writer's file is up, so no new reader can start. Wait out the ones
  // that were already reading — and hand the lock back if they outlast the
  // budget, rather than holding a tenant hostage behind a queue we gave up on.
  try {
    for (let attempt = 0; ; attempt += 1) {
      if ((await liveReaders(tenantRoot, staleMs)).live === 0) break;
      if (Date.now() >= deadline) throw new ContentLockTimeout();
      await backoff(attempt);
    }
    do {
      await waitForWriterPin(tenantRoot, deadline, staleMs);
      await beat.assertOwned();
      pin = await claim(tenantRoot, writerPin(tenantRoot));
      if (!pin && Date.now() >= deadline) throw new ContentLockTimeout();
    } while (!pin);
    await beat.assertOwned();
  } catch (error) {
    await release();
    throw error;
  }
  return {
    release,
    brokeStaleWriter,
    compromised: beat.compromised,
    assertOwned: beat.assertOwned
  };
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
    await waitForWriterPin(tenantRoot, deadline, staleMs);
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
    const owner = await claim(tenantRoot, file);
    if (!owner) {
      // The name is this call's alone, so nobody else can be holding it: the
      // claim was swept while it stood still. It waits like any other attempt
      // that did not go through, and does not outlive its budget.
      if (Date.now() >= deadline) throw new ContentLockTimeout();
      await backoff(attempt);
      continue;
    }
    // Mark first, then look again: a writer that took its file between the
    // check above and this line would otherwise never see this reader, and
    // would publish a rename underneath a read that spans two files.
    if (
      (await pathExists(writer)) ||
      (await pathExists(writerPin(tenantRoot)))
    ) {
      await releaseOwn(file, owner.token);
      if (Date.now() >= deadline) throw new ContentLockTimeout();
      await backoff(attempt);
      continue;
    }
    const beat = startHeartbeat(file, owner.token, staleMs);
    return {
      brokeStaleWriter,
      compromised: beat.compromised,
      assertOwned: beat.assertOwned,
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
  /** Entries removed: abandoned locks, pins, guards and claim staging files. */
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
 * whose owner is gone, a break guard nobody released, and the private files
 * of claims that never finished. Called from the periodic journal sweep,
 * because a tenant nobody writes to any more is exactly the one where nothing
 * else would.
 */
export async function sweepStaleLocks(tenantRoot: string): Promise<LockSweep> {
  const staleMs = processLockStaleMs();
  let { removed } = await liveReaders(tenantRoot, staleMs);
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
  // A pin reclaimed here also raises the flag: its owner, too, may have died
  // part way through publishing.
  if (
    (await pathExists(writerPin(tenantRoot))) &&
    (await reclaimWriterPin(tenantRoot, staleMs))
  ) {
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
  // A crash before or after link() can leave its private staging name behind.
  // These names are never reused. Removing one cannot remove a published
  // lock; a claim paused before link() finds its file gone and claims again.
  const entries = await fs.readdir(locksRoot(tenantRoot)).catch(() => []);
  for (const name of entries) {
    if (!name.startsWith(claimPrefix)) continue;
    const file = path.join(locksRoot(tenantRoot), name);
    // One file that will not go must not cost the other tenants their sweep.
    if (
      (await breakable(file, staleMs, Date.now())) &&
      (await fs.rm(file, { force: true }).then(
        () => true,
        () => false
      ))
    ) {
      removed += 1;
    }
  }
  return { removed, writerBroken };
}
