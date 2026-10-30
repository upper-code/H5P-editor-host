/*
 * What "a provisioned H5P library directory" means, in one place.
 *
 * Three things have to agree on it: provisioning (scripts/provision-libraries.mjs)
 * installs them, bundling (scripts/bundle-libraries.mjs) archives them, and the
 * host's readiness probe (src/tenant-manager.ts, isLibraryDirectory) counts
 * them. When these drifted apart, a bundle could contain what a deployment
 * would not count.
 *
 * It also reads the library fields of a library's semantics, which a
 * replacement copy must not narrow (`droppedLibraryOptions`).
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

/**
 * The accepted versions of every `type: "library"` field in a library's
 * semantics, keyed by the field's path (`chapters[]/chapter`). An option is a
 * `Name major.minor` string or an object with that `name`.
 *
 * The path records where the field's value is stored, not only the names: a
 * list adds `[]`, and a group of one field that is not `isSubContent` — which
 * holds that field's value directly instead of under its name — adds `=`. A
 * patch that changes the storage (a second field in such a group, a group
 * turned into a list) leaves stored values where the editor no longer looks,
 * so it shows up as the old field gone.
 *
 * The walk follows `fields` and `field` only, as the H5P editor and its
 * content upgrade do. The host reads the same options per field
 * (src/library-resolution.ts): the editor offers exactly these versions in a
 * field and clears a stored library that is not among them.
 */
export function libraryFieldOptions(semantics) {
  const result = new Map();
  const pending = Array.isArray(semantics)
    ? semantics.map((field) => ({ field, path: [] }))
    : [];
  while (pending.length) {
    const { field, path } = pending.pop();
    if (!field || typeof field !== 'object') continue;
    const name = typeof field.name === 'string' ? field.name : '?';
    if (field.type === 'library') {
      const key = [...path, name].join('/');
      const options = result.get(key) || new Set();
      for (const option of Array.isArray(field.options) ? field.options : []) {
        const value = typeof option === 'string' ? option : option?.name;
        if (typeof value === 'string' && value.trim()) {
          options.add(value.trim());
        }
      }
      result.set(key, options);
    } else if (field.type === 'list') {
      pending.push({ field: field.field, path: [...path, `${name}[]`] });
    } else if (field.type === 'group' && Array.isArray(field.fields)) {
      const direct = field.fields.length === 1 && field.isSubContent !== true;
      const group = [...path, direct ? `${name}=` : name];
      for (const child of field.fields) {
        pending.push({ field: child, path: group });
      }
    }
  }
  return result;
}

/**
 * What a replacement copy of a library takes away from its library fields:
 * every option of `before` that `after` no longer lists in the same field —
 * dropped, or replaced by another version of the same library (`now`). A
 * field missing from `after` loses all of its options (`removed`). Options
 * `after` adds are not reported: accepting more breaks no stored content.
 */
export function droppedLibraryOptions(before, after) {
  const dropped = [];
  const afterOptions = libraryFieldOptions(after);
  for (const [field, options] of libraryFieldOptions(before)) {
    const kept = afterOptions.get(field);
    for (const option of options) {
      if (kept?.has(option)) continue;
      const machineName = option.split(' ')[0];
      dropped.push({
        field,
        option,
        removed: !kept,
        now: kept
          ? [...kept].filter((other) => other.split(' ')[0] === machineName)
          : []
      });
    }
  }
  return dropped;
}
