const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const createHostApp = require('../build/src/app').default;
const {
  transactionalContentStorage,
  contentRevision,
  withContentLock
} = require('../build/src/content-transactions');
const { tmpDir, withEnv } = require('./helpers');
const {
  CORE,
  appRoot,
  auth,
  log,
  multipart,
  rawGet,
  rawSend,
  stubTenants,
  withHost
} = require('./host');

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
    libraryManager: {
      getSemantics: async () => [],
      // What `GET …/edit` compares the stored content's libraries with.
      listInstalledLibraries: async () => ({
        'H5P.Column': [
          {
            machineName: 'H5P.Column',
            majorVersion: 1,
            minorVersion: 18,
            patchVersion: 3
          }
        ]
      })
    },
    async saveOrUpdateContentReturnMetaData(id, params, metadata) {
      return { id: await write(id, params, metadata), metadata };
    },
    async saveOrUpdateContent(id, params, metadata) {
      return write(id, params, metadata);
    },
    async render(_id, _language, renderUser) {
      return {
        scripts: [],
        styles: [],
        integration: { user: { name: renderUser.name } }
      };
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

test('new content carries no default library unless EDITOR_DEFAULT_LIBRARY is set', async (t) => {
  const { tenant } = writingTenant(t);
  await withHost(
    async (port) => {
      const bare = await rawGet(port, `${CORE}/api/v1/content/new/edit`, auth);
      assert.equal(bare.status, 200, bare.body);
      assert.equal(JSON.parse(bare.body).h5p.library, undefined);
    },
    { tenant }
  );
});

test('EDITOR_DEFAULT_LIBRARY sends new content straight to that library', async (t) => {
  withEnv(t, { EDITOR_DEFAULT_LIBRARY: 'VMB.InteractiveBook 1.6' });
  const { tenant } = writingTenant(t);
  await withHost(
    async (port) => {
      const fresh = await rawGet(port, `${CORE}/api/v1/content/new/edit`, auth);
      assert.equal(fresh.status, 200, fresh.body);
      assert.equal(
        JSON.parse(fresh.body).h5p.library,
        'VMB.InteractiveBook 1.6'
      );

      // An existing item still reflects its own stored library, never the
      // deployment default.
      const created = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        {
          library: 'H5P.Column 1.18',
          params: { content: 'x' },
          metadata: { title: 'Book' }
        },
        auth
      );
      assert.equal(created.status, 200, created.body);
      const { contentId } = JSON.parse(created.body);
      const existing = await rawGet(
        port,
        `${CORE}/api/v1/content/${contentId}/edit`,
        auth
      );
      assert.equal(existing.status, 200, existing.body);
      assert.equal(JSON.parse(existing.body).h5p.library, 'H5P.Column 1.18');
    },
    { tenant }
  );
});

test('the edit model carries the tenant user without an author-placeholder name', async (t) => {
  const { tenant } = writingTenant(t);
  tenant.user = {
    id: 'dev1',
    name: '',
    type: 'local',
    email: 'user@interactive-book-editor.local'
  };
  await withHost(
    async (port) => {
      const fresh = await rawGet(port, `${CORE}/api/v1/content/new/edit`, auth);
      assert.equal(fresh.status, 200, fresh.body);
      assert.equal(JSON.parse(fresh.body).h5p.integration.user.name, '');
    },
    { tenant }
  );
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
    const ajax = await rawGet(port, `${CORE}/h5p/ajax?action=files`, auth);
    assert.equal(ajax.status, 599);
  });
});

test('remote catalogue AJAX actions are rejected before they can make outbound requests', async () => {
  await withHost(async (port) => {
    const metadata = await rawGet(
      port,
      `${CORE}/h5p/ajax?action=content-hub-metadata-cache`,
      auth
    );
    assert.equal(metadata.status, 404);

    for (const action of ['library-install', 'get-content']) {
      const response = await rawSend(
        port,
        'POST',
        `${CORE}/h5p/ajax?action=${action}`,
        {},
        auth
      );
      assert.equal(response.status, 404, action);
    }

    // The editor's local-library AJAX surface remains available.
    const local = await rawGet(
      port,
      `${CORE}/h5p/ajax?action=libraries&machineName=H5P.Column&majorVersion=1&minorVersion=18`,
      auth
    );
    assert.equal(local.status, 599);
  });
});

