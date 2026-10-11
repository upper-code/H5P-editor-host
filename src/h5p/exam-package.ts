import { AsyncLocalStorage } from 'async_hooks';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { LibraryName } from '@lumieducation/h5p-server';
import type {
  ContentId,
  H5PEditor,
  IContentMetadata,
  ILibraryName,
  IUser
} from '@lumieducation/h5p-server';
import DependencyGetter from '@lumieducation/h5p-server/build/src/DependencyGetter';

import HostError from '../errors';
import { isInsideDirectory } from '../content-id';

/**
 * A book published with an encrypted exam (a root `vmbExam` in its
 * parameters, a placeholder chapter in place of the exam) is stored whole.
 *
 * h5p-server keeps only what the open parameters reference: an import copies
 * just those files, under fresh names, and every save recomputes
 * `preloadedDependencies` from the open parameters alone. The exam chapter is
 * ciphertext the host cannot read, so the media and libraries only it uses
 * were dropped, and the shared media it names were renamed under it — the
 * chapter the framing parent later decrypts and injects (web/player-bridge.js)
 * rendered with broken images and without its libraries' scripts.
 *
 * For such a package the import route (src/app.ts) keeps its `content/`
 * exactly as packaged and its declared dependencies; an editor save keeps the
 * stored ones; and h5p-server's removal of files the open parameters no
 * longer reference is switched off for it. Packages without `vmbExam` go
 * through h5p-server as before.
 */

/** Whether `params` carries an encrypted exam. The one test of exam mode. */
export function isExamContent(params: unknown): boolean {
  const exam = plainObject(params)?.vmbExam;
  return typeof plainObject(exam)?.data === 'string';
}

