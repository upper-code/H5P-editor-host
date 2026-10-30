const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const pino = require('pino');

const { tmpDir } = require('./helpers');
const { CORE, auth, rawGet, withHost } = require('./host');

/*
 * What the host logs about a request that did not end in a regular answer.
 * `error` is kept for the host's own failures (5xx): a refusal (4xx) is a
 * warning, and a client that hung up mid-request is `info` — routine, and
 * an operator alerting on `error` must not be paged for either.
 */

/** A logger that keeps every line it writes, parsed. */
function capturingLog() {
  const lines = [];
  const log = pino(
    { level: 'trace' },
    { write: (line) => lines.push(JSON.parse(line)) }
  );
  return { log, lines };
}

/** The first logged line `predicate` accepts, waited for up to 5 s. */
async function lineFor(lines, predicate) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const line = lines.find(predicate);
    if (line) return line;
    if (Date.now() > deadline) {
      assert.fail(`no matching log line in ${JSON.stringify(lines)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A tenant with stored content id 1 whose export is `exportContent`, over a
 * content directory of the test's own (the download takes the content lock).
 */
function exportingTenant(t, exportContent) {
  const root = tmpDir(t, 'host-log-');
  const content = path.join(root, 'content');
  fs.mkdirSync(path.join(content, '1'), { recursive: true });
  fs.writeFileSync(path.join(content, '1', 'content.json'), '{}');
  return {
    context: {
      language_code: 'en',
      paths: { content, tmp: path.join(root, 'tmp') },
      h5pEditor: {
        getContent: async () => ({ h5p: { title: 'Book' } }),
        exportContent
      }
    }
  };
}

/**
 * Sends `head` (and `body`) on a raw socket and hangs up: at once, or once
 * the first bytes of the answer arrive (`afterFirstBytes`).
 */
async function hangUp(port, text, { afterFirstBytes = false } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  socket.write(text);
  if (afterFirstBytes) await once(socket, 'data');
  else await new Promise((resolve) => setTimeout(resolve, 50));
  socket.destroy();
}

const headers = Object.entries(auth)
  .map(([name, value]) => `${name}: ${value}\r\n`)
  .join('');

test('a refusal is logged as a warning and a failure of the host as an error', async (t) => {
  const { log, lines } = capturingLog();
  const tenant = exportingTenant(t, async (_id, stream) => {
    stream.destroy(
      Object.assign(new Error('EIO: disk failure'), { code: 'EIO' })
    );
    throw new Error('export failed');
  });
  await withHost(
    async (port) => {
      const refused = await rawGet(
        port,
        `${CORE}/api/v1/content/new/download`,
        {
          ...auth,
          connection: 'close'
        }
      );
      assert.equal(refused.status, 400, refused.body);
      const failed = await rawGet(port, `${CORE}/api/v1/content/1/download`, {
        ...auth,
        connection: 'close'
      });
      assert.equal(failed.status, 500, failed.body);
    },
    { tenant, log }
  );
  const refusal = await lineFor(lines, (line) => line.status === 400);
  assert.equal(refusal.level, 40, 'warn');
  assert.equal(refusal.msg, 'Editor service request failed');
  const failure = await lineFor(lines, (line) => line.status === 500);
  assert.equal(failure.level, 50, 'error');
  assert.equal(failure.err.message, 'export failed');
});

test('a client that hangs up mid-body or mid-download is logged at info, without a stack on stderr', async (t) => {
  const { log, lines } = capturingLog();
  // Express's final handler prints the stack of an error passed on after the
  // headers went out; a hang-up must not reach it.
  const stderr = t.mock.method(console, 'error', () => undefined);
  const tenant = exportingTenant(t, async (_id, stream) => {
    // Far more than the socket buffers take, so the client is gone while
    // the response is still being written.
    stream.end(Buffer.alloc(32 * 1024 * 1024));
  });
  await withHost(
    async (port) => {
      // A save whose body stops short of its Content-Length.
      await hangUp(
        port,
        `PATCH ${CORE}/api/v1/content/new HTTP/1.1\r\nHost: host\r\n${headers}` +
          'content-type: application/json\r\ncontent-length: 1000\r\n\r\n{"lib'
      );
      const body = await lineFor(
        lines,
        (line) => line.err?.message === 'request aborted'
      );
      assert.equal(body.level, 30, 'info');
      assert.equal(body.msg, 'Editor service request abandoned by the client');

      await hangUp(
        port,
        `GET ${CORE}/api/v1/content/1/download HTTP/1.1\r\nHost: host\r\n${headers}\r\n`,
        { afterFirstBytes: true }
      );
      const download = await lineFor(lines, (line) =>
        line.path?.endsWith('/download')
      );
      assert.equal(download.level, 30, 'info');
      assert.equal(download.err.code, 'ERR_STREAM_PREMATURE_CLOSE');
      // The host has nothing else left to do with the request.
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    { tenant, log }
  );
  assert.equal(
    lines.filter((line) => line.level >= 40).length,
    0,
    JSON.stringify(lines)
  );
  assert.equal(stderr.mock.callCount(), 0);
});
