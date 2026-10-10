const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const initI18n = require('../build/src/h5p/i18n').default;
const { tmpDir } = require('./helpers');

const packageTranslations = path.join(
  path.dirname(require.resolve('@lumieducation/h5p-server/package.json')),
  'build/assets/translations'
);

test('Russian translates the server strings and falls back to English for the player', async () => {
  // h5p-server ships no client/ru.json; the player chrome stays English by
  // design (docs/DESIGN_DECISIONS.md), which rests on `fallbackLng: 'en'`.
  const { translationCallback: t } = await initI18n('ru', false);
  assert.match(t('server:api-version-unsupported', 'ru'), /^Системе/);
  assert.equal(t('client:fullscreen', 'ru'), 'Fullscreen');
  assert.equal(t('client:fullscreen', 'en'), 'Fullscreen');
});

test('a language with no translations of its own renders English', async () => {
  const { translationCallback: t } = await initI18n('xx', false);
  assert.match(t('server:api-version-unsupported', 'xx'), /^The system/);
});

test('missing English translations stop the initialization', async (t) => {
  // i18next itself resolves with nothing loaded, and every string would then
  // render as its bare key; the English files are the fallback for all.
  const root = tmpDir(t, 'host-i18n-');
  for (const ns of ['client', 'server']) {
    fs.mkdirSync(path.join(root, ns));
    fs.copyFileSync(
      path.join(packageTranslations, ns, 'en.json'),
      path.join(root, ns, 'en.json')
    );
  }
  await assert.rejects(
    initI18n('en', false, root),
    /English translations missing for copyright-semantics, metadata-semantics, storage-file-implementations/
  );
});
