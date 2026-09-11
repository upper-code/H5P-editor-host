const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
  transactionalContentStorage
} = require('../build/src/content-transactions');
const { tmpDir, withEnv } = require('./helpers');
const { CORE, auth, multipart, rawGet, rawSend, withHost } = require('./host');

// What h5p-server throws for an unknown content id: an H5pError whose message
// is an internal error id, with the HTTP status beside it.
function missingContent(contentId) {
  return Object.assign(
    new Error(
      `content-file-missing (filename: h5p.json, contentId: ${contentId})`
    ),
    { httpStatusCode: 404 }
  );
}

// A tenant whose editor really writes content to a temp directory, so the
// PATCH route's size accounting can be observed end to end. The "editor" and
// "player" are stubs of the h5p-server methods the content routes call, but
// the storage under them is the real transactional proxy the tenant factory
// installs, so a save inside a content transaction lands in the transaction's
// staging directory and only becomes visible when it commits.
function writingTenant(t) {
  const dataRoot = tmpDir(t, 'host-data-');
  const root = path.join(dataRoot, 'dev1');
  const content = path.join(root, 'content');
  fs.mkdirSync(content, { recursive: true });
  const contentStorage = transactionalContentStorage(content);
  const user = { id: 'dev1', name: 'dev', type: 'local', email: 'a@b.c' };
  let nextId = 7;
  const directory = (id) => path.join(content, String(id));
  const exists = (id) =>
    fs.existsSync(path.join(directory(id), 'content.json'));
  // Inside a transaction the proxy substitutes the transaction's own id.
  const write = async (id, params, metadata) =>
    String(
      await contentStorage.addContent(
        metadata || {},
        params,
        user,
        id || String(nextId++)
      )
    );
  const h5pEditor = {
    contentStorage,
    async saveOrUpdateContentReturnMetaData(id, params, metadata) {
      return { id: await write(id, params, metadata), metadata };
    },
    async saveOrUpdateContent(id, params, metadata) {
      return write(id, params, metadata);
    },
    async render() {
      return { scripts: [], styles: [], integration: {} };
    },
    async getContent(id) {
      if (!exists(id)) throw missingContent(id);
      return {
        h5p: { title: 'Book' },
        library: 'H5P.Column 1.18',
        params: { params: {}, metadata: {} }
      };
    },
    async deleteContent(id) {
      if (!exists(id)) throw missingContent(id);
      fs.rmSync(directory(id), { recursive: true, force: true });
    },
    async exportContent(id, stream) {
      if (!exists(id)) throw missingContent(id);
      stream.end('h5p');
    }
  };
  const h5pPlayer = {
    async render(id) {
      if (!exists(id)) throw missingContent(id);
      return { integration: {}, scripts: [], styles: [], contentId: id };
    }
  };
  return {
    dataRoot,
    root,
    tenant: {
      rootPath: root,
      context: {
        language_code: 'en',
        paths: { content, tmp: path.join(root, 'tmp') },
        h5pEditor,
        h5pPlayer
      }
    }
  };
}

test('the edit and render routes reject a traversal content id', async () => {
  await withHost(async (port) => {
    for (const id of ['..', '%2e%2e', '.', 'abc']) {
      const edit = await rawGet(
        port,
        `${CORE}/api/v1/content/${id}/edit`,
        auth
      );
      assert.equal(edit.status, 400, `edit ${id}`);
      const render = await rawGet(
        port,
        `${CORE}/api/v1/content/${id}/render`,
        auth
      );
      assert.equal(render.status, 400, `render ${id}`);
    }
  });
});

test('the H5P AJAX namespace rejects a traversal id before the GPL router', async () => {
  await withHost(async (port) => {
    const encoded = await rawGet(
      port,
      `${CORE}/h5p/content/%2e%2e/secret.png`,
      auth
    );
    assert.equal(encoded.status, 400);
    const literal = await rawGet(
      port,
      `${CORE}/h5p/content/../secret.png`,
      auth
    );
    assert.equal(literal.status, 400);
  });
});

test('the per-viewer state route answers "nothing stored" instead of the GPL router\'s 403', async () => {
  await withHost(async (port) => {
    // What the editor core sends for every field with an "important
    // description" panel (h5peditor.js ns.storage): content id 0, no state.
    const key = `${CORE}/h5p/contentUserData/0/H5P-Blanks-question-important-description-open/0`;
    const read = await rawGet(port, key, auth);
    assert.equal(read.status, 200);
    assert.deepEqual(JSON.parse(read.body), { success: true, data: false });

    const write = await rawSend(port, 'POST', key, { data: 'true' }, auth);
    assert.equal(write.status, 200);
    assert.deepEqual(JSON.parse(write.body), { success: true });

    // Other methods and the rest of the namespace still reach the router.
    const other = await rawSend(port, 'DELETE', key, {}, auth);
    assert.equal(other.status, 599);
    const ajax = await rawGet(port, `${CORE}/h5p/ajax?action=libraries`, auth);
    assert.equal(ajax.status, 599);
  });
});

