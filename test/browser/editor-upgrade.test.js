const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

// The editor page's upgrade dialog in a real browser: the committed page,
// stylesheet and bridge (web/), the committed core's content upgrade, and a
// stand-in for the editor runtime. The parent page frames the editor on the
// same origin and records what the bridge posts to it.

const root = path.resolve(__dirname, '../..');
const origin = 'https://h5p-host.test';

const editModel = (missingLibraries) => ({
  revision: 'rev-1',
  missingLibraries,
  h5p: {
    integration: {
      libraryUrl: '/core/js',
      pluginCacheBuster: '?v=1',
      editor: { assets: {}, ajaxPath: '/ajax?action=' }
    },
    styles: [],
    // The bridge loads core scripts into its own document only.
    scripts: ['/core/js/editor-stand-in.js'],
    library: 'H5P.Book 1.0',
    params: { chapters: [{ library: 'H5P.Col 1.0', params: { text: 'a' } }] },
    metadata: { title: 'Book' }
  }
});

const upgradable = [
  { library: 'H5P.Book 1.0', upgrade: 'H5P.Book 1.2', reason: 'not-installed' },
  { library: 'H5P.Col 1.0', upgrade: 'H5P.Col 1.1', reason: 'not-installed' }
];

// What `H5PEditor.Editor` needs to be for the bridge: it records what it
// was started with and is ready at once.
const standIn = `
  window.H5P = { jQuery: function () {} };
  window.H5PEditor = {
    Editor: function (library, state, mount, onIframeLoaded) {
      window.started = { library: library, state: JSON.parse(state) };
      this.selector = { form: {} };
      const frame = { H5PEditor: {}, H5P: {}, document: document };
      setTimeout(function () { onIframeLoaded.call(frame); });
    }
  };`;

const libraries = {
  'H5P.Book 1.2': {
    name: 'H5P.Book',
    version: { major: 1, minor: 2 },
    semantics: [
      {
        name: 'chapters',
        type: 'list',
        field: { name: 'chapter', type: 'library', options: ['H5P.Col 1.1'] }
      }
    ],
    upgradesScript: null
  },
  'H5P.Col 1.1': {
    name: 'H5P.Col',
    version: { major: 1, minor: 1 },
    semantics: [{ name: 'text', type: 'text' }],
    upgradesScript: null
  }
};

const parentPage = `<!doctype html>
<html>
  <body>
    <script>
      window.messages = [];
      addEventListener('message', (event) => window.messages.push(event.data));
    </script>
    <iframe src="/editor/7" style="width: 800px; height: 600px"></iframe>
  </body>
</html>`;

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  });
});
test.after(async () => {
  await browser?.close();
});

async function editorPage(t, missingLibraries) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser JavaScript errors'));
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    const json = (body) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(body)
      });
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: parentPage });
    }
    if (url.pathname === '/editor/7') {
      return route.fulfill({ path: path.join(root, 'web/editor-host.html') });
    }
    if (url.pathname.startsWith('/web/')) {
      return route.fulfill({ path: path.join(root, url.pathname) });
    }
    if (url.pathname === '/api/v1/content/7/edit') {
      return json(editModel(missingLibraries));
    }
    if (url.pathname === '/core/js/editor-stand-in.js') {
      return route.fulfill({
        contentType: 'text/javascript',
        body: standIn
      });
    }
    if (url.pathname.startsWith('/core/js/')) {
      return route.fulfill({
        path: path.join(root, 'assets/h5p', url.pathname)
      });
    }
    if (url.pathname === '/ajax') {
      const key = `${url.searchParams.get('machineName')} ${url.searchParams.get('majorVersion')}.${url.searchParams.get('minorVersion')}`;
      return libraries[key]
        ? json(libraries[key])
        : route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(origin);
  const frame = page.frameLocator('iframe');
  await frame.locator('#host-upgrade[open]').waitFor();
  return { page, frame };
}

const messages = (page) => page.evaluate(() => window.messages);

