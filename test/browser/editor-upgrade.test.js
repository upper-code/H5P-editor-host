const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

// The editor page's upgrade dialog — and the notice offering a newer
// installed version — in a real browser: the committed page,
// stylesheet and bridge (web/), the committed core's content upgrade, and a
// stand-in for the editor runtime. The parent page frames the editor on the
// same origin and records what the bridge posts to it.

const root = path.resolve(__dirname, '../..');
const origin = 'https://h5p-host.test';

const editModel = (missingLibraries, library, availableUpgrade) => ({
  revision: 'rev-1',
  missingLibraries,
  ...(availableUpgrade ? { availableUpgrade } : {}),
  h5p: {
    integration: {
      libraryUrl: '/core/js',
      pluginCacheBuster: '?v=1',
      editor: { assets: {}, ajaxPath: '/ajax?action=' }
    },
    styles: [],
    // The bridge loads core scripts into its own document only.
    scripts: ['/core/js/editor-stand-in.js'],
    library,
    params: { chapters: [{ library: 'H5P.Col 1.0', params: { text: 'a' } }] },
    metadata: { title: 'Book' }
  }
});

const upgradable = [
  { library: 'H5P.Book 1.0', upgrade: 'H5P.Book 1.2', reason: 'not-installed' },
  { library: 'H5P.Col 1.0', upgrade: 'H5P.Col 1.1', reason: 'not-installed' }
];

