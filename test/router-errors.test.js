const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const createApp = require('../build/src/app').default;
const TenantManager = require('../build/src/tenant-manager').default;
const { tmpDir, withEnv } = require('./helpers');
const { appRoot, log } = require('./host');

/** The host over a real tenant, with h5p-express's own error handler. */
async function realHost(t) {
  const scratch = tmpDir(t, 'host-router-errors-');
  withEnv(t, {
    H5P_HOST_DATA_DIR: scratch,
    H5P_LIBRARIES_DIR: path.join(scratch, 'libraries'),
    H5P_HOST_UPLOAD_TMP_DIR: path.join(scratch, 'upload-tmp'),
    H5P_HOST_SHARED_SECRET: 'test-secret'
  });
  const tenants = new TenantManager(appRoot, log);
  await tenants.initialize();
  const server = createApp(appRoot, log, tenants).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const tenant = await tenants.get('review');
  // Unreadable stored parameters: `content.json` is a directory, so the read
  // fails with a raw EISDIR rather than an H5pError.
  const content = path.join(tenant.context.paths.content, '7');
  await fs.mkdir(path.join(content, 'content.json'), { recursive: true });
  await fs.writeFile(path.join(content, 'h5p.json'), '{"title":"Book"}');
  const base = `http://127.0.0.1:${server.address().port}/h5p-editor-core`;
  return (url) =>
    fetch(`${base}/${url}`, {
      headers: {
        'x-h5p-host-secret': 'test-secret',
        'x-distributor-id': 'review'
      }
    });
}

test('a raw error under /h5p answers 500 without its text, in the envelope the editor reads', async (t) => {
  withEnv(t, { NODE_ENV: 'production' });
  const get = await realHost(t);
  const response = await get('h5p/params/7');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    errorCode: '',
    httpStatusCode: 500,
    message: 'Editor service request failed.',
    success: false
  });

  // An H5pError the router translated for the user is a 4xx and stays as it is.
  const missing = await get('h5p/params/404');
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.success, false);
  assert.notEqual(body.message, 'Editor service request failed.');
});

test('development keeps the router error text', async (t) => {
  // Set after the tenant is built: development also turns on i18next's debug
  // output, which only floods the test log.
  const get = await realHost(t);
  withEnv(t, { NODE_ENV: 'development' });
  const response = await get('h5p/params/7');
  assert.equal(response.status, 500);
  assert.match((await response.json()).message, /EISDIR/);
});
