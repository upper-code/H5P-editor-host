import path from 'path';
import i18next from 'i18next';
import Backend from 'i18next-fs-backend';
import type { ITranslationFunction } from '@lumieducation/h5p-server';

// The H5P server localizes semantics, hub info and error messages through these
// namespaces. The translation JSON is shipped inside the installed
// @lumieducation/h5p-server package, so nothing needs to be vendored here.
const namespaces = [
  'client',
  'copyright-semantics',
  'hub',
  'library-metadata',
  'metadata-semantics',
  'server',
  'storage-file-implementations'
];

export interface WebI18n {
  /** `(key, language) => string` adapter the H5P editor/player expect. */
  translationCallback: ITranslationFunction;
}

export default async function initI18n(
  language: string,
  isDevelopment: boolean
): Promise<WebI18n> {
  const translationsRoot = path.join(
    path.dirname(require.resolve('@lumieducation/h5p-server/package.json')),
    'build/assets/translations'
  );

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

  const translationCallback: ITranslationFunction = (key, lng) =>
    instance.t(key, { lng }) as unknown as string;

  return { translationCallback };
}