test('the host answers only with a valid shared secret', async () => {
  await withHost(async (port) => {
    const anonymous = await rawGet(port, `${CORE}/api/v1/contents`);
    assert.equal(anonymous.status, 401);
    const wrongTenant = await rawGet(port, `${CORE}/api/v1/contents`, {
      'x-h5p-host-secret': 'dev-secret',
      'x-distributor-id': '../escape'
    });
    assert.equal(wrongTenant.status, 400);
  });
});

test('readiness reports provisioning state; health only reports liveness', async () => {
  await withHost(async (port) => {
    const health = await rawGet(port, '/health');
    assert.equal(health.status, 200);
    const ready = await rawGet(port, '/ready');
    assert.equal(ready.status, 200);
    const body = JSON.parse(ready.body);
    assert.equal(body.libraryCount, 144);
    // The embedder compares this with the version it was built against.
    assert.equal(body.contractVersion, 3);
    // No H5P_HOST_ALLOWED_PARENTS configured: `frame-ancestors 'self'` only.
    assert.deepEqual(body.allowedParents, []);
  });

  await withHost(
    async (port) => {
      const ready = await rawGet(port, '/ready');
      assert.equal(ready.status, 503, 'no libraries means not ready');
      assert.equal(JSON.parse(ready.body).status, 'not-ready');
    },
    {
      readiness: {
        ready: false,
        libraryCount: 0,
        librariesPath: '/tmp/libs',
        storageWritable: true
      }
    }
  );
});

test('every response pins who may frame this service', async () => {
  await withHost(async (port) => {
    const { headers } = await rawGet(port, '/health');
    assert.equal(headers['content-security-policy'], "frame-ancestors 'self'");
    assert.equal(headers['x-content-type-options'], 'nosniff');
  });
});

test('a configured parent allowlist pins who the editor page may talk to', async (t) => {
  withEnv(t, { H5P_HOST_ALLOWED_PARENTS: 'https://shelf.example' });
  await withHost(async (port) => {
    const { headers } = await rawGet(port, '/health');
    assert.equal(
      headers['content-security-policy'],
      'frame-ancestors https://shelf.example'
    );

    // The page echoes `parentOrigin` back as its postMessage target, so an
    // origin outside the allowlist must never be served.
    const foreign = await rawGet(
      port,
      `${CORE}/editor/5?parentOrigin=https%3A%2F%2Fevil.test`,
      auth
    );
    assert.equal(foreign.status, 400);

    const allowed = await rawGet(
      port,
      `${CORE}/editor/5?parentOrigin=https%3A%2F%2Fshelf.example`,
      auth
    );
    assert.equal(allowed.status, 200);

    // Readiness advertises the same allowlist so an embedder on a sibling
    // origin can confirm at boot that it is actually permitted to frame this.
    const ready = await rawGet(port, `${CORE}/api/v1/readiness`, auth);
    assert.deepEqual(JSON.parse(ready.body).allowedParents, [
      'https://shelf.example'
    ]);
  });
});

test('the editor save takes the flat body shape and reports the size delta', async (t) => {
  const { tenant } = writingTenant(t);
  await withHost(
    async (port) => {
      const created = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        {
          library: 'H5P.Column 1.18',
          params: { content: 'x'.repeat(100) },
          metadata: { title: 'Book' }
        },
        auth
      );
      assert.equal(created.status, 200, created.body);
      const first = JSON.parse(created.body);
      assert.match(first.contentId, /^\d+$/);
      assert.equal(first.metadata.title, 'Book');
      assert.ok(first.savedBytes > 100, 'the written content is measured');
      assert.equal(
        first.deltaBytes,
        first.savedBytes,
        'new content: delta = size'
      );

      // Saving a smaller revision of the same content yields a negative delta.
      const updated = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/${first.contentId}`,
        {
          library: 'H5P.Column 1.18',
          params: { content: 'x' },
          metadata: { title: 'Book' }
        },
        auth
      );
      assert.equal(updated.status, 200, updated.body);
      const second = JSON.parse(updated.body);
      assert.equal(second.contentId, first.contentId);
      assert.ok(second.savedBytes < first.savedBytes);
      assert.equal(second.deltaBytes, second.savedBytes - first.savedBytes);

      // The contract is a flat { library, params, metadata } body; the nested
      // `params.params` wrapper is rejected with a 400.
      const nested = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        { params: { params: {}, metadata: {} } },
        auth
      );
      assert.equal(nested.status, 400);
      const undefinedId = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/undefined`,
        { library: 'x', params: {}, metadata: {} },
        auth
      );
      assert.equal(undefinedId.status, 400);
    },
    { tenant }
  );
});

