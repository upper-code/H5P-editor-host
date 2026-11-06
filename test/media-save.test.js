const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const TenantManager = require('../build/src/tenant-manager').default;
const { saveEditorContent } = require('../build/src/routes/content');
const {
  mutateContent,
  contentRevision,
  readOperation
} = require('../build/src/content-transactions');
const { sweepExpired } = require('../build/src/temp-storage');
const { parsePasteReference } = require('../build/src/paste-sources');
const { tmpDir, withEnv, writeLibrary, repoRoot } = require('./helpers');
const { withHost, rawGet, rawSend, CORE, auth } = require('./host');

async function fixture(t) {
  const root = tmpDir(t, 'host-media-save-');
  const libraries = path.join(root, 'libraries');
  withEnv(t, {
    H5P_HOST_DATA_DIR: root,
    H5P_LIBRARIES_DIR: libraries,
    H5P_HOST_UPLOAD_TMP_DIR: path.join(root, 'uploads')
  });
  await writeLibrary(
    libraries,
    'H5P.ReviewMedia-1.0',
    {
      machineName: 'H5P.ReviewMedia',
      title: 'Media fixture',
      majorVersion: 1,
      minorVersion: 0,
      patchVersion: 0,
      runnable: 1
    },
    {
      'semantics.json': JSON.stringify([
        { name: 'image', type: 'image', optional: true },
        { name: 'audio', type: 'audio', optional: true },
        { name: 'video', type: 'video', optional: true },
        {
          name: 'child',
          type: 'library',
          optional: true,
          options: ['H5P.ReviewMedia 1.0']
        }
      ])
    }
  );
  const manager = new TenantManager(repoRoot, { info() {}, warn() {} });
  const tenant = await manager.get('media');
  const editor = tenant.context.h5pEditor;
  return {
    tenant,
    editor,
    upload: (name, data = 'media bytes') =>
      editor.temporaryFileManager.addFile(
        name,
        Readable.from([data]),
        tenant.user
      ),
    save: (params, id, options = {}) => {
      const body = {
        library: 'H5P.ReviewMedia 1.0',
        params,
        metadata: { title: 'Example', license: 'U' }
      };
      return mutateContent({
        root: tenant.context.paths.content,
        id,
        fingerprint: structuredClone(body),
        reason: 'editor-save',
        save: () =>
          saveEditorContent(tenant.context, tenant.user, id || 'new', body, {
            bookId: 'keep',
            ...options
          })
      });
    }
  };
}

test('the media boundary is inclusive and an excess rolls back the real H5P save', async (t) => {
  withEnv(t, { H5P_HOST_MAX_BOOK_BYTES: '100000' });
  const { tenant, editor, upload, save } = await fixture(t);
  const first = await upload('limit.png', Buffer.alloc(96000));
  const image = { path: `${first}#tmp`, mime: 'image/png' };
  // Original images and repeated references to the same file use one stored
  // file, so this is exactly 96%, rather than twice that allowance.
  const original = await save({ image: { ...image, originalImage: image } });
  const extra = await upload('extra.mp3', 'x');
  await assert.rejects(
    save(
      { image, audio: [{ path: `${extra}#tmp`, mime: 'audio/mpeg' }] },
      original.contentId
    ),
    (error) =>
      error.statusCode === 413 &&
      error.code === 'book-media-too-large' &&
      /96000 bytes/.test(error.message)
  );
  assert.equal(
    await contentRevision(tenant.context.paths.content, original.contentId),
    original.revision
  );
  assert.equal(
    await editor.contentStorage.fileExists(original.contentId, first),
    true
  );
  // A refused transaction must also retain the temporary upload for a retry.
  assert.equal(
    await editor.temporaryFileManager.fileExists(extra, tenant.user),
    true
  );
  // Removing media frees the book's allowance on the next save.
  await save(
    { audio: [{ path: `${extra}#tmp`, mime: 'audio/mpeg' }] },
    original.contentId
  );
});

