import path from 'path';
import type {
  H5PEditor,
  IContentMetadata,
  ILibraryName
} from '@lumieducation/h5p-server';
import type PackageImporter from '@lumieducation/h5p-server/build/src/PackageImporter';

import HostError from '../errors';
import { uninstalledLibraries } from '../library-resolution';
import { isExamContent } from './exam-package';
import getUbernameFromH5pJson from './ubername';
import {
  checkPackageNames,
  isExternalReference,
  isPlainRelativePath,
  packageImport,
  refused,
  stagePackageContent,
  type PackageImport
} from './whole-package';

/**
 * A package on library versions this host does not have — a book exported
 * before the host's libraries moved on — imported on the caller's request
 * (`x-import-outdated-libraries: keep` on the import routes), so that the
 * editor can open it and offer the upgrade to the installed versions
 * (`missingLibraries` of the edit model, web/editor-host.js).
 *
 * h5p-server refuses such a package before anything else
 * (`install-missing-libraries`), and every later step of its import and save
 * needs the semantics of the versions the content names: the media check,
 * the copy of the referenced files, the generated `h5p.json`. Those are
 * exactly what is missing. With the caller's consent, and when every missing
 * version the content names (`uninstalledLibraries`) has a newer installed
 * one, the package is stored as it is instead: its `h5p.json`, its
 * `content.json`, and every `content/` file under its own name
 * (whole-package.ts), like an exam package. The editor's upgrade then works
 * on the stored parameters, and its save goes through
 * missing-library-update.ts, which also removes the files the upgraded
 * parameters no longer reference.
 *
 * Without the semantics, which fields hold files is not known: a `{ path,
 * mime }` object stands for a file here. The save after the upgrade checks
 * the media with the installed semantics (`media-missing`) all the same.
 *
 * Versions only the package's `h5p.json` declares — dependencies of the
 * versions the content names, as they were where it was exported — do not
 * count: content naming only installed versions takes h5p-server's usual
 * path, whose save recomputes the dependencies from the installed libraries.
 * Without the caller's consent nothing changes: h5p-server's refusal stands.
 */

/** The request header and value by which the caller consents. */
export const keepOutdatedHeader = 'x-import-outdated-libraries';
export const keepOutdatedValue = 'keep';

interface RequiredLibraries {
  getRequiredLibraries(metadata: IContentMetadata): ILibraryName[];
}

/**
 * Takes h5p-server's installation check of a package import over for an
 * import that keeps outdated packages: the libraries it would check are
 * recorded in the import's state, it checks none, and
 * `stageOutdatedPackage` decides once the extracted parameters can be read.
 * Every other import — without the consent, or the editor's "Upload" tab,
 * which runs outside the import route's state — is checked as before.
 *
 * `getRequiredLibraries` is private in h5p-server's types; the same 9.3.3
 * internals package-importer.ts builds on.
 */
export function deferInstallationCheck(importer: PackageImporter): void {
  const internals = importer as unknown as RequiredLibraries;
  const required = internals.getRequiredLibraries;
  internals.getRequiredLibraries = (metadata) => {
    const libraries = required.call(importer, metadata);
    const state = packageImport.getStore();
    if (!state?.keepOutdated) return libraries;
    state.declared = libraries;
    return [];
  };
}

/**
 * The outdated half of the package storer (package-importer.ts), run when
 * the caller consented, before anything reads the semantics. Answers `false`
 * when the package goes h5p-server's usual way: everything it declares is
 * installed, or the content names only installed versions. Otherwise refuses
 * a package that cannot be stored as it is, or stages its `content/` for
 * the save and answers `true`.
 */
export async function stageOutdatedPackage(
  editor: H5PEditor,
  state: PackageImport,
  metadata: IContentMetadata,
  parameters: unknown,
  contentDirectory: string
): Promise<boolean> {
  const notInstalled = await editor.libraryManager.getNotInstalledLibraries(
    state.declared ?? []
  );
  if (notInstalled.length === 0) return false;
  const missing = await uninstalledLibraries(
    editor,
    getUbernameFromH5pJson(metadata),
    parameters
  );
  if (missing.length === 0) return false;
  const names = (entries: { library: string }[]) =>
    entries.map((entry) => entry.library).join(', ');
  // The exam's ciphertext was written for these versions, and its declared
  // dependencies are kept as they are (exam-package.ts).
  if (isExamContent(parameters)) {
    throw new HostError(
      `The exam needs ${names(missing)}, which is not installed on this ` +
        'host. Re-publish the exam book. No changes were saved.',
      422,
      { code: 'exam-library-missing' }
    );
  }
  const stuck = missing.filter((entry) => !entry.upgrade);
  if (stuck.length > 0) {
    throw new HostError(
      `The package uses library versions that are not installed on this ` +
        `host and have no newer installed version: ${names(stuck)}. Export ` +
        'it for the installed libraries. No changes were saved.',
      422,
      { code: 'library-missing' }
    );
  }
  const files = await checkPackageNames(contentDirectory, state, {
    subject: 'The package',
    retry: 'Rename them and export the package again.'
  });
  checkFileReferences(parameters, new Set(files));
  await stagePackageContent(contentDirectory, state, 'h5p-outdated-');
  state.outdated = missing.map((entry) => entry.library);
  return true;
}

/**
 * Refuses references the stored package could not serve: a `#tmp` path (the
 * save after the upgrade would copy a same-named file from the tenant's
 * temporary storage instead), the content's own metadata files, and a file
 * object (`{ path, mime }`) whose file the package lacks. External
 * references are left alone, as the ordinary import leaves them
 * (`isExternalReference`). A stack of its own, as in `nestedLibraries`.
 */
function checkFileReferences(parameters: unknown, files: Set<string>): void {
  const pending = [parameters];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object') continue;
    const record = next as Record<string, unknown>;
    // Not `push(...values)`: a long array would exceed the argument limit.
    for (const child of Object.values(record)) pending.push(child);
    const file = record.path;
    if (typeof file !== 'string' || !file) continue;
    if (/#tmp$/.test(file)) {
      throw refused('The package references a temporary editor file.');
    }
    const target = path.posix.normalize(file);
    if (target === 'content.json' || target === 'h5p.json') {
      throw refused('The package references its own metadata file.');
    }
    if (
      typeof record.mime !== 'string' ||
      isExternalReference(file, record.mime)
    ) {
      continue;
    }
    if (!isPlainRelativePath(file) || !files.has(file)) {
      throw new HostError(
        `The package is missing the media file ${path.posix.basename(file)}. ` +
          'Export a complete package and retry. No changes were saved.',
        422,
        { code: 'media-missing' }
      );
    }
  }
}
