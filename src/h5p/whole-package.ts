import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ContentId, H5PEditor, IUser } from '@lumieducation/h5p-server';
import type { ILibraryName } from '@lumieducation/h5p-server';

import HostError from '../errors';
import { isInsideDirectory } from '../content-id';

/**
 * A package import that keeps the package's `content/` whole: every file
 * under the package's own name, instead of h5p-server's copy of only the
 * files the parameters reference, under fresh names. Two kinds of package
 * take this path, each because the host cannot see what the parameters
 * reference:
 *
 * - an exam package (exam-package.ts): the encrypted chapter is ciphertext;
 * - a package on library versions this host does not have, imported on the
 *   caller's request (outdated-package.ts): the semantics that say which
 *   fields are files are not installed.
 *
 * This module holds what both share: the import's state, the archive's
 * hidden entries, the checks of the names kept, the move of the extracted
 * `content/` aside, and its write into the content.
 */

/**
 * The state of one package import, set by the import route around its
 * `uploadPackage` call only. The editor's own "Upload" tab goes through the
 * same `uploadPackage` without it and keeps h5p-server's behaviour: the
 * editor form it fills needs `#tmp` paths.
 */
export interface PackageImport {
  /**
   * The private directory a package's `content/` is staged in, once there is
   * one. The route removes it after the save, whatever happened.
   */
  staging?: string;
  /** The staged `content/` (inside `staging`), once it is complete. */
  content?: string;
  /**
   * The archive's `content/` entries h5p-server will not extract (see
   * `hiddenContentEntries`), relative to `content/`; `null` when the archive
   * could not be listed.
   */
  hidden: string[] | null;
  /**
   * Whether the caller asked to keep a package on library versions that are
   * not installed (`x-import-outdated-libraries: keep`).
   */
  keepOutdated?: boolean;
  /**
   * With `keepOutdated`: every library the package's `h5p.json` declares,
   * taken from h5p-server's installation check, which then checks nothing
   * (outdated-package.ts).
   */
  declared?: ILibraryName[];
  /**
   * The versions the content names that are not installed, once the package
   * has been staged to be stored as it is (outdated-package.ts).
   */
  outdated?: string[];
}

export const packageImport = new AsyncLocalStorage<PackageImport>();

/**
 * The `content/` files of an archive that h5p-server leaves out: it extracts
 * no entry whose name starts with `.` or `_`, and its package validator does
 * not even look at them, so they are gone before anything else sees the
 * extracted package. A package kept whole may reference such a file where the
 * host cannot see it, and it would vanish silently, so such a package is
 * refused. `.DS_Store` is Finder litter nobody references.
 *
 * Reads the central directory only, through the zip reader h5p-server itself
 * uses (patched in src/zip-stream-patch.ts), without extracting anything.
 */
export async function hiddenContentEntries(
  archive: string | Buffer
): Promise<string[] | null> {
  const h5pServer = path.dirname(
    require.resolve('@lumieducation/h5p-server/package.json')
  );
  const yauzl = require(
    path.dirname(
      require.resolve('yauzl-promise/package.json', { paths: [h5pServer] })
    )
  );
  let zip;
  try {
    zip =
      typeof archive === 'string'
        ? await yauzl.open(archive)
        : await yauzl.fromBuffer(archive);
  } catch {
    // The import itself reports an unreadable archive; this only says that
    // nothing is known about its hidden entries.
    return null;
  }
  const hidden: string[] = [];
  try {
    await zip.walkEntries((entry: { fileName: string }) => {
      const name = entry.fileName;
      if (!name.startsWith('content/') || name.endsWith('/')) return;
      const basename = path.posix.basename(name);
      if (
        basename !== '.DS_Store' &&
        (basename.startsWith('.') || basename.startsWith('_'))
      ) {
        hidden.push(name.slice('content/'.length));
      }
    });
    return hidden;
  } catch {
    return null;
  } finally {
    await zip.close().catch(() => {});
  }
}

/**
 * Every regular file under `directory`, as a POSIX path relative to it,
 * except the root `content.json` and `h5p.json` — the stored content's own
 * parameters and metadata, which the save writes. Anything that is neither a
 * file nor a directory is skipped; the package extraction makes none.
 */
export async function packageFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(path.join(directory, relative), {
      withFileTypes: true
    });
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (
        entry.isFile() &&
        name !== 'content.json' &&
        name !== 'h5p.json'
      ) {
        files.push(name);
      }
    }
  };
  await walk('');
  return files.sort();
}

/**
 * A name `H5P.getPath` can join onto the content URL as is. It does not
 * encode the path: a browser cuts it at `#` or `?`, `%` starts an escape, and
 * the URL parser drops tabs and newlines (`images/a\nb.png` loads
 * `images/ab.png`). Kept unrenamed, a file must be reachable by its name.
 */