test('upload preflight counts unsaved, nested and own pasted media and ignores remote URLs', async (t) => {
  withEnv(t, { H5P_HOST_MAX_BOOK_BYTES: '100000' });
  const { tenant, upload, save } = await fixture(t);
  const first = await upload('first.png', Buffer.alloc(40000));
  const original = await save({
    image: { path: `${first}#tmp`, mime: 'image/png' }
  });
  await sweepExpired(tenant.context.paths.tmp, 1, Date.now() + 1000);
  const second = await upload('second.mp3', Buffer.alloc(10000));
  await withHost(
    async (port) => {
      const check = (params, incomingBytes, id = original.contentId) =>
        rawSend(
          port,
          'POST',
          `${CORE}/api/v1/content/${id}/check-media-size`,
          {
            library: 'H5P.ReviewMedia 1.0',
            metadata: {},
            params,
            incomingBytes
          },
          auth
        );
      const params = {
        image: { path: `${first}#tmp`, mime: 'image/png' },
        child: {
          library: 'H5P.ReviewMedia 1.0',
          params: {
            audio: [{ path: `${second}#tmp`, mime: 'audio/mpeg' }],
            video: [
              { path: 'https://example.com/large.mp4', mime: 'video/mp4' }
            ]
          }
        }
      };
      const allowed = await check(params, 46000);
      assert.equal(allowed.status, 200, allowed.body);
      assert.deepEqual(JSON.parse(allowed.body), {
        maxBookBytes: 100000,
        maxMediaBytes: 96000,
        mediaBytes: 50000
      });
      const refused = await check(params, 46001);
      assert.equal(refused.status, 413, refused.body);
      assert.equal(JSON.parse(refused.body).code, 'book-media-too-large');
      const removed = await check({}, 96000);
      assert.equal(removed.status, 200, removed.body);
      assert.equal(JSON.parse(removed.body).mediaBytes, 0);
      // H5P copies a reference to the book's own file once per reference.
      const pasted = await check(
        {
          audio: [1, 2].map(() => ({
            path: `../${original.contentId}/${first}`,
            mime: 'audio/mpeg'
          }))
        },
        16000
      );
      assert.equal(pasted.status, 200, pasted.body);
      assert.equal(JSON.parse(pasted.body).mediaBytes, 80000);
      const mixed = await check(
        {
          audio: [
            { path: `../${original.contentId}/${first}`, mime: 'audio/mpeg' },
            { path: first, mime: 'audio/mpeg' }
          ]
        },
        16000
      );
      assert.equal(mixed.status, 200, mixed.body);
      assert.equal(JSON.parse(mixed.body).mediaBytes, 80000);
      for (const invalid of [-1, 1.5, '10', null]) {
        assert.equal((await check({}, invalid)).status, 400);
      }
      assert.equal(
        (await check({ image: { path: '../../secret', mime: 'image/png' } }, 0))
          .status,
        400
      );
      for (const missingPath of [
        'missing.png#tmp',
        'missing.png',
        '../987654/missing.png'
      ]) {
        const missing = await check(
          { image: { path: missingPath, mime: 'image/png' } },
          96000
        );
        assert.equal(missing.status, 200, missing.body);
        assert.equal(JSON.parse(missing.body).mediaBytes, 0);
      }
      assert.equal(
        await contentRevision(tenant.context.paths.content, original.contentId),
        original.revision
      );
      // Generation does not depend on the browser preflight.
      const oversized = await upload('too-large.mp3', Buffer.alloc(96001));
      const generated = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/generated-content`,
        {
          library: 'H5P.ReviewMedia 1.0',
          metadata: { title: 'Large', license: 'U' },
          params: { audio: [{ path: `${oversized}#tmp`, mime: 'audio/mpeg' }] }
        },
        auth
      );
      assert.equal(generated.status, 413, generated.body);
      assert.equal(JSON.parse(generated.body).code, 'book-media-too-large');
    },
    { tenant }
  );
});

