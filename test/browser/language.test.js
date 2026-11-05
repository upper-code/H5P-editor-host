const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const origin = 'https://h5p-language.test';
let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  });
});
test.after(async () => browser?.close());

for (const [language, bold] of Object.entries({
  en: 'Bold',
  ru: 'Жирный',
  es: 'Negrita',
  ka: 'Bold'
})) {
  test(`${language}: rich-text UI is localized without changing content language`, async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], 'browser JavaScript errors'));
    await page.addInitScript(() => {
      window.fixtureErrors = [];
      window.addEventListener('error', (event) =>
        window.fixtureErrors.push(event.message)
      );
      window.addEventListener('unhandledrejection', (event) =>
        window.fixtureErrors.push(String(event.reason))
      );
    });
    await page.route(`${origin}/**`, (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') {
        const translation = ['ru', 'es'].includes(language)
          ? `<script src="/assets/h5p/editor/ckeditor/translations/${language}.js"></script>`
          : '';
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html lang="ka">
            <head><meta charset="utf-8"></head><body>
            <div id="text"><p>Original content</p></div>
            <script src="/assets/h5p/core/js/jquery.js"></script>
            <script>
              window.H5PEditor = window.ns = {
                $: window.H5P.jQuery,
                widgets: {},
                contentLanguage: '${language}',
                defaultLanguage: 'ka'
              };
              window.H5PIntegration = { editor: {} };
            </script>
            <script src="/assets/h5p/editor/scripts/h5peditor-html.js"></script>
            <script src="/assets/h5p/editor/ckeditor/ckeditor.js"></script>
            ${translation}
            <script type="module">
              import { localizeEditorFrame } from '/web/host-language.js';
              localizeEditorFrame(window);
              localizeEditorFrame(window);
              const html = new H5PEditor.Html(null, {
                tags: ['strong', 'p'], enterMode: 'p'
              }, '', () => {});
              window.richTextEditor = await window.ClassicEditor.create(
                document.getElementById('text'), html.getCKEditorConfig()
              );
            </script>
          </body></html>`
        });
      }
      return route.fulfill({ path: path.join(root, pathname) });
    });
    await page.goto(`${origin}/?lang=${language}`);
    await page.waitForFunction(
      () => window.richTextEditor || window.fixtureErrors.length,
      null,
      { timeout: 5000 }
    );
    assert.deepEqual(
      await page.evaluate(() => window.fixtureErrors),
      [],
      'rich-text fixture initialization errors'
    );
    const actual = await page.evaluate(() => ({
      documentLanguage: document.documentElement.lang,
      uiLanguage: window.richTextEditor.locale.uiLanguage,
      contentLanguage: window.richTextEditor.locale.contentLanguage,
      contentDefault: window.H5PEditor.defaultLanguage,
      bold: window.richTextEditor.t('Bold'),
      content: window.richTextEditor.getData()
    }));
    assert.deepEqual(actual, {
      documentLanguage: language,
      uiLanguage: ['ru', 'es'].includes(language) ? language : 'en',
      contentLanguage: 'ka',
      contentDefault: 'ka',
      bold,
      content: '<p>Original content</p>'
    });
    assert.equal(
      await page.locator('.ck-editor__editable').getAttribute('lang'),
      'ka'
    );
  });
}