test('the upgrade dialog lists the versions, takes the focus and upgrades into the editor', async (t) => {
  const { page, frame } = await editorPage(t, upgradable);
  const dialog = frame.locator('#host-upgrade');
  assert.equal(
    await dialog.evaluate((element) => element.matches(':modal')),
    true
  );
  assert.equal(
    await frame.locator('#host-upgrade-title').textContent(),
    'Upgrade the content to edit it'
  );
  assert.deepEqual(
    await frame.locator('#host-upgrade-list li').allTextContents(),
    ['H5P.Book 1.0 → H5P.Book 1.2', 'H5P.Col 1.0 → H5P.Col 1.1']
  );
  const button = frame.locator('#host-upgrade-button');
  assert.equal(await button.textContent(), 'Upgrade');
  assert.equal(
    await button.evaluate((element) => element === document.activeElement),
    true
  );
  const [error] = await messages(page);
  assert.equal(error.type, 'error');
  assert.equal(error.code, 'library-missing');
  assert.equal(error.revision, 'rev-1');

  await button.click();
  await frame.locator('#host-upgrade').waitFor({ state: 'hidden' });
  const started = await frame.locator('body').evaluate(() => window.started);
  assert.deepEqual(started, {
    library: 'H5P.Book 1.2',
    state: {
      params: {
        chapters: [{ library: 'H5P.Col 1.1', params: { text: 'a' } }]
      },
      metadata: { title: 'Book' }
    }
  });
  await page.waitForFunction(() =>
    window.messages.some((message) => message.type === 'changed')
  );
  assert.deepEqual(
    (await messages(page)).map((message) => message.type),
    ['error', 'ready', 'changed']
  );
  assert.equal(await frame.locator('#host-error').isVisible(), false);
  assert.equal(await frame.locator('#host-upgrade-reopen').isVisible(), false);
});

test('Escape closes the upgrade dialog without an editor, and the page reopens it', async (t) => {
  const { page, frame } = await editorPage(t, upgradable);
  await page.keyboard.press('Escape');
  await frame.locator('#host-upgrade').waitFor({ state: 'hidden' });
  // The message stays on the page, with a way back to the dialog.
  assert.match(
    await frame.locator('#host-error').textContent(),
    /library versions that are not installed: H5P\.Book 1\.0, H5P\.Col 1\.0/
  );
  assert.equal(await frame.locator('#host-error').isVisible(), true);
  const reopen = frame.locator('#host-upgrade-reopen');
  await reopen.click();
  await frame.locator('#host-upgrade[open]').waitFor();
  assert.equal(await reopen.isVisible(), false);
  assert.equal(
    await frame.locator('body').evaluate(() => window.started),
    undefined
  );
});

test('a failed upgrade is shown in the dialog and can be retried', async (t) => {
  const { page, frame } = await editorPage(t, [
    ...upgradable,
    // Not in the library data: loading it fails the upgrade.
    { library: 'H5P.Txt 1.0', upgrade: 'H5P.Txt 1.1', reason: 'not-installed' }
  ]);
  await page.route(`${origin}/ajax?*`, (route) =>
    route.fulfill({ status: 404, body: '' })
  );
  const button = frame.locator('#host-upgrade-button');
  await button.click();
  const failure = frame.locator('#host-upgrade-error');
  await failure.waitFor();
  assert.match(await failure.textContent(), /could not be upgraded/);
  assert.equal(await button.isEnabled(), true);
  assert.equal(await button.textContent(), 'Upgrade');
  assert.equal(await frame.locator('#host-upgrade[open]').count(), 1);
  assert.equal((await messages(page)).at(-1).code, 'library-upgrade-failed');
});

test('without a newer installed version the dialog explains and offers no upgrade', async (t) => {
  const { frame } = await editorPage(t, [
    { library: 'H5P.Book 1.0', upgrade: null, reason: 'not-installed' }
  ]);
  assert.equal(
    await frame.locator('#host-upgrade-title').textContent(),
    'This content cannot be opened'
  );
  assert.deepEqual(
    await frame.locator('#host-upgrade-list li').allTextContents(),
    ['H5P.Book 1.0 — no newer version installed']
  );
  assert.equal(await frame.locator('#host-upgrade-button').isVisible(), false);
  const close = frame.locator('#host-upgrade-close');
  assert.equal(
    await close.evaluate((element) => element === document.activeElement),
    true
  );
  await close.click();
  await frame.locator('#host-upgrade').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#host-error').isVisible(), true);
  assert.equal(await frame.locator('#host-upgrade-reopen').isVisible(), false);
});
