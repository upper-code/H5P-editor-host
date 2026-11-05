import type { IEditorModel } from '@lumieducation/h5p-server';
import { hostRoute } from './route-prefix';

export const queryLanguages = ['en', 'ru', 'es', 'ka'] as const;

/** A request selects its own language without changing a cached tenant. */
export function requestLanguage(value: unknown): string {
  if (typeof value !== 'string') return 'en';
  const language = value.trim().toLowerCase().split(/[-_]/)[0];
  return (queryLanguages as readonly string[]).includes(language)
    ? language
    : 'en';
}

/** Match the browser's literal query keys instead of Express's nested parser. */
export function requestLanguageFromUrl(url: string): string {
  const values = new URL(url, 'http://host.invalid').searchParams.getAll(
    'lang'
  );
  return requestLanguage(values.length === 1 ? values[0] : undefined);
}

/** Keep `action=` last: the H5P core appends the action name to this URL. */
function ajaxLanguage(url: string, language: string): string {
  return url.replace(/([?&])action=/, `$1lang=${language}&action=`);
}

/**
 * H5P's models otherwise send subsequent semantics requests in the deployment
 * language. The Georgian core overlay follows English because the vendored
 * editor has no Georgian file; all unprovided strings keep that fallback.
 */
export function withEditorLanguage(
  model: IEditorModel,
  language: string
): IEditorModel {
  const integration = model.integration;
  const editor = integration.editor;
  if (integration.ajaxPath) {
    integration.ajaxPath = ajaxLanguage(integration.ajaxPath, language);
  }
  if (editor?.ajaxPath) {
    editor.ajaxPath = ajaxLanguage(editor.ajaxPath, language);
  }
  // CKEditor does not load its own translation bundles. Of our supported UI
  // languages, ru/es ship separately; its built-in English handles ka.
  if (language === 'ru' || language === 'es') {
    const translation = hostRoute(
      `/h5p/editor/ckeditor/translations/${language}.js`
    );
    model.scripts = [...model.scripts, translation];
    if (editor?.assets?.js)
      editor.assets.js = [...editor.assets.js, translation];
  }
  if (language === 'ka') {
    const overlay = hostRoute('/web/language/ka.js');
    model.scripts = [...model.scripts, overlay];
    if (editor?.assets?.js) editor.assets.js = [...editor.assets.js, overlay];
  }
  return model;
}
