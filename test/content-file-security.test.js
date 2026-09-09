const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const createApp = require('../build/src/app').default;
const TenantManager = require('../build/src/tenant-manager').default;
const { tmpDir, withEnv } = require('./helpers');
const { appRoot, log } = require('./host');

test('real H5P storage rejects HTML uploads and sandboxes legacy files, SVG and Range responses', async (t) => {
  const scratch = tmpDir(t, 'host-file-security-');
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
  const base = `http://127.0.0.1:${server.address().port}/h5p-editor-core`;
  const headers = {
    'x-h5p-host-secret': 'test-secret',
    'x-distributor-id': 'review'
  };
  const upload = async (name, type, data) => {
    const body = new FormData();
    body.set('file', new Blob([data], { type }), name);
    return fetch(`${base}/api/v1/temporary-files`, {
      method: 'POST',
      headers,
      body
    });
  };
  const html = '<!doctype html><script>window.marker=true</script>';
  for (const [name, type] of [
    ['test.html', 'image/png'],
    ['test.png', 'text/html'],
    ['test.XHTML', 'application/octet-stream'],
    ['test.js', 'text/plain']
  ]) {
    const response = await upload(name, type, html);
    assert.equal(response.status, 415, name);
    await response.arrayBuffer();
  }
  // The editor's own upload route answers to the same rule; h5p-server's
  // configurable whitelist is not the only thing standing between an HTML file
  // and a URL on this origin.
  const editorUpload = new FormData();
  editorUpload.set('file', new Blob([html], { type: 'text/html' }), 'x.html');
  const viaEditor = await fetch(`${base}/h5p/ajax?action=files`, {
    method: 'POST',
    headers,
    body: editorUpload
  });
  assert.equal(viaEditor.status, 415);
  await viaEditor.arrayBuffer();
  const tenant = await tenants.get('review');
  const legacy = await tenant.context.h5pEditor.temporaryFileManager.addFile(
    'legacy.html',
    Readable.from([html]),
    tenant.user
  );
  const content = path.join(tenant.context.paths.content, '7');
  await fs.mkdir(content);
  await fs.writeFile(path.join(content, 'h5p.json'), '{"title":"Book"}');
  await fs.writeFile(path.join(content, 'content.json'), '{}');
  await fs.writeFile(path.join(content, 'legacy.html'), html);
  for (const url of [
    `h5p/temp-files/${legacy}`,
    'h5p/content/7/legacy%2Ehtml'
  ]) {
    for (const range of [undefined, 'bytes=0-15']) {
      const response = await fetch(`${base}/${url}`, {
        headers: { ...headers, ...(range ? { Range: range } : {}) }
      });
      assert.equal(response.status, range ? 206 : 200, url);
      assert.equal(response.headers.get('content-disposition'), 'attachment');
      assert.match(
        response.headers.get('content-security-policy'),
        /(?:^|;\s*)sandbox(?:;|$)/
      );
      assert.doesNotMatch(
        response.headers.get('content-security-policy'),
        /allow-scripts|allow-same-origin/
      );
      await response.arrayBuffer();
    }
  }
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>window.marker=true</script></svg>';
  const image = await upload('image.svg', 'image/svg+xml', svg);
  assert.equal(image.status, 201);
  const saved = await image.json();
  const imageResponse = await fetch(
    `${base}/h5p/temp-files/${saved.path.replace(/#tmp$/, '')}`,
    { headers }
  );
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(imageResponse.headers.get('content-security-policy'), /sandbox/);
  assert.equal(imageResponse.headers.get('content-disposition'), null);
  assert.equal(await imageResponse.text(), svg);
  const bridge = await fetch(`${base}/web/editor-host.js`, { headers });
  assert.equal(bridge.status, 200);
  assert.doesNotMatch(bridge.headers.get('content-security-policy'), /sandbox/);
  await bridge.arrayBuffer();
});