test('preflight counts ordinary local media in dotted directories before and after saving', async (t) => {
  withEnv(t, { H5P_HOST_MAX_BOOK_BYTES: '100000' });
  const { tenant, upload, save } = await fixture(t);
  const file = await upload('assets.v1/audio.mp3', Buffer.alloc(40000));
  assert.match(file, /^assets\.v1\//);
  const params = {
    audio: [
      { path: `${file}#tmp`, mime: 'audio/mpeg' },
      { path: `${file}#tmp`, mime: 'audio/mpeg' }
    ],
    video: [
      { path: 'youtu.be/example', mime: 'video/youtube' },
      { path: 'media.example/video.mp4', mime: 'video/mp4' },
      { path: 'https://media.example/video.mp4', mime: 'video/mp4' }
    ]
  };
  await withHost(
    async (port) => {
      const check = (id, incomingBytes) =>
        rawSend(
          port,
          'POST',
          `${CORE}/api/v1/content/${id}/check-media-size`,
          {
            library: 'H5P.ReviewMedia 1.0',
            params,
            metadata: {},
            incomingBytes
          },
          auth
        );
      const verify = async (id) => {
        const admitted = await check(id, 56000);
        assert.equal(admitted.status, 200, admitted.body);
        assert.equal(JSON.parse(admitted.body).mediaBytes, 40000);
        const refused = await check(id, 56001);
        assert.equal(refused.status, 413, refused.body);
        assert.equal(JSON.parse(refused.body).code, 'book-media-too-large');
      };
      await verify('new');
      // Keep the #tmp spelling the open form still has after a save. Once
      // temporary files expire, only the stored file can supply these bytes.
      const stored = await save({ audio: structuredClone(params.audio) });
      await sweepExpired(tenant.context.paths.tmp, 1, Date.now() + 1000);
      await verify(stored.contentId);
      params.audio.forEach((audio) => {
        audio.path = file;
      });
      await verify(stored.contentId);
    },
    { tenant }
  );
});

test('expired media can be replaced one file at a time while saves remain atomic and size-limited', async (t) => {
  withEnv(t, { H5P_HOST_MAX_BOOK_BYTES: '100000' });
  const { tenant, editor, upload, save } = await fixture(t);
  const kept = await upload('kept.mp3', Buffer.alloc(40000));
  const audio = [{ path: `${kept}#tmp`, mime: 'audio/mpeg' }];
  const original = await save({ audio: structuredClone(audio) });
  const expiredImage = await upload('expired.png');
  const expiredVideo = await upload('expired.mp4');
  await sweepExpired(tenant.context.paths.tmp, 1, Date.now() + 1000);
  const params = {
    audio,
    image: { path: `${expiredImage}#tmp`, mime: 'image/png' },
    child: {
      library: 'H5P.ReviewMedia 1.0',
      params: {
        video: [{ path: `${expiredVideo}#tmp`, mime: 'video/mp4' }]
      }
    }
  };
  await withHost(
    async (port) => {
      const check = (incomingBytes) =>
        rawSend(
          port,
          'POST',
          `${CORE}/api/v1/content/${original.contentId}/check-media-size`,
          {
            library: 'H5P.ReviewMedia 1.0',
            params,
            metadata: {},
            incomingBytes
          },
          auth
        );
      const admitted = await check(56000);
      assert.equal(admitted.status, 200, admitted.body);
      assert.equal(JSON.parse(admitted.body).mediaBytes, 40000);
      const refused = await check(56001);
      assert.equal(refused.status, 413, refused.body);
      assert.equal(JSON.parse(refused.body).code, 'book-media-too-large');

      // The current form still holds both expired paths when replacement
      // starts. Replacing one must not require removing the other first.
      const image = await upload('replacement.png', Buffer.alloc(10000));
      params.image.path = `${image}#tmp`;
      const next = await check(46000);
      assert.equal(next.status, 200, next.body);
      assert.equal(JSON.parse(next.body).mediaBytes, 50000);
      await assert.rejects(save(structuredClone(params), original.contentId), {
        statusCode: 422,
        code: 'media-missing'
      });
      assert.equal(
        await contentRevision(tenant.context.paths.content, original.contentId),
        original.revision
      );

      const video = await upload('replacement.mp4', Buffer.alloc(20000));
      params.child.params.video[0].path = `${video}#tmp`;
      const saved = await save(structuredClone(params), original.contentId);
      assert.notEqual(saved.revision, original.revision);
      const stored = await editor.contentStorage.getParameters(saved.contentId);
      assert.equal(stored.image.path, image);
      assert.equal(stored.child.params.video[0].path, video);
    },
    { tenant }
  );
});

test('preflight tolerates temporary expiry during measurement but propagates other storage failures', async (t) => {
  const { tenant, editor, upload } = await fixture(t);
  const file = await upload('expiring.png');
  const temporary = editor.temporaryFileManager;
  const getStats = temporary.getFileStats.bind(temporary);
  let failure;
  t.mock.method(temporary, 'getFileStats', async (...args) => {
    if (failure)
      throw Object.assign(new Error('Storage failure'), { code: failure });
    // Expire after the check has selected temporary storage, before its stat.
    await sweepExpired(tenant.context.paths.tmp, 1, Date.now() + 1000);
    return getStats(...args);
  });
  await withHost(
    async (port) => {
      const check = () =>
        rawSend(
          port,
          'POST',
          `${CORE}/api/v1/content/new/check-media-size`,
          {
            library: 'H5P.ReviewMedia 1.0',
            params: { image: { path: `${file}#tmp`, mime: 'image/png' } },
            metadata: {},
            incomingBytes: 10
          },
          auth
        );
      const expired = await check();
      assert.equal(expired.status, 200, expired.body);
      assert.equal(JSON.parse(expired.body).mediaBytes, 0);
      failure = 'ENOENT'; // The janitor can also win after storage's exists check.
      const vanished = await check();
      assert.equal(vanished.status, 200, vanished.body);
      assert.equal(JSON.parse(vanished.body).mediaBytes, 0);
      failure = 'EIO';
      const unreadable = await check();
      assert.equal(unreadable.status, 500, unreadable.body);
    },
    { tenant }
  );
});

test('expired media refuses the real H5P save instead of publishing an empty path', async (t) => {
  const { tenant, upload, save } = await fixture(t);
  const file = await upload('expired.png');
  await sweepExpired(tenant.context.paths.tmp, 1, Date.now() + 1000);
  await assert.rejects(
    save({ image: { path: `${file}#tmp`, mime: 'image/png' } }),
    (error) =>
      error.statusCode === 422 &&
      error.code === 'media-missing' &&
      // The author is told which file to upload again.
      error.message.includes(path.basename(file))
  );
  assert.deepEqual(await fs.readdir(tenant.context.paths.content), []);
});

test('a swallowed media copy error rolls back an update, preserving its content and revision', async (t) => {
  const { tenant, editor, upload, save } = await fixture(t);
  const first = await upload('first.png');
  const original = await save({
    image: { path: `${first}#tmp`, mime: 'image/png' }
  });
  const replacement = await upload('replacement.png');
  t.mock.method(editor.contentManager, 'addContentFile', async () => {
    throw Object.assign(new Error('copy failed'), { code: 'EIO' });
  });
  await assert.rejects(
    save(
      { image: { path: `${replacement}#tmp`, mime: 'image/png' } },
      original.contentId
    ),
    { statusCode: 422, code: 'media-missing' }
  );
  assert.equal(
    await contentRevision(tenant.context.paths.content, original.contentId),
    original.revision
  );
  assert.equal(
    (await editor.contentStorage.getParameters(original.contentId)).image.path,
    first
  );
  assert.equal(
    await editor.contentStorage.fileExists(original.contentId, first),
    true
  );
});

test('saved media remains reusable after temp expiry; pasted, nested and remote media stay supported', async (t) => {
  const { tenant, editor, upload, save } = await fixture(t);
  const first = await upload('first.png');
  const original = await save({
    image: { path: `${first}#tmp`, mime: 'image/png' }
  });
  await sweepExpired(tenant.context.paths.tmp, 1, Date.now() + 1000);
  const retry = await save(
    { image: { path: `${first}#tmp`, mime: 'image/png' } },
    original.contentId
  );
  assert.equal(retry.contentId, original.contentId);
  const pasted = await save(
    {
      child: {
        library: 'H5P.ReviewMedia 1.0',
        params: {
          image: {
            path: `../${original.contentId}/${first}`,
            mime: 'image/png'
          },
          audio: [{ path: 'https://example.com/audio.mp3', mime: 'audio/mpeg' }]
        }
      }
    },
    undefined,
    { pasteSources: new Set([original.contentId]) }
  );
  const params = await editor.contentStorage.getParameters(pasted.contentId);
  assert.ok(params.child.params.image.path);
  assert.equal(
    await editor.contentStorage.fileExists(
      pasted.contentId,
      params.child.params.image.path
    ),
    true
  );
  assert.equal(
    params.child.params.audio[0].path,
    'https://example.com/audio.mp3'
  );
});

/** A stored book with one file, the files of the tenant, and the save route. */
async function pasteFixture(t) {
  const context = await fixture(t);
  const { tenant, upload, save } = context;
  const file = await upload('source.png', 'source bytes');
  const source = await save({
    image: { path: `${file}#tmp`, mime: 'image/png' }
  });
  const root = tenant.context.paths.content;
  return {
    ...context,
    file,
    sourceId: source.contentId,
    root,
    // Every file under the tenant's content directory, so a refusal can be
    // shown to have written nothing, wherever it would have.
    stored: async () => (await fs.readdir(root, { recursive: true })).sort(),
    patch: (port, id, params, headers = {}) =>
      rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/${id}`,
        {
          library: 'H5P.ReviewMedia 1.0',
          metadata: { title: 'Pasted', license: 'U' },
          params
        },
        { ...auth, ...headers }
      )
  };
}

const imageAt = (file) => ({ image: { path: file, mime: 'image/png' } });

test('a paste reference is judged by its segments, wherever the host runs', () => {
  const working = process.cwd();
  // At `/` nothing resolves outside the working directory.
  for (const directory of [working, '/']) {
    process.chdir(directory);
    try {
      assert.deepEqual(parsePasteReference('../content/12/images/x.png'), {
        sourceId: '12',
        filename: 'images/x.png'
      });
      assert.deepEqual(parsePasteReference('../12/x.png'), {
        sourceId: '12',
        filename: 'x.png'
      });
      for (const reference of [
        '../content/12//etc/hosts',
        `../content/12/${working}/x.png`,
        '../content/12/../../canary.png',
        '../content/12/a/../b.png',
        '../content/12/a/..',
        '../content/12/a\\..\\b.png',
        '../content/../canary.png',
        '../../canary.png',
        '../content/12',
        '../content/12/',
        '../abc/x.png',
        'images/x.png'
      ]) {
        assert.equal(parsePasteReference(reference), undefined, reference);
      }
    } finally {
      process.chdir(working);
    }
  }
});

test('a paste within one book takes a source like any other and stores a copy', async (t) => {
  const { tenant, file, sourceId, root, patch } = await pasteFixture(t);
  const params = {
    image: { path: file, mime: 'image/png' },
    audio: [{ path: `../${sourceId}/${file}`, mime: 'audio/mpeg' }]
  };
  await withHost(
    async (port) => {
      const refused = await patch(port, sourceId, params);
      assert.equal(refused.status, 422, refused.body);
      assert.equal(JSON.parse(refused.body).code, 'paste-source-refused');
      const saved = await patch(port, sourceId, params, {
        'x-h5p-paste-sources': sourceId
      });
      assert.equal(saved.status, 200, saved.body);
      const stored =
        await tenant.context.h5pEditor.contentStorage.getParameters(sourceId);
      assert.equal(stored.image.path, file);
      assert.notEqual(stored.audio[0].path, file);
      assert.doesNotMatch(stored.audio[0].path, /\.\.\//);
      for (const name of [stored.image.path, stored.audio[0].path]) {
        assert.equal(
          await fs.readFile(path.join(root, sourceId, name), 'utf8'),
          'source bytes'
        );
      }
    },
    { tenant }
  );
});

test('a save copies another book only from a source the request names', async (t) => {
  const { tenant, editor, file, sourceId, root, stored, patch, save } =
    await pasteFixture(t);
  const target = await save({});
  const before = await stored();
  const refused = (response) => {
    assert.equal(response.status, 422, response.body);
    const answer = JSON.parse(response.body);
    assert.equal(answer.code, 'paste-source-refused');
    assert.match(answer.error, /No changes were saved/);
    assert.doesNotMatch(answer.error, /source\.png|\.\.\//);
  };
  const reference = `../content/${sourceId}/${file}`;
  await withHost(
    async (port) => {
      // Not named: over stored content and for new content alike.
      for (const id of [target.contentId, 'new']) {
        refused(await patch(port, id, imageAt(reference)));
        refused(
          await patch(port, id, imageAt(`../${sourceId}/${file}`), {
            'x-h5p-paste-sources': String(Number(sourceId) + 1)
          })
        );
        // An empty list names nothing, whatever an embedder's proxy makes of it.
        refused(
          await patch(port, id, imageAt(reference), {
            'x-h5p-paste-sources': ''
          })
        );
      }
      // Wherever the scan finds a file, also as a `#tmp` path.
      for (const params of [
        { audio: [{ path: reference, mime: 'audio/mpeg' }] },
        {
          image: {
            path: 'kept.png',
            mime: 'image/png',
            originalImage: { path: reference, mime: 'image/png' }
          }
        },
        {
          child: { library: 'H5P.ReviewMedia 1.0', params: imageAt(reference) }
        },
        imageAt(`${reference}#tmp`),
        // YouTube's mime type must not pass for an external URL here.
        { video: [{ path: reference, mime: 'video/YouTube' }] }
      ]) {
        refused(await patch(port, 'new', params));
      }
      assert.deepEqual(await stored(), before);
      assert.equal(
        await contentRevision(root, target.contentId),
        target.revision
      );

      for (const [index, path_] of [
        reference,
        `../${sourceId}/${file}`
      ].entries()) {
        const saved = await patch(port, target.contentId, imageAt(path_), {
          'x-h5p-paste-sources': `${Number(sourceId) + 5},${sourceId}`
        });
        assert.equal(saved.status, 200, saved.body);
        const params = await editor.contentStorage.getParameters(
          target.contentId
        );
        assert.doesNotMatch(params.image.path, /\.\.\//, `reference ${index}`);
        assert.equal(
          await fs.readFile(
            path.join(root, target.contentId, params.image.path),
            'utf8'
          ),
          'source bytes'
        );
      }
    },
    { tenant }
  );
});

