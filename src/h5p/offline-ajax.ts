import type { Request, RequestHandler } from 'express';
import type { H5PEditor, IUser } from '@lumieducation/h5p-server';

import HostError from '../errors';
import type { WebContext } from './context';

/**
 * The two rules the offline policy (offline-model.ts) needs at the editor's
 * AJAX endpoint, applied before the third-party router: refuse the actions
 * that would reach the remote catalogue, and answer the library list the
 * editor core asks for once that catalogue is switched off.
 */

interface AjaxRequest extends Request {
  ctx: WebContext;
  user: IUser;
  language: string;
}

/**
 * The `action` of a request to the AJAX endpoint, or undefined for any other
 * request. h5p-express dispatches on the exact string, so an array or a
 * differently-cased action reaches no handler there either; lower-casing here
 * only makes the guard err on the side of refusing.
 */
function ajaxAction(req: Request): string | undefined {
  if (!/^\/ajax\/?$/i.test(req.path)) {
    return undefined;
  }
  const { action } = req.query;
  return typeof action === 'string' ? action.toLowerCase() : undefined;
}

/**
 * The only AJAX actions in the bundled adapter that contact the remote
 * catalogue directly: `get-content` downloads a package before any permission
 * check, the other two serve the catalogue client. Refusing them here means a
 * crafted request cannot bypass the offline UI.
 */
const REMOTE_CATALOGUE_ACTIONS = new Set([
  'content-hub-metadata-cache',
  'library-install',
  'get-content'
]);

export function rejectRemoteCatalogueActions(): RequestHandler {
  return (req, res, next) => {
    const action = ajaxAction(req);
    if (action !== undefined && REMOTE_CATALOGUE_ACTIONS.has(action)) {
      next(new HostError('External content catalogue is disabled.', 404));
      return;
    }
    next();
  };
}

/** A library as `getContentTypeCache` lists it; the type is not exported. */
type ListedLibrary = Awaited<
  ReturnType<H5PEditor['getContentTypeCache']>
>['libraries'][number];

/** One entry of the list `h5peditor-selector-legacy.js` builds its menu from. */
export interface SelectableLibrary {
  name: string;
  majorVersion: number;
  minorVersion: number;
  title: string;
  restricted: boolean;
  uberName: string;
}

/**
 * The content types an author may start from: the newest runnable version of
 * each provisioned library, restricted ones marked as such — the same set the
 * catalogue client was shown until now, in the flat shape the legacy selector
 * reads. Titles come from `getLibraryOverview`, the source of the sub-content
 * lists too. No tutorial or example links: the selector hides them when the
 * fields are absent.
 *
 * `getContentTypeCache` never contacts the catalogue here: the cache is
 * pre-seeded and never refreshed (editor.ts), so all it adds is the local
 * libraries, with the restriction rule applied.
 */
export async function listSelectableLibraries(
  h5pEditor: H5PEditor,
  user: IUser,
  language: string
): Promise<SelectableLibrary[]> {
  const { libraries } = await h5pEditor.getContentTypeCache(user, language);
  const installed = libraries.filter((library) => library.installed);
  const uberName = (library: ListedLibrary): string =>
    `${library.machineName} ${library.localMajorVersion}.${library.localMinorVersion}`;
  const restricted = new Set(
    installed.filter((library) => library.restricted).map(uberName)
  );
  const overview = await h5pEditor.getLibraryOverview(
    installed.map(uberName),
    language
  );
  return overview
    .filter((library) => library.runnable)
    .map((library) => ({
      name: library.name,
      majorVersion: library.majorVersion,
      minorVersion: library.minorVersion,
      title: library.title,
      restricted: restricted.has(library.uberName),
      uberName: library.uberName
    }));
}

/**
 * With `hubIsEnabled` off, the editor core loads its library menu from
 * `GET /ajax?action=libraries` with no library named
 * (h5peditor-editor.js). h5p-server 9.3.3 implements that action only for one
 * named library and answers 400 otherwise, so the list is served here. A
 * request that does name a library is the per-library lookup and passes on.
 */
export function legacyLibraryList(): RequestHandler {
  return async (req, res, next) => {
    if (
      req.method !== 'GET' ||
      ajaxAction(req) !== 'libraries' ||
      req.query.machineName !== undefined
    ) {
      next();
      return;
    }
    try {
      const { ctx, user, language } = req as AjaxRequest;
      res.json(await listSelectableLibraries(ctx.h5pEditor, user, language));
    } catch (error) {
      next(error);
    }
  };
}