/** The `path` strings of `vmbExam.media`, as written, for an exam. */
export function examMediaPaths(params: unknown): string[] {
  if (!isExamContent(params)) return [];
  const media = (params as { vmbExam: { media?: unknown } }).vmbExam.media;
  if (!Array.isArray(media)) return [];
  return media
    .map((entry) => plainObject(entry)?.path)
    .filter((entry): entry is string => typeof entry === 'string');
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The state of one package import, set by the import route around its
 * `uploadPackage` call only. The editor's own "Upload" tab goes through the
 * same `uploadPackage` without it and keeps h5p-server's behaviour: the
 * editor form it fills needs `#tmp` paths.
 */
export interface ExamImport {
  /**
   * The staged copy of an exam package's `content/`, once there is one. The
   * route removes it after the save, whatever happened.
   */
  content?: string;
  /**
   * The archive's `content/` entries h5p-server will not extract (see
   * `hiddenContentEntries`), relative to `content/`; `null` when the archive
   * could not be listed.
   */
  hidden: string[] | null;
}

export const examImport = new AsyncLocalStorage<ExamImport>();

/**
 * The `content/` files of an archive that h5p-server leaves out: it extracts
 * no entry whose name starts with `.` or `_`, and its package validator does
 * not even look at them, so they are gone before anything else sees the
 * extracted package. Only the encrypted chapter could reference such a file,
 * and it would vanish silently, so an exam package with any of them is
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
async function packageFiles(directory: string): Promise<string[]> {
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
 * the ciphertext would then name a file the package no longer has.
 */
const maxPathLength = 255;

/** A plain relative POSIX path: no root, no `.`/`..`/empty segments. */
function isPlainRelativePath(name: string): boolean {
  return (
    name !== '' &&
    !name.includes('\\') &&
    name
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function refused(message: string): HostError {
  return new HostError(`${message} No changes were saved.`, 400);
}

/**
 * The exam-mode half of the package storer (package-importer.ts), run after
 * its media check: refuses what cannot be kept under its own name, then moves
 * the extracted `content/` aside for the save, before h5p-server deletes its
 * extraction directory. The messages name no paths (a 4xx message reaches the
 * caller verbatim).
 */
export async function stageExamPackage(
  contentDirectory: string,
  parameters: unknown,
  references: { filePath: string; temporary?: boolean }[],
  exam: ExamImport
): Promise<void> {
  for (const reference of references) {
    // A `#tmp` reference would make the save copy a same-named file from the
    // tenant's temporary storage instead of the package's own.
    if (reference.temporary) {
      throw refused('The exam package references a temporary editor file.');
    }
    const target = path.posix.normalize(reference.filePath);
    if (target === 'content.json' || target === 'h5p.json') {
      throw refused('The exam package references its own metadata file.');
    }
  }
  if (exam.hidden === null) {
    throw refused('The exam package could not be read.');
  }
  if (exam.hidden.length > 0) {
    throw refused(
      'The exam package contains files whose names start with "." or "_", ' +
        'which cannot be imported. Rename them and publish the book again.'
    );
  }
  const files = await packageFiles(contentDirectory);
  for (const file of files) {
    if (file.length >= maxPathLength) {
      throw refused('The exam package contains a file path that is too long.');
    }
    if (unsafeInUrl.test(file)) {
      throw refused(
        'The exam package contains a file name with "#", "?", "%" or a ' +
          'control character.'
      );
    }
  }
  const present = new Set(files);
  for (const media of examMediaPaths(parameters)) {
    if (!isPlainRelativePath(media) || !present.has(media)) {
      throw refused('The exam package is missing a file of its exam.');
    }
  }
  // Recorded before the move, so the route removes it even if the move fails
  // half-way.
  exam.content = await fs.mkdtemp(path.join(os.tmpdir(), 'h5p-exam-'));
  try {
    await fs.rename(contentDirectory, exam.content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.cp(contentDirectory, exam.content, { recursive: true });
  }
}

const libraryKey = (library: ILibraryName): string =>
  `${library.machineName} ${library.majorVersion}.${library.minorVersion}`;

/**
 * Writes an exam package's staged `content/` (`directory`) into content `id`
 * under the package's own names. With `replace` — a new version over stored
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
  }
  for (const file of files) {
    if (!isInsideDirectory(directory, file)) {
      throw new HostError('Invalid file name.', 400);
    }
    await storage.addFile(
      id,
      file,
      fsSync.createReadStream(path.join(directory, ...file.split('/'))),
      user
    );
  }
}

/** `a/b/c.png` → `['a', 'a/b']`. */
function parentDirectories(file: string): string[] {
  const segments = file.split('/');
  return segments
    .slice(0, -1)
    .map((_segment, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * Keeps the libraries an exam needs in the saved `preloadedDependencies`.
 *
 * h5p-server recomputes the list from the open parameters, which do not show
 * what the encrypted chapter uses; `declared` is what the publisher declared
 * (an import: the package's `h5p.json`; an editor save: what was stored).
 * The player loads scripts by exactly this list.
 *
 * Refuses (`422`, re-publish the book) when any library in the declared tree
 * is not installed or cannot be read — h5p-server's dependency walk would
 * skip it silently, and the ciphertext was written for it — and when the
 * merged tree holds two versions of one library: `H5P.newRunnable` picks a
 * constructor by name alone, so one would silently replace the other on the
 * page.
 *
 * Returns `metadata` with the merged list, rewriting the stored `h5p.json`
 * when the merge added anything; `metadata` itself when it did not.
 */
export async function keepDeclaredDependencies(
  editor: H5PEditor,
  id: ContentId,
  declared: ILibraryName[],
  metadata: IContentMetadata,
  params: unknown,
  user: IUser
): Promise<IContentMetadata> {
  await assertInstalledTree(editor, declared);
  const merged = [...metadata.preloadedDependencies];
  const known = new Set(merged.map(libraryKey));
  for (const library of declared) {
    const name = {
      machineName: library.machineName,
      majorVersion: Number(library.majorVersion),
      minorVersion: Number(library.minorVersion)
    };
    if (known.has(libraryKey(name))) continue;
    known.add(libraryKey(name));
    merged.push(name);
  }
  const tree = await new DependencyGetter(
    editor.libraryStorage
  ).getDependentLibraries(merged, { preloaded: true });
  const versions = new Map<string, Set<string>>();
  for (const library of [...merged, ...tree]) {
    const seen = versions.get(library.machineName) ?? new Set<string>();
    seen.add(`${library.majorVersion}.${library.minorVersion}`);
    versions.set(library.machineName, seen);
    if (seen.size > 1) {
      throw new HostError(
        `The exam and the rest of the book need different versions of ` +
          `${library.machineName}. Re-publish the exam book. No changes ` +
          'were saved.',
        422,
        { code: 'exam-library-conflict' }
      );
    }
  }
  if (merged.length === metadata.preloadedDependencies.length) return metadata;
  const mergedMetadata = { ...metadata, preloadedDependencies: merged };
  await editor.contentStorage.addContent(
    mergedMetadata,
    params as never,
    user,
    id
  );
  return mergedMetadata;
}

/** Reads every library of the tree under `roots`, refusing at the first miss. */
async function assertInstalledTree(
  editor: H5PEditor,
  roots: ILibraryName[]
): Promise<void> {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const library = pending.pop()!;
    const key = libraryKey(library);
    if (seen.has(key)) continue;
    seen.add(key);
    let installed;
    try {
      installed = await editor.libraryStorage.getLibrary(
        new LibraryName(
          library.machineName,
          Number(library.majorVersion),
          Number(library.minorVersion)
        )
      );
    } catch {
      throw new HostError(
        `The exam needs ${key}, which is not installed on this host. ` +
          'Re-publish the exam book. No changes were saved.',
        422,
        { code: 'exam-library-missing' }
      );
    }
    pending.push(...(installed.preloadedDependencies ?? []));
  }
}

interface OldFilesRemover {
  deleteUnusedOldFiles(
    contentId: ContentId,
    oldFiles: string[],
    newFiles: string[]
  ): Promise<void>;
}

/**
 * Stops h5p-server removing "unused" files of exam content on update. It
 * deletes what the old open parameters referenced and the new ones do not,
 * but a file the open part stops naming may still be the encrypted chapter's
 * (and with a stored library missing, missing-library-update.ts makes every
 * file a candidate). Only an exam package import removes such files
 * (`storePackageContent`). Judged by the parameters just written.
 *
 * `getFilesInParams` is left alone: the save also uses it to tell which
 * `#tmp` references are already stored. `contentStorer` and
 * `deleteUnusedOldFiles` are private in h5p-server's types; the same 9.3.3
 * internals package-importer.ts builds on.
 */
export function keepExamFilesOnUpdate(editor: H5PEditor): void {
  const storer = (editor as unknown as { contentStorer: OldFilesRemover })
    .contentStorer;
  const deleteUnusedOldFiles = storer.deleteUnusedOldFiles.bind(storer);
  storer.deleteUnusedOldFiles = async (contentId, oldFiles, newFiles) => {
    if (isExamContent(await editor.contentStorage.getParameters(contentId))) {
      return;
    }
    await deleteUnusedOldFiles(contentId, oldFiles, newFiles);
  };
}