test('a path outside the content directory is refused whatever sources are named', async (t) => {
  const { tenant, sourceId, root, file, stored, patch } = await pasteFixture(t);
  const canary = path.join(path.dirname(root), 'canary.png');
  await fs.writeFile(canary, 'canary bytes');
  await fs.mkdir(path.join(root, sourceId, 'sub'), { recursive: true });
  const before = await stored();
  await withHost(
    async (port) => {
      for (const reference of [
        '../content/../canary.png',
        '../../canary.png',
        '../content/..',
        `../content/${sourceId}/../../canary.png`,
        `../content/${sourceId}/sub/../../../canary.png`,
        `../content/${sourceId}//etc/hosts`,
        `../content/content/${sourceId}/${file}`,
        `../${sourceId}`,
        '../.hidden/canary.png'
      ]) {
        for (const headers of [
          {},
          { 'x-h5p-paste-sources': sourceId },
          { 'x-h5p-paste-sources': `${sourceId},0` }
        ]) {
          const response = await patch(
            port,
            'new',
            imageAt(reference),
            headers
          );
          assert.equal(response.status, 422, `${reference}: ${response.body}`);
          assert.equal(
            JSON.parse(response.body).code,
            'paste-source-refused',
            reference
          );
        }
      }
      assert.deepEqual(await stored(), before);
      assert.equal(await fs.readFile(canary, 'utf8'), 'canary bytes');
    },
    { tenant }
  );
});

