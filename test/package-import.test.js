const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { tmpDir, writeLibrary } = require('./helpers');
const { CORE, auth, multipart, rawGet, withHost } = require('./host');
const createH5PConfig = require('../build/src/h5p/config').default;
const {
  default: createH5PEditor,
  createLibraryStorage
} = require('../build/src/h5p/editor');
const {
  contentRevision,
  readOperation
} = require('../build/src/content-transactions');

// Use the same zip writer h5p-server uses for exports.
const { ZipFile } = require(
  require.resolve('yazl', {
    paths: [
      path.dirname(require.resolve('@lumieducation/h5p-server/package.json'))
    ]
  })
);

const metadata = {
  title: 'Original',
  language: 'en',
  mainLibrary: 'H5P.MediaFixture',
  preloadedDependencies: [
    { machineName: 'H5P.MediaFixture', majorVersion: 1, minorVersion: 0 }
  ],
  embedTypes: ['div'],
  license: 'U',
  authorComments: '@id=media-fixture;'
};

async function packageOf(params, files = {}, title = 'Original') {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(JSON.stringify({ ...metadata, title })),
    'h5p.json'
  );
  zip.addBuffer(Buffer.from(JSON.stringify(params)), 'content/content.json');
  for (const [name, bytes] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(bytes), `content/${name}`);
  }
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function mediaTenant(t) {
  const root = tmpDir(t, 'package-import-');
  const libraries = path.join(root, 'libraries');
  const content = path.join(root, 'content');
  const tmp = path.join(root, 'tmp');
  await fs.mkdir(content);
  await fs.mkdir(tmp);
  await writeLibrary(
    libraries,
    'H5P.MediaFixture-1.0',
    {
      machineName: 'H5P.MediaFixture',
      title: 'Media fixture',
      majorVersion: 1,
      minorVersion: 0,
      patchVersion: 0,
      runnable: 1
    },
    {
      'semantics.json': JSON.stringify([
        {
          name: 'media',
          type: 'group',
          fields: ['image', 'audio', 'video', 'file'].map((type) => ({
            name: type,
            type,
            optional: true
          }))
        }
      ])
    }
  );
  const h5pEditor = await createH5PEditor(
    createH5PConfig(),
    createLibraryStorage(libraries),
    content,
    tmp,
    (key) => key,
    'http://localhost/editor'
  );
  return {
    rootPath: root,
    context: { language_code: 'en', paths: { content, tmp }, h5pEditor }
  };
}

const importPackage = (port, bytes, id = '', headers = {}) =>
  multipart(
    port,
    `${CORE}/api/v1/import/h5p${id ? `/${id}` : ''}`,
    [{ filename: 'book.h5p', contentType: 'application/zip', data: bytes }],
    { ...auth, 'idempotency-key': crypto.randomUUID(), ...headers }
  );

for (const [type, name, mime] of [
  ['image', 'images/pixel.png', 'image/png'],
  ['audio', 'audios/sound.mp3', 'audio/mpeg'],
  ['video', 'videos/movie.mp4', 'video/mp4'],
  ['file', 'files/document.pdf', 'application/pdf']
]) {
  test(`a package missing a referenced ${type} cannot create or replace content`, async (t) => {
    const tenant = await mediaTenant(t);
    const { content, tmp } = tenant.context.paths;
    const asset = { path: name, mime };
    const params = {
      media: { [type]: ['audio', 'video'].includes(type) ? [asset] : asset }
    };
    const complete = await packageOf(params, {
      [name]: 'original media bytes'
    });
    const incomplete = await packageOf(params, {}, 'Incomplete replacement');
    await withHost(
      async (port) => {
        const rejectedNew = await importPackage(port, incomplete);
        assert.equal(rejectedNew.status, 422, rejectedNew.body);
        assert.equal(JSON.parse(rejectedNew.body).code, 'media-missing');
        assert.deepEqual(await fs.readdir(content), []);
        assert.deepEqual(await fs.readdir(tmp), []);

        const created = await importPackage(port, complete);
        assert.equal(created.status, 201, created.body);
        const first = JSON.parse(created.body);
        const directory = path.join(content, first.contentId);
        const beforeParams = await fs.readFile(
          path.join(directory, 'content.json')
        );
        const beforeMetadata = await fs.readFile(
          path.join(directory, 'h5p.json')
        );
        const storedMedia = JSON.parse(beforeParams).media[type];
        const storedPath = (
          Array.isArray(storedMedia) ? storedMedia[0] : storedMedia
        ).path;
        const originalFile = await fs.readFile(
          path.join(directory, storedPath)
        );
        const operationId = crypto.randomUUID();
        const refused = await importPackage(port, incomplete, first.contentId, {
          'if-match': first.revision,
          'idempotency-key': operationId
        });
        assert.equal(refused.status, 422, refused.body);
        assert.equal(JSON.parse(refused.body).code, 'media-missing');
        assert.match(
          JSON.parse(refused.body).detail,
          new RegExp(path.basename(name))
        );
        assert.deepEqual(
          await fs.readFile(path.join(directory, 'content.json')),
          beforeParams
        );
        assert.deepEqual(
          await fs.readFile(path.join(directory, 'h5p.json')),
          beforeMetadata
        );
        assert.deepEqual(
          await fs.readFile(path.join(directory, storedPath)),
          originalFile
        );
        assert.equal(
          await contentRevision(content, first.contentId),
          first.revision
        );
        assert.equal(await readOperation(content, operationId), undefined);

        // The refusal leaves no receipt and releases the lock: the repaired
        // package can retry the same operation and replace the same content.
        const repaired = await packageOf(
          params,
          { [name]: 'replacement media bytes' },
          'Complete replacement'
        );
        const replaced = await importPackage(port, repaired, first.contentId, {
          'if-match': first.revision,
          'idempotency-key': operationId
        });
        assert.equal(replaced.status, 200, replaced.body);
        assert.equal(JSON.parse(replaced.body).contentId, first.contentId);
        const after = JSON.parse(
          await fs.readFile(path.join(directory, 'content.json'), 'utf8')
        ).media[type];
        const afterPath = (Array.isArray(after) ? after[0] : after).path;
        assert.equal(
          await fs.readFile(path.join(directory, afterPath), 'utf8'),
          'replacement media bytes'
        );
        await assert.rejects(fs.stat(path.join(directory, storedPath)), {
          code: 'ENOENT'
        });
      },
      { tenant }
    );
  });
}

