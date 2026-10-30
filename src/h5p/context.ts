import type { H5PEditor, H5PPlayer } from '@lumieducation/h5p-server';

/**
 * Per-tenant context: the H5P objects and the two directories that belong to
 * the tenant. It never leaves this service — the embedder sees the HTTP API,
 * not these objects.
 *
 * The shared library directory is deliberately not here: it belongs to the
 * deployment, not to a tenant, and `TenantManager` owns it.
 */
export interface WebContext {
  h5pEditor: H5PEditor;
  h5pPlayer: H5PPlayer;
  language_code: string;
  paths: {
    content: string;
    tmp: string;
  };
}
