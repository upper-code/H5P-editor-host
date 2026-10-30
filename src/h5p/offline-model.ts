import type { IEditorModel, IIntegration } from '@lumieducation/h5p-server';

/**
 * Assets that only implement the remote content catalogue. The local library
 * selector does not depend on any of them.
 */
const REMOTE_CATALOGUE_ASSETS = [
  '/scripts/h5p-hub-client.js',
  '/scripts/h5peditor-selector-hub.js',
  '/styles/css/h5p-hub-client.css'
];

function isRemoteCatalogueAsset(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0].toLowerCase();
  return REMOTE_CATALOGUE_ASSETS.some((suffix) => path.endsWith(suffix));
}

/** Removes the remote-catalogue client while preserving list order. */
export function withoutRemoteCatalogueAssets(urls: string[]): string[] {
  return urls.filter((url) => !isRemoteCatalogueAsset(url));
}

/**
 * Removes remote catalogue endpoints and branding from an integration object.
 *
 * h5p-server 9.3.3 emits `hubIsEnabled: true` and the public catalogue URL
 * even when `contentHubEnabled` is false. Treat its generated model as
 * untrusted at our HTTP boundary and make the offline policy explicit.
 *
 * `hubIsEnabled: false` is also what switches the editor core to its legacy
 * library selector, which loads its menu from an AJAX action the package
 * does not implement — offline-ajax.ts answers that one.
 */
export function withRemoteCatalogueDisabled(
  source: IIntegration
): IIntegration {
  const integration: IIntegration = {
    ...source,
    hubIsEnabled: false,
    contents: source.contents
      ? Object.fromEntries(
          Object.entries(source.contents).map(([id, content]) => [
            id,
            {
              ...content,
              displayOptions: {
                ...content.displayOptions,
                // This is the vendor logo/link in the player's action bar.
                icon: false
              }
            }
          ])
        )
      : source.contents,
    editor: source.editor
      ? {
          ...source.editor,
          enableContentHub: false,
          assets: {
            js: withoutRemoteCatalogueAssets(source.editor.assets.js),
            css: withoutRemoteCatalogueAssets(source.editor.assets.css)
          }
        }
      : source.editor
  };

  // Do not serialize upstream URLs into either editor or player pages.
  delete integration.Hub;
  if (integration.editor) {
    delete integration.editor.hub;
  }
  return integration;
}

/** Applies the offline policy to both asset lists carried by an editor model. */
export function withRemoteCatalogueDisabledInEditor(
  model: IEditorModel
): IEditorModel {
  return {
    ...model,
    scripts: withoutRemoteCatalogueAssets(model.scripts),
    styles: withoutRemoteCatalogueAssets(model.styles),
    integration: withRemoteCatalogueDisabled(model.integration)
  };
}