test('a new version can be imported over content on a library version that is not installed', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  // Stored by an installation that had H5P.MediaFixture 0.9; this one has
  // only 1.0, so h5p-server cannot scan the stored parameters for media.
  const directory = path.join(content, '9');
  await fs.mkdir(path.join(directory, 'images'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'h5p.json'),
    JSON.stringify({
      ...metadata,
      title: 'Old',
      preloadedDependencies: [
        { machineName: 'H5P.MediaFixture', majorVersion: 0, minorVersion: 9 }
      ]
    })
  );
  await fs.writeFile(
    path.join(directory, 'content.json'),
    JSON.stringify({
      media: { image: { path: 'images/old.png', mime: 'image/png' } }
    })
  );
  await fs.writeFile(path.join(directory, 'images/old.png'), 'old bytes');
  const revision = await contentRevision(content, '9');
  const bytes = await packageOf(
    { media: { image: { path: 'images/new.png', mime: 'image/png' } } },
    { 'images/new.png': 'new bytes' },
    'New version'
  );
  await withHost(
    async (port) => {
      const replaced = await importPackage(port, bytes, '9', {
        'if-match': revision
      });
      assert.equal(replaced.status, 200, replaced.body);
      const stored = JSON.parse(
        await fs.readFile(path.join(directory, 'h5p.json'), 'utf8')
      );
      assert.equal(stored.title, 'New version');
      assert.equal(stored.preloadedDependencies[0].minorVersion, 0);
      const image = JSON.parse(
        await fs.readFile(path.join(directory, 'content.json'), 'utf8')
      ).media.image.path;
      assert.equal(
        await fs.readFile(path.join(directory, image), 'utf8'),
        'new bytes'
      );
      // The old version's media is no longer referenced, so it goes.
      assert.deepEqual(await fs.readdir(path.join(directory, 'images')), [
        path.basename(image)
      ]);
    },
    { tenant }
  );
});

test('package imports preserve external media URLs and accept omitted optional media', async (t) => {
  const tenant = await mediaTenant(t);
  await withHost(
    async (port) => {
      for (const media of [
        {},
        { image: { path: '', mime: 'image/png' } },
        {
          image: {
            path: 'https://example.invalid/image.png',
            mime: 'image/png'
          }
        },
        {
          video: [{ path: 'https://youtu.be/example', mime: 'video/YouTube' }]
        }
      ]) {
        const created = await importPackage(port, await packageOf({ media }));
        assert.equal(created.status, 201, created.body);
        const { contentId } = JSON.parse(created.body);
        const edit = await rawGet(
          port,
          `${CORE}/api/v1/content/${contentId}/edit`,
          auth
        );
        assert.equal(edit.status, 200, edit.body);
        assert.deepEqual(JSON.parse(edit.body).h5p.params.media, media);
      }
    },
    { tenant }
  );
});

test('the importer retains h5p-server support for legacy external video references', async (t) => {
  const tenant = await mediaTenant(t);
  const params = {
    media: { video: [{ path: 'youtu.be/example', mime: 'video/YouTube' }] }
  };
  const uploaded = await tenant.context.h5pEditor.uploadPackage(
    await packageOf(params),
    { id: 'dev1', name: 'dev', type: 'local', email: 'a@b.c' }
  );
  assert.deepEqual(uploaded.parameters, params);
});
