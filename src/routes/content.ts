import { Router, Request } from 'express';

import { contentRevision } from '../content-transactions';
import HostError, { mapContentNotFound } from '../errors';
import { savePayload } from '../save-payload';
import { assertContentId } from '../content-id';
import type WebUser from '../h5p/user';
import type { WebContext } from '../h5p/context';
import {
  withTooltipScripts,
  withEditorStyles,
  withTooltipIntegration
} from '../h5p/tooltip-hotfix';
import { withRemoteCatalogueDisabledInEditor } from '../h5p/offline-model';

interface WebRequest extends Request {
  ctx: WebContext;
  user: WebUser;
  language: string;
}

// `new` maps to an undefined content id, i.e. "create a new piece of content".
// Anything else must be a stored numeric id: these routes hand the value to H5P
// storage, which joins it onto a filesystem path (see content-id.ts). The
// literal string `undefined` is rejected by assertContentId rather than being
// silently treated as "create new".
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
 * made in another window is refused instead of overwritten.
 */
export const editContent: Router = Router();

editContent.get('/api/v1/content/:contentId/edit', async (req, res, next) => {
  try {
    const webReq = req as WebRequest;
    const contentId = resolveContentId(req.params.contentId);
    const { h5pEditor } = webReq.ctx;

    const model = withRemoteCatalogueDisabledInEditor(
      await h5pEditor.render(contentId, webReq.language, webReq.user)
    );

    // h5p-server's editorAssetList.json omits the core tooltip files
    // (issue #3374); re-add them so editor tooltips work. See tooltip-hotfix.
    // The outer editor chrome loads `model.scripts`/`model.styles`, but the
    // editor renders its content *preview* inside an iframe built from
    // `integration.editor.assets`, so that list has to be patched too or
    // tooltips are missing exactly where the author is editing.
    model.scripts = withTooltipScripts(model.scripts);
    model.styles = withEditorStyles(model.styles);
    model.integration = withTooltipIntegration(model.integration);

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
 */
export async function saveEditorContent(
  ctx: WebContext,
  user: WebUser,
  rawContentId: string,
  body: Record<string, unknown> | undefined
): Promise<{ contentId: string; metadata: unknown }> {
  const contentId = resolveContentId(rawContentId);
  const payload = savePayload(body);
  const expected = nestedLibraries(payload.params);
  const result = await ctx.h5pEditor.saveOrUpdateContentReturnMetaData(
    contentId,
    payload.params,
    payload.metadata as never,
    payload.library,
    user
  );
  // H5P filters out sub-content whose library the container's semantics do not
  // allow, silently and after the write. Comparing what went in with what came
  // back turns that into a refusal the author can act on; the transaction
  // discards the staged write, so nothing was saved.
  const actual = nestedLibraries(
    await ctx.h5pEditor.contentStorage.getParameters(String(result.id))
  );
  for (const [library, count] of expected) {
    if ((actual.get(library) || 0) < count) {
      throw new HostError(
        `The selected container does not support ${library}. No changes were saved.`,
        422
      );
    }
  }
  return { contentId: String(result.id), metadata: result.metadata };
}

/** Counts every `{ library, params }` pair nested anywhere in the value. */
function nestedLibraries(
  value: unknown,
  result = new Map<string, number>()
): Map<string, number> {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.library === 'string' && record.library && record.params) {
      result.set(record.library, (result.get(record.library) || 0) + 1);
    }
    Object.values(record).forEach((child) => nestedLibraries(child, result));
  }
  return result;
}
