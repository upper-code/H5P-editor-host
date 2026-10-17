import crypto from 'crypto';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { Router, Request } from 'express';
import { ContentFileScanner, LibraryName } from '@lumieducation/h5p-server';
import type { IContentMetadata, ILibraryName } from '@lumieducation/h5p-server';

import { contentRevision } from '../content-transactions';
import HostError, { mapContentNotFound } from '../errors';
import { savePayload } from '../save-payload';
import { assertContentId } from '../content-id';
import { bookIdOf, withBookId } from '../book-id';
import {
  availableUpgrade,
  missingLibraries,
  nestedLibraries
} from '../library-resolution';
import type WebUser from '../h5p/user';
import type { WebContext } from '../h5p/context';
import {
  withCoreScripts,
  withEditorStyles,
  withCoreAssetsIntegration
} from '../h5p/core-assets-hotfix';
import { withRemoteCatalogueDisabledInEditor } from '../h5p/offline-model';
import {
  examMediaPaths,
  isExamContent,
  keepDeclaredDependencies
} from '../h5p/exam-package';
import { storePackageContent } from '../h5p/whole-package';

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
 * `missingLibraries` it names but this host does not have installed — or has,
 * nested where the installed container no longer accepts them — each with the
 * installed version that can replace it (library-resolution.ts). The editor
 * page offers that upgrade instead of opening a form whose semantics cannot
 * load, or that would clear the unaccepted parts of the content. Content
 * the editor opens as it is carries `availableUpgrade` — `{ library,
 * upgrade }` when a newer version of its main library is installed, `null`
 * otherwise — which the page offers as an optional upgrade.
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
    const missing = await missingLibraries(
      h5pEditor,
      content.library,
      content.params.params
    );
    res.json({
      revision: await contentRevision(webReq.ctx.paths.content, contentId),
      missingLibraries: missing,
      // Offered only for content the editor opens as it is: blocked content
      // gets the upgrade dialog for `missingLibraries` instead.
      availableUpgrade: missing.length
        ? null
        : await availableUpgrade(
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
 * a stored book keeps its own when the payload names none — the editor form
 * holds the metadata it was opened with, so the saves that follow creating a
 * book would otherwise drop the id again — and new content, or a stored book
 * that never had one (stored before ids were given out, or imported from a
 * package without one), gets a fresh one. The id is drawn inside the
 * content transaction, so a replay of the same operation answers with the
 * recorded result instead of drawing another. Author comments too long to
 * hold the id as well refuse the save (`422 author-comments-too-long`).
 *
 * Content with an encrypted exam (exam-package.ts) keeps what only the exam
 * uses. A package import passes the staged package `content/` as
 * `packageContent`, stored under its own names (replacing the stored files
 * on an update), and the package's `preloadedDependencies` as
 * `declaredDependencies`; an editor save of exam content keeps the stored
 * dependencies. Either way the answer carries the merged metadata. Any
 * other save may not bring a `vmbExam` of its own (`422
 * exam-import-required`), and every save of exam content checks that the
 * files of `vmbExam.media` are stored (`422 exam-media-missing` for an
 * editor save).
 */
export async function saveEditorContent(
  ctx: WebContext,
  user: WebUser,
  rawContentId: string,
  body: Record<string, unknown> | undefined,
  options: {
    bookId?: boolean;
    packageContent?: string;
    declaredDependencies?: ILibraryName[];
  } = {}
): Promise<{ contentId: string; metadata: unknown }> {
  const contentId = resolveContentId(rawContentId);
  const payload = savePayload(body);
  // An exam arrives with its files only through the import routes. The
  // editor's "Upload" tab copies just what the open part references, and a
  // new publication may reuse the old file names with new ciphertext, so
  // whether the files exist cannot tell: any other save must carry the
  // stored `vmbExam` unchanged (the editor form reuses what it loaded).
  if (!options.packageContent && isExamContent(payload.params)) {
    const stored =
      contentId === undefined
        ? undefined
        : await ctx.h5pEditor.contentStorage.getParameters(contentId);
    if (
      !isExamContent(stored) ||
      !isDeepStrictEqual(
        (stored as { vmbExam: unknown }).vmbExam,
        (payload.params as { vmbExam: unknown }).vmbExam
      )
    ) {
      throw new HostError(
        'An exam book must be imported through the import route, not ' +
          'saved from the editor or its Upload tab. No changes were saved.',
        422,
        { code: 'exam-import-required' }
      );
    }
  }
  if (
    options.bookId &&
    bookIdOf(payload.metadata.authorComments) === undefined
  ) {
    const storedId =
      contentId === undefined
        ? undefined
        : bookIdOf(
            (await ctx.h5pEditor.contentStorage.getMetadata(contentId))
              .authorComments
          );
    payload.metadata = withBookId(
      payload.metadata,
      storedId ?? crypto.randomUUID()
    );
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
  // Read before the write replaces them: the libraries the stored exam was
  // saved with, which the recomputed list would drop.
  const declared =
    options.declaredDependencies ??
    (contentId !== undefined && isExamContent(payload.params)
      ? (await ctx.h5pEditor.contentStorage.getMetadata(contentId))
          .preloadedDependencies
      : undefined);
  const result = await ctx.h5pEditor.saveOrUpdateContentReturnMetaData(
    contentId as string,
    payload.params,
    payload.metadata as never,
    payload.library,
    user
  );
  const savedId = String(result.id);
  if (options.packageContent) {
    // Before the checks below: the open references point into these files.
    await storePackageContent(
      ctx.h5pEditor,
      savedId,
      options.packageContent,
      user,
      { replace: contentId !== undefined }
    );
  }
  // H5P filters out sub-content whose library the container's semantics do not
  // allow, silently and after the write. Comparing what went in with what came
  // back turns that into a refusal the author can act on; the transaction
  // discards the staged write, so nothing was saved.
  const storedParams =
    await ctx.h5pEditor.contentStorage.getParameters(savedId);
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
      !(await ctx.h5pEditor.contentStorage.fileExists(savedId, file.filePath))
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
  // The media check above sees only the open references; the placeholder
  // chapter names none of the exam's files. An import has just stored them
  // (a miss is the host's fault); an editor save of the stored exam must
  // find them stored — content an older host imported may lack them. Only a
  // stored file counts: not a directory, not `content.json`/`h5p.json`.
  const examFiles = examMediaPaths(storedParams);
  const storedExamFiles =
    examFiles.length === 0
      ? new Set<string>()
      : new Set(
          (await ctx.h5pEditor.contentStorage.listFiles(savedId, user))
            .map((file) => file.split(path.sep).join('/'))
            .filter((file) => file !== 'content.json' && file !== 'h5p.json')
        );
  for (const file of examFiles) {
    if (!storedExamFiles.has(file)) {
      if (options.packageContent) {
        throw new HostError('An exam file could not be saved.', 500);
      }
      throw new HostError(
        'The exam files of this book are missing. Import the exam book ' +
          'again through the import route. No changes were saved.',
        422,
        { code: 'exam-media-missing' }
      );
    }
  }
  const metadata =
    declared && isExamContent(storedParams)
      ? await keepDeclaredDependencies(
          ctx.h5pEditor,
          savedId,
          declared,
          result.metadata,
          storedParams,
          user
        )
      : result.metadata;
  return { contentId: savedId, metadata };
}

/**
 * Stores a package on library versions this host does not have as it is
 * (h5p/outdated-package.ts): the package's `h5p.json` and `content.json`
 * unchanged, and its staged `content/` (`packageContent`) under its own
 * names, replacing the stored files on an update. Nothing here may read the
 * semantics of the versions it names — they are missing — so h5p-server's
 * save, which scans and re-generates both files with them, is not used.
 * Runs inside the import's content transaction, like `saveEditorContent`:
 * `addContent` writes to the transaction's id.
 */
export async function saveOutdatedPackage(
  ctx: WebContext,
  user: WebUser,
  rawContentId: string,
  body: Record<string, unknown>,
  packageContent: string
): Promise<{ contentId: string; metadata: unknown }> {
  const contentId = resolveContentId(rawContentId);
  // The same shape and depth checks as any other save.
  const payload = savePayload(body);
  const metadata = payload.metadata as unknown as IContentMetadata;
  const savedId = String(
    await ctx.h5pEditor.contentStorage.addContent(
      metadata,
      payload.params,
      user,
      contentId
    )
  );
  await storePackageContent(ctx.h5pEditor, savedId, packageContent, user, {
    replace: contentId !== undefined
  });
  return { contentId: savedId, metadata };
}