test('the content listing dates an item by its content.json, which every save rewrites', async (t) => {
  const { tenant } = writingTenant(t);
  await withHost(
    async (port) => {
      const created = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        {
          library: 'H5P.Column 1.18',
          params: { content: 'x' },
          metadata: { title: 'Dated' }
        },
        auth
      );
      assert.equal(created.status, 200, created.body);
      const { contentId } = JSON.parse(created.body);
      // h5p-server rewrites content.json in place: the file moves, the
      // directory's own mtime does not. Make the two disagree on purpose.
      const directory = path.join(tenant.context.paths.content, contentId);
      const savedAt = new Date('2026-01-02T03:04:05.000Z');
      fs.utimesSync(path.join(directory, 'content.json'), savedAt, savedAt);
      const listed = await rawGet(port, `${CORE}/api/v1/contents`, auth);
      assert.equal(listed.status, 200, listed.body);
      const [item] = JSON.parse(listed.body).content;
      assert.equal(item.id, contentId);
      assert.equal(item.updatedAt, savedAt.toISOString());
    },
    { tenant }
  );
});

test('tenant files are marked private for caches; the request id is echoed', async () => {
  await withHost(async (port) => {
    const headers = { ...auth, 'x-request-id': 'trace-7' };
    const content = await rawGet(
      port,
      `${CORE}/h5p/content/1/images/a.png`,
      headers
    );
    assert.equal(content.status, 599, 'reached the (stub) GPL router');
    assert.equal(content.headers['cache-control'], 'private, no-store');
    assert.equal(content.headers['x-request-id'], 'trace-7');
    const library = await rawGet(
      port,
      `${CORE}/h5p/libraries/H5P.X-1.0/x.js`,
      headers
    );
    assert.equal(library.status, 599);
    assert.equal(library.headers['cache-control'], undefined);
    // A malformed id is not echoed back.
    const odd = await rawGet(port, `${CORE}/licenses`, {
      ...auth,
      'x-request-id': 'not valid!'
    });
    assert.equal(odd.headers['x-request-id'], undefined);
  });
});

test('a crafted image upload is refused before the GPL router runs', async () => {
  await withHost(async (port) => {
    // Declared as a PNG, ICNS on the wire: the bytes are what decides.
    const response = await multipart(port, `${CORE}/h5p/ajax?action=files`, [
      {
        filename: 'a.png',
        contentType: 'image/png',
        data: Buffer.concat([Buffer.from('icns'), Buffer.alloc(64)])
      }
    ]);
    assert.equal(response.status, 415, response.body);
    assert.match(response.body, /ICNS images are not accepted/);
  });
});

test('both save endpoints reject malformed flat payloads before calling H5P', async () => {
  await withHost(async (port) => {
    const valid = { library: 'H5P.Column 1.18', params: {}, metadata: {} };
    const invalid = [
      null,
      [],
      'text',
      {},
      ...['library', 'params', 'metadata'].flatMap((field) =>
        [null, true, 1, []].map((value) => ({ ...valid, [field]: value }))
      ),
      { ...valid, library: '  ' },
      { ...valid, params: 'text' },
      { ...valid, metadata: 'text' }
    ];
    for (const [method, endpoint] of [
      ['PATCH', 'content/new'],
      ['POST', 'generated-content']
    ]) {
      for (const body of invalid) {
        const response = await rawSend(
          port,
          method,
          `${CORE}/api/v1/${endpoint}`,
          body,
          auth
        );
        assert.equal(
          response.status,
          400,
          `${endpoint}: ${JSON.stringify(body)}: ${response.body}`
        );
      }
    }
  });
});

test('all tenant responses forbid storage in caches, including case variants', async () => {
  await withHost(async (port) => {
    for (const suffix of [
      'editor/new',
      'api/v1/contents',
      'api/v1/content/1/render',
      'h5p/params/1',
      'h5p/download/1',
      'H5P/CONTENT/1/a.png',
      'h5p/TEMP-FILES/a.png'
    ]) {
      const response = await rawGet(port, `${CORE}/${suffix}`, auth);
      assert.equal(
        response.headers['cache-control'],
        'private, no-store',
        suffix
      );
    }
  });
});

test('the temp quota includes incoming bytes on API, import and editor uploads', async (t) => {
  withEnv(t, { H5P_HOST_MAX_TEMP_BYTES: '10' });
  const { tenant } = writingTenant(t);
  fs.mkdirSync(tenant.context.paths.tmp);
  fs.writeFileSync(path.join(tenant.context.paths.tmp, 'existing'), '12345678');
  await withHost(
    async (port) => {
      for (const endpoint of [
        'api/v1/temporary-files',
        'api/v1/import/h5p',
        'h5p/ajax?action=files'
      ]) {
        const response = await multipart(port, `${CORE}/${endpoint}`, [
          { filename: 'a.h5p', data: 'abc' }
        ]);
        assert.equal(response.status, 413, response.body);
      }
      const fits = await multipart(port, `${CORE}/h5p/ajax?action=files`, [
        { data: 'ab' }
      ]);
      assert.equal(fits.status, 599, fits.body);
    },
    { tenant }
  );
});

