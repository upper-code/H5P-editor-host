import path from 'path';
import i18next from 'i18next';
import Backend from 'i18next-fs-backend';
import type { ITranslationFunction } from '@lumieducation/h5p-server';

// The runtime localizes semantics and error messages through these namespaces.
// Remote-catalogue translations are deliberately not loaded; that namespace
// also carries content-type titles, but the editor is built without
// `enableLibraryNameLocalization` (editor.ts), so nothing reads them. The JSON
// is shipped inside the installed @lumieducation/h5p-server package, so
// nothing needs to be vendored here.
const namespaces = [
  'client',
  'copyright-semantics',
  'library-metadata',
  'metadata-semantics',
  'server',
  'storage-file-implementations'
];

export interface WebI18n {
  /** `(key, language) => string` adapter the H5P editor/player expect. */
  translationCallback: ITranslationFunction;
}

/** Where the installed h5p-server package keeps its translation files. */
function packageTranslations(): string {
  return path.join(
    path.dirname(require.resolve('@lumieducation/h5p-server/package.json')),
    'build/assets/translations'
  );
}

/**
 * Loads the translations and returns the callback the editor and player use.
 *
 * i18next does not fail when a file cannot be read: it resolves, and every
 * string then renders as its bare key (`server:content-not-found`). The
 * English files are the fallback for every other language and ship with the
 * package, so a namespace missing there is a broken install, and this throws
 * — `TenantManager.initialize` awaits it, so the start fails instead of the
 * editor. Another language may lack a namespace by design (Russian player
 * strings, docs/DESIGN_DECISIONS.md) and falls back to English.
 */
export default async function initI18n(
  language: string,
  isDevelopment: boolean,
  translationsRoot = packageTranslations()
): Promise<WebI18n> {
  const instance = i18next.createInstance();
  await instance.use(Backend).init({
    debug: isDevelopment,
    lng: language,
    fallbackLng: 'en',
    ns: namespaces,
    defaultNS: 'server',
    preload: language === 'en' ? ['en'] : [language, 'en'],
    // Resolve only once the backend has finished loading, so the returned
    // callback is usable synchronously.
    initImmediate: false,
    backend: {
      loadPath: path.join(translationsRoot, '{{ns}}/{{lng}}.json')
    }
  });

  // `library-metadata` translates library titles out of English, the
  // language they are written in, so it has no English file to miss.
  const missing = namespaces.filter(
    (ns) => ns !== 'library-metadata' && !instance.hasResourceBundle('en', ns)
  );
  if (missing.length) {
    throw new Error(
      `English translations missing for ${missing.join(', ')} ` +
        `(looked in ${translationsRoot}).`
    );
  }

  const translationCallback: ITranslationFunction = (key, lng) =>
    instance.t(key, { lng }) as unknown as string;

  return { translationCallback };
}