const unsafeInUrl = /[#?%\u0000-\u001f\u007f]/;

/**
 * h5p-server's export shortens a referenced path of this length or more, and
 * the parameters would then name a file the package no longer has.
 */
const maxPathLength = 255;

/** A plain relative POSIX path: no root, no `.`/`..`/empty segments. */
export function isPlainRelativePath(name: string): boolean {
  return (
    name !== '' &&
    !name.includes('\\') &&
    name
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/** A `400` that says nothing was saved. Messages name no paths. */
export function refused(message: string): HostError {
  return new HostError(`${message} No changes were saved.`, 400);
}

/**
 * Refuses an extracted `content/` whose files cannot all be kept under their
 * own names — a hidden entry h5p-server did not extract, a path too long or
 * not reachable by its name — and returns its files (`packageFiles`).
 * `subject` starts each message ("The exam package"), `retry` ends the one
 * about hidden entries.
 */
export async function checkPackageNames(
  contentDirectory: string,
  state: PackageImport,
  { subject, retry }: { subject: string; retry: string }
): Promise<string[]> {
  if (state.hidden === null) {
    throw refused(`${subject} could not be read.`);
  }
  if (state.hidden.length > 0) {
    throw refused(
      `${subject} contains files whose names start with "." or "_", ` +
        `which cannot be imported. ${retry}`
    );
  }
  const files = await packageFiles(contentDirectory);
  for (const file of files) {
    if (file.length >= maxPathLength) {
      throw refused(`${subject} contains a file path that is too long.`);
    }
    if (unsafeInUrl.test(file)) {
      throw refused(
        `${subject} contains a file name with "#", "?", "%" or a ` +
          'control character.'
      );
    }
  }
  return files;
}

/**
 * Moves the extracted `content/` aside for the save, before h5p-server
 * deletes its extraction directory, into a private directory named
 * `<prefix>…` in the system's temporary directory; records both in `state`.
 */
export async function stagePackageContent(
  contentDirectory: string,
  state: PackageImport,
  prefix: string
): Promise<void> {
  // Recorded before the move, so the route removes it even if the move fails
  // half-way. The package goes one level down: `mkdtemp` makes the directory
  // private (0700), while the extracted tree keeps the permissions it was
  // unpacked with — moved in place of the private directory, it would sit
  // readable in the shared temporary directory.
  state.staging = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const staged = path.join(state.staging, 'content');
  try {
    await fs.rename(contentDirectory, staged);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.cp(contentDirectory, staged, { recursive: true });
  }
  state.content = staged;
}

/**
 * Writes a package's staged `content/` (`directory`) into content `id` under
 * the package's own names. With `replace` — a new version over stored
 * content — the stored files the package does not have go first, and with
 * them every directory no package file lives in, so a name can change from a
 * file to a directory and back. Runs inside the save's content transaction:
 * every write lands in its stage.
 */
export async function storePackageContent(
  editor: H5PEditor,
  id: ContentId,
  directory: string,
  user: IUser,
  { replace }: { replace: boolean }
): Promise<void> {
  const storage = editor.contentStorage;
  const files = await packageFiles(directory);
  if (replace) {
    const kept = new Set(files);
    const keptDirectories = new Set(files.flatMap(parentDirectories));
    const stored = (await storage.listFiles(id, user)).map((file) =>
      file.split(path.sep).join('/')
    );
    const removed = stored.filter((file) => !kept.has(file));
    for (const file of removed) await storage.deleteFile(id, file);
    // The outermost directories that held only removed files; deleteFile
    // removes a directory with whatever is left in it, which is nothing.
    const emptied = [...new Set(removed.flatMap(parentDirectories))].filter(
      (dir) => !keptDirectories.has(dir)
    );
    for (const dir of emptied) {
      if (!emptied.some((other) => dir.startsWith(`${other}/`))) {
        await storage.deleteFile(id, dir);
      }
    }
    // A directory an earlier save left empty (h5p-server removes files, not
    // the directories they were in) where the package has a file. The
    // listing holds files only, so it is not among `stored`; `fileExists`
    // tests the path, whatever is there.
    const storedFiles = new Set(stored);
    for (const file of files) {
      if (!storedFiles.has(file) && (await storage.fileExists(id, file))) {
        await storage.deleteFile(id, file);
      }
    }
  }
  for (const file of files) {
    if (!isInsideDirectory(directory, file)) {
      throw new HostError('Invalid file name.', 400);
    }
    // Opened here rather than by a lazy read stream: a write refused before
    // it read would leave that stream's descriptor open, and a stream still
    // opening when the route removes the staged tree fails with nobody
    // listening.
    const handle = await fs.open(path.join(directory, ...file.split('/')));
    try {
      await storage.addFile(id, file, handle.createReadStream(), user);
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

/** `a/b/c.png` → `['a', 'a/b']`. */
function parentDirectories(file: string): string[] {
  const segments = file.split('/');
  return segments
    .slice(0, -1)
    .map((_segment, index) => segments.slice(0, index + 1).join('/'));
}