test('a malformed paste sources header is refused before anything is written', async (t) => {
  const { tenant, file, sourceId, stored, patch } = await pasteFixture(t);
  const before = await stored();
  await withHost(
    async (port) => {
      for (const value of [
        'abc',
        '1,',
        ',1',
        '1,,2',
        '1, 2',
        '1;2',
        '-1',
        '1.5',
        '../1',
        'new'
      ]) {
        const response = await patch(
          port,
          'new',
          imageAt(`../content/${sourceId}/${file}`),
          { 'x-h5p-paste-sources': value }
        );
        assert.equal(response.status, 400, `${value}: ${response.body}`);
      }
      assert.deepEqual(await stored(), before);
    },
    { tenant }
  );
});

test('a refused paste leaves no receipt, and the sources are not part of the operation', async (t) => {
  const { tenant, file, sourceId, root, patch } = await pasteFixture(t);
  const key = crypto.randomUUID();
  const reference = imageAt(`../content/${sourceId}/${file}`);
  await withHost(
    async (port) => {
      const refused = await patch(port, 'new', reference, {
        'idempotency-key': key
      });
      assert.equal(refused.status, 422, refused.body);
      assert.equal(await readOperation(root, key), undefined);
      // The same operation, now with the source named, is a first attempt...
      const saved = await patch(port, 'new', reference, {
        'idempotency-key': key,
        'x-h5p-paste-sources': sourceId
      });
      assert.equal(saved.status, 200, saved.body);
      // ...and a replay answers what it recorded, whatever it names now.
      const replayed = await patch(port, 'new', reference, {
        'idempotency-key': key
      });
      assert.equal(replayed.status, 200, replayed.body);
      assert.equal(
        JSON.parse(replayed.body).contentId,
        JSON.parse(saved.body).contentId
      );
    },
    { tenant }
  );
});

