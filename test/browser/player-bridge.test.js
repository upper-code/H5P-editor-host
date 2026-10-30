const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

// The preview bridge between real windows on different origins, using the
// committed core and a stand-in book: readiness, normal content interaction,
// frame resize and session recovery must work without the retired channels.
const root = path.resolve(__dirname, '../..');
const parentOrigin = 'https://shelf-parent.test';
const hostOrigin = 'https://h5p-host.test';
const examPath = 'images/exam.png';

const params = {
  chapters: [],
  behaviour: {},
  vmbExam: {
    page: 2,
    iv: 'aXY=',
    data: 'Y2lwaGVy',
    mac: 'bWFj',
    media: [{ path: examPath, iv: 'aXYx', mac: 'bWFjMQ==' }]
  }
};
const integration = {
  url: '/h5p',
  crossorigin: 'anonymous',
  crossoriginCacheBuster: 'cb=1',
  l10n: { H5P: {} },
  contents: {
    'cid-7': {
      library: 'VMB.InteractiveBook 1.6',
      jsonContent: JSON.stringify(params),
      contentUrl: '/content/7',
      // What `H5P.init` reads besides the parameters when it starts the
      // book on `/render`, as h5p-server's player writes it.
      fullScreen: '0',
      displayOptions: {
        frame: false,
        export: false,
        embed: false,
        copyright: false,
        icon: false,
        copy: false
      },
      metadata: { title: 'Book', license: 'U' }
    }
  }
};

// The core scripts h5p-server's player page loads, in its order
// (`playerAssetList.json` in h5p-server).
const coreScripts = [
  'jquery.js',
  'h5p.js',
  'h5p-event-dispatcher.js',
  'h5p-x-api-event.js',
  'h5p-x-api.js',
  'h5p-content-type.js',
  'h5p-confirmation-dialog.js',
  'h5p-action-bar.js',
  'request-queue.js'
]
  .map((file) => `<script src="/core/js/${file}"></script>`)
  .join('\n    ');

// The host's script order: the core and content libraries run before the
// bridge, which observes the core's document-ready initialization. A page
// with init suppressed exercises the preview shell's content-error path.
const playerPage = (start) => `<!doctype html>
<html class="h5p-iframe">
  <body>
    <div class="h5p-content" data-content-id="7"></div>
    <script>window.H5PIntegration = ${JSON.stringify(integration)};</script>
    ${coreScripts}
    <script>
      H5P.preventInit = ${!start};
      window.previewClicks = 0;
      window.previewResizes = 0;
      H5P.PreviewItem = function () {
        this.attach = function ($container) {
          $container.append('<button id="preview-action">Preview action</button>');
          $container.find('button').on('click', function () {
            window.previewClicks += 1;
          });
        };
      };
      window.VMB = {
        InteractiveBook: function (params) {
          window.bookParams = params;
          this.attach = function ($container) {
            H5P.newRunnable({
              library: 'H5P.PreviewItem 1.0',
              params: {},
              subContentId: 'preview-item'
            }, 7, $container);
          };
          this.trigger = function (type) {
            if (type === 'resize') window.previewResizes += 1;
          };
        }
      };
      window.coreMethods = {
        newRunnable: H5P.newRunnable,
        getPath: H5P.getPath,
        addQueryParameter: H5P.addQueryParameter
      };
    </script>
    <script src="/web/player-bridge.js"></script>
  </body>
</html>`;

const parentPage = (playerPath) => `<!doctype html>
<body>
  <iframe id="player" src="${hostOrigin}/${playerPath}?parentOrigin=${encodeURIComponent(parentOrigin)}"></iframe>
  <script>
    window.received = [];
    addEventListener('message', (event) => {
      const frame = document.getElementById('player').contentWindow;
      if (
        event.origin === '${hostOrigin}' &&
        event.source === frame &&
        event.data &&
        event.data.source === 'h5p-player-host'
      ) {
        window.received.push(event.data);
      }
    });
  </script>
</body>`;

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  });
});
test.after(async () => {
  await browser?.close();
});

