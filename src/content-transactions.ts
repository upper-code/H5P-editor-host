import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fsImplementations } from '@lumieducation/h5p-server';
import { numericContentId } from './content-id';
import syncDirectory from './durable-write';
import envNumber from './env';
import HostError, { ContentLockTimeout } from './errors';
import acquireProcessLock, {
  HeldProcessLock,
  clearRecoveryRequired,
  markRecoveryRequired,
  recoveryRequiredOnDisk,
  sweepStaleLocks
} from './process-lock';
import { directorySize } from './temp-storage';

const { FileContentStorage, DirectoryTemporaryFileStorage } = fsImplementations;
const active = new AsyncLocalStorage<{
  storage: InstanceType<typeof FileContentStorage>;
  /** The staging root `storage` writes into; see `stageWrites`. */
  stage: string;
  id: string;
}>();
// A failed publication must be settled before another reader or writer can
// observe the tenant. Only failed publications need a journal scan; completed
// receipts can otherwise grow without making every save scan their history.
const recoveryRequired = new Set<string>();
/**
 * The cross-process lock each tenant's current writer holds, so the write can
 * ask whether it still has it. Only exclusive holders are recorded: the
 * in-process queue means there is at most one per tenant at a time.
 */
const heldExclusively = new Map<string, HeldProcessLock>();

type Release = () => void;

interface SharedPhase {
  /** What this phase's readers wait for: everything queued ahead of it. */
  start: Promise<void>;
  holders: number;
  finish: Release;
}

interface LockState {
  /** What the next acquisition must wait for. */
  tail: Promise<void>;
  /** The open shared phase at the end of the chain, if there is one. */
  shared?: SharedPhase;
}

const locks = new Map<string, LockState>();

function lockState(root: string): LockState {
  let state = locks.get(root);
  if (!state) {
    state = { tail: Promise.resolve() };
    locks.set(root, state);
  }
  return state;
}

/** Drops the map entry once nothing is queued on it any more. */
function forgetWhenIdle(root: string, state: LockState): void {
  const { tail } = state;
  void tail.then(() => {
    if (locks.get(root) === state && state.tail === tail && !state.shared) {
      locks.delete(root);
    }
  });
}

/** Makes a release idempotent: both `res.end` and `res.close` call it. */
function once(release: Release): Release {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}

function acquireExclusive(root: string): {
  turn: Promise<void>;
  release: Release;
} {
  const state = lockState(root);
  const previous = state.tail;
  let finish!: Release;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // A writer closes any open shared phase: readers arriving from now on queue
  // behind it, so a steady stream of reads cannot starve a save.
  state.shared = undefined;
  state.tail = previous.then(() => held);
  forgetWhenIdle(root, state);
  return { turn: previous, release: once(finish) };
}

function acquireShared(root: string): {
  turn: Promise<void>;
  release: Release;
} {
  const state = lockState(root);
  let phase = state.shared;
  if (!phase) {
    const previous = state.tail;
    let finish!: Release;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    phase = { start: previous, holders: 0, finish };
    state.shared = phase;
    state.tail = previous.then(() => held);
    forgetWhenIdle(root, state);
  }
  const current = phase;
  current.holders += 1;
  const release = once(() => {
    current.holders -= 1;
    if (current.holders === 0) {
      if (state.shared === current) state.shared = undefined;
      current.finish();
    }
  });
  return { turn: current.start, release };
}

export { ContentLockTimeout };

/**
 * Runs `task` under the tenant's content lock.
 *
 * Writers are exclusive; readers (`mode: 'shared'`) run concurrently with each
 * other but never alongside a write, which is what keeps a two-file read — the
 * revision is `h5p.json` plus `content.json` — from straddling the directory
 * rename that publishes a save. A reader that only streams one file needs no
 * lock at all: an open descriptor survives the rename.
 *
 * `waitMs` bounds how long an acquisition queues before giving up with a 503,
 * so a write never hangs on a holder that is slow to leave — a shared reader
 * still at work, or a writer in another process. The one reader that could
 * otherwise hold on for the length of a client's socket, the `.h5p` export,
 * builds its package under the lock and streams it out with the lock already
 * released (see the download route), so a thin link no longer blocks a save.
 */