test('generation takes no paste sources: the header means nothing there', async (t) => {
  const { tenant, file, sourceId, stored } = await pasteFixture(t);
  const before = await stored();
  await withHost(
    async (port) => {
      const response = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/generated-content`,
        {
          library: 'H5P.ReviewMedia 1.0',
          metadata: { title: 'Generated', license: 'U' },
          params: imageAt(`../content/${sourceId}/${file}`)
        },
        { ...auth, 'x-h5p-paste-sources': sourceId }
      );
      assert.equal(response.status, 422, response.body);
      assert.equal(JSON.parse(response.body).code, 'paste-source-refused');
      assert.deepEqual(await stored(), before);
    },
    { tenant }
  );
});

test('media pasted from another book counts towards the limit of the save', async (t) => {
  withEnv(t, { H5P_HOST_MAX_BOOK_BYTES: '100000' });
  const { tenant, upload, save, stored, patch } = await pasteFixture(t);
  const large = await upload('large.mp3', Buffer.alloc(50000));
  const source = await save({
    audio: [{ path: `${large}#tmp`, mime: 'audio/mpeg' }]
  });
  const before = await stored();
  const reference = {
    path: `../content/${source.contentId}/${large}`,
    mime: 'audio/mpeg'
  };
  await withHost(
    async (port) => {
      const refused = await patch(
        port,
        'new',
        { audio: [reference, reference] },
        { 'x-h5p-paste-sources': source.contentId }
      );
      assert.equal(refused.status, 413, refused.body);
      assert.equal(JSON.parse(refused.body).code, 'book-media-too-large');
      assert.deepEqual(await stored(), before);
    },
    { tenant }
  );
});

