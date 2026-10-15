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
import {
  checkPackageNames,
  isPlainRelativePath,
  refused,
  stagePackageContent,
  type PackageImport
} from './whole-package';

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
 * exactly as packaged (whole-package.ts) and its declared dependencies; an
 * editor save keeps the stored ones; and h5p-server's removal of files the
 * open parameters no longer reference is switched off for it. Packages
 * without `vmbExam` go through h5p-server as before.
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
  exam: PackageImport
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
  const files = await checkPackageNames(contentDirectory, exam, {
    subject: 'The exam package',
    retry: 'Rename them and publish the book again.'
  });
  const present = new Set(files);
  for (const media of examMediaPaths(parameters)) {
    if (!isPlainRelativePath(media) || !present.has(media)) {
      throw refused('The exam package is missing a file of its exam.');
    }
  }
  await stagePackageContent(contentDirectory, exam, 'h5p-exam-');
}

const libraryKey = (library: ILibraryName): string =>
  `${library.machineName} ${library.majorVersion}.${library.minorVersion}`;

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
 * merge brings two versions of one library together: `H5P.newRunnable` picks
 * a constructor by name alone, so one would silently replace the other on the
 * page. Only a conflict the merge creates counts: more versions of a
 * library in the merged tree than in the open part's tree and than in the
 * tree of what the exam adds (the declared libraries the open part does not
 * name), each on its own. Two versions within one of those are ordinary in
 * H5P (`H5P.AdvancedBlanks 1.2` and `H5P.MultiChoice 1.16` need
 * `H5P.Question` 1.4 and 1.5) and the book carried them before; refusing
 * them would refuse a book the host imports fine without `vmbExam`. What the
 * exam adds is measured without the open part's libraries: a package's
 * `h5p.json` lists the open part's tree too, so the whole declared tree
 * always holds both sides of a conflict and would let every one through.
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
  const declaredNames = declared.map((library) => ({
    machineName: library.machineName,
    majorVersion: Number(library.majorVersion),
    minorVersion: Number(library.minorVersion)
  }));
  const merged = [...metadata.preloadedDependencies];
  const known = new Set(merged.map(libraryKey));
  for (const name of declaredNames) {
    const key = libraryKey(name);
    if (known.has(key)) continue;
    known.add(key);
    merged.push(name);
  }
  const getter = new DependencyGetter(editor.libraryStorage);
  const versionsIn = async (
    roots: ILibraryName[]
  ): Promise<Map<string, Set<string>>> => {
    const tree = await getter.getDependentLibraries(roots, { preloaded: true });
    const versions = new Map<string, Set<string>>();
    for (const library of [...roots, ...tree]) {
      const seen = versions.get(library.machineName) ?? new Set<string>();
      seen.add(
        `${Number(library.majorVersion)}.${Number(library.minorVersion)}`
      );
      versions.set(library.machineName, seen);
    }
    return versions;
  };
  const open = await versionsIn(metadata.preloadedDependencies);
  const openKeys = new Set(metadata.preloadedDependencies.map(libraryKey));
  const added = await versionsIn(
    declaredNames.filter((name) => !openKeys.has(libraryKey(name)))
  );
  // The merged roots are the open part's plus what the exam adds, so the
  // merged tree is the union of the two.
  for (const [machineName, addedVersions] of added) {
    const openVersions = open.get(machineName) ?? new Set<string>();
    const all = new Set([...openVersions, ...addedVersions]);
    if (all.size > openVersions.size && all.size > addedVersions.size) {
      throw new HostError(
        `The exam needs another version of ${machineName} than the rest of ` +
          'the book. Re-publish the exam book. No changes were saved.',
        422,
        { code: 'exam-library-conflict' }
      );
    }
  }
  if (merged.length === metadata.preloadedDependencies.length) return metadata;
  const mergedMetadata = { ...metadata, preloadedDependencies: merged };
  await editor.contentStorage.addContent(mergedMetadata, params, user, id);
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