export function withContentLock<T>(
  root: string,
  task: () => Promise<T>,
  options: { mode?: 'exclusive' | 'shared'; waitMs?: number } = {}
): Promise<T> {
  const waitMs = options.waitMs ?? contentLockWaitMs();
  // One budget covers both halves of the acquisition. Giving each its own
  // would let a request that waited out the queue here wait the same again on
  // the lock file, and answer twice as late as `H5P_HOST_MUTATION_WAIT_MS`
  // promises.
  const deadline =
    Number.isFinite(waitMs) && waitMs > 0 ? Date.now() + waitMs : Infinity;
  // Finishing an interrupted publication rewrites the live directory, so it
  // has to run alone even when the request that noticed it is a reader.
  const shared = options.mode === 'shared' && !recoveryRequired.has(root);
  const { turn, release } = shared
    ? acquireShared(root)
    : acquireExclusive(root);
  const again = (): Promise<T> => {
    if (deadline === Infinity) return withContentLock(root, task, options);
    const remaining = deadline - Date.now();
    // A budget of zero means "no limit" to `withContentLock`, so a retry that
    // has already run out of time must be refused here rather than handed on
    // as an unbounded wait.
    if (remaining <= 0) return Promise.reject(new ContentLockTimeout());
    return withContentLock(root, task, { ...options, waitMs: remaining });
  };
  return waitForTurn(turn, waitMs, release).then(async () => {
    // The flag can also be raised *after* this acquisition: the write that
    // failed to publish was ahead of a whole shared phase, and every reader
    // in it would otherwise recover concurrently. Hand the turn back and
    // come round again — the second acquisition sees the flag and takes the
    // lock exclusively, which is where a repair belongs.
    if (shared && recoveryRequired.has(root)) {
      release();
      return again();
    }
    let held;
    try {
      held = await acquireProcessLock(tenantRootOf(root), {
        mode: shared ? 'shared' : 'exclusive',
        deadline
      });
    } catch (error) {
      release();
      throw error;
    }
    // Taking a lock from a dead owner says more than that the tenant is free:
    // the owner died holding it, which is the one window in which a
    // publication can have been left half-applied. The on-disk flag says the
    // same thing about a process that is no longer here to raise it in memory.
    // A reader cannot repair either, so it gives the turn back and comes round
    // as a writer.
    const tenantRoot = tenantRootOf(root);
    if (held.brokeStaleWriter || (await recoveryRequiredOnDisk(tenantRoot))) {
      recoveryRequired.add(root);
      if (shared) {
        await held.release();
        release();
        return again();
      }
    }
    if (!shared) heldExclusively.set(root, held);
    try {
      if (recoveryRequired.has(root)) {
        await recoverTransactions(root);
        recoveryRequired.delete(root);
      }
      return await task();
    } finally {
      if (heldExclusively.get(root) === held) heldExclusively.delete(root);
      // A lock that stopped being ours means this ran beside something else,
      // whatever it was. The tenant cannot be assumed intact, and the next
      // caller has to replay the journal before it reads.
      if (held.compromised()) {
        recoveryRequired.add(root);
        await markRecoveryRequired(tenantRoot).catch(() => undefined);
      }
      await held.release();
      release();
    }
  });
}

/** `<tenant>`, the directory holding both `content` and `operations`. */
function tenantRootOf(root: string): string {
  return path.dirname(root);
}

/**
 * Refuses to go on when this writer's lock stopped being its own.
 *
 * The lock can be lost while a write is running — an hour of silence past
 * `H5P_HOST_LOCK_MAX_HOLD_MS`, or somebody deleting the file — and by then
 * another process may have taken the tenant and saved into it. Neither writing
 * a journal record nor publishing one may happen after that: the first would
 * leave a transaction a later recovery would replay over the newer save, and
 * the second would overwrite it outright. Both are checked, because a write
 * can lose the lock between them.
 */
function assertStillHeld(root: string): void {
  if (heldExclusively.get(root)?.compromised()) {
    throw new HostError(
      'The lock on this content was lost while saving. Retry.',
      503
    );
  }
}

/**
 * Waits for the lock, or gives the turn up. Releasing on timeout keeps the
 * queue moving: the requests behind this one still wait only for the holder.
 */
function waitForTurn(
  turn: Promise<void>,
  waitMs: number,
  release: Release
): Promise<void> {
  if (!Number.isFinite(waitMs) || waitMs <= 0) return turn;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      release();
      reject(new ContentLockTimeout());
    }, waitMs);
    timer.unref?.();
    turn.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const exists = (name: string) =>
  fs.access(name).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
export const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The usage reason of a generation write — the save `POST
 * /api/v1/generated-content` makes and the compensating delete that undoes
 * it. The embedder books these through the job that made them rather than
 * through `pendingOperations`, which is why the journal treats them apart.
 */
export const GENERATION_REASON = 'docx-generation';

/** How long a mutating request may queue for the content lock. */
const contentLockWaitMs = () => envNumber('H5P_HOST_MUTATION_WAIT_MS', 30_000);

/**
 * How long a settled journal entry is kept.
 *
 * A record is the receipt that makes a repeated `Idempotency-Key` return the
 * first answer instead of writing again, so it has to outlive every retry the
 * embedder can still make — which in practice means a browser tab left open
 * across a weekend. It does not have to outlive that: once the embedder has
 * acknowledged the write and the window has passed, the entry is only debris,
 * and one entry per save adds up (see `pruneOperations`).
 */
const operationRetentionMs = () =>
  envNumber('H5P_HOST_OPERATION_RETENTION_MS', 7 * 24 * 60 * 60 * 1000);

/**
 * Reads every environment limit this module uses.
 *
 * The getters are called per request so a test can set a variable after the
 * module loads, which also means a typo would otherwise surface as a failing
 * save rather than a refused start. `main` calls this before it listens, where
 * an operator is watching.
 */