// `probe()` answers the embedder's `session/probe` with a status (404, as
// where no embedder answers it, by default); `/content/7/denied.png` is
// refused as by an expired session.
async function framedPlayer(t, playerPath = 'render', probe = () => 404) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser JavaScript errors'));

  await page.route(`${parentOrigin}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: parentPage(playerPath) })
  );
  await page.route(`${hostOrigin}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (['/render', '/render-error'].includes(pathname)) {
      return route.fulfill({
        contentType: 'text/html',
        body: playerPage(pathname === '/render')
      });
    }
    if (pathname.startsWith('/core/js/')) {
      return route.fulfill({
        path: path.join(root, 'assets/h5p', pathname)
      });
    }
    if (pathname === '/web/player-bridge.js') {
      return route.fulfill({ path: path.join(root, pathname) });
    }
    if (pathname === '/session/probe') {
      return route.fulfill({ status: probe(), body: '' });
    }
    if (pathname === '/content/7/denied.png') {
      return route.fulfill({ status: 401, body: '' });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(parentOrigin);
  const frame = page.frame({ url: (url) => url.origin === hostOrigin });
  await frame.waitForFunction(() => document.readyState === 'complete');
  return { page, frame };
}

test('a framed preview reports readiness and preserves the published book parameters', async (t) => {
  const { page, frame } = await framedPlayer(t);
  await page.waitForFunction(() =>
    window.received.some((message) => message.type === 'player-ready')
  );
  assert.deepEqual(await frame.evaluate(() => window.bookParams), params);
  assert.deepEqual(
    await page.evaluate(() =>
      window.received.filter((message) => message.type === 'player-ready')
    ),
    [{ source: 'h5p-player-host', type: 'player-ready', contentId: '7' }]
  );
});

test('a preview that does not initialize reports player-error', async (t) => {
  const { page } = await framedPlayer(t, 'render-error');
  await page.waitForFunction(() =>
    window.received.some((message) => message.type === 'player-error')
  );
  assert.deepEqual(await page.evaluate(() => window.received), [
    { source: 'h5p-player-host', type: 'player-error', contentId: '7' }
  ]);
});

test('retired commands leave preview interaction and file resolution to the content', async (t) => {
  const { page, frame } = await framedPlayer(t);
  await frame.waitForSelector('#preview-action');
  // A message from the frame follows every parent command, so waiting for
  // it also waits for the commands to be delivered across the window pair.
  await frame.evaluate(() => {
    addEventListener('message', (event) => {
      if (event.data?.type === 'preview-check') {
        parent.postMessage({ checked: true }, event.origin);
      }
    });
  });
  await page.evaluate((target) => {
    window.checked = false;
    addEventListener('message', (event) => {
      if (
        event.origin === target &&
        event.source === document.getElementById('player').contentWindow &&
        event.data?.checked
      ) {
        window.checked = true;
      }
    });
    for (const message of [
      { type: 'pick-mode', enabled: true },
      { type: 'pick-clear' },
      { type: 'exam-cipher', requestId: 'c1' },
      {
        type: 'exam-media',
        requestId: 'm1',
        files: [{ path: 'images/exam.png', data: new ArrayBuffer(1) }]
      },
      { type: 'preview-check' }
    ]) {
      document
        .getElementById('player')
        .contentWindow.postMessage(
          { source: 'editor-embedder', ...message },
          target
        );
    }
  }, hostOrigin);
  await page.waitForFunction(() => window.checked);
  await frame.click('#preview-action');
  assert.equal(await frame.evaluate(() => window.previewClicks), 1);
  assert.equal(await frame.locator('[data-sub-content-id]').count(), 0);
  assert.deepEqual(await frame.evaluate(() => window.bookParams), params);
  assert.equal(
    await frame.evaluate(() =>
      Object.entries(window.coreMethods).every(
        ([name, method]) => H5P[name] === method
      )
    ),
    true
  );
  assert.deepEqual(
    await page.evaluate(() => window.received.map((message) => message.type)),
    ['player-ready']
  );
});

test('resizing the preview frame reaches the content', async (t) => {
  const { page, frame } = await framedPlayer(t);
  await frame.waitForSelector('#preview-action');
  const before = await frame.evaluate(() => window.previewResizes);
  await page.evaluate(() => {
    document.getElementById('player').style.width = '640px';
  });
  await frame.waitForFunction((count) => window.previewResizes > count, before);
});

const expiries = (page) =>
  page.evaluate(
    () =>
      window.received.filter((message) => message.type === 'session-expired')
        .length
  );

test("the start-up probe's 401 reaches the parent once", async (t) => {
  const { page } = await framedPlayer(t, 'render', () => 401);
  await page.waitForFunction(() =>
    window.received.some((message) => message.type === 'session-expired')
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.received.find((message) => message.type === 'session-expired')
    ),
    { source: 'h5p-player-host', type: 'session-expired' }
  );
});

test('an image the session refuses asks the probe, and its 401 reaches the parent once per series', async (t) => {
  const probes = [];
  const { page, frame } = await framedPlayer(t, 'render', () => {
    // The start-up probe: the session holds; it is gone afterwards.
    probes.push(probes.length ? 401 : 204);
    return probes.at(-1);
  });
  while (!probes.length) {
    await page.waitForTimeout(10);
  }
  const deny = () =>
    frame.evaluate(
      () =>
        new Promise((resolve) => {
          const img = document.createElement('img');
          img.onerror = () => setTimeout(resolve, 50);
          img.src = '/content/7/denied.png';
          document.body.append(img);
        })
    );
  await deny();
  await page.waitForFunction(() =>
    window.received.some((message) => message.type === 'session-expired')
  );
  await deny();
  await page.waitForTimeout(100);
  assert.equal(await expiries(page), 1, 'one signal per series');
  assert.deepEqual(probes, [204, 401], 'no probe once the series is reported');

  await page.evaluate((target) => {
    document
      .getElementById('player')
      .contentWindow.postMessage(
        { source: 'editor-embedder', type: 'session-renewed' },
        target
      );
  }, hostOrigin);
  await page.waitForTimeout(50);
  await deny();
  await page.waitForFunction(
    () =>
      window.received.filter((message) => message.type === 'session-expired')
        .length === 2
  );
  assert.deepEqual(probes, [204, 401, 401]);
});
