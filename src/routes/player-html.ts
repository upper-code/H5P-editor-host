import { Router, Request } from 'express';

import { mapContentNotFound } from '../errors';
import { assertContentId } from '../content-id';
import type WebUser from '../h5p/user';
import type { WebContext } from '../h5p/context';
import type { IPlayerModel } from '@lumieducation/h5p-server';
import {
  withTooltipScripts,
  withTooltipStyles,
  withTooltipIntegration
} from '../h5p/tooltip-hotfix';

interface WebRequest extends Request {
  ctx: WebContext;
  user: WebUser;
  language: string;
}

// Optional CDN offload for the static H5P core/library assets. When CDN_BASE is
// set, absolute (origin-relative) asset URLs are prefixed with it so the large,
// cacheable runtime files can be served from a CDN instead of the app. Unset by
// default, in which case the player is served entirely from this origin.
//
// This is a static rewrite of the URLs emitted into the player HTML: it changes
// only where the browser loads assets from and performs no server-side fetching.
const CDN_BASE = (process.env.CDN_BASE || '').replace(/\/+$/, '');

function withCdnBase(urls: string[]): string[] {
  if (!CDN_BASE) {
    return urls;
  }
  // Only origin-relative URLs ("/h5p/...") are rewritten. A protocol-relative
  // URL ("//cdn/...") also starts with "/" but already names its own host, so it
  // must be left alone rather than prefixed into "${CDN_BASE}//cdn/...".
  return urls.map((url) =>
    url.startsWith('/') && !url.startsWith('//') ? `${CDN_BASE}${url}` : url
  );
}

// Prevent a stray "</script>" (or any tag) inside the serialized integration
// object from terminating the inline script element.
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Renders the standard H5P embed page from a player model. This is the publicly
 * documented H5P integration contract: an `h5p-iframe` document that declares
 * `window.H5PIntegration`, links the model's styles, hosts a
 * `div.h5p-content[data-content-id]` mount point, and loads the model's
 * scripts in order.
 */
export function renderPlayerHtml(model: IPlayerModel): string {
  // Re-add the core tooltip assets that h5p-server drops (issue #3374) before
  // the CDN rewrite, so the injected URLs are offloaded to the CDN too.
  const styles = withCdnBase(withTooltipStyles(model.styles || []));
  const scripts = withCdnBase(withTooltipScripts(model.scripts || []));
  // This page is a div-embed, so it renders from `styles`/`scripts` above and
  // `integration.core` is inert here. Patch it anyway: it is the list a client
  // building an h5p-iframe via `H5P.getHeadTags` would use, so keeping it in
  // sync means the tooltip fix survives such a client being added later.
  const integration = withTooltipIntegration(model.integration);

  const links = styles
    .map((href) => `<link rel="stylesheet" href="${href}" />`)
    .join('\n    ');
  const scriptTags = scripts
    .map((src) => `<script src="${src}"></script>`)
    .join('\n    ');

  return `<!doctype html>
<html class="h5p-iframe">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${links}
  </head>
  <body>
    <div class="h5p-content" data-content-id="${model.contentId}"></div>
    <script>window.H5PIntegration = ${safeJson(integration)};</script>
    ${scriptTags}
  </body>
</html>`;
}

/**
 * GET /api/v1/content/:contentId/render
 *
 * Renders a saved piece of content as a standalone H5P player page. Missing
 * content is reported as 404.
 */
export const renderContent: Router = Router();

renderContent.get(
  '/api/v1/content/:contentId/render',
  async (req, res, next) => {
    try {
      const webReq = req as WebRequest;
      // Only a stored numeric id may reach the player's content storage.
      const contentId = assertContentId(req.params.contentId);
      const model = (await webReq.ctx.h5pPlayer.render(
        contentId,
        webReq.user,
        webReq.language
      )) as IPlayerModel;
      res.type('html').send(renderPlayerHtml(model));
    } catch (error) {
      next(mapContentNotFound(error));
    }
  }
);

export default renderContent;
