const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const origin = 'https://h5p-media.test';
let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  });
});
test.after(async () => browser?.close());

async function uploader(t, respond) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser JavaScript errors'));
  const uploads = [];
  await page.route(`${origin}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
          <script src="/assets/h5p/core/js/h5p-event-dispatcher.js"></script>
          <script>window.H5PEditor = { t: (group, key) => key, getAjaxUrl: () => '/upload' };</script>
          <script src="/assets/h5p/editor/scripts/h5peditor-file-uploader.js"></script>`
      });
    }
    if (pathname === '/upload') {
      uploads.push(route.request());
      return respond
        ? respond(route)
        : route.fulfill({
            contentType: 'application/json',
            body: '{"path":"new.png#tmp"}'
          });
    }
    return route.fulfill({ path: path.join(root, pathname) });
  });
  await page.goto(origin);
  await page.evaluate(() => {
    window.events = [];
    window.upload = new window.H5PEditor.FileUploader({ type: 'image' });
    window.upload.on('upload', () => window.events.push('upload'));
    window.upload.on('uploadComplete', (event) =>
      window.events.push(event.data)
    );
  });
  return { page, uploads };
}

test('the real uploader displays a preflight refusal without sending any media bytes', async (t) => {
  const { page, uploads } = await uploader(t);
  await page.evaluate(() => {
    window.H5PEditor.beforeMediaUpload = async () => {
      throw new Error('The total media size exceeds the limit of 480 MiB.');
    };
    window.upload.uploadFiles([new File(['image'], 'image.png')]);
  });
  await page.waitForFunction(() => window.events.length === 2);
  assert.deepEqual(await page.evaluate(() => window.events), [
    'upload',
    { error: 'The total media size exceeds the limit of 480 MiB.', data: null }
  ]);
  assert.equal(uploads.length, 0);
});

test('an edited image waits for admission and releases bytes after its widget applies the result', async (t) => {
  const { page, uploads } = await uploader(t);
  await page.evaluate(() => {
    window.H5PEditor.beforeMediaUpload = () =>
      new Promise((resolve) => {
        window.admit = () => resolve(() => window.events.push('released'));
      });
    window.upload.upload(
      new Blob(['edited image'], { type: 'image/png' }),
      'edited.png'
    );
  });
  await page.waitForFunction(() => typeof window.admit === 'function');
  assert.equal(uploads.length, 0);
  await page.evaluate(() => window.admit());
  await page.waitForFunction(() => window.events.length === 3);
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].postData(), /filename="edited.png"/);
  assert.deepEqual(await page.evaluate(() => window.events), [
    'upload',
    { error: null, data: { path: 'new.png#tmp' } },
    'released'
  ]);
});

for (const failure of ['http', 'network', 'malformed']) {
  test(`a ${failure} upload failure releases its reservation and reports an error`, async (t) => {
    const { page } = await uploader(t, (route) =>
      failure === 'network'
        ? route.abort('failed')
        : route.fulfill({
            status: failure === 'http' ? 413 : 200,
            contentType: 'application/json',
            body:
              failure === 'http'
                ? '{"error":"Total media limit exceeded."}'
                : 'null'
          })
    );
    await page.evaluate(() => {
      window.H5PEditor.beforeMediaUpload = async () => () =>
        window.events.push('released');
      window.upload.uploadFiles([new File(['image'], 'image.png')]);
    });
    await page.waitForFunction(() => window.events.length === 3);
    const events = await page.evaluate(() => window.events);
    assert.equal(events[0], 'upload');
    assert.ok(events[1].error);
    assert.equal(events[1].data, null);
    assert.equal(events[2], 'released');
  });
}

test('the uploader still works in an embedding without a preflight hook', async (t) => {
  const { page, uploads } = await uploader(t);
  await page.evaluate(() =>
    window.upload.uploadFiles([new File(['image'], 'image.png')])
  );
  await page.waitForFunction(() => window.events.length === 2);
  assert.equal(uploads.length, 1);
  assert.equal(await page.evaluate(() => window.events[1].error), null);
});
