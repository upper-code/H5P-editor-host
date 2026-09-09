import fs from 'fs/promises';

/**
 * Flushes a directory so a rename made inside it survives a power loss.
 *
 * `rename` is atomic against concurrent readers, but on most filesystems the
 * new directory entry itself is only durable once the directory is synced —
 * without this a crash can leave the record neither at its temp name nor at
 * its target. Not every platform lets a directory be opened, so a failure
 * here is not an error: the data was already flushed to the device, only the
 * ordering guarantee is weaker.
 *
 * The same helper exists in WebEditorShelf for its outbox and job store; the
 * operation journal here is the counterpart record and needs the same
 * durability.
 */
export default async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Directory fsync is not supported here; the rename still happened.
  } finally {
    await handle.close();
  }
}
