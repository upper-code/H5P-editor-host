import path from 'path';
import type { ContentId, H5PEditor, IUser } from '@lumieducation/h5p-server';

/**
 * The h5p-server error ids for a library version that is not installed, as
 * the semantic scan of stored parameters meets it: its `semantics.json` (or
 * the library itself) cannot be read.
 */
const MISSING_LIBRARY_ERRORS = new Set([
  'library-file-missing',
  'library-not-found'
]);

interface OldFilesLister {
  getFilesInParams(contentId: ContentId, user: IUser): Promise<string[]>;
}

/**
 * Lets stored content that names a library version this host does not have
 * be replaced at all — by an editor save of its upgraded parameters (the
 * editor page's "Upgrade to the installed version") or by a version import
 * over its id.
 *
 * On every update h5p-server first lists the files the *stored* parameters
 * reference (`ContentStorer.getFilesInParams`), scanning them with the stored
 * libraries' semantics: that list decides which files the new parameters
 * reference are already in the content directory (rather than in temporary
 * storage) and which old files the new parameters no longer use (deleted).
 * With a stored library version missing the scan throws, and so does every
 * update of the content. In that case only, the files actually stored with
 * the content stand in for the list: each one the new parameters reference
 * stays in place, the rest are removed as unreferenced old files.
 *
 * `contentStorer` and `getFilesInParams` are private in h5p-server's types;
 * the same 9.3.3 internals package-importer.ts builds on.
 */
export default function tolerateMissingStoredLibraries(
  editor: H5PEditor
): void {
  const storer = (editor as unknown as { contentStorer: OldFilesLister })
    .contentStorer;
  const scanStoredParams = storer.getFilesInParams.bind(storer);
  storer.getFilesInParams = async (contentId, user) => {
    try {
      return await scanStoredParams(contentId, user);
    } catch (error) {
      const errorId = (error as { errorId?: unknown } | null)?.errorId;
      if (typeof errorId !== 'string' || !MISSING_LIBRARY_ERRORS.has(errorId)) {
        throw error;
      }
      // The scan's paths are the parameters' own (`images/x.png`); the
      // listing's are the file system's, so they are made to match on
      // every platform.
      return (await editor.contentStorage.listFiles(contentId, user)).map(
        (file) => file.split(path.sep).join('/')
      );
    }
  };
}