export function assertContentJournalConfig(): void {
  contentLockWaitMs();
  operationRetentionMs();
}

/** `<tenant>/operations`, the sibling of the tenant's `content` directory. */
function operationsRoot(root: string): string {
  return path.join(path.dirname(root), 'operations');
}

/**
 * `<tenant>/operations/acked`, where an acknowledged record is moved.
 *
 * The split is what keeps the journal cheap. `pendingOperations` runs on every
 * save (the embedder settles writes it may have missed before it admits a new
 * one) and again on a short timer, and both only ever need the records nobody
 * has accounted for yet. Leaving acknowledged receipts in the same directory
 * made those passes read every record ever written — a measured second per
 * pass at twenty thousand saves, on the save's own critical path.
 */
function ackedRoot(root: string): string {
  return path.join(operationsRoot(root), 'acked');
}

/**
 * Files the stage may share with the live copy until something writes them.
 *
 * `cloneDirectory` hardlinks the previous revision into the staging area where
 * the filesystem has no reflink, so a staged file can be the very same inode
 * as the published one. h5p-server writes with `createWriteStream` and
 * `writeJSON`, both of which truncate in place — through a hardlink that would
 * rewrite the *live* content. Removing the staged name first breaks the link,
 * so the write lands on a new inode and the published revision stays intact
 * until the rename publishes ours.
 *
 * This is the complete write surface of `FileContentStorage`: `deleteFile` and
 * `deleteContent` only unlink names, and every other method reads.
 */
const stageWrites: Record<string, (id: string, args: unknown[]) => string[]> = {
  addContent: (id) => [
    path.join(id, 'h5p.json'),
    path.join(id, 'content.json')
  ],
  addFile: (id, args) => [path.join(id, String(args[1]))]
};

async function breakLinks(stageRoot: string, names: string[]): Promise<void> {
  await Promise.all(
    names.map((name) => fs.rm(insideStage(stageRoot, name), { force: true }))
  );
}

/**
 * The staged path for a name h5p-server was given, or a refusal.
 *
 * `addFile` takes its filename from the editor's upload, and this is the one
 * place that path is handed to `rm` rather than to a write: a name that
 * climbed out of the staging area would delete a file the transaction does not
 * own. h5p-server sanitizes filenames, but a deletion must not rest on that.
 */
function insideStage(stageRoot: string, name: string): string {
  const staged = path.resolve(stageRoot, name);
  const root = path.resolve(stageRoot);
  if (staged !== root && !staged.startsWith(root + path.sep)) {
    throw new HostError('Invalid file name.', 400);
  }
  return staged;
}

/** Writes are isolated until their final size and revision have been checked.
 * Reads of pasted media from other content still use the live repository. */
export function transactionalContentStorage(
  root: string
): InstanceType<typeof FileContentStorage> {
  const live = new FileContentStorage(root);
  return new Proxy(live, {
    get(target, key) {
      const member = Reflect.get(target, key);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const tx = active.getStore();
        if (!tx) return member.apply(target, args);
        const forcedId = key === 'addContent';
        if (forcedId) args[3] = tx.id;
        if (!forcedId && String(args[0]) !== tx.id) {
          return member.apply(target, args);
        }
        const call = () =>
          Reflect.get(tx.storage, key).apply(tx.storage, args) as unknown;
        const writes = stageWrites[String(key)];
        if (!writes) return call();
        return breakLinks(tx.stage, writes(tx.id, args)).then(call);
      };
    }
  });
}

export function transactionalTemporaryStorage(
  root: string
): InstanceType<typeof DirectoryTemporaryFileStorage> {
  const storage = new DirectoryTemporaryFileStorage(root);
  return new Proxy(storage, {
    get(target, key) {
      const member = Reflect.get(target, key);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        // An update consumes #tmp files. Keep them until expiry so a rejected
        // or interrupted transaction can be retried with the original payload.
        if (key === 'deleteFile' && active.getStore()) return Promise.resolve();
        return member.apply(target, args);
      };
    }
  });
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  // The record is the receipt that makes a replayed idempotency key answer
  // instead of writing again, and the marker recovery reads after a crash, so
  // its directory entry has to reach the device too — not just its contents.
  await syncDirectory(path.dirname(file));
}

/** Hash both complete metadata and parameter files for optimistic concurrency. */
export async function contentRevision(
  root: string,
  id: string
): Promise<string> {
  const parts = await Promise.all(
    ['h5p.json', 'content.json'].map((name) =>
      fs.readFile(path.join(root, id, name))
    )
  );
  return crypto
    .createHash('sha256')
    .update(parts[0])
    .update('\0')
    .update(parts[1])
    .digest('hex');
}

export interface ContentSummary {
  id: string;
  title: string;
  mainLibrary: string;
  updatedAt: string;
}