test('the upload preflight opens no other book but still counts its own', async (t) => {
  withEnv(t, { H5P_HOST_MAX_BOOK_BYTES: '100000' });
  const { tenant, editor, upload, file, sourceId, save } =
    await pasteFixture(t);
  const ownFile = await upload('own.png', Buffer.alloc(40000));
  const own = await save({
    image: { path: `${ownFile}#tmp`, mime: 'image/png' }
  });
  const opened = [];
  for (const method of ['fileExists', 'getFileStats']) {
    const real = editor.contentStorage[method].bind(editor.contentStorage);
    t.mock.method(editor.contentStorage, method, (id, ...rest) => {
      opened.push(String(id));
      return real(id, ...rest);
    });
  }
  await withHost(
    async (port) => {
      const check = (id, reference) =>
        rawSend(
          port,
          'POST',
          `${CORE}/api/v1/content/${id}/check-media-size`,
          {
            library: 'H5P.ReviewMedia 1.0',
            metadata: {},
            params: imageAt(reference),
            incomingBytes: 0
          },
          auth
        );
      for (const id of ['new', own.contentId]) {
        for (const reference of [
          `../content/${sourceId}/${file}`,
          `../${sourceId}/${file}`,
          `../content/${sourceId}/missing.png`
        ]) {
          const foreign = await check(id, reference);
          assert.equal(foreign.status, 200, foreign.body);
          assert.equal(JSON.parse(foreign.body).mediaBytes, 0, reference);
        }
      }
      assert.deepEqual(opened, []);
      for (const reference of [
        `../content/${own.contentId}/${ownFile}`,
        `../${own.contentId}/${ownFile}`
      ]) {
        const counted = await check(own.contentId, reference);
        assert.equal(counted.status, 200, counted.body);
        assert.equal(JSON.parse(counted.body).mediaBytes, 40000);
      }
      assert.ok(opened.every((id) => id === own.contentId));
      for (const id of ['new', own.contentId]) {
        const invalid = await check(id, '../content/../canary.png');
        assert.equal(invalid.status, 400, invalid.body);
        assert.equal(JSON.parse(invalid.body).error, 'Invalid media path.');
      }
    },
    { tenant }
  );
});