test('the library list the legacy selector asks for is answered by the host, localized', async () => {
  // What the editor core requests with `hubIsEnabled` off: the action with no
  // library named, which the GPL router only knows per library (400 there).
  const calls = [];
  const h5pEditor = {
    async getContentTypeCache(user, language) {
      calls.push(['cache', user.id, language]);
      const local = (machineName, restricted = false) => ({
        machineName,
        installed: true,
        restricted,
        localMajorVersion: 1,
        localMinorVersion: 18
      });
      return {
        libraries: [
          local('H5P.Column'),
          local('H5P.Questionnaire', true),
          // A catalogue entry that is not installed is never offered.
          { machineName: 'H5P.Remote', installed: false, restricted: false }
        ]
      };
    },
    async getLibraryOverview(uberNames, language) {
      calls.push(['overview', uberNames, language]);
      return uberNames.map((uberName) => ({
        uberName,
        name: uberName.split(' ')[0],
        majorVersion: 1,
        minorVersion: 18,
        title: `${uberName.split(' ')[0].replace('H5P.', '')} (${language})`,
        restricted: false,
        runnable: 1,
        tutorialUrl: ''
      }));
    }
  };
  await withHost(
    async (port) => {
      const list = await rawGet(
        port,
        `${CORE}/h5p/ajax?action=libraries`,
        auth
      );
      assert.equal(list.status, 200);
      assert.deepEqual(JSON.parse(list.body), [
        {
          name: 'H5P.Column',
          majorVersion: 1,
          minorVersion: 18,
          title: 'Column (ru)',
          restricted: false,
          uberName: 'H5P.Column 1.18'
        },
        {
          name: 'H5P.Questionnaire',
          majorVersion: 1,
          minorVersion: 18,
          title: 'Questionnaire (ru)',
          restricted: true,
          uberName: 'H5P.Questionnaire 1.18'
        }
      ]);
      assert.deepEqual(calls, [
        ['cache', 'dev1', 'ru'],
        ['overview', ['H5P.Column 1.18', 'H5P.Questionnaire 1.18'], 'ru']
      ]);

      // The POST variant is the sub-content overview and stays upstream's.
      const post = await rawSend(
        port,
        'POST',
        `${CORE}/h5p/ajax?action=libraries`,
        { libraries: ['H5P.Column 1.18'] },
        auth
      );
      assert.equal(post.status, 599);
    },
    {
      tenant: {
        context: {
          language_code: 'ru',
          paths: { content: '/tmp/dev1/content', tmp: '/tmp/dev1/tmp' },
          h5pEditor
        }
      }
    }
  );
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

test('the correlation id is echoed even on a request rejected before a tenant is resolved', async () => {
  await withHost(async (port) => {
    const rejected = await rawGet(port, `${CORE}/api/v1/contents`, {
      'x-request-id': 'browser-req-1'
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers['x-request-id'], 'browser-req-1');

    const badPath = await rawGet(port, `${CORE}/%2e%2e/escape`, {
      'x-h5p-host-secret': 'dev-secret',
      'x-request-id': 'browser-req-2'
    });
    assert.equal(badPath.status, 400);
    assert.equal(badPath.headers['x-request-id'], 'browser-req-2');
  });
});

test('a system error code never makes an internal 500 message public', async () => {
  const systemError = Object.assign(
    new Error("ENOENT: no such file, open '/private/secret/data.json'"),
    { code: 'ENOENT' }
  );
  await withHost(
    async (port) => {
      const response = await rawGet(port, '/ready');
      assert.equal(response.status, 500, response.body);
      assert.deepEqual(JSON.parse(response.body), {
        error: 'Editor service request failed.'
      });
    },
    {
      readiness: async () => {
        throw systemError;
      }
    }
  );
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
    assert.equal(body.contractVersion, 7);
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

// A tenant whose player renders any id, for the render route's own guards.
function renderingTenant() {
  return {
    context: {
      language_code: 'en',
      paths: { content: '/tmp/dev1/content', tmp: '/tmp/dev1/tmp' },
      h5pPlayer: {
        async render(id) {
          return { integration: {}, scripts: [], styles: [], contentId: id };
        }
      }
    }
  };
}

test('the player page takes a parentOrigin only from the allowlist', async (t) => {
  withEnv(t, { H5P_HOST_ALLOWED_PARENTS: 'https://spa.example' });
  await withHost(
    async (port) => {
      const render = (query) =>
        rawGet(port, `${CORE}/api/v1/content/5/render${query}`, auth);
      // The pick-mode bridge posts to `parentOrigin`, so a foreign or
      // unparseable one is refused like the editor's.
      for (const query of [
        '?parentOrigin=https%3A%2F%2Fevil.test',
        '?parentOrigin=not%20a%20url',
        // Repeated, it parses as an array; the page would use the first.
        '?parentOrigin=https%3A%2F%2Fevil.test&parentOrigin=https%3A%2F%2Fspa.example'
      ]) {
        const refused = await render(query);
        assert.equal(refused.status, 400, query);
        assert.equal(
          JSON.parse(refused.body).error,
          'Parent origin is not allowed.'
        );
      }
      const allowed = await render('?parentOrigin=https%3A%2F%2Fspa.example');
      assert.equal(allowed.status, 200, allowed.body);
      assert.match(allowed.body, /\/h5p-editor-core\/web\/player-bridge\.js/);
      // Shelf opens its preview top-level, without the param.
      assert.equal((await render('')).status, 200);
    },
    { tenant: renderingTenant() }
  );
});

test('with no allowlist the player page takes any parentOrigin', async () => {
  await withHost(
    async (port) => {
      const response = await rawGet(
        port,
        `${CORE}/api/v1/content/5/render?parentOrigin=https%3A%2F%2Fany.test`,
        auth
      );
      assert.equal(response.status, 200, response.body);

      const bridge = await rawGet(port, `${CORE}/web/player-bridge.js`, auth);
      assert.equal(bridge.status, 200);
      assert.match(bridge.headers['content-type'], /javascript/);
      assert.match(bridge.body, /h5p-player-host/);
    },
    { tenant: renderingTenant() }
  );
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

test('an editor save or a generation gives a new book an id that later saves keep', async (t) => {
  const { tenant } = writingTenant(t);
  const { content } = tenant.context.paths;
  const stored = (id) =>
    JSON.parse(fs.readFileSync(path.join(content, id, 'h5p.json'), 'utf8'))
      .authorComments;
  const save = async (port, target, metadata, route = 'PATCH') => {
    const response =
      route === 'PATCH'
        ? await rawSend(
            port,
            'PATCH',
            `${CORE}/api/v1/content/${target}`,
            { library: 'H5P.Column 1.18', params: {}, metadata },
            auth
          )
        : await rawSend(
            port,
            'POST',
            `${CORE}/api/v1/generated-content`,
            { library: 'H5P.Column 1.18', params: {}, metadata },
            auth
          );
    assert.ok(response.status < 300, response.body);
    return JSON.parse(response.body).contentId;
  };
  const uuid =
    '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  await withHost(
    async (port) => {
      const created = await save(port, 'new', { title: 'Book' });
      const entry = stored(created);
      assert.match(entry, new RegExp(`^@id=${uuid};$`));

      // The editor form still holds the metadata it was opened with, so the
      // next save names no id: the stored one is kept, after the author's text.
      await save(port, created, {
        title: 'Book',
        authorComments: 'popup=true;'
      });
      assert.equal(stored(created), `popup=true;\n${entry}`);
      await save(port, created, { title: 'Book' });
      assert.equal(stored(created), entry);
      // An id the author wrote is theirs to change.
      await save(port, created, { title: 'Book', authorComments: 'id=other;' });
      assert.equal(stored(created), 'id=other;');

      // The author's comments come first, and every new book gets its own id.
      const generated = await save(
        port,
        null,
        { title: 'Docx', authorComments: 'From a .docx  \n' },
        'POST'
      );
      assert.match(
        stored(generated),
        new RegExp(`^From a \\.docx\\n@id=${uuid};$`)
      );
      assert.notEqual(stored(generated).slice(-37), entry.slice(-37));
      const named = await save(port, 'new', {
        title: 'Book',
        authorComments: '@id=4d682a53-7e2e-4dd6-8314-d17719e5d3dc;'
      });
      assert.equal(stored(named), '@id=4d682a53-7e2e-4dd6-8314-d17719e5d3dc;');

      // Author comments with no room left for the id refuse the save rather
      // than store a new book without one, or drop a stored book's: 5000
      // characters at most, of which "\n@id=<uuid>;" takes 42 and the
      // stored "\n@id=other;" 11.
      const before = fs.readdirSync(content).sort();
      for (const [target, length] of [
        ['new', 4959],
        [created, 4990]
      ]) {
        const refused = await rawSend(
          port,
          'PATCH',
          `${CORE}/api/v1/content/${target}`,
          {
            library: 'H5P.Column 1.18',
            params: {},
            metadata: { title: 'Book', authorComments: 'x'.repeat(length) }
          },
          auth
        );
        assert.equal(refused.status, 422, refused.body);
        assert.equal(JSON.parse(refused.body).code, 'author-comments-too-long');
      }
      assert.deepEqual(fs.readdirSync(content).sort(), before);
      assert.equal(stored(created), 'id=other;');
      await save(port, created, {
        title: 'Book',
        authorComments: 'x'.repeat(4989)
      });
      assert.equal(stored(created), `${'x'.repeat(4989)}\n@id=other;`);

      // A book stored before ids were given out is not given one by a save.
      await tenant.context.h5pEditor.contentStorage.addContent(
        { title: 'Old' },
        {},
        { id: 'dev1' },
        '42'
      );
      await save(port, '42', { title: 'Old' });
      assert.equal(stored('42'), undefined);
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

test('a listing never observes the gap between the two publication renames', async (t) => {
  const { tenant } = writingTenant(t);
  const moved = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const live = path.join(tenant.context.paths.content, '7');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'h5p.json'), '{"title":"Before"}');
  fs.writeFileSync(path.join(live, 'content.json'), '{}');
  const rename = fsp.rename;
  t.mock.method(fsp, 'rename', async (from, to) => {
    await rename(from, to);
    if (from === live) {
      moved.resolve();
      await resume.promise;
    }
  });
  await withHost(
    async (port) => {
      const save = rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/7`,
        {
          library: 'H5P.Column 1.18',
          params: {},
          metadata: { title: 'After' }
        },
        auth
      );
      try {
        await moved.promise;
        const listing = rawGet(port, `${CORE}/api/v1/contents`, auth);
        assert.equal(
          await Promise.race([
            listing.then(() => 'answered'),
            new Promise((resolve) => setTimeout(() => resolve('waiting'), 100))
          ]),
          'waiting'
        );
        resume.resolve();
        assert.equal((await save).status, 200);
        const response = await listing;
        assert.equal(response.status, 200);
        const [item] = JSON.parse(response.body).content;
        assert.equal(item.id, '7');
        assert.equal(item.title, 'After');
      } finally {
        resume.resolve();
        await save;
      }
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

test('mutations and listings wait per tenant while chrome remains available', async (t) => {
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
        // Chrome and readiness remain available during a save. Content
        // listings must wait for a consistent published revision.
        assert.equal(
          (await rawGet(port, `${CORE}/editor/new`, auth)).status,
          200
        );
        assert.equal(
          (await rawGet(port, `${CORE}/web/editor-host.js`, auth)).status,
          200
        );
        let listingAnswered = false;
        const listing = rawGet(port, `${CORE}/api/v1/contents`, auth).then(
          (response) => {
            listingAnswered = true;
            return response;
          }
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
        assert.equal(listingAnswered, false, 'the listing waits for the save');
        release.resolve();
        assert.equal((await first).status, 200, (await first).body);
        assert.equal((await second).status, 200, (await second).body);
        assert.equal((await listing).status, 200);
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
        // 503, so the embedder retries. Unlike a generic 5xx, this one carries
        // a `code` and a `Retry-After` (createErrorHandler exposes both for
        // any error class that sets `code` — its message was written to be
        // read by an embedder).
        const queued = await rawSend(
          port,
          'PATCH',
          `${CORE}/api/v1/content/new`,
          body,
          auth
        );
        assert.equal(queued.status, 503, queued.body);
        assert.equal(JSON.parse(queued.body).code, 'content-locked');
        assert.equal(queued.headers['retry-after'], '1');
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

test('the ack settles under the content lock, so a sweep cannot delete the receipt mid-acknowledgement', async (t) => {
  // The journal janitor prunes a settled generation receipt by age under the
  // content lock. Acknowledging one takes the same lock: without it a prune
  // could delete the operation directory in the window between the ack reading
  // the record, rewriting it as acknowledged and moving it into `acked/`, and
  // the ack would answer `ok` with no receipt left — a replayed idempotency key
  // would then write the content a second time. With the lock held throughout,
  // the ack has to wait for it: it gives up with a 503 rather than settling
  // behind the holder's back, and once the lock is free it succeeds.
  const { dataRoot, root, tenant } = writingTenant(t);
  const content = path.join(root, 'content');
  withEnv(t, { H5P_HOST_MUTATION_WAIT_MS: '200' });
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
      const { operationId } = JSON.parse(saved.body);

      // Hold the tenant's content lock, exactly as a sweep in flight would.
      const held = Promise.withResolvers();
      const release = Promise.withResolvers();
      const holder = withContentLock(content, async () => {
        held.resolve();
        await release.promise;
      });
      await held.promise;

      const blocked = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/operations/${operationId}/ack`,
        {},
        auth
      );
      assert.equal(blocked.status, 503, blocked.body);
      // The receipt is untouched: still pending, still there to acknowledge.
      const pending = await rawGet(port, `${CORE}/api/v1/pending-usage`, auth);
      assert.deepEqual(
        JSON.parse(pending.body).pending.map((item) => item.operationId),
        [operationId]
      );

      release.resolve();
      await holder;

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
      // The new book's id is part of the answer the replay must repeat.
      assert.match(JSON.parse(first.body).metadata.authorComments, /^@id=/);
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

test('the edit model lists the library versions it uses that are not installed, with the installed upgrade', async (t) => {
  const { tenant } = writingTenant(t);
  const { h5pEditor } = tenant.context;
  const installed = (machineName, ...versions) =>
    versions.map(([majorVersion, minorVersion]) => ({
      machineName,
      majorVersion,
      minorVersion,
      patchVersion: 0
    }));
  h5pEditor.libraryManager.listInstalledLibraries = async () => ({
    'H5P.InteractiveBook': installed('H5P.InteractiveBook', [1, 7], [1, 6]),
    'H5P.Column': installed('H5P.Column', [1, 18]),
    'H5P.Text': installed('H5P.Text', [1, 0])
  });
  await withHost(
    async (port) => {
      const created = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        {
          library: 'H5P.Column 1.18',
          params: { content: 'x' },
          metadata: { title: 'Book' }
        },
        auth
      );
      const { contentId } = JSON.parse(created.body);
      const current = await rawGet(
        port,
        `${CORE}/api/v1/content/${contentId}/edit`,
        auth
      );
      assert.equal(current.status, 200, current.body);
      assert.deepEqual(JSON.parse(current.body).missingLibraries, []);

      h5pEditor.getContent = async () => ({
        h5p: { title: 'Book' },
        library: 'H5P.InteractiveBook 1.5',
        params: {
          metadata: {},
          params: {
            chapters: [
              {
                library: 'H5P.Column 1.13',
                params: {
                  content: [
                    { content: { library: 'H5P.Text 1.1', params: {} } },
                    { content: { library: 'H5P.Column 1.18', params: {} } },
                    { content: { library: 'not a library', params: {} } }
                  ]
                }
              },
              { library: 'H5P.Column 1.13', params: {} }
            ]
          }
        }
      });
      const old = await rawGet(
        port,
        `${CORE}/api/v1/content/${contentId}/edit`,
        auth
      );
      assert.equal(old.status, 200, old.body);
      // Main library first; a version newer than every installed one has no
      // upgrade (content is never downgraded); unparseable names are left to
      // the editor.
      assert.deepEqual(JSON.parse(old.body).missingLibraries, [
        {
          library: 'H5P.InteractiveBook 1.5',
          upgrade: 'H5P.InteractiveBook 1.7'
        },
        { library: 'H5P.Column 1.13', upgrade: 'H5P.Column 1.18' },
        { library: 'H5P.Text 1.1', upgrade: null }
      ]);
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
      contractVersion: 7,
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

test('a package import that never finishes unpacking fails and releases the tenant', async (t) => {
  withEnv(t, { H5P_HOST_IMPORT_TIMEOUT_MS: '100' });
  const { tenant } = writingTenant(t);
  const metadata = {
    title: 'Imported',
    mainLibrary: 'H5P.Column',
    preloadedDependencies: [
      { machineName: 'H5P.Column', majorVersion: 1, minorVersion: 18 }
    ]
  };
  let stall = true;
  tenant.context.h5pEditor.uploadPackage = () =>
    stall
      ? new Promise(() => {})
      : Promise.resolve({ metadata, parameters: {} });
  await withHost(
    async (port) => {
      // One key for both: the embedder retries a 504 as the same operation.
      const idempotencyKey = crypto.randomUUID();
      const importPackage = () =>
        multipart(
          port,
          `${CORE}/api/v1/import/h5p`,
          [
            { filename: 'book.h5p', contentType: 'application/zip', data: 'PK' }
          ],
          { ...auth, 'idempotency-key': idempotencyKey }
        );
      const stalled = await importPackage();
      assert.equal(stalled.status, 504, stalled.body);
      assert.equal(JSON.parse(stalled.body).code, 'import-timeout');

      // The stalled import no longer holds the content lock, and left no
      // receipt behind: the retry imports rather than replaying a failure.
      stall = false;
      const next = await importPackage();
      assert.equal(next.status, 201, next.body);
    },
    { tenant }
  );
});

test('a package imported over existing content keeps its id and replaces it', async (t) => {
  const { tenant } = writingTenant(t);
  const packageOf = (title, content) => ({
    metadata: {
      title,
      mainLibrary: 'H5P.Column',
      authorComments: '@id=book-1;',
      preloadedDependencies: [
        { machineName: 'H5P.Column', majorVersion: 1, minorVersion: 18 }
      ]
    },
    parameters: { content }
  });
  const packages = [];
  tenant.context.h5pEditor.uploadPackage = async () => {
    const next = packages.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  await withHost(
    async (port) => {
      const importOver = (contentId) =>
        multipart(
          port,
          `${CORE}/api/v1/import/h5p/${contentId}`,
          [
            { filename: 'book.h5p', contentType: 'application/zip', data: 'PK' }
          ],
          { ...auth, 'idempotency-key': crypto.randomUUID() }
        );
      const metadataOf = (contentId) =>
        rawGet(port, `${CORE}/api/v1/content/${contentId}/metadata`, auth);
      const v1 = packageOf('Book v1', 'x'.repeat(500));
      const created = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/new`,
        {
          library: 'H5P.Column 1.18',
          params: v1.parameters,
          metadata: v1.metadata
        },
        auth
      );
      assert.equal(created.status, 200, created.body);
      const first = JSON.parse(created.body);

      const before = await metadataOf(first.contentId);
      assert.equal(before.status, 200, before.body);
      assert.deepEqual(JSON.parse(before.body), {
        contentId: first.contentId,
        title: 'Book v1',
        mainLibrary: 'H5P.Column',
        authorComments: '@id=book-1;'
      });

      // A package that cannot be unpacked leaves the stored content alone.
      packages.push(new Error('not a zip'));
      const broken = await importOver(first.contentId);
      assert.ok(broken.status >= 400, broken.body);
      assert.equal(
        JSON.parse((await metadataOf(first.contentId)).body).title,
        'Book v1'
      );

      packages.push(packageOf('Book v2', 'y'));
      const replaced = await importOver(first.contentId);
      assert.equal(replaced.status, 200, replaced.body);
      const second = JSON.parse(replaced.body);
      assert.equal(second.contentId, first.contentId);
      assert.match(second.operationId, /^[0-9a-f-]{36}$/);
      assert.ok(second.deltaBytes < 0, 'the smaller version frees bytes');
      assert.equal(second.deltaBytes, second.savedBytes - first.savedBytes);
      assert.equal(
        JSON.parse((await metadataOf(first.contentId)).body).title,
        'Book v2'
      );
      const listing = JSON.parse(
        (await rawGet(port, `${CORE}/api/v1/contents`, auth)).body
      );
      assert.deepEqual(
        listing.content.map((item) => item.id),
        [first.contentId],
        'replaced, not imported beside it'
      );

      // An import over a content that does not exist creates nothing.
      packages.push(packageOf('Stray', 'z'));
      assert.equal((await importOver('987654')).status, 404);
      assert.equal((await importOver('new')).status, 400);
      assert.equal((await metadataOf('987654')).status, 404);
      assert.equal((await metadataOf('abc')).status, 400);
      assert.equal((await metadataOf('new')).status, 400);
      // A file that is not a package is refused before it is unpacked.
      const notPackage = await multipart(
        port,
        `${CORE}/api/v1/import/h5p/${first.contentId}`,
        [{ filename: 'book.zip', contentType: 'application/zip', data: 'PK' }],
        { ...auth, 'idempotency-key': crypto.randomUUID() }
      );
      assert.equal(notPackage.status, 415, notPackage.body);
      assert.equal(packages.length, 1, 'the stray package was never consumed');
    },
    { tenant }
  );
});

for (const [name, min] of [
  ['H5P_HOST_IMPORT_TIMEOUT_MS', 1],
  ['H5P_HOST_MUTATION_WAIT_MS', 0]
]) {
  test(`${name} past what a Node timer can hold stops app construction`, (t) => {
    // Node would cut the timeout to 1 ms instead.
    withEnv(t, { [name]: String(2 ** 31) });
    const tenants = stubTenants();
    t.after(() =>
      fs.rmSync(tenants.uploadStagingDirectory, {
        recursive: true,
        force: true
      })
    );
    assert.throws(
      () => createHostApp(appRoot, log, tenants),
      new RegExp(
        `${name} must be a number of at least ${min} and at most 2147483647`
      )
    );
  });
}

test('a conditional download refuses changed content before exporting any bytes', async (t) => {
  const { tenant, root } = writingTenant(t);
  const dir = path.join(root, 'content', '1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'content.json'), '{}');
  fs.writeFileSync(path.join(dir, 'h5p.json'), '{}');
  const revision = await contentRevision(path.join(root, 'content'), '1');
  let exports = 0;
  const originalExport = tenant.context.h5pEditor.exportContent;
  tenant.context.h5pEditor.exportContent = async (...args) => {
    exports++;
    return originalExport(...args);
  };
  await withHost(
    async (port) => {
      for (const match of [revision, `"${revision}"`]) {
        const response = await rawGet(
          port,
          `${CORE}/api/v1/content/1/download`,
          {
            ...auth,
            connection: 'close',
            'if-match': match
          }
        );
        assert.equal(response.status, 200, response.body);
        assert.equal(response.body, 'h5p');
      }
      fs.writeFileSync(path.join(dir, 'content.json'), '{"text":"newer"}');
      const stale = await rawGet(port, `${CORE}/api/v1/content/1/download`, {
        ...auth,
        connection: 'close',
        'if-match': revision
      });
      assert.equal(stale.status, 412, stale.body);
      assert.equal(JSON.parse(stale.body).code, 'ContentRevisionMismatch');
      assert.equal(
        exports,
        2,
        'no package was exported for the stale revision'
      );
    },
    { tenant }
  );
});

test('metadata answers a field-less h5p.json with nulls and a corrupt one with 500', async (t) => {
  const { tenant, root } = writingTenant(t);
  const dir = path.join(root, 'content', '1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'content.json'), '{}');
  await withHost(
    async (port) => {
      const metadata = () =>
        rawGet(port, `${CORE}/api/v1/content/1/metadata`, auth);
      for (const stored of ['null', '[]', '"text"']) {
        fs.writeFileSync(path.join(dir, 'h5p.json'), stored);
        const response = await metadata();
        assert.equal(response.status, 200, response.body);
        assert.deepEqual(JSON.parse(response.body), {
          contentId: '1',
          title: null,
          mainLibrary: null,
          authorComments: null
        });
      }
      fs.writeFileSync(path.join(dir, 'h5p.json'), '{"title": "Book"');
      assert.equal((await metadata()).status, 500);
    },
    { tenant }
  );
});

test('metadata finishes before a writer queued behind its shared lock', async (t) => {
  withEnv(t, { H5P_HOST_MUTATION_WAIT_MS: '500' });
  const { tenant } = writingTenant(t);
  const content = tenant.context.paths.content;
  const file = path.join(content, '1', 'h5p.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ title: 'Before' }));
  let reads = 0;
  let writer;
  await withHost(
    async (port) => {
      Object.defineProperty(tenant.context.paths, 'content', {
        get() {
          // First access: the middleware takes its shared lock. Second:
          // the route starts reading. Queue a writer at that boundary,
          // as can happen while the middleware awaits the process lock.
          if (++reads === 2) {
            writer = withContentLock(content, async () => {
              await fsp.writeFile(file, JSON.stringify({ title: 'After' }));
            }).then(
              () => 'saved',
              (error) => error
            );
          }
          return content;
        }
      });
      const response = await rawGet(
        port,
        `${CORE}/api/v1/content/1/metadata`,
        auth
      );
      const written = await writer;
      assert.equal(response.status, 200, response.body);
      assert.equal(JSON.parse(response.body).title, 'Before');
      assert.equal(written, 'saved');
      const after = await rawGet(
        port,
        `${CORE}/api/v1/content/1/metadata`,
        auth
      );
      assert.equal(JSON.parse(after.body).title, 'After');
    },
    { tenant }
  );
});

test('/h5p/params takes the shared content lock like metadata; other h5p reads take none', async (t) => {
  // The GPL router answers `GET /h5p/params/:id` from `H5PEditor.getContent`,
  // which reads `h5p.json` and `content.json` separately — a two-file read
  // that could straddle the rename publishing a save, exactly like
  // `.../metadata`. It is not called by the bridge, but the embedder proxies
  // it, so it has to wait for a writer, and a writer has to wait for it.
  // A single-file read under `/h5p` stays lock-free (a streamed file is
  // consistent on its own) and must not queue behind a writer.
  withEnv(t, { H5P_HOST_MUTATION_WAIT_MS: '500' });
  const { tenant, root } = writingTenant(t);
  const content = path.join(root, 'content');
  fs.mkdirSync(path.join(content, '1'), { recursive: true });
  fs.writeFileSync(
    path.join(content, '1', 'h5p.json'),
    JSON.stringify({ title: 'Book' })
  );
  // Stands in for the GPL router: a `params` read stalls until the test lets
  // it finish, so the shared lock it holds can be observed from outside.
  let stall = Promise.resolve();
  let entered = () => {};
  tenant.h5pRouter = async (req, res) => {
    if (/^\/params\//.test(req.path)) {
      entered();
      await stall;
    }
    res.json({ path: req.path });
  };
  await withHost(
    async (port) => {
      // Whatever assertion fails, the stalled request and the held lock are
      // let go before `withHost` closes the server, or it would wait for the
      // open socket for ever.
      const release = Promise.withResolvers();
      const finish = Promise.withResolvers();
      const inFlight = [];
      try {
        // A writer holds the exclusive lock: `params` waits, a file read
        // does not.
        const held = Promise.withResolvers();
        const writer = withContentLock(content, async () => {
          held.resolve();
          await release.promise;
        });
        inFlight.push(writer);
        await held.promise;
        let paramsAnswered = false;
        const params = rawGet(port, `${CORE}/h5p/params/1`, auth).then(
          (response) => {
            paramsAnswered = true;
            return response;
          }
        );
        inFlight.push(params);
        const file = await rawGet(port, `${CORE}/h5p/content/1/a.png`, auth);
        assert.equal(file.status, 200, file.body);
        assert.deepEqual(JSON.parse(file.body), { path: '/content/1/a.png' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(paramsAnswered, false, 'params waits for the writer');
        release.resolve();
        await writer;
        const answered = await params;
        assert.equal(answered.status, 200, answered.body);
        assert.deepEqual(JSON.parse(answered.body), { path: '/params/1' });

        // A `params` read in flight holds the lock shared: a writer queues
        // behind it, another shared reader runs alongside it.
        const stalled = Promise.withResolvers();
        entered = stalled.resolve;
        stall = finish.promise;
        let stalledAnswered = false;
        const reading = rawGet(port, `${CORE}/h5p/params/1`, auth).then(
          (response) => {
            stalledAnswered = true;
            return response;
          }
        );
        inFlight.push(reading);
        await stalled.promise;
        // Issued before the writer: a writer closes the open shared phase,
        // so a reader arriving after it would queue behind it.
        const alongside = await rawGet(
          port,
          `${CORE}/api/v1/content/1/metadata`,
          auth
        );
        assert.equal(alongside.status, 200, alongside.body);
        assert.equal(JSON.parse(alongside.body).title, 'Book');
        let written = false;
        const queued = withContentLock(content, async () => {
          written = true;
        }).then(
          () => 'written',
          (error) => error
        );
        inFlight.push(queued);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(written, false, 'the writer waits for the params read');
        assert.equal(stalledAnswered, false);
        finish.resolve();
        assert.equal((await reading).status, 200);
        assert.equal(await queued, 'written');
      } finally {
        release.resolve();
        finish.resolve();
        await Promise.allSettled(inFlight);
      }
    },
    { tenant }
  );
});