/**
 * Every stored item under a tenant's content root, newest first.
 *
 * The layout of a content directory is this module's business, not a route's:
 * an item is a numerically named directory holding `h5p.json` (its metadata)
 * and `content.json` (its parameters) — the same two files `contentRevision`
 * hashes. `content.json` is also what dates an item: h5p-server rewrites it in
 * place on every save, which leaves the directory's own mtime untouched, so
 * the directory is only the fallback for content that has none yet.
 *
 * Metadata that cannot be read is not an error: a save publishes the directory
 * by rename, but a crash mid-write can still leave one behind, and it stays
 * visible with fallback metadata rather than making the whole listing fail.
 */
export async function listContent(root: string): Promise<ContentSummary[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const content = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && numericContentId.test(entry.name)
      )
      .map(async (entry) => {
        const directory = path.join(root, entry.name);
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(
            await fs.readFile(path.join(directory, 'h5p.json'), 'utf8')
          );
        } catch (error) {
          // Keep partially written content visible with fallback metadata.
        }
        const stats = await fs
          .stat(path.join(directory, 'content.json'))
          .catch(() => fs.stat(directory));
        return {
          id: entry.name,
          title: String(metadata.title || `Interactive book ${entry.name}`),
          mainLibrary: String(metadata.mainLibrary || ''),
          updatedAt: stats.mtime.toISOString()
        };
      })
  );
  return content.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

export interface MutationResult {
  operationId: string;
  contentId: string;
  savedBytes: number;
  deltaBytes: number;
  revision?: string;
  metadata?: unknown;
  removedBytes?: number;
}
export interface RecordData {
  fingerprint: string;
  state: 'prepared' | 'done';
  reason: string;
  acknowledged?: boolean;
  /** Epoch ms: when the record reached `done`, and when it was acknowledged. */
  completedAt?: number;
  acknowledgedAt?: number;
  deleted: boolean;
  result: MutationResult;
}

/**
 * Publishes a prepared transaction, and marks the tenant as needing repair for
 * as long as that is in flight.
 *
 * `complete` renames the live directory out of the way before it renames the
 * staged one in, so a failure between the two leaves the tenant without its
 * content until the journal is replayed. This call raises the flag around that
 * window itself, so a single publication — a write that just prepared a
 * transaction, or the replay of an idempotency key — needs no help from its
 * caller.
 *
 * Lowering it again is only this call's to do when this call raised it: a
 * caller that had already raised the flag wants it held past this publication,
 * because a recovery pass publishes one entry after another and a journal is
 * not settled because its first entry is.
 */
async function publish(
  root: string,
  dir: string,
  record: RecordData
): Promise<void> {
  const held = recoveryRequired.has(root);
  const tenantRoot = tenantRootOf(root);
  assertStillHeld(root);
  recoveryRequired.add(root);
  // The in-memory flag only warns this process. A publication that fails —
  // not a crash, a plain error — leaves the tenant needing the same repair,
  // and the process that has to do it may be another one, or this one after a
  // restart. Both flags come down together, and only on success.
  await markRecoveryRequired(tenantRoot);
  await complete(root, dir, record);
  if (!held) {
    recoveryRequired.delete(root);
    await clearRecoveryRequired(tenantRoot);
  }
}

async function complete(
  root: string,
  dir: string,
  record: RecordData
): Promise<void> {
  const live = path.join(root, record.result.contentId);
  const staged = path.join(dir, 'content', record.result.contentId);
  const previous = path.join(dir, 'previous');
  if (record.state === 'prepared') {
    if (record.deleted) {
      if (await exists(live)) await fs.rename(live, previous);
    } else if (await exists(staged)) {
      if (await exists(live)) await fs.rename(live, previous);
      await fs.rename(staged, live);
    } else if (!(await exists(live))) {
      throw new Error(`Incomplete content transaction: ${dir}`);
    }
    record.state = 'done';
    record.completedAt = Date.now();
    await atomicJson(path.join(dir, 'record.json'), record);
  }
  await fs.rm(previous, { recursive: true, force: true });
  await fs.rm(path.join(dir, 'content'), { recursive: true, force: true });
}

async function readRecord(file: string): Promise<RecordData | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as RecordData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Lists an operations directory, skipping everything that is not one of our
 * records. A tenant that has never been written to has no such directory at
 * all, which is the common case and costs a single failed `readdir`.
 */
