const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

// The player bridge's exam channel between two real windows on different
// origins: the real structured clone with transferred buffers, and a blob
// URL loaded by an element, which the Node harness cannot show. The core and
// the bridge are the committed files; there is no host and no library.

const root = path.resolve(__dirname, '../..');
const parentOrigin = 'https://shelf-parent.test';
const hostOrigin = 'https://h5p-host.test';
const examPath = 'images/exam.png';
// What the host stores for an exam file: ciphertext, not an image.
const cipher = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
// A 1×1 PNG: the plain bytes the parent decrypted.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
      contentUrl: '/content/7'
    }
  }
};

// The host's page in miniature: the integration, the core scripts the bridge
// relies on, then the bridge. `H5P.preventInit` keeps the core from starting
// a library that is not there; the fetch spy keeps the buffers the bridge
// downloads, so the test can see them detached after the transfer.
const playerPage = `<!doctype html>
<html class="h5p-iframe">
  <body>
    <div class="h5p-content" data-content-id="7"></div>
    <script>window.H5PIntegration = ${JSON.stringify(integration)};</script>
    <script src="/core/js/jquery.js"></script>
    <script src="/core/js/h5p.js"></script>
    <script src="/core/js/h5p-event-dispatcher.js"></script>
    <script>
      H5P.preventInit = true;
      window.downloaded = [];
      const realFetch = window.fetch;
      window.fetch = (...args) =>
        realFetch(...args).then((response) => {
          const read = response.arrayBuffer.bind(response);
          response.arrayBuffer = () =>
            read().then((buffer) => {
              window.downloaded.push(buffer);
              return buffer;
            });
          return response;
        });
    </script>
    <script src="/web/player-bridge.js"></script>
  </body>
</html>`;

const parentPage = `<!doctype html>
<body>
  <iframe id="player" src="${hostOrigin}/render?parentOrigin=${encodeURIComponent(parentOrigin)}"></iframe>
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

async function framedPlayer(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser JavaScript errors'));

  await page.route(`${parentOrigin}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: parentPage })
  );
  await page.route(`${hostOrigin}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/render') {
      return route.fulfill({ contentType: 'text/html', body: playerPage });
    }
    if (pathname.startsWith('/core/js/')) {
      return route.fulfill({
        path: path.join(root, 'assets/h5p', pathname)
      });
    }
    if (pathname === '/web/player-bridge.js') {
      return route.fulfill({ path: path.join(root, pathname) });
    }
    if (pathname === `/content/7/${examPath}`) {
      return route.fulfill({
        contentType: 'image/png',
        body: cipher
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(parentOrigin);
  const frame = page.frame({ url: (url) => url.origin === hostOrigin });
  await frame.waitForFunction(() => document.readyState === 'complete');
  return { page, frame };
}

test('the framed bridge opens the book to the parent in a real page', async (t) => {
  const { frame } = await framedPlayer(t);
  const origins = await frame.evaluate(
    () =>
      JSON.parse(window.H5PIntegration.contents['cid-7'].jsonContent).behaviour
        .remoteOrigins
  );
  assert.deepEqual(origins, [hostOrigin, parentOrigin]);
});

test('exam-cipher hands the parent the stored bytes as transferred buffers', async (t) => {
  const { page, frame } = await framedPlayer(t);
  await page.evaluate((target) => {
    document
      .getElementById('player')
      .contentWindow.postMessage(
        { source: 'editor-embedder', type: 'exam-cipher', requestId: 'c1' },
        target
      );
  }, hostOrigin);
  await page.waitForFunction(() =>
    window.received.some((message) => message.type === 'exam-cipher')
  );
  const answer = await page.evaluate(() => {
    const message = window.received.find(
      (entry) => entry.type === 'exam-cipher'
    );
    return {
      requestId: message.requestId,
      contentId: message.contentId,
      vmbExam: message.vmbExam,
      files: message.files.map((file) => ({
        path: file.path,
        buffer: file.data instanceof ArrayBuffer,
        bytes: [...new Uint8Array(file.data)]
      }))
    };
  });
  assert.deepEqual(answer, {
    requestId: 'c1',
    contentId: '7',
    vmbExam: params.vmbExam,
    files: [{ path: examPath, buffer: true, bytes: [...cipher] }]
  });
  assert.deepEqual(
    await frame.evaluate(() =>
      window.downloaded.map((buffer) => buffer.byteLength)
    ),
    [0],
    'the frame handed its buffer over'
  );
});

test('exam-media turns an exam image into a loadable blob URL', async (t) => {
  const { page, frame } = await framedPlayer(t);
  const show = () =>
    frame.evaluate(async (file) => {
      const img = document.createElement('img');
      H5P.setSource(img, { path: file }, 7);
      document.body.append(img);
      let loaded = true;
      try {
        await img.decode();
      } catch (error) {
        loaded = false;
      }
      return { src: img.src, loaded, width: img.naturalWidth };
    }, examPath);

  // Before: the element gets the stored ciphertext, which is no image.
  const before = await show();
  assert.equal(before.src, `${hostOrigin}/content/7/${examPath}?cb=1`);
  assert.equal(before.loaded, false);

  const left = await page.evaluate(
    ({ target, file, base64 }) => {
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
      document.getElementById('player').contentWindow.postMessage(
        {
          source: 'editor-embedder',
          type: 'exam-media',
          requestId: 'm1',
          files: [{ path: file, data, type: 'image/png' }]
        },
        target,
        [data]
      );
      return data.byteLength;
    },
    { target: hostOrigin, file: examPath, base64: png }
  );
  assert.equal(left, 0, 'the parent handed its buffer over');
  await page.waitForFunction(() =>
    window.received.some((message) => message.type === 'exam-media-ready')
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.received.find((message) => message.type === 'exam-media-ready')
    ),
    {
      source: 'h5p-player-host',
      type: 'exam-media-ready',
      contentId: '7',
      requestId: 'm1',
      count: 1
    }
  );

  const after = await show();
  assert.match(after.src, /^blob:https:\/\/h5p-host\.test\//);
  assert.equal(after.loaded, true);
  assert.ok(after.width > 0);
});
