const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const coreDir = path.resolve(__dirname, '../../assets/h5p/core');
const origin = 'https://h5p-runtime.test';
const fixture = `<!doctype html>
<html class="h5p-iframe">
  <head>
    <link rel="stylesheet" href="/styles/h5p-fonts.css">
    <link rel="stylesheet" href="/styles/h5p-theme-variables.css">
    <link rel="stylesheet" href="/styles/h5p-confirmation-dialog.css">
    <link rel="stylesheet" href="/styles/h5p-core-button.css">
    <link rel="stylesheet" href="/styles/h5p-tooltip.css">
  </head>
  <body>
    <button id="trigger" aria-label="Tooltip text"
      style="position: absolute; left: 300px; top: 100px; width: 150px; height: 50px">Hover me</button>
    <button id="outside">Outside</button>
    <div id="dialog-parent" class="h5p-content h5p-large" style="min-height: 600px"></div>
    <script src="/js/h5p-event-dispatcher.js"></script>
    <script>H5P.t = (key) => key; window.H5PIntegration = {};</script>
    <script src="/js/h5p-confirmation-dialog.js"></script>
    <script src="/js/h5p-tooltip.js"></script>
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

async function runtime(t) {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser JavaScript errors'));

  // Intercept every asset locally: no server, external requests or runtime
  // library bundle. The actual CSS and fonts participate in layout and icons.
  // A file the fixture names but the core no longer ships (an upstream rename,
  // say) answers 404 and fails the test, rather than leaving the page silently
  // unstyled or the route handler throwing.
  const missing = [];
  t.after(() => assert.deepEqual(missing, [], 'core files missing on disk'));
  await page.route(`${origin}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: fixture });
    }
    const file = path.join(coreDir, pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return route.fulfill({ path: file });
    }
    if (pathname !== '/favicon.ico') {
      missing.push(pathname);
    }
    return route.fulfill({ status: 404, body: '' });
  });
  const time = new Date('2026-10-08T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time.getTime() + 1000);
  await page.goto(origin);
  return page;
}

async function showTooltip(page) {
  await page.evaluate(() => {
    window.tooltip = new H5P.Tooltip(document.querySelector('#trigger'), {
      position: 'bottom'
    });
  });
  await page.hover('#trigger');
  await page.clock.runFor(550);
  const tooltip = page.locator('.h5p-tooltip');
  assert.equal(await tooltip.isVisible(), true);
  return tooltip;
}

test('tooltip survives a delayed move from its trigger and hides after leaving', async (t) => {
  const page = await runtime(t);
  const tooltip = await showTooltip(page);
  const box = await tooltip.boundingBox();

  // Spend more than the 1 ms leave-handler delay between the button and the
  // tooltip, but enter before the 500 ms grace period expires.
  await page.mouse.move(box.x - 5, box.y + box.height / 2);
  await page.clock.runFor(50);
  await tooltip.hover();
  await page.clock.runFor(600);
  assert.equal(await tooltip.isVisible(), true, 'readable under the pointer');

  await page.mouse.move(10, 500);
  await page.clock.runFor(600);
  assert.equal(await tooltip.isVisible(), false, 'hidden after leaving');
});

test('moving keyboard focus away preserves a hovered tooltip', async (t) => {
  const page = await runtime(t);
  await page.evaluate(() => {
    window.tooltip = new H5P.Tooltip(document.querySelector('#trigger'), {
      position: 'bottom'
    });
  });
  // Show by keyboard focus, then switch to reading with the mouse.
  await page.locator('#trigger').focus();
  await page.clock.runFor(550);
  const tooltip = page.locator('.h5p-tooltip');
  assert.equal(await tooltip.isVisible(), true);
  await tooltip.hover();
  await page.locator('#outside').focus();
  await page.clock.runFor(600);
  assert.equal(await tooltip.isVisible(), true, 'hover survives trigger blur');
});

test('legacy confirmation button keeps its icon, focus and confirm action', async (t) => {
  const page = await runtime(t);
  await page.locator('#outside').focus();
  await page.evaluate(() => {
    window.confirmed = 0;
    const dialog = new H5P.ConfirmationDialog({
      headerText: 'Remove item',
      dialogText: 'Really remove it?',
      cancelText: 'Cancel',
      confirmText: 'Confirm'
    }).appendTo(document.querySelector('#dialog-parent'));
    dialog.on('confirmed', () => window.confirmed++);
    dialog.show();
  });
  assert.equal(
    await page
      .getByRole('button', { name: 'Cancel', exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
    'focus starts inside the dialog'
  );

  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  assert.equal(
    await confirm.evaluate(
      (button) => getComputedStyle(button, '::before').content
    ),
    '"\ue601"',
    'legacy confirmation icon'
  );
  await confirm.click();
  assert.equal(await page.evaluate(() => window.confirmed), 1);
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  assert.equal(
    await page
      .locator('#outside')
      .evaluate((button) => button === document.activeElement),
    true,
    'focus returns to the opener'
  );
});

test('themed confirmation buttons retain their theme and cancel action', async (t) => {
  const page = await runtime(t);
  await page.evaluate(() => {
    window.canceled = 0;
    const dialog = new H5P.ConfirmationDialog({
      theme: true,
      cancelText: 'Cancel',
      confirmText: 'Confirm'
    }).appendTo(document.querySelector('#dialog-parent'));
    dialog.on('canceled', () => window.canceled++);
    dialog.show();
  });
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  assert.equal(
    await confirm.evaluate(
      (button) =>
        button.classList.contains('h5p-theme-primary-cta') &&
        button.classList.contains('h5p-theme-check') &&
        !button.classList.contains('h5p-core-button')
    ),
    true
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => window.canceled), 1);
  assert.equal(await page.getByRole('alertdialog').count(), 0);
});
