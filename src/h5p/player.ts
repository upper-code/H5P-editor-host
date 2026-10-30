import { H5PPlayer } from '@lumieducation/h5p-server';
import type { H5PEditor, H5PConfig } from '@lumieducation/h5p-server';
import type { ITranslationFunction } from '@lumieducation/h5p-server';

import WebUrlGenerator from './url-generator';
import RestrictivePermissionSystem from './permission-system';

/**
 * Constructs a tenant-scoped H5PPlayer that shares the editor's library and
 * content storage (and its content-user-data storage, if any). The player uses
 * the same public-origin URL generator as the editor so rendered content
 * resolves its assets and unique content URL against the configured origin.
 */
export default function createH5PPlayer(
  h5pEditor: H5PEditor,
  config: H5PConfig,
  translationCallback: ITranslationFunction,
  publicBaseUrl: string
): H5PPlayer {
  const h5pPlayer = new H5PPlayer(
    h5pEditor.libraryStorage,
    h5pEditor.contentStorage,
    config,
    undefined,
    new WebUrlGenerator(config, publicBaseUrl),
    translationCallback,
    // Same restrictive policy as the editor (see permission-system.ts).
    { permissionSystem: new RestrictivePermissionSystem() },
    h5pEditor.contentUserDataStorage
  );

  // The render route serializes the raw player model (IPlayerModel) itself.
  h5pPlayer.setRenderer((model) => model);
  return h5pPlayer;
}
