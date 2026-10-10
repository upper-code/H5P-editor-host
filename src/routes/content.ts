import crypto from 'crypto';
import path from 'path';
import { Router, Request } from 'express';
import { ContentFileScanner, LibraryName } from '@lumieducation/h5p-server';

import { contentRevision } from '../content-transactions';
import HostError, { mapContentNotFound } from '../errors';
import { savePayload } from '../save-payload';
import { assertContentId } from '../content-id';
import { bookIdOf, withBookId } from '../book-id';
import { missingLibraries, nestedLibraries } from '../library-resolution';
import type WebUser from '../h5p/user';
import type { WebContext } from '../h5p/context';
import {
  withCoreScripts,
  withEditorStyles,
  withCoreAssetsIntegration
} from '../h5p/core-assets-hotfix';
import { withRemoteCatalogueDisabledInEditor } from '../h5p/offline-model';

interface WebRequest<P = Request['params']> extends Request<P> {
  ctx: WebContext;
  user: WebUser;
  language: string;
}

// `new` maps to an undefined content id, i.e. "create a new piece of content".
// Anything else must be a stored numeric id: these routes hand the value to H5P
// storage, which joins it onto a filesystem path (see content-id.ts). The
// literal string `undefined` is rejected by assertContentId rather than being
// silently treated as "create new".
//
// h5p-server types the id of `render` and `saveOrUpdateContentReturnMetaData`
// as a string, but both treat `undefined` as new content; the call sites cast.
function resolveContentId(raw: string): string | undefined {
  assertContentId(raw, { creatable: true });
  return raw === 'new' ? undefined : raw;
}

// Optional deployment default (`MachineName major.minor`, e.g.
// "VMB.InteractiveBook 1.6") for content created through the editor UI.
// Unset keeps h5p-server's stock behaviour: the editor model carries no
// library and the client (editor-host.js's `ns.Editor`) shows the
// content-type hub instead of going straight to a form. Read per request
// rather than cached at import so it follows the environment.
function defaultLibraryForNewContent(): string | undefined {
  const value = (process.env.EDITOR_DEFAULT_LIBRARY || '').trim();
  return value || undefined;
}

/**
 * GET /api/v1/content/:contentId/edit
 *
 * Returns the editor model. For a new item it is the bare editor model; for an
 * existing item the stored library, params and metadata are merged into the
 * model so the client can rehydrate the editor, together with the content's
 * current `revision` — what the next save presents as `If-Match` so a change
 * made in another window is refused instead of overwritten — and the
 * `missingLibraries` it names but this host does not have installed, each
 * with the installed version that can replace it (library-resolution.ts). The
 * editor page offers that upgrade instead of opening a form whose semantics
 * cannot load.
 */
export const editContent: Router = Router();

editContent.get('/api/v1/content/:contentId/edit', async (req, res, next) => {
  try {
    const webReq = req as WebRequest<{ contentId: string }>;
    const contentId = resolveContentId(req.params.contentId);
    const { h5pEditor } = webReq.ctx;

    const model = withRemoteCatalogueDisabledInEditor(
      await h5pEditor.render(contentId as string, webReq.language, webReq.user)
    );

    // h5p-server's editorAssetList.json omits core files the 1.28 core needs
    // (fonts, theme, tooltip, table; see core-assets-hotfix). The outer editor
    // chrome loads `model.scripts`/`model.styles`, but the editor renders its
    // content *preview* inside an iframe built from `integration.editor.assets`,
    // so that list has to be patched too or icons and the theme are missing
    // exactly where the author is editing.
    model.scripts = withCoreScripts(model.scripts);
    model.styles = withEditorStyles(model.styles);
    model.integration = withCoreAssetsIntegration(model.integration);

    if (!contentId) {
      const defaultLibrary = defaultLibraryForNewContent();
      res.json({
        keywords: [],
        published: false,
        h5p: defaultLibrary ? { ...model, library: defaultLibrary } : model
      });
      return;
    }

    const content = await h5pEditor.getContent(contentId, webReq.user);
    res.json({
      revision: await contentRevision(webReq.ctx.paths.content, contentId),
      missingLibraries: await missingLibraries(
        h5pEditor,
        content.library,
        content.params.params
      ),
      h5p: {
        ...model,
        library: content.library,
        metadata: content.params.metadata,
        params: content.params.params
      }
    });
  } catch (error) {
    next(mapContentNotFound(error));
  }
});

