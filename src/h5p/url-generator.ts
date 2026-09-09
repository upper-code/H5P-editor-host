import { UrlGenerator } from '@lumieducation/h5p-server';
import type { ContentId, IH5PConfig } from '@lumieducation/h5p-server';

/**
 * The default UrlGenerator derives the canonical content URL from the config's
 * base URL. In the multi-tenant web editor the player is served from the
 * application's own `/content/:id` route under a configurable public origin, so
 * only `uniqueContentUrl` needs to be overridden.
 */
export default class WebUrlGenerator extends UrlGenerator {
  private publicBaseUrl: string;

  constructor(config: IH5PConfig, publicBaseUrl: string) {
    super(config);
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  public uniqueContentUrl(contentId: ContentId): string {
    return `${this.publicBaseUrl}/content/${contentId}`;
  }
}