test('pending uploads reserve quota and release it when the response finishes', async (t) => {
  withEnv(t, { H5P_HOST_MAX_TEMP_BYTES: '10' });
  const { tenant } = writingTenant(t);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  tenant.h5pRouter = async (req, res) => {
    if (req.tenant.distributorId !== 'dev1') {
      res.status(204).end();
      return;
    }
    entered.resolve();
    await finish.promise;
    res.status(204).end();
  };
  await withHost(
    async (port) => {
      const first = multipart(port, `${CORE}/h5p/ajax`, [{ data: '123456' }]);
      try {
        await entered.promise;
        const second = await multipart(port, `${CORE}/api/v1/temporary-files`, [
          { data: '123456' }
        ]);
        assert.equal(second.status, 413, second.body);
        const other = await multipart(
          port,
          `${CORE}/h5p/ajax`,
          [{ data: '123456' }],
          {
            ...auth,
            'x-distributor-id': 'dev2'
          }
        );
        assert.equal(
          other.status,
          204,
          'another tenant has its own reservation budget'
        );
      } finally {
        finish.resolve();
        await first;
      }
      const retry = await multipart(port, `${CORE}/h5p/ajax`, [
        { data: '123456' }
      ]);
      assert.equal(retry.status, 204, retry.body);
    },
    { tenant }
  );
});

test('multipart cleanup removes files from every field, also on a rejected request', async () => {
  await withHost(async (port, tenants) => {
    const response = await multipart(port, `${CORE}/api/v1/temporary-files`, [
      { name: 'unexpected', data: 'one' },
      { name: 'unexpected', data: 'two' },
      { name: 'another', data: 'three' }
    ]);
    assert.equal(response.status, 400, response.body);
    // Cleanup is asynchronous after the response closes.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (fs.readdirSync(tenants.uploadStagingDirectory).length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(fs.readdirSync(tenants.uploadStagingDirectory), []);
  });
});

test('an over-large multipart request is refused before anything is staged', async (t) => {
  withEnv(t, { H5P_HOST_MAX_MULTIPART_BYTES: '1000' });
  await withHost(async (port, tenants) => {
    const over = await multipart(port, `${CORE}/h5p/ajax?action=files`, [
      { data: 'x'.repeat(2000) }
    ]);
    assert.equal(over.status, 413, over.body);
    // The guard runs before express-fileupload, so the request never reached
    // the staging directory at all.
    assert.deepEqual(fs.readdirSync(tenants.uploadStagingDirectory), []);
    // A request within the limit still reaches the GPL router (599 stub).
    const fits = await multipart(port, `${CORE}/h5p/ajax?action=files`, [
      { data: 'x' }
    ]);
    assert.equal(fits.status, 599, fits.body);
  });
});

test('a multipart request over the file-count limit is refused and cleaned up', async (t) => {
  withEnv(t, { H5P_HOST_MAX_UPLOAD_FILES: '1' });
  await withHost(async (port, tenants) => {
    const many = await multipart(port, `${CORE}/h5p/ajax?action=files`, [
      { data: 'a' },
      { data: 'b' }
    ]);
    assert.equal(many.status, 413, many.body);
    // Cleanup is asynchronous after the response closes.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (fs.readdirSync(tenants.uploadStagingDirectory).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(fs.readdirSync(tenants.uploadStagingDirectory), []);
    // A request within the limit reaches the GPL router (599 stub).
    const one = await multipart(port, `${CORE}/h5p/ajax?action=files`, [
      { data: 'a' }
    ]);
    assert.equal(one.status, 599, one.body);
  });
});

