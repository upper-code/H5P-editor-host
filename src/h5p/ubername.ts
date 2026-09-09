import { LibraryName } from '@lumieducation/h5p-server';
import type { IContentMetadata } from '@lumieducation/h5p-server';

/**
 * Resolves the main library of a piece of content to its "ubername" using
 * whitespace as the version separator (e.g. `H5P.InteractiveBook 1.11`), the
 * form `saveOrUpdateContent` expects for `mainLibraryUbername`.
 *
 * The main library is the preloaded dependency whose machine name matches
 * `metadata.mainLibrary`. Returns an empty string when it cannot be found.
 */
export default function getUbernameFromH5pJson(
  metadata: IContentMetadata
): string {
  const dependency = (metadata.preloadedDependencies || []).find(
    (dep) => dep.machineName === metadata.mainLibrary
  );
  return dependency
    ? LibraryName.toUberName(dependency, { useWhitespace: true })
    : '';
}