// What `H5PEditor.Editor` needs to be for the bridge: it records what it
// was started with (every editor in \`window.editors\`) and is ready at once.
const standIn = `
  window.H5P = { jQuery: function () {} };
  window.editors = [];
  window.H5PEditor = {
    Editor: function (library, state, mount, onIframeLoaded) {
      window.started = { library: library, state: JSON.parse(state) };
      window.editors.push(window.started);
      this.getLibrary = function () { return library; };
      this.getParams = function () { return JSON.parse(state); };
      mount.textContent = 'Editor for ' + library;
      this.selector = { form: {} };
      const frame = {
        H5PEditor: {},
        H5P: {},
        document: document,
        XMLHttpRequest: window.XMLHttpRequest
      };
      // The vendored getContent with H5P.Book 1.3 installed: the save-time
      // upgrade of the form's namespace (the page replaces it), from an
      // \`ns.ContentType\` to the entry of the legacy library list the
      // selector holds with the hub off, as the host serves it.
      this.getContent = function (submit, error) {
        const params = JSON.parse(state);
        if (library !== 'H5P.Book 1.2') {
          submit({ library: library, params: JSON.stringify(params) });
          return;
        }
        frame.H5PEditor.upgradeContent(
          { machineName: 'H5P.Book', majorVersion: '1', minorVersion: '2' },
          {
            name: 'H5P.Book',
            majorVersion: 1,
            minorVersion: 3,
            title: 'Book',
            restricted: false,
            uberName: 'H5P.Book 1.3'
          },
          params,
          function (err, result) {
            if (err) error(err);
            else submit({ library: 'H5P.Book 1.3', params: result });
          }
        );
      };
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
  'H5P.Book 1.3': {
    name: 'H5P.Book',
    version: { major: 1, minor: 3 },
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

// `refused`: paths answered `401` as a Shelf whose session lapsed answers
// them; `patches`: the bodies of the saves, each answered as stored;
// `mockClock`: advance the upgrade deadline without a real minute's wait.
async function editorPage(
  t,
  missingLibraries,
  library = 'H5P.Book 1.0',
  availableUpgrade,
  {
    refused = new Set(),
    patches = [],
    mockClock = false,
    libraryData = libraries
  } = {}
) {
  const page = await browser.newPage();
  t.after(() => page.close());
  if (mockClock) await page.clock.install();
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
    if (refused.has(url.pathname)) {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{"error":"Session expired."}'
      });
    }
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: parentPage });
    }
    if (
      url.pathname === '/api/v1/content/7' &&
      route.request().method() === 'PATCH'
    ) {
      patches.push(JSON.parse(route.request().postData()));
      return json({ contentId: '7', revision: `rev-${patches.length + 1}` });
    }
    if (url.pathname === '/editor/7') {
      return route.fulfill({ path: path.join(root, 'web/editor-host.html') });
    }
    if (url.pathname.startsWith('/web/')) {
      return route.fulfill({ path: path.join(root, url.pathname) });
    }
    if (url.pathname === '/api/v1/content/7/edit') {
      return json(editModel(missingLibraries, library, availableUpgrade));
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
      return libraryData[key]
        ? json(libraryData[key])
        : route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(origin);
  const frame = page.frameLocator('iframe');
  await frame
    .locator(availableUpgrade ? '#host-offer' : '#host-upgrade[open]')
    .waitFor();
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
  assert.equal(error.notInstalled, true);

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
  assert.equal(
    await button.evaluate((element) => element === document.activeElement),
    true
  );
  // Closed and reopened: the dialog starts afresh, the page keeps the reason.
  await frame.locator('#host-upgrade-close').click();
  await frame.locator('#host-upgrade').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#host-error').isVisible(), true);
  assert.match(
    await frame.locator('#host-error').textContent(),
    /could not be upgraded/
  );
  await frame.locator('#host-upgrade-reopen').click();
  await frame.locator('#host-upgrade[open]').waitFor();
  assert.equal(await failure.isVisible(), false);
  assert.equal(
    await button.evaluate((element) => element === document.activeElement),
    true
  );
});

test('content blocked only by unaccepted versions is reported as installed', async (t) => {
  // The book itself is on its installed version.
  const { page } = await editorPage(
    t,
    [
      { library: 'H5P.Col 1.0', upgrade: 'H5P.Col 1.1', reason: 'not-accepted' }
    ],
    'H5P.Book 1.2'
  );
  const [error] = await messages(page);
  assert.equal(error.code, 'library-missing');
  assert.equal(error.notInstalled, false);
});

test('one version that is not installed among unaccepted ones is reported as not installed', async (t) => {
  const { page } = await editorPage(t, [
    {
      library: 'H5P.Book 1.0',
      upgrade: 'H5P.Book 1.2',
      reason: 'not-installed'
    },
    { library: 'H5P.Col 1.0', upgrade: 'H5P.Col 1.1', reason: 'not-accepted' }
  ]);
  const [error] = await messages(page);
  assert.equal(error.code, 'library-missing');
  assert.equal(error.notInstalled, true);
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

test('a newer installed version is offered above a working editor and upgrades it in place', async (t) => {
  const { page, frame } = await editorPage(t, [], 'H5P.Book 1.2', {
    library: 'H5P.Book 1.2',
    upgrade: 'H5P.Book 1.3'
  });
  await page.waitForFunction(() =>
    window.messages.some((message) => message.type === 'ready')
  );
  const offer = frame.locator('#host-offer');
  assert.match(
    await frame.locator('#host-offer-text').textContent(),
    /^This content uses H5P\.Book 1\.2\. A newer version, H5P\.Book 1\.3, is installed\./
  );
  // Not modal: the editor below stays usable, and the notice sits above it.
  assert.equal(await frame.locator('dialog[open]').count(), 0);
  const editorArea = frame.locator('#h5p-editor-root');
  assert.equal(
    (await editorArea.textContent()).trim(),
    'Editor for H5P.Book 1.2'
  );
  const [offerBox, editorBox] = await Promise.all([
    offer.boundingBox(),
    editorArea.boundingBox()
  ]);
  assert.ok(offerBox.y + offerBox.height <= editorBox.y);

  await frame.locator('#host-offer-upgrade').click();
  await frame
    .locator('#host-offer-text', { hasText: 'was upgraded to H5P.Book 1.3' })
    .waitFor();
  assert.equal(
    (await editorArea.textContent()).trim(),
    'Editor for H5P.Book 1.3'
  );
  assert.deepEqual(
    await frame.locator('body').evaluate(() => window.editors.at(-1)),
    {
      library: 'H5P.Book 1.3',
      state: {
        params: {
          chapters: [{ library: 'H5P.Col 1.1', params: { text: 'a' } }]
        },
        metadata: { title: 'Book' }
      }
    }
  );
  assert.equal(await frame.locator('#host-offer-upgrade').isVisible(), false);
  await page.waitForFunction(() =>
    window.messages.some((message) => message.type === 'changed')
  );
  // One `ready` for the page, `changed` for the upgraded content.
  assert.deepEqual(
    (await messages(page)).map((message) => message.type),
    ['ready', 'changed']
  );
  await frame.locator('#host-offer-dismiss').click();
  await offer.waitFor({ state: 'hidden' });
});

test('the offered upgrade waits for the requests the editor has running', async (t) => {
  const { page, frame } = await editorPage(t, [], 'H5P.Book 1.2', {
    library: 'H5P.Book 1.2',
    upgrade: 'H5P.Book 1.3'
  });
  await page.waitForFunction(() =>
    window.messages.some((message) => message.type === 'ready')
  );
  // The answered upload is held until the test releases it.
  const answered = new Promise((resolve) => {
    page.route(`${origin}/upload?id=0`, resolve);
  });
  await page.route(`${origin}/upload?id=1`, () => {});
  const body = frame.locator('body');
  // An upload that is answered, and one the author cancels.
  await body.evaluate(() => {
    window.uploads = [0, 1].map((id) => {
      const request = new XMLHttpRequest();
      request.open('POST', `/upload?id=${id}`);
      request.send('file');
      return request;
    });
  });
  const button = frame.locator('#host-offer-upgrade');
  const failure = frame.locator('#host-offer-error');
  await button.click();
  await failure.waitFor();
  assert.match(await failure.textContent(), /still uploading or loading/);
  await body.evaluate(() => window.uploads[1].abort());
  await button.click();
  assert.match(await failure.textContent(), /still uploading or loading/);
  const route = await Promise.race([
    answered,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('The upload never arrived.')), 5000)
    )
  ]);
  await route.fulfill({ contentType: 'application/json', body: '{}' });
  await page
    .frames()
    .find((candidate) => candidate !== page.mainFrame())
    .waitForFunction(() => window.uploads[0].readyState === 4, null, {
      timeout: 5000
    });
  await button.click();
  await frame
    .locator('#host-offer-text', { hasText: 'was upgraded to H5P.Book 1.3' })
    .waitFor();
  assert.equal(await failure.isVisible(), false);
});

test('a save whose upgrade script the lapsed session refuses is held and repeated on renewal', async (t) => {
  const refused = new Set(['/core/js/h5p-content-upgrade-process.js']);
  const patches = [];
  const { page } = await editorPage(
    t,
    [],
    'H5P.Book 1.2',
    { library: 'H5P.Book 1.2', upgrade: 'H5P.Book 1.3' },
    { refused, patches }
  );
  await page.waitForFunction(() =>
    window.messages.some((message) => message.type === 'ready')
  );
  const send = (type) =>
    page.evaluate((type) => {
      document
        .querySelector('iframe')
        .contentWindow.postMessage(
          { source: 'editor-embedder', type },
          location.origin
        );
    }, type);
  await send('save');
  await page.waitForFunction(() =>
    window.messages.some((message) => message.type === 'error')
  );
  const held = await messages(page);
  assert.deepEqual(
    held.map((message) => message.type),
    ['ready', 'saving', 'session-expired', 'error']
  );
  assert.equal(held.at(-1).status, 401);
  assert.equal(patches.length, 0);

  refused.clear();
  await send('session-renewed');
  await page.waitForFunction(() =>
    window.messages.some((message) => message.type === 'saved')
  );
  assert.deepEqual(
    (await messages(page)).slice(held.length).map((message) => message.type),
    ['saving', 'saved']
  );
  assert.equal(patches.length, 1);
  assert.equal(patches[0].library, 'H5P.Book 1.3');
  assert.deepEqual(patches[0].params, {
    chapters: [{ library: 'H5P.Col 1.1', params: { text: 'a' } }]
  });
});

const bookUpgradesPath = '/h5p/libraries/H5P.Book-1.3/upgrades.js';

for (const scriptPath of [
  '/core/js/h5p-version.js',
  '/core/js/h5p-content-upgrade-process.js',
  bookUpgradesPath
]) {
  test(`a save bypasses a hung ${path.basename(scriptPath)} and ignores its late upgrade`, async (t) => {
    const patches = [];
    const { page, frame } = await editorPage(
      t,
      [],
      'H5P.Book 1.2',
      { library: 'H5P.Book 1.2', upgrade: 'H5P.Book 1.3' },
      {
        patches,
        mockClock: true,
        libraryData: {
          ...libraries,
          'H5P.Book 1.3': {
            ...libraries['H5P.Book 1.3'],
            upgradesScript: `${bookUpgradesPath}?v=1`
          }
        }
      }
    );
    await page.waitForFunction(() =>
      window.messages.some((message) => message.type === 'ready')
    );
    // The counter distinguishes the abandoned run from a repeated save;
    // the parameter proves each saved snapshot was upgraded exactly once.
    const upgradeScript = {
      contentType: 'text/javascript',
      body: `
        var H5PUpgrades = H5PUpgrades || {};
        H5PUpgrades['H5P.Book'] = { 1: { 3: function (params, done) {
          window.upgradeCalls = (window.upgradeCalls || 0) + 1;
          params.upgradeCount = (params.upgradeCount || 0) + 1;
          done(null, params);
        } } };
      `
    };
    await page.route(`${origin}${bookUpgradesPath}?*`, (route) =>
      route.fulfill(upgradeScript)
    );
    const loads = [];
    let held;
    await page.route(`${origin}${scriptPath}?*`, (route) => {
      loads.push(route.request().url());
      if (loads.length === 1) {
        // The first request stays unanswered until a later save succeeds.
        held = route;
        return;
      }
      return route.fallback();
    });
    const requested = page.waitForRequest(
      (request) => new URL(request.url()).pathname === scriptPath
    );
    await frame.locator('#host-offer-upgrade').click();
    await requested;
    await page.clock.fastForward(60_000);
    const failure = frame.locator('#host-offer-error');
    await failure.waitFor();
    assert.match(await failure.textContent(), /did not finish in time/);

    const save = () =>
      page.evaluate(() => {
        document
          .querySelector('iframe')
          .contentWindow.postMessage(
            { source: 'editor-embedder', type: 'save' },
            location.origin
          );
      });
    await save();
    await page.waitForFunction(() =>
      window.messages.some((message) => message.type === 'saved')
    );
    assert.equal(loads.length, 2);
    assert.notEqual(loads[0], loads[1], 'the unfinished fetch is not shared');
    const saved = await messages(page);
    assert.deepEqual(
      saved.map((message) => message.type),
      ['ready', 'saving', 'saved']
    );
    assert.equal(patches.length, 1);
    assert.equal(patches[0].library, 'H5P.Book 1.3');
    assert.deepEqual(patches[0].params, {
      chapters: [{ library: 'H5P.Col 1.1', params: { text: 'a' } }],
      upgradeCount: 1
    });
    assert.equal(
      (await frame.locator('#h5p-editor-root').textContent()).trim(),
      'Editor for H5P.Book 1.2',
      'saving keeps the current form and does not rebuild it'
    );

    // A late script still executes and lets the abandoned upgrade finish.
    // Its result must not replace the editor or send another save or event.
    await held.fulfill(
      scriptPath === bookUpgradesPath
        ? upgradeScript
        : { path: path.join(root, 'assets/h5p', scriptPath) }
    );
    await page.waitForFunction(
      () => document.querySelector('iframe').contentWindow.upgradeCalls === 2
    );
    assert.deepEqual(await messages(page), saved);
    assert.equal(patches.length, 1);
    assert.equal(
      await frame.locator('body').evaluate(() => window.editors.length),
      1,
      'the late upgrade does not rebuild the editor'
    );

    await save();
    await page.waitForFunction(
      () =>
        window.messages.filter((message) => message.type === 'saved').length ===
        2
    );
    assert.equal(patches.length, 2);
    assert.deepEqual(patches[1], patches[0]);
    assert.equal(loads.length, 2, 'the next save reuses the loaded scripts');
    assert.deepEqual(
      (await messages(page)).map((message) => message.type),
      ['ready', 'saving', 'saved', 'saving', 'saved']
    );
  });
}
