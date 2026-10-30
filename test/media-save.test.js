const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const TenantManager = require('../build/src/tenant-manager').default;
const { saveEditorContent } = require('../build/src/routes/content');
const {
  mutateContent,
  contentRevision
} = require('../build/src/content-transactions');
const { sweepExpired } = require('../build/src/temp-storage');
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
    save: (params, id) => {
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
            bookId: 'keep'
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

test('upload preflight counts unsaved, nested and pasted media and ignores remote URLs', async (t) => {
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
      const pasted = await check(
        {
          audio: [1, 2].map(() => ({
            path: `../${original.contentId}/${first}`,
            mime: 'audio/mpeg'
          }))
        },
        16000,
        'new'
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
  const pasted = await save({
    child: {
      library: 'H5P.ReviewMedia 1.0',
      params: {
        image: { path: `../${original.contentId}/${first}`, mime: 'image/png' },
        audio: [{ path: 'https://example.com/audio.mp3', mime: 'audio/mpeg' }]
      }
    }
  });
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