/**
 * The editor save: persists the payload `{ library, params, metadata }` — the
 * same flat body shape `POST /api/v1/generated-content` accepts — and returns
 * the saved content id and its metadata. `rawContentId` is `new` or a stored
 * numeric id, validated here.
 *
 * Every caller runs this inside a content transaction (`mutateContent` in
 * app.ts), which stages the write, measures the size delta the embedder
 * charges to its quota and only then publishes it, so a rejection here — the
 * nested-library check below included — leaves the stored content untouched.
 *
 * With `bookId` the saved `authorComments` carries a book id (book-id.ts):
 * new content gets a fresh one, and a stored book keeps its own when the
 * payload names none — the editor form holds the metadata it was opened with,
 * so the saves that follow creating a book would otherwise drop the id again.
 * A stored book that never had one is not given one here. Author comments too
 * long to hold the id as well refuse the save (`422 author-comments-too-long`).
 */
export async function saveEditorContent(
  ctx: WebContext,
  user: WebUser,
  rawContentId: string,
  body: Record<string, unknown> | undefined,
  options: { bookId?: boolean } = {}
): Promise<{ contentId: string; metadata: unknown }> {
  const contentId = resolveContentId(rawContentId);
  const payload = savePayload(body);
  if (
    options.bookId &&
    bookIdOf(payload.metadata.authorComments) === undefined
  ) {
    const id =
      contentId === undefined
        ? crypto.randomUUID()
        : bookIdOf(
            (await ctx.h5pEditor.contentStorage.getMetadata(contentId))
              .authorComments
          );
    if (id !== undefined) payload.metadata = withBookId(payload.metadata, id);
  }
  const expected = nestedLibraries(payload.params);
  let library;
  try {
    library = LibraryName.fromUberName(payload.library, {
      useWhitespace: true
    });
  } catch {
    throw new HostError('Invalid library name.', 400);
  }
  const scanner = new ContentFileScanner(ctx.h5pEditor.libraryManager);
  // H5P mutates params and swallows missing-file/copy errors, replacing the
  // reference with an empty path. Snapshot the semantic file locations first
  // so that such a partial save is rejected by the enclosing transaction.
  const expectedFiles = await scanner.scanForFiles(
    structuredClone(payload.params),
    library
  );
  const result = await ctx.h5pEditor.saveOrUpdateContentReturnMetaData(
    contentId as string,
    payload.params,
    payload.metadata as never,
    payload.library,
    user
  );
  // H5P filters out sub-content whose library the container's semantics do not
  // allow, silently and after the write. Comparing what went in with what came
  // back turns that into a refusal the author can act on; the transaction
  // discards the staged write, so nothing was saved.
  const storedParams = await ctx.h5pEditor.contentStorage.getParameters(
    String(result.id)
  );
  const actual = nestedLibraries(storedParams);
  for (const [library, count] of expected) {
    if ((actual.get(library) || 0) < count) {
      throw new HostError(
        `The selected container does not support ${library}. No changes were saved.`,
        422
      );
    }
  }
  const storedFiles = new Map(
    (await scanner.scanForFiles(storedParams, library)).map((file) => [
      file.context.jsonPath,
      file
    ])
  );
  for (const expectedFile of expectedFiles) {
    const file = storedFiles.get(expectedFile.context.jsonPath);
    if (
      !file ||
      !(await ctx.h5pEditor.contentStorage.fileExists(
        String(result.id),
        file.filePath
      ))
    ) {
      // Named, so the author knows which file to upload again; the name is
      // the one the file was uploaded under, plus a random suffix.
      throw new HostError(
        `The media file ${path.posix.basename(expectedFile.filePath)} is ` +
          'missing or could not be saved. Upload it again and retry. No ' +
          'changes were saved.',
        422,
        { code: 'media-missing' }
      );
    }
  }
  return { contentId: String(result.id), metadata: result.metadata };
}