test('the download route packages content and streams it as an attachment', async (t) => {
  const { tenant, root } = writingTenant(t);
  // Make content id 1 exist for the getContent/exportContent stubs.
  const dir = path.join(root, 'content', '1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'content.json'), '{}');
  await withHost(
    async (port) => {
      // `Connection: close` so the socket ends with the response instead of
      // lingering keep-alive into `withHost`'s `server.close()`; this is the
      // one streamed response in the suite, and a kept-alive one races that
      // teardown into a multi-second wait.
      const response = await rawGet(port, `${CORE}/api/v1/content/1/download`, {
        ...auth,
        connection: 'close'
      });
      assert.equal(response.status, 200, response.body);
      // The stub writes 'h5p'; the route builds that into a temp file under a
      // brief shared lock and streams the file out with the lock released, so
      // the bytes, the download filename and the known length all survive the
      // round trip through the temp file.
      assert.equal(response.body, 'h5p');
      assert.match(
        response.headers['content-disposition'],
        /attachment; filename="Book.h5p"/
      );
      assert.equal(response.headers['content-length'], '3');
    },
    { tenant }
  );
});

test('an unknown content id answers a uniform 404 without h5p-server internals', async (t) => {
  const { tenant } = writingTenant(t);
  await withHost(
    async (port) => {
      const attempts = [
        ['GET', 'content/404/edit'],
        ['GET', 'content/404/render'],
        ['GET', 'content/404/download'],
        ['DELETE', 'content/404']
      ];
      for (const [method, suffix] of attempts) {
        const response =
          method === 'GET'
            ? await rawGet(port, `${CORE}/api/v1/${suffix}`, auth)
            : await rawSend(port, method, `${CORE}/api/v1/${suffix}`, {}, auth);
        assert.equal(
          response.status,
          404,
          `${method} ${suffix}: ${response.body}`
        );
        assert.deepEqual(
          JSON.parse(response.body),
          { error: 'Content not found.', detail: 'Content not found.' },
          `${method} ${suffix} must not echo the internal error id`
        );
      }
    },
    { tenant }
  );
});

test('a save whose size measurement fails publishes nothing, so a retry adds no copy', async (t) => {
  const { root, tenant } = writingTenant(t);
  const original = fsp.lstat;
  // Fails the measurement of the *staged* write — the last step before the
  // transaction publishes it — while the measurement of the stored content
  // that precedes it still succeeds.
  const staging = path.join(root, 'operations');
  let failStaged = false;
  t.mock.method(fsp, 'lstat', async (filename, ...args) => {
    if (failStaged && String(filename).startsWith(staging)) {
      throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' });
    }
    return original(filename, ...args);
  });
  const body = {
    library: 'H5P.Column 1.18',
    params: { content: 'x' },
    metadata: { title: 'Book' }
  };
  const contentDir = tenant.context.paths.content;
  const stored = (id) =>
    JSON.parse(
      fs.readFileSync(path.join(contentDir, id, 'content.json'), 'utf8')
    );
  await withHost(
    async (port) => {
      for (const [method, endpoint, ok] of [
        ['PATCH', 'content/new', 200],
        ['POST', 'generated-content', 201]
      ]) {
        failStaged = true;
        const failed = await rawSend(
          port,
          method,
          `${CORE}/api/v1/${endpoint}`,
          body,
          auth
        );
        assert.equal(failed.status, 500, failed.body);
        assert.deepEqual(
          fs.readdirSync(contentDir),
          [],
          `${endpoint}: the item nobody can be told about never appears`
        );
        failStaged = false;
        const retried = await rawSend(
          port,
          method,
          `${CORE}/api/v1/${endpoint}`,
          body,
          auth
        );
        assert.equal(retried.status, ok, retried.body);
        const { contentId } = JSON.parse(retried.body);
        assert.deepEqual(
          fs.readdirSync(contentDir),
          [contentId],
          `${endpoint}: exactly one item after the retry`
        );
        fs.rmSync(path.join(contentDir, contentId), {
          recursive: true,
          force: true
        });
      }
      // An update that cannot be measured leaves the stored revision as it was:
      // the transaction stages the new one and discards it (contract version 3;
      // before that the half-reported update stayed written).
      const created = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        auth
      );
      const { contentId } = JSON.parse(created.body);
      assert.deepEqual(stored(contentId), { content: 'x' });
      failStaged = true;
      const unmeasured = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/${contentId}`,
        { ...body, params: { content: 'xy' } },
        auth
      );
      assert.equal(unmeasured.status, 500, unmeasured.body);
      assert.deepEqual(fs.readdirSync(contentDir), [contentId]);
      assert.deepEqual(
        stored(contentId),
        { content: 'x' },
        'the stored revision is untouched'
      );
      // And the retry, once the measurement works again, does apply it.
      failStaged = false;
      const retried = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/${contentId}`,
        { ...body, params: { content: 'xy' } },
        auth
      );
      assert.equal(retried.status, 200, retried.body);
      assert.deepEqual(stored(contentId), { content: 'xy' });
    },
    { tenant }
  );
});

test('an upload whose bytes have already landed is not counted a second time against a concurrent one', async (t) => {
  withEnv(t, { H5P_HOST_MAX_TEMP_BYTES: '10' });
  const { tenant } = writingTenant(t);
  fs.mkdirSync(tenant.context.paths.tmp);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let handled = 0;
  // Like H5P's temporary storage: the bytes reach `tmp/` while the request is
  // still being answered.
  tenant.h5pRouter = async (req, res) => {
    handled += 1;
    fs.copyFileSync(
      req.files.file.tempFilePath,
      path.join(tenant.context.paths.tmp, `upload-${handled}`)
    );
    if (handled === 1) {
      entered.resolve();
      await finish.promise;
    }
    res.status(204).end();
  };
  await withHost(
    async (port) => {
      const first = multipart(port, `${CORE}/h5p/ajax`, [{ data: '123456' }]);
      try {
        await entered.promise;
        // On disk 6, reserved 6 + 1: a scan would make that 13, the truth is 7.
        const second = await multipart(port, `${CORE}/h5p/ajax`, [
          { data: '1' }
        ]);
        assert.equal(second.status, 204, second.body);
        // The first upload's reservation still counts: 6 + 1 + 4 exceeds the cap.
        const third = await multipart(port, `${CORE}/h5p/ajax`, [
          { data: '1234' }
        ]);
        assert.equal(third.status, 413, third.body);
      } finally {
        finish.resolve();
        await first;
      }
      // Idle again: measured afresh, 7 bytes on disk.
      const over = await multipart(port, `${CORE}/h5p/ajax`, [
        { data: '1234' }
      ]);
      assert.equal(over.status, 413, over.body);
      const fits = await multipart(port, `${CORE}/h5p/ajax`, [{ data: '123' }]);
      assert.equal(fits.status, 204, fits.body);
    },
    { tenant }
  );
});

