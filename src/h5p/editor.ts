import {
  H5PEditor,
  fsImplementations,
  cacheImplementations
} from '@lumieducation/h5p-server';
import type { H5PConfig } from '@lumieducation/h5p-server';
import type {
  ILibraryStorage,
  ITranslationFunction
} from '@lumieducation/h5p-server';

import {
  transactionalContentStorage,
  transactionalTemporaryStorage
} from '../content-transactions';

import WebUrlGenerator from './url-generator';
import RestrictivePermissionSystem from './permission-system';

const { InMemoryStorage, FileLibraryStorage } = fsImplementations;
const { CachedLibraryStorage } = cacheImplementations;

/**
 * The library storage, shared by every tenant: the provisioned libraries are
 * one read-only directory, so one metadata cache serves all of them instead
 * of each tenant warming (and holding) its own copy of the same manifests.
 * Sharing is safe because nothing ever installs or updates a library at
 * runtime (see permission-system.ts), which is the only thing that would
 * invalidate the cache.
 */
export function createLibraryStorage(librariesPath: string): ILibraryStorage {
  return new CachedLibraryStorage(new FileLibraryStorage(librariesPath));
}

/**
 * Constructs a tenant-scoped H5PEditor backed by the filesystem.
 *
 * The editor runs fully offline: the in-memory key-value cache is pre-seeded
 * with an empty content-type cache and a fresh timestamp so the editor treats
 * the hub cache as up to date and never calls out to fetch content types.
 * Combined with `config.fetchingDisabled`, installing or updating libraries is
 * structurally impossible. `forceUpdate()` is intentionally not called.
 */
export default async function createH5PEditor(
  config: H5PConfig,
  libraryStorage: ILibraryStorage,
  contentPath: string,
  temporaryPath: string,
  translationCallback: ITranslationFunction,
  publicBaseUrl: string
): Promise<H5PEditor> {
  const cache = new InMemoryStorage();
  await cache.save('contentTypeCache', []);
  await cache.save('contentTypeCacheUpdate', Date.now());

  const h5pEditor = new H5PEditor(
    cache,
    config,
    libraryStorage,
    transactionalContentStorage(contentPath),
    transactionalTemporaryStorage(temporaryPath),
    translationCallback,
    new WebUrlGenerator(config, publicBaseUrl),
    // Replace the package default (LaissezFaire, which allows library
    // installation) with a policy that denies every general action, i.e.
    // installing or updating libraries. See permission-system.ts.
    { permissionSystem: new RestrictivePermissionSystem() }
  );

  // The routes consume the raw editor model (IEditorModel) as JSON rather than
  // a rendered HTML page, so the renderer is the identity function.
  h5pEditor.setRenderer((model) => model);
  return h5pEditor;
}
