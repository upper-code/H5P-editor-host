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
const { withHost, rawGet, CORE, auth } = require('./host');

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
    upload: (name) =>
      editor.temporaryFileManager.addFile(
        name,
        Readable.from(['media bytes']),
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
          saveEditorContent(tenant.context, tenant.user, id || 'new', body)
      });
    }
  };
}

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