// --- Contract version 3: the per-tenant mutation lock ---

test('mutations are serialized per tenant while reads run alongside them', async (t) => {
  const { tenant } = writingTenant(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const save = tenant.context.h5pEditor.saveOrUpdateContentReturnMetaData;
  let holding = false;
  tenant.context.h5pEditor.saveOrUpdateContentReturnMetaData = async (
    ...args
  ) => {
    if (!holding) {
      holding = true;
      entered.resolve();
      await release.promise;
    }
    return save(...args);
  };
  const body = {
    library: 'H5P.Column 1.18',
    params: { content: 'x' },
    metadata: { title: 'Book' }
  };
  await withHost(
    async (port) => {
      const first = rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        auth
      );
      try {
        await entered.promise;
        // The editor page, its assets and every read must not queue behind a
        // save: they are what a browser asks for *during* one, and the save
        // itself is answered only after them.
        assert.equal(
          (await rawGet(port, `${CORE}/editor/new`, auth)).status,
          200
        );
        assert.equal(
          (await rawGet(port, `${CORE}/web/editor-host.js`, auth)).status,
          200
        );
        assert.equal(
          (await rawGet(port, `${CORE}/api/v1/contents`, auth)).status,
          200
        );
        assert.equal(
          (await rawGet(port, `${CORE}/api/v1/readiness`, auth)).status,
          200
        );

        let secondAnswered = false;
        const second = rawSend(
          port,
          'PATCH',
          `${CORE}/api/v1/content/new`,
          body,
          auth
        ).then((response) => {
          secondAnswered = true;
          return response;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(
          secondAnswered,
          false,
          'a second mutation waits for the first'
        );
        release.resolve();
        assert.equal((await first).status, 200, (await first).body);
        assert.equal((await second).status, 200, (await second).body);
      } finally {
        release.resolve();
        await first;
      }
    },
    { tenant }
  );
});

test('a mutation that waits too long for its turn is refused rather than hung', async (t) => {
  withEnv(t, { H5P_HOST_MUTATION_WAIT_MS: '25' });
  const { tenant } = writingTenant(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const save = tenant.context.h5pEditor.saveOrUpdateContentReturnMetaData;
  let holding = false;
  tenant.context.h5pEditor.saveOrUpdateContentReturnMetaData = async (
    ...args
  ) => {
    if (!holding) {
      holding = true;
      entered.resolve();
      await release.promise;
    }
    return save(...args);
  };
  const body = {
    library: 'H5P.Column 1.18',
    params: { content: 'x' },
    metadata: { title: 'Book' }
  };
  await withHost(
    async (port) => {
      const first = rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        auth
      );
      try {
        await entered.promise;
        // 503, so the embedder retries; the reason stays out of the body like
        // every other 5xx (createErrorHandler).
        const queued = await rawSend(
          port,
          'PATCH',
          `${CORE}/api/v1/content/new`,
          body,
          auth
        );
        assert.equal(queued.status, 503, queued.body);
      } finally {
        release.resolve();
        assert.equal((await first).status, 200);
      }
      // Giving up the turn must not leave the queue blocked.
      const after = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        auth
      );
      assert.equal(after.status, 200, after.body);
    },
    { tenant }
  );
});

// --- Contract version 3: operations, acknowledgement and pending usage ---

test('a completed write is pending until it is acknowledged', async (t) => {
  const { dataRoot, root, tenant } = writingTenant(t);
  const body = {
    library: 'H5P.Column 1.18',
    params: { content: 'x' },
    metadata: { title: 'Book' }
  };
  await withHost(
    async (port) => {
      const saved = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        auth
      );
      assert.equal(saved.status, 200, saved.body);
      const { operationId, contentId, deltaBytes } = JSON.parse(saved.body);
      assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
      assert.deepEqual(fs.readdirSync(path.join(root, 'operations')), [
        operationId
      ]);

      const read = await rawGet(
        port,
        `${CORE}/api/v1/operations/${operationId}`,
        auth
      );
      assert.equal(read.status, 200, read.body);
      assert.equal(JSON.parse(read.body).contentId, contentId);

      const pending = await rawGet(port, `${CORE}/api/v1/pending-usage`, auth);
      assert.equal(pending.status, 200, pending.body);
      assert.deepEqual(
        JSON.parse(pending.body).pending.map((item) => [
          item.distributorId,
          item.reason,
          item.operationId,
          item.deltaBytes
        ]),
        [['dev1', 'editor-save', operationId, deltaBytes]]
      );

      const ack = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/operations/${operationId}/ack`,
        {},
        auth
      );
      assert.equal(ack.status, 200, ack.body);
      const afterAck = await rawGet(port, `${CORE}/api/v1/pending-usage`, auth);
      assert.deepEqual(JSON.parse(afterAck.body).pending, []);
      // The record survives the acknowledgement grace period, so the reconciler
      // and the request's own inline call can both acknowledge it.
      const again = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/operations/${operationId}/ack`,
        {},
        auth
      );
      assert.equal(again.status, 200, again.body);
    },
    { tenant, dataDirectory: dataRoot }
  );
});

