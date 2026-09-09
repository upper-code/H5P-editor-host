/*
 * The host under test, over a real socket.
 *
 * Requests go out through `http.request` rather than fetch: Node's fetch
 * normalizes `..` and `%2e%2e` out of a URL before sending it, which is
 * exactly what an attacker would not do, and several tests here are about what
 * the host makes of such a path.
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const pino = require('pino');

const createHostApp = require('../build/src/app').default;

const appRoot = path.resolve(__dirname, '..');
const log = pino({ level: 'silent' });

/** The mount every host route hangs off (the H5P_HOST_ROUTE_PREFIX default). */
const CORE = '/h5p-editor-core';

/** Credentials the stub tenant below answers to. */
const auth = { 'x-h5p-host-secret': 'dev-secret', 'x-distributor-id': 'dev1' };

/** One request, written verbatim, resolved once the whole answer is in. */
function send(port, { method = 'GET', path: requestPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { port, host: '127.0.0.1', method, path: requestPath, headers },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: text
          })
        );
      }
    );
    request.on('error', reject);
    request.end(body);
  });
}

const rawGet = (port, requestPath, headers = {}) =>
  send(port, { path: requestPath, headers });

function rawSend(port, method, requestPath, body, headers = {}) {
  const payload = JSON.stringify(body);
  return send(port, {
    method,
    path: requestPath,
    headers: {
      ...headers,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    },
    body: payload
  });
}

/**
 * A multipart POST of one or more files. Each file's `contentType` is what the
 * part declares — which is what the upload guards read, and what a crafted
 * upload lies about.
 */
function multipart(port, requestPath, files, headers = auth) {
  const boundary = 'host-test-boundary';
  const body = Buffer.concat([
    ...files.flatMap(
      ({
        name = 'file',
        filename = 'a.bin',
        contentType = 'application/octet-stream',
        data = 'x'
      }) => [
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
        ),
        Buffer.from(data),
        Buffer.from('\r\n')
      ]
    ),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
  return send(port, {
    method: 'POST',
    path: requestPath,
    headers: {
      ...headers,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.length
    },
    body
  });
}

/**
 * A TenantManager stub: enough for the guards under test to run and no more.
 * `h5pRouter` answers 599, so a request that slips through to the GPL router
 * is unmistakable in an assertion.
 */
function stubTenants({ readiness, tenant = {}, dataDirectory } = {}) {
  const uploadStagingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'host-upload-')
  );
  return {
    uploadStagingDirectory,
    // Only `GET /api/v1/pending-usage` reads this; the default keeps it a real
    // (empty) directory for every other test.
    dataDirectory: dataDirectory || uploadStagingDirectory,
    readiness: async () =>
      readiness || {
        ready: true,
        libraryCount: 144,
        storageWritable: true
      },
    get: async (distributorId) => ({
      distributorId,
      rootPath: '/tmp/dev1',
      context: {
        language_code: 'en',
        paths: { content: '/tmp/dev1/content', tmp: '/tmp/dev1/tmp' }
      },
      user: { id: 'dev1', name: 'dev', type: 'local', email: 'a@b.c' },
      h5pRouter: (req, res) => res.status(599).end(),
      ...tenant
    })
  };
}

/**
 * Runs the host on an ephemeral port for the duration of `run(port, tenants)`,
 * then closes it and removes the staging directory it was given.
 */
async function withHost(run, options = {}) {
  const tenants = stubTenants(options);
  const app = createHostApp(appRoot, log, tenants);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await run(server.address().port, tenants);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tenants.uploadStagingDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  CORE,
  appRoot,
  auth,
  log,
  multipart,
  rawGet,
  rawSend,
  send,
  stubTenants,
  withHost
};
