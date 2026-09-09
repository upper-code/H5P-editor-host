import path from 'path';
import type { Logger } from 'pino';
import fs from 'fs/promises';

/** Recursively sums the size of every regular file under a directory. */
export async function directorySize(directory: string): Promise<number> {
  let total = 0;
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else if (entry.isFile()) {
      const stats = await fs
        .lstat(entryPath)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
      if (stats?.isFile()) total += stats.size;
    }
  }
  return total;
}

/**
 * Deletes files under `directory` that have not been written to for `maxAgeMs`,
 * then prunes the directories left empty. Returns the number of files removed.
 *
 * Temporary H5P files expire at `createdAt + temporaryFileLifetime` and are
 * never rewritten, so modification time is an accurate stand-in for expiry —
 * and it works for tenants whose editor instance is no longer cached in memory,
 * which is exactly when nothing else would ever clean them up.
 */
export async function sweepExpired(
  directory: string,
  maxAgeMs: number,
  now = Date.now()
): Promise<number> {
  let removed = 0;
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch(() => []);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removed += await sweepExpired(entryPath, maxAgeMs, now);
      // Only removes the directory when it is already empty.
      await fs.rmdir(entryPath).catch(() => undefined);
    } else if (entry.isFile()) {
      const stats = await fs.stat(entryPath).catch(() => undefined);
      if (stats && now - stats.mtimeMs > maxAgeMs) {
        await fs.rm(entryPath, { force: true }).catch(() => undefined);
        removed += 1;
      }
    }
  }
  return removed;
}

export interface JanitorOptions {
  /** Root holding one directory per tenant. */
  dataRoot: string;
  /** Sub-directory of each tenant root to sweep. */
  tenantSubdirectory: string;
  /** Additional absolute directories to sweep (e.g. the upload staging dir). */
  extraDirectories?: string[];
  maxAgeMs: number;
  intervalMs: number;
  log: Logger;
}

/**
 * Periodically removes expired temporary files.
 *
 * Without this, staged editor uploads accumulate for the lifetime of the
 * deployment: h5p-server only expires temporary files when something calls
 * `TemporaryFileManager.cleanUp()`, and nothing does that on its own.
 *
 * Returns a stop function. The timer is unref'd so it never keeps the process
 * alive on its own.
 */
export function startTemporaryFileJanitor(options: JanitorOptions): () => void {
  const { dataRoot, tenantSubdirectory, maxAgeMs, intervalMs, log } = options;
  if (intervalMs <= 0 || maxAgeMs <= 0) {
    log.info('Temporary-file janitor disabled by configuration');
    return () => undefined;
  }

  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const targets = [...(options.extraDirectories || [])];
      const tenants = await fs
        .readdir(dataRoot, { withFileTypes: true })
        .catch(() => []);
      tenants
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .forEach((entry) =>
          targets.push(path.join(dataRoot, entry.name, tenantSubdirectory))
        );

      let removed = 0;
      for (let index = 0; index < targets.length; index += 1) {
        removed += await sweepExpired(targets[index], maxAgeMs);
      }
      if (removed > 0) {
        log.info({ removed }, 'Removed expired temporary files');
      }
    } catch (error) {
      log.warn({ err: error }, 'Temporary-file sweep failed');
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
 * Bytes promised to in-flight uploads, per tenant, so concurrent requests
 * cannot all be admitted against the same free space.
 *
 * A reservation's `budget` is fixed when it is taken: this request plus the
 * ones reserved before it and not yet released, never a later arrival. That
 * makes admission first come, first served — a request that fits on its own
 * is not refused because another was queued behind it.
 *
 * The directory itself is measured through `used()`, and only while nothing
 * is in flight: while reservations are outstanding, the measurement taken when
 * the first of them arrived is reused, plus the bytes of every reservation
 * released since. An in-flight upload is therefore counted exactly once — by
 * its reservation — whether or not its bytes have already reached the
 * directory, instead of twice (the reservation plus a scan that sees them)
 * once they have. A released upload is assumed to have landed until the next
 * idle measurement, which keeps the guard conservative.
 */
export class TempReservations {
  private readonly reserved = new Map<string, number>();

  /** Per key, the measurement a burst of overlapping uploads shares. */
  private readonly bursts = new Map<
    string,
    { measured: Promise<number>; landed: number }
  >();

  public reserve(
    key: string,
    bytes: number
  ): { budget: number; release: () => void } {
    const budget = (this.reserved.get(key) || 0) + bytes;
    this.reserved.set(key, budget);
    let released = false;
    return {
      budget,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        const remaining = (this.reserved.get(key) || 0) - bytes;
        if (remaining > 0) {
          this.reserved.set(key, remaining);
          const burst = this.bursts.get(key);
          if (burst) {
            burst.landed += bytes;
          }
        } else {
          this.reserved.delete(key);
          this.bursts.delete(key);
        }
      }
    };
  }

  /**
   * Bytes to count as already in the directory for an admission decision
   * taken while holding a reservation for `key`. `measure` runs only for the
   * first outstanding reservation; later arrivals in the same burst share its
   * result. A failed measurement is not kept, so the next arrival measures
   * again.
   */
  public async used(
    key: string,
    measure: () => Promise<number>
  ): Promise<number> {
    let burst = this.bursts.get(key);
    if (!burst) {
      const started = { measured: measure(), landed: 0 };
      burst = started;
      this.bursts.set(key, started);
      started.measured.catch(() => {
        if (this.bursts.get(key) === started) {
          this.bursts.delete(key);
        }
      });
    }
    return (await burst.measured) + burst.landed;
  }

  /** Bytes currently reserved for one tenant. */
  public reservedFor(key: string): number {
    return this.reserved.get(key) || 0;
  }
}