test('the same idempotency key answers once and writes once', async (t) => {
  const { tenant } = writingTenant(t);
  const key = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  const body = {
    library: 'H5P.Column 1.18',
    params: { content: 'x' },
    metadata: { title: 'Book' }
  };
  const headers = { ...auth, 'idempotency-key': key };
  await withHost(
    async (port) => {
      const first = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        headers
      );
      assert.equal(first.status, 200, first.body);
      const replay = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        headers
      );
      assert.equal(replay.status, 200, replay.body);
      assert.deepEqual(
        JSON.parse(replay.body),
        JSON.parse(first.body),
        'the first answer is repeated'
      );
      assert.deepEqual(
        fs.readdirSync(tenant.context.paths.content),
        [JSON.parse(first.body).contentId],
        'and nothing was written a second time'
      );
      // The same key for different content is a conflict, not a silent overwrite.
      const other = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        { ...body, params: { content: 'other' } },
        headers
      );
      assert.equal(other.status, 409, other.body);
    },
    { tenant }
  );
});

test('an operation that has not completed can be neither read nor acknowledged', async (t) => {
  const { root, tenant } = writingTenant(t);
  const id = '00000000-0000-4000-8000-000000000001';
  fs.mkdirSync(path.join(root, 'operations', id), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'operations', id, 'record.json'),
    JSON.stringify({
      fingerprint: 'x',
      state: 'prepared',
      reason: 'editor-save',
      deleted: false,
      result: { operationId: id, contentId: '7', savedBytes: 1, deltaBytes: 1 }
    })
  );
  await withHost(
    async (port) => {
      for (const [method, suffix] of [
        ['GET', ''],
        ['POST', '/ack']
      ]) {
        const response =
          method === 'GET'
            ? await rawGet(
                port,
                `${CORE}/api/v1/operations/${id}${suffix}`,
                auth
              )
            : await rawSend(
                port,
                method,
                `${CORE}/api/v1/operations/${id}${suffix}`,
                {},
                auth
              );
        assert.equal(
          response.status,
          404,
          `${method} ${suffix}: ${response.body}`
        );
      }
      const unknown = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/operations/00000000-0000-4000-8000-000000000002/ack`,
        {},
        auth
      );
      assert.equal(unknown.status, 404, unknown.body);
      const malformed = await rawGet(
        port,
        `${CORE}/api/v1/operations/not-a-uuid`,
        auth
      );
      assert.equal(malformed.status, 400, malformed.body);
    },
    { tenant }
  );
});

test('the usage reason is an allowlist, and the byte allowance a number', async (t) => {
  const { tenant } = writingTenant(t);
  const body = {
    library: 'H5P.Column 1.18',
    params: { content: 'x' },
    metadata: { title: 'Book' }
  };
  await withHost(
    async (port) => {
      const created = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        auth
      );
      const { contentId } = JSON.parse(created.body);
      for (const reason of ['made-up', 'ROLLBACK', '']) {
        const refused = await rawSend(
          port,
          'DELETE',
          `${CORE}/api/v1/content/${contentId}`,
          {},
          { ...auth, 'x-usage-reason': reason }
        );
        assert.equal(refused.status, 400, `${reason}: ${refused.body}`);
      }
      const bad = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/${contentId}`,
        body,
        { ...auth, 'x-max-delta-bytes': '-1' }
      );
      assert.equal(bad.status, 400, bad.body);
      const tight = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/${contentId}`,
        { ...body, params: { content: 'x'.repeat(500) } },
        { ...auth, 'x-max-delta-bytes': '1' }
      );
      assert.equal(tight.status, 413, tight.body);
      const removed = await rawSend(
        port,
        'DELETE',
        `${CORE}/api/v1/content/${contentId}`,
        {},
        { ...auth, 'x-usage-reason': 'rollback' }
      );
      assert.equal(removed.status, 200, removed.body);
      assert.ok(JSON.parse(removed.body).removedBytes > 0);
      assert.deepEqual(fs.readdirSync(tenant.context.paths.content), []);
    },
    { tenant }
  );
});

test('a save is refused when the content changed since the revision it matched', async (t) => {
  const { tenant } = writingTenant(t);
  const body = {
    library: 'H5P.Column 1.18',
    params: { content: 'x' },
    metadata: { title: 'Book' }
  };
  await withHost(
    async (port) => {
      const created = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        auth
      );
      const { contentId, revision } = JSON.parse(created.body);
      assert.match(revision, /^[0-9a-f]{64}$/);
      const edit = await rawGet(
        port,
        `${CORE}/api/v1/content/${contentId}/edit`,
        auth
      );
      assert.equal(
        JSON.parse(edit.body).revision,
        revision,
        'the editor is told what to match'
      );

      const updated = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/${contentId}`,
        { ...body, params: { content: 'y' } },
        { ...auth, 'if-match': revision }
      );
      assert.equal(updated.status, 200, updated.body);
      const stale = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/${contentId}`,
        { ...body, params: { content: 'z' } },
        { ...auth, 'if-match': revision }
      );
      assert.equal(stale.status, 409, stale.body);
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(
            path.join(tenant.context.paths.content, contentId, 'content.json'),
            'utf8'
          )
        ),
        { content: 'y' },
        'the rejected save changed nothing'
      );
    },
    { tenant }
  );
});

test('incomplete content is rejected without issuing a misleading revision', async (t) => {
  const { tenant } = writingTenant(t);
  // A directory H5P created but did not finish filling in.
  const partial = path.join(tenant.context.paths.content, '4242');
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(path.join(partial, 'content.json'), '{}');
  await withHost(
    async (port) => {
      const edit = await rawGet(port, `${CORE}/api/v1/content/4242/edit`, auth);
      assert.equal(edit.status, 500, edit.body);
    },
    { tenant }
  );
});

test('authenticated readiness reports the contract without the library path', async () => {
  await withHost(async (port) => {
    const response = await rawGet(port, `${CORE}/api/v1/readiness`, auth);
    assert.equal(response.status, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), {
      status: 'ready',
      contractVersion: 3,
      libraryCount: 144,
      storageWritable: true,
      allowedParents: []
    });
  });
});

test('the container capability route resolves both ubername spellings', async () => {
  const semantics = [
    {
      name: 'content',
      type: 'list',
      field: { type: 'library', options: ['H5P.Column 1.18'] }
    }
  ];
  const asked = [];
  const tenant = {
    context: {
      language_code: 'en',
      paths: { content: '/tmp/dev1/content', tmp: '/tmp/dev1/tmp' },
      h5pEditor: {
        libraryManager: {
          async getSemantics(library) {
            asked.push(
              `${library.machineName} ${library.majorVersion}.${library.minorVersion}`
            );
            if (library.machineName !== 'H5P.Column') {
              throw Object.assign(new Error('library-missing'), {
                httpStatusCode: 404
              });
            }
            return semantics;
          }
        }
      }
    }
  };
  await withHost(
    async (port) => {
      for (const library of ['H5P.Column 1.18', 'H5P.Column-1.18']) {
        const response = await rawSend(
          port,
          'POST',
          `${CORE}/api/v1/libraries/capabilities`,
          { library },
          auth
        );
        assert.equal(response.status, 200, response.body);
        assert.deepEqual(JSON.parse(response.body), {
          allowed: ['H5P.Column 1.18']
        });
      }
      assert.deepEqual(asked, ['H5P.Column 1.18', 'H5P.Column 1.18']);

      const unknown = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/libraries/capabilities`,
        { library: 'H5P.Missing 1.0' },
        auth
      );
      assert.equal(unknown.status, 404, unknown.body);
      assert.deepEqual(
        JSON.parse(unknown.body),
        { error: 'Unknown library.', detail: 'Unknown library.' },
        'no h5p-server error id'
      );

      const malformed = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/libraries/capabilities`,
        { library: 'nonsense' },
        auth
      );
      assert.equal(malformed.status, 400, malformed.body);
      const missing = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/libraries/capabilities`,
        {},
        auth
      );
      assert.equal(missing.status, 400, missing.body);
    },
    { tenant }
  );
});

