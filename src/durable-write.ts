import fs from 'fs/promises';
import path from 'path';

function unsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code || '') ||
    (process.platform === 'win32' &&
      ['EISDIR', 'EPERM', 'EACCES'].includes(code || ''))
  );
}

/**
 * Flushes a directory so a rename made inside it survives a power loss.
 *
 * `rename` is atomic against concurrent readers, but on most filesystems the
 * new directory entry itself is only durable once the directory is synced —
 * without this a crash can leave the record neither at its temp name nor at
 * its target. Only unsupported directory syncing is tolerated; real I/O
 * failures must not turn an undurable save into a success response.
 *
 * The operation journal is the receipt an embedder's own accounting relies
 * on, so it needs this durability as much as any ledger does.
 */
export default async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
  } catch (error) {
    if (unsupported(error)) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!unsupported(error)) throw error;
  } finally {
    await handle.close();
  }
}

/** Persist newly created directories all the way to their existing parent. */
export async function makeDirectory(dir: string): Promise<void> {
  const firstCreated = await fs.mkdir(dir, { recursive: true });
  if (!firstCreated) return;
  const parent = path.dirname(path.resolve(firstCreated));
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    await syncDirectory(current);
    if (current === parent) break;
  }
}

/**
 * Flush regular files before the directories that name them, then the stage
 * root. Symlinks are not followed; the containing directory is still synced.
 */
export async function syncTree(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await syncTree(file);
    } else if (entry.isFile()) {
      const handle = await fs.open(file, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await syncDirectory(directory);
}
