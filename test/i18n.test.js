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

test('Russian translates server strings and the offline player UI', async () => {
  const { translationCallback: t } = await initI18n('ru', false);
  assert.match(t('server:api-version-unsupported', 'ru'), /^Системе/);
  assert.equal(t('client:fullscreen', 'ru'), 'На весь экран');
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

test('all query languages are synchronously ready in one shared translator', async () => {
  const { translationCallback: t } = await initI18n('en', false);
  assert.equal(t('client:fullscreen', 'ru'), 'На весь экран');
  assert.equal(t('client:fullscreen', 'es'), 'PantallaCompleta');
  assert.equal(t('client:fullscreen', 'ka'), 'სრულ ეკრანზე');
  assert.equal(t('metadata-semantics:title', 'ka'), 'სათაური');
  assert.equal(t('copyright-semantics:author', 'ka'), 'ავტორი');
  assert.match(t('server:api-version-unsupported', 'ka'), /^The system/);
});