test('a nested library the container filtered out is refused, and nothing is saved', async (t) => {
  const { tenant } = writingTenant(t);
  const save = tenant.context.h5pEditor.saveOrUpdateContentReturnMetaData;
  // What H5P does with sub-content the container's semantics do not allow: it
  // drops it, silently, and only after the parameters have been written.
  tenant.context.h5pEditor.saveOrUpdateContentReturnMetaData = (
    id,
    params,
    ...rest
  ) =>
    save(
      id,
      {
        ...params,
        content: (params.content || []).filter(
          (item) => item.library !== 'H5P.Video 1.6'
        )
      },
      ...rest
    );
  const supported = { library: 'H5P.Text 1.1', params: { text: 'ok' } };
  const body = {
    library: 'H5P.Column 1.18',
    metadata: { title: 'Book' },
    params: {
      content: [
        supported,
        { library: 'H5P.Video 1.6', params: { sources: [] } }
      ]
    }
  };
  await withHost(
    async (port) => {
      const refused = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        body,
        auth
      );
      assert.equal(refused.status, 422, refused.body);
      assert.match(JSON.parse(refused.body).error, /H5P\.Video 1\.6/);
      assert.deepEqual(
        fs.readdirSync(tenant.context.paths.content),
        [],
        'the transaction discards the write the author was told about'
      );

      const accepted = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        { ...body, params: { content: [supported] } },
        auth
      );
      assert.equal(accepted.status, 200, accepted.body);
    },
    { tenant }
  );
});