async function operationIds(operations: string): Promise<string[]> {
  const entries = await fs
    .readdir(operations, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  return entries
    .filter(
      (entry) => entry.isDirectory() && operationIdPattern.test(entry.name)
    )
    .map((entry) => entry.name);
}

/**
 * How long ago this entry last mattered, in ms, or undefined if it cannot be
 * told. The directory's own mtime answers it for every kind of entry: a
 * staging area is touched while it is being written, and a record directory
 * last when `atomicJson` renamed the receipt into it — at completion for an
 * unacknowledged write, at acknowledgement for a settled one. Reading the JSON
 * back would tell us no more and would cost a file read per entry.
 */
async function entryAge(dir: string, now: number): Promise<number | undefined> {
  const stats = await fs.stat(dir).catch(() => undefined);
  return stats ? now - stats.mtimeMs : undefined;
}

/**
 * Removes the journal entries that have outlived their purpose: acknowledged
 * receipts past `H5P_HOST_OPERATION_RETENTION_MS`, and the staging debris of a
 * crash that never got as far as writing a record.
 *
 * A record that is still `prepared`, or `done` and unacknowledged, is never
 * removed here whatever its age: the first is waiting for recovery to finish
 * its rename, and the second is the only surviving evidence of a write the
 * embedder has not charged for yet.
 *
 * The one exception is a generation write (`reason: docx-generation`, the
 * save and its compensating delete). Those are not offered to the embedder
 * through `pendingOperations` — it books them from its own job pipeline, and
 * acknowledges them from there once it has — so an unacknowledged one is not
 * evidence of an uncharged write, only of an embedder that did not get round
 * to saying so. Keeping it for ever would leave one directory per generation
 * behind, and every pending scan of the tenant reading it to skip it. Past
 * the retention window it goes like an acknowledged receipt.
 *
 * Called from `recoverTransactions` (so every start sweeps) and, throttled,
 * after an acknowledgement — one entry accumulates per save, and nothing else
 * would ever remove them.
 */
export async function pruneOperations(
  root: string,
  now = Date.now()
): Promise<number> {
  const retention = operationRetentionMs();
  const operations = operationsRoot(root);
  const acked = ackedRoot(root);
  let removed = 0;
  const expire = async (dir: string) => {
    const age = await entryAge(dir, now);
    if (age === undefined || age <= retention) return;
    await fs.rm(dir, { recursive: true, force: true });
    removed += 1;
  };
  for (const id of await operationIds(operations)) {
    const dir = path.join(operations, id);
    const record = await readRecord(path.join(dir, 'record.json'));
    // No record: staging a crash abandoned before it could commit to anything.
    // Acknowledged but still here: a crash between the receipt and the move
    // below, which only age can now clear. A completed generation write is
    // settled elsewhere (see above) and expires like a receipt. Anything else
    // is in flight or is a write nobody has charged for, and stays whatever
    // its age.
    if (
      record &&
      !record.acknowledged &&
      !(record.state === 'done' && record.reason === GENERATION_REASON)
    )
      continue;
    await expire(dir);
  }
  for (const id of await operationIds(acked)) {
    await expire(path.join(acked, id));
  }
  return removed;
}

/**
 * Prune costs a `readdir` plus a `stat` per settled receipt, which is cheap
 * but not free, and an acknowledgement happens on every save. Once an hour per
 * tenant is often enough for a retention window measured in days.
 */
const lastPrune = new Map<string, number>();
const pruneIntervalMs = 60 * 60 * 1000;

function prunePeriodically(root: string, log?: PruneLogger): void {
  const now = Date.now();
  if (now - (lastPrune.get(root) ?? 0) < pruneIntervalMs) return;
  lastPrune.set(root, now);
  void pruneOperations(root, now).catch((error) => {
    // Housekeeping never fails the request that triggered it; the next
    // acknowledgement tries again.
    lastPrune.delete(root);
    log?.warn({ err: error, root }, 'Could not prune the operation journal');
  });
}

interface PruneLogger {
  warn(context: object, message: string): void;
}

/**
 * Finishes or discards the transactions a crash left half-applied, then sweeps
 * the journal. Only unsettled entries are walked: an acknowledged receipt has
 * nothing left to publish.
 */
export async function recoverTransactions(root: string): Promise<void> {
  const operations = operationsRoot(root);
  // The repair flag stays up for the whole walk, publications included: a pass
  // that dies half way — an unreadable record, a device that went away — has
  // left the entries behind it exactly as it found them, and the next request
  // has to run this again instead of reading content that is still moved
  // aside. Only a walk that reaches the end has settled the journal.
  recoveryRequired.add(root);
  for (const id of await operationIds(operations)) {
    const dir = path.join(operations, id);
    const record = await readRecord(path.join(dir, 'record.json'));
    if (record) {
      await publish(root, dir, record);
    } else {
      // A crash before prepare cannot have changed the live content.
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  recoveryRequired.delete(root);
  await clearRecoveryRequired(tenantRootOf(root));
  // Sweeping is housekeeping, not repair: a failure here leaves nothing to
  // recover, so it must not raise the flag again.
  await pruneOperations(root);
}

/**
 * Recovery for a caller that is not already holding the tenant: the pass a
 * process runs over every tenant before it starts serving.
 *
 * Another process may be serving that tenant right now — the case this whole
 * file lock exists for — and it has recovered the journal itself. So a lock
 * that cannot be had is not a failure: it is proof that someone live owns the
 * tenant, and the start goes on without repairing behind their back. Returns
 * whether the pass actually ran.
 */
export async function recoverTransactionsLocked(
  root: string,
  waitMs?: number
): Promise<boolean> {
  try {
    await withContentLock(root, () => recoverTransactions(root), { waitMs });
    return true;
  } catch (error) {
    if (error instanceof ContentLockTimeout) return false;
    throw error;
  }
}

export interface JournalJanitorOptions {
  /** The directory holding one directory per tenant. */
  dataRoot: string;
  intervalMs: number;
  log: PruneLogger & { info(context: object, message: string): void };
}

/**
 * Sweeps every tenant's journal and lock directory on a timer.
 *
 * `prunePeriodically` only ever runs on the back of an acknowledgement, which
 * means a tenant that stops being written to keeps its last receipts — and a
 * lock file a crash left behind — for as long as the deployment lives. The
 * expiry windows are days long, so this timer is measured in hours: it exists
 * to make sure the sweep happens at all, not to make it prompt.
 *
 * Returns a stop function; the timer is unref'd, so it never holds the process
 * open by itself.
 */
/** How long the sweep queues for one tenant before leaving it for next time. */
const sweepLockWaitMs = 2000;

export function startJournalJanitor(
  options: JournalJanitorOptions
): () => void {
  const { dataRoot, intervalMs, log } = options;
  if (intervalMs <= 0) {
    log.info({}, 'Journal janitor disabled by configuration');
    return () => undefined;
  }
  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const tenants = await fs
        .readdir(dataRoot, { withFileTypes: true })
        .catch(() => []);
      let removed = 0;
      for (const entry of tenants) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const tenantRoot = path.join(dataRoot, entry.name);
        const contentRoot = path.join(tenantRoot, 'content');
        // Under the tenant's lock: a staging directory that has no record yet
        // belongs either to a crash or to a save that is running right now,
        // and only the lock tells the two apart. A tenant that is busy is
        // skipped — the sweep has all the time in the world.
        try {
          removed += await withContentLock(
            contentRoot,
            () => pruneOperations(contentRoot),
            { waitMs: sweepLockWaitMs }
          );
          lastPrune.set(contentRoot, Date.now());
        } catch (error) {
          if (!(error instanceof ContentLockTimeout)) throw error;
        }
        const sweep = await sweepStaleLocks(tenantRoot);
        removed += sweep.removed;
        // Clearing an abandoned writer's lock without replaying its journal
        // would leave the tenant looking free while a publication is still
        // half-applied. The flag the sweep raises makes the next request
        // repair it; doing it here means there does not have to be one.
        if (sweep.writerBroken) {
          log.info(
            { tenant: entry.name },
            'Recovering a tenant whose writer did not survive'
          );
          await recoverTransactionsLocked(contentRoot);
        }
      }
      if (removed > 0) {
        log.info({ removed }, 'Swept settled journal entries and stale locks');
      }
    } catch (error) {
      log.warn({ err: error }, 'Journal sweep failed');
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * The record for one operation id, wherever it now lives: an unsettled entry
 * sits directly in `operations/`, one the embedder has acknowledged in
 * `operations/acked/`. Both answer a replayed idempotency key with the first
 * result, which is the whole point of keeping the receipt.
 */
export async function readOperation(
  root: string,
  id: string
): Promise<RecordData | undefined> {
  if (!operationIdPattern.test(id)) {
    throw new HostError('Invalid operation id.', 400);
  }
  return (
    (await readRecord(path.join(operationsRoot(root), id, 'record.json'))) ??
    readRecord(path.join(ackedRoot(root), id, 'record.json'))
  );
}

/**
 * Marks a completed operation as accounted for by the embedder and moves it
 * out of the way of the pending scans.
 *
 * The record is kept — for `H5P_HOST_OPERATION_RETENTION_MS`, in
 * `operations/acked/` — rather than removed here, so a repeated
 * acknowledgement (the reconciler and the request's own inline call can race)
 * and a replayed idempotency key still find it instead of a 404. Moving it is
 * what keeps `pendingOperations` proportional to the writes nobody has
 * charged for rather than to every write ever made.
 *
 * Must run under the tenant's content lock, held across the read that produced
 * `record`. A settled generation receipt is pruned by age (see
 * `pruneOperations`), and a prune that ran between the read here and the rename
 * below would delete the directory this call has just rewritten — the ack would
 * return but leave no receipt, and the next replay would write the content
 * again. The lock is what excludes the janitor's sweep from that window.
 */
export async function acknowledgeOperation(
  root: string,
  id: string,
  record: RecordData,
  log?: PruneLogger
): Promise<void> {
  record.acknowledged = true;
  record.acknowledgedAt = Date.now();
  const from = path.join(operationsRoot(root), id);
  const to = path.join(ackedRoot(root), id);
  const settled = (await exists(path.join(from, 'record.json'))) ? from : to;
  await atomicJson(path.join(settled, 'record.json'), record);
  if (settled === from) {
    await fs.mkdir(ackedRoot(root), { recursive: true });
    // Move, never overwrite: two acknowledgements of the same write can be in
    // flight (the reconciler and the request's own inline call), and removing
    // the destination first would let the second one delete the receipt the
    // first had just moved there. If the entry is already gone, the other call
    // moved it and there is nothing left to do.
    try {
      await fs.rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await syncDirectory(ackedRoot(root));
    await syncDirectory(operationsRoot(root));
  }
  prunePeriodically(root, log);
}

export interface PendingOperation extends MutationResult {
  distributorId: string;
  reason: string;
}

/**
 * Completed writes that no embedder has acknowledged: what the reconciler
 * charges after a request died between this service's write and the embedder's
 * accounting. Generation runs are excluded — the embedder books those through
 * its own job pipeline.
 *
 * `distributorId` narrows the walk to one tenant. The embedder settles its own
 * pending writes before it admits a new save, and that call has no business
 * reading — or transferring — every other tenant's journal.
 */
export async function pendingOperations(
  dataRoot: string,
  distributorId?: string
): Promise<PendingOperation[]> {
  const pending: PendingOperation[] = [];
  const tenants = distributorId
    ? [distributorId]
    : (await fs.readdir(dataRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
  for (const tenant of tenants) {
    const contentRoot = path.join(dataRoot, tenant, 'content');
    for (const id of await operationIds(operationsRoot(contentRoot))) {
      const record = await readOperation(contentRoot, id);
      if (
        record?.state === 'done' &&
        !record.acknowledged &&
        record.reason !== GENERATION_REASON
      ) {
        pending.push({
          distributorId: tenant,
          reason: record.reason,
          ...record.result
        });
      }
    }
  }
  return pending;
}

type CloneStrategy = 'reflink' | 'hardlink' | 'copy';

/**
 * The cheapest strategy a device has been seen to support. A reflink attempt
 * that fails costs a partial copy and its cleanup, and what a filesystem can do
 * does not change while the process runs, so ask each device once — by device,
 * because a deployment is free to mount one tenant's data somewhere the next
 * tenant's is not.
 */
const cloneStrategies = new Map<number, CloneStrategy>();

/**
 * Whether this error says the filesystem cannot do the operation at all.
 *
 * Only that is worth remembering. A full disk (`ENOSPC`), a device that
 * hiccupped (`EIO`) or an inode that ran out of links (`EMLINK`) is this
 * save's misfortune, not the mount's nature, and taking it for one would put
 * every later save on that device onto a full byte copy — the very cost this
 * ladder exists to avoid — until someone restarts the process.
 */
function unsupportedHere(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return (
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'ENOSYS' ||
    code === 'ENOTTY' ||
    code === 'EINVAL' ||
    code === 'EXDEV' ||
    code === 'EPERM'
  );
}

/**
 * Materializes the previous revision in the transaction's staging area.
 *
 * Three strategies, cheapest first. `COPYFILE_FICLONE` makes this a reflink
 * where the filesystem supports one (APFS, Btrfs, XFS), so the copy costs
 * metadata instead of the content's bytes. On ext4 — the ordinary Linux
 * deployment, and the one that matters here — there is no reflink, and letting
 * libuv fall back to a byte copy would duplicate the whole book on every
 * single save: a 200 MB book means 200 MB read and written before the editor's
 * change is even applied, plus that much free space. So the second strategy is
 * a hardlink farm, which costs one directory entry per file; the proxy in
 * `transactionalContentStorage` unlinks a staged name before writing it, so no
 * write ever reaches the published inode through a shared link. Only when
 * hardlinks are unavailable too (a different filesystem, a mount that forbids
 * them) does this fall back to copying the bytes.
 *
 * A step down the ladder applies to this call whatever went wrong — a
 * hardlink farm needs neither the space nor the reflink support the attempt
 * before it wanted — but only a filesystem that cannot do the operation at all
 * is remembered for the next one.
 */
async function cloneDirectory(from: string, to: string): Promise<void> {
  const device = await fs.stat(from).then(
    (stats) => stats.dev,
    () => undefined
  );
  const learn = (strategy: CloneStrategy): void => {
    if (device !== undefined) cloneStrategies.set(device, strategy);
  };
  let known: CloneStrategy =
    (device === undefined ? undefined : cloneStrategies.get(device)) ??
    'reflink';
  if (known === 'reflink') {
    try {
      await fs.cp(from, to, {
        recursive: true,
        mode: fsConstants.COPYFILE_FICLONE_FORCE
      });
      return;
    } catch (error) {
      if (unsupportedHere(error)) learn((known = 'hardlink'));
      await fs.rm(to, { recursive: true, force: true });
    }
  }
  if (known !== 'copy') {
    try {
      await linkDirectory(from, to);
      return;
    } catch (error) {
      // Only once reflinks are ruled out for good does a refused link mean
      // this device is down to copying; while the cheaper rung is still
      // believed to work, the ladder has to start at the top again next time.
      if (unsupportedHere(error) && known === 'hardlink') learn('copy');
      await fs.rm(to, { recursive: true, force: true });
    }
  }
  await fs.cp(from, to, { recursive: true });
}

/** Recreates the directory tree with every file hardlinked, not copied. */
async function linkDirectory(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await linkDirectory(source, target);
    } else if (entry.isFile()) {
      await fs.link(source, target);
    } else {
      // A symlink or anything else that is not ours to reproduce: copy it and
      // let the filesystem decide what that means.
      await fs.cp(source, target, { recursive: true, verbatimSymlinks: true });
    }
  }
}

/** Call under the tenant request lock; the journal also recovers a crash during rename. */
async function mutateContentUnlocked(options: {
  root: string;
  id?: string;
  operationId?: string;
  fingerprint: unknown;
  revision?: string;
  maxDeltaBytes?: number;
  reason: string;
  deleted?: boolean;
  save: () => Promise<{ contentId: string; metadata?: unknown }>;
}): Promise<MutationResult> {
  const operationId = options.operationId || crypto.randomUUID();
  if (!operationIdPattern.test(operationId)) {
    throw new HostError('Invalid operation id.', 400);
  }
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        options.id,
        options.reason,
        options.fingerprint,
        options.revision
      ])
    )
    .digest('hex');
  const previous = await readOperation(options.root, operationId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) {
      throw new HostError(
        'Operation id was already used for a different save.',
        409
      );
    }
    // A replay of a key whose transaction never finished publishing has to
    // finish it before answering. One that is already `done` — including one
    // the embedder has acknowledged and this service has moved aside — has
    // nothing left to do but repeat the recorded answer.
    if (previous.state === 'prepared') {
      await publish(
        options.root,
        path.join(operationsRoot(options.root), operationId),
        previous
      );
    }
    return previous.result;
  }
  if (options.id) {
    if (!(await exists(path.join(options.root, options.id)))) {
      throw new HostError('Content not found.', 404);
    }
    const revision = await contentRevision(options.root, options.id);
    if (options.revision && options.revision !== revision) {
      throw new HostError(
        'This content was changed in another editor. Reload before saving.',
        409
      );
    }
  }
  const id = options.id || crypto.randomInt(1, 2 ** 48).toString();
  if (!options.id && (await exists(path.join(options.root, id)))) {
    throw new HostError('Content id collision. Retry.', 503);
  }
  const dir = path.join(operationsRoot(options.root), operationId);
  await fs.rm(dir, { recursive: true, force: true });
  const stage = path.join(dir, 'content');
  await fs.mkdir(stage, { recursive: true });
  // Link the operation directory into `operations/` durably before anything
  // touches live content. `complete` renames the live directory aside, and a
  // crash that persisted that rename but not this entry would leave a mutated
  // tenant with no prepared record for the recovery pass to replay — a save
  // lost with the tenant's content moved out of the way. `atomicJson` fsyncs
  // the record and the `operations/<id>` directory that holds it; this fsyncs
  // the parent that holds *that*.
  await syncDirectory(operationsRoot(options.root));
  let prepared = false;
  try {
    const before = options.id
      ? await directorySize(path.join(options.root, id))
      : 0;
    if (options.id && !options.deleted) {
      await cloneDirectory(path.join(options.root, id), path.join(stage, id));
    }
    const saved = options.deleted
      ? { contentId: id }
      : await active.run(
          { storage: new FileContentStorage(stage), stage, id },
          options.save
        );
    const after = options.deleted
      ? 0
      : await directorySize(path.join(stage, id));
    const delta = after - before;
    if (delta > (options.maxDeltaBytes ?? Number.MAX_SAFE_INTEGER)) {
      throw new HostError(
        'Not enough disk space for the saved content and media.',
        413
      );
    }
    const result: MutationResult = {
      ...saved,
      contentId: id,
      operationId,
      savedBytes: after,
      deltaBytes: delta,
      ...(options.deleted
        ? { removedBytes: before }
        : { revision: await contentRevision(stage, id) })
    };
    const record: RecordData = {
      fingerprint,
      state: 'prepared',
      reason: options.reason,
      deleted: !!options.deleted,
      result
    };
    assertStillHeld(options.root);
    await atomicJson(path.join(dir, 'record.json'), record);
    prepared = true;
    await publish(options.root, dir, record);

    return result;
  } finally {
    if (!prepared) await fs.rm(dir, { recursive: true, force: true });
  }
}

export function mutateContent(
  options: Parameters<typeof mutateContentUnlocked>[0] & { waitMs?: number }
): Promise<MutationResult> {
  // `waitMs` is what the HTTP-level per-tenant queue in `app.ts` had left of
  // its budget when it handed the request on; the content lock draws from the
  // same budget rather than starting a fresh one. A budget already spent is a
  // 503 now, not an unbounded wait — `withContentLock` reads a non-positive
  // `waitMs` as "no limit", which is the opposite of what a spent budget means.
  if (options.waitMs !== undefined && options.waitMs <= 0) {
    return Promise.reject(new ContentLockTimeout());
  }
  return withContentLock(options.root, () => mutateContentUnlocked(options), {
    waitMs: options.waitMs
  });
}