test('content on a library version that is not installed can still be replaced, keeping its referenced media', async (t) => {
  const { tenant, editor, save } = await fixture(t);
  // Stored by another installation on H5P.ReviewMedia 0.9, which this host
  // lacks: h5p-server's update scans the stored parameters with that
  // version's semantics, which cannot be read.
  const id = '41';
  const directory = path.join(tenant.context.paths.content, id);
  await fs.mkdir(path.join(directory, 'images'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'h5p.json'),
    JSON.stringify({
      title: 'Old',
      language: 'en',
      mainLibrary: 'H5P.ReviewMedia',
      embedTypes: ['iframe'],
      license: 'U',
      preloadedDependencies: [
        { machineName: 'H5P.ReviewMedia', majorVersion: 0, minorVersion: 9 }
      ]
    })
  );
  const image = { path: 'images/kept.png', mime: 'image/png' };
  await fs.writeFile(
    path.join(directory, 'content.json'),
    JSON.stringify({ image })
  );
  await fs.writeFile(path.join(directory, 'images/kept.png'), 'kept');
  await fs.writeFile(path.join(directory, 'images/orphan.png'), 'orphan');

  // The upgraded parameters, as the editor page saves them.
  const saved = await save({ image }, id);
  assert.equal(saved.contentId, id);
  assert.equal(
    (await editor.contentStorage.getMetadata(id)).preloadedDependencies[0]
      .minorVersion,
    0
  );
  // The stored files stand in for the unscannable old parameters: what the
  // new parameters reference stays, the rest goes as unreferenced.
  assert.deepEqual(await editor.contentStorage.listFiles(id), [
    path.join('images', 'kept.png')
  ]);
});

test('the real vendor download route is disabled and the guarded host export works', async (t) => {
  const { tenant, save } = await fixture(t);
  const result = await save({});
  await withHost(
    async (port) => {
      const legacy = await rawGet(
        port,
        `${CORE}/h5p/download/${result.contentId}`,
        auth
      );
      assert.equal(legacy.status, 404);
      const exported = await rawGet(
        port,
        `${CORE}/api/v1/content/${result.contentId}/download`,
        auth
      );
      assert.equal(exported.status, 200, exported.body);
      assert.match(exported.headers['content-disposition'], /attachment/);
      assert.ok(exported.body.startsWith('PK'));
    },
    { tenant }
  );
});
