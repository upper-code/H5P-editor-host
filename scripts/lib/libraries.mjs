/*
 * What "a provisioned H5P library directory" means, in one place.
 *
 * Three things have to agree on it: provisioning (scripts/provision-libraries.mjs)
 * installs them, bundling (scripts/bundle-libraries.mjs) archives them, and the
 * host's readiness probe (src/tenant-manager.ts, isLibraryDirectory) counts
 * them. When these drifted apart, a bundle could contain what a deployment
 * would not count.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';

/** H5P directory convention: `Machine.Name-<major>.<minor>`. */
export const LIBRARY_DIR_NAME = /^(.+)-(\d+)\.(\d+)$/;

/** macOS metadata: AppleDouble twins, Finder state, Finder's zip side folder. */
export function isMacosMetadata(entry) {
  if (entry.name === '.DS_Store') return true;
  if (entry.name === '__MACOSX') return entry.isDirectory();
  return entry.name.startsWith('._') && !entry.isDirectory();
}

/**
 * The candidate library directories directly under `dir`, sorted, so a run
 * over the same tree always reports and archives them in the same order.
 * Hidden directories are staging and bookkeeping (`.provision-tmp-…`,
 * `.bundle.json`), never libraries.
 */
export async function libraryDirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !isMacosMetadata(entry)
    )
    .map((entry) => entry.name)
    .sort();
}

/** Streams the file rather than reading it whole: a bundle is hundreds of MiB. */
export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
