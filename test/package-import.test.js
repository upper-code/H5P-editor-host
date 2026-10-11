const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { tmpDir, writeLibrary } = require('./helpers');
const { CORE, auth, multipart, rawGet, withHost } = require('./host');
const createH5PConfig = require('../build/src/h5p/config').default;
const createH5PPlayer = require('../build/src/h5p/player').default;
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

async function packageOf(
  params,
  files = {},
  title = 'Original',
  overrides = {}
) {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(JSON.stringify({ ...metadata, title, ...overrides })),
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

const library = (machineName, majorVersion, minorVersion, extra = {}) => ({
  machineName,
  title: machineName,
  majorVersion,
  minorVersion,
  patchVersion: 0,
  runnable: 0,
  ...extra
});

const dependency = (machineName, majorVersion = 1, minorVersion = 0) => ({
  machineName,
  majorVersion,
  minorVersion
});

/**
 * A tenant with the media fixture as its main library and, unless
 * `examFixture` is false, `H5P.ExamFixture 1.0` — a library only an exam
 * would need, with a script of its own. `mediaDependencies` become the media
 * fixture's own preloaded dependencies; `libraries` are written as well, as
 * `{ 'Name-1.0': library.json, … }` or `{ 'Name-1.0': [library.json, files] }`.
 */
async function mediaTenant(
  t,
  { libraries: extraLibraries = {}, mediaDependencies, examFixture = true } = {}
) {
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
      ...library('H5P.MediaFixture', 1, 0, { runnable: 1 }),
      title: 'Media fixture',
      ...(mediaDependencies ? { preloadedDependencies: mediaDependencies } : {})
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
  const all = {
    ...(examFixture
      ? {
          'H5P.ExamFixture-1.0': [
            library('H5P.ExamFixture', 1, 0, {
              preloadedJs: [{ path: 'exam.js' }]
            }),
            { 'exam.js': '/* exam fixture */' }
          ]
        }
      : {}),
    ...extraLibraries
  };
  for (const [name, value] of Object.entries(all)) {
    const [meta, files] = Array.isArray(value) ? value : [value, {}];
    await writeLibrary(libraries, name, meta, files);
  }
  const config = createH5PConfig();
  const h5pEditor = await createH5PEditor(
    config,
    createLibraryStorage(libraries),
    content,
    tmp,
    (key) => key,
    'http://localhost/editor'
  );
  const h5pPlayer = createH5PPlayer(
    h5pEditor,
    config,
    (key) => key,
    'http://localhost/editor'
  );
  return {
    rootPath: root,
    context: {
      language_code: 'en',
      paths: { content, tmp },
      h5pEditor,
      h5pPlayer
    }
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

test('a package whose main library is not among its dependencies is refused with 400', async (t) => {
  const tenant = await mediaTenant(t);
  const { content, tmp } = tenant.context.paths;
  const unresolvable = await packageOf({}, {}, 'Original', {
    mainLibrary: 'H5P.Elsewhere'
  });
  await withHost(
    async (port) => {
      const refused = await importPackage(port, unresolvable);
      assert.equal(refused.status, 400, refused.body);
      assert.match(
        JSON.parse(refused.body).error,
        /does not declare a resolvable main library/
      );
      assert.deepEqual(await fs.readdir(content), []);
      assert.deepEqual(await fs.readdir(tmp), []);
    },
    { tenant }
  );
});

// --- Exam packages (src/h5p/exam-package.ts) --------------------------------

const http = require('node:http');
const os = require('node:os');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { withEnv } = require('./helpers');
const { rawSend } = require('./host');
const { sweepExpired } = require('../build/src/temp-storage');

const yauzl = require(
  path.dirname(
    require.resolve('yauzl-promise/package.json', {
      paths: [
        path.dirname(require.resolve('@lumieducation/h5p-server/package.json'))
      ]
    })
  )
);

const tenantUser = { id: 'dev1', name: 'dev', type: 'local', email: 'a@b.c' };

const examDependencies = [
  dependency('H5P.MediaFixture'),
  dependency('H5P.ExamFixture')
];

/**
 * Parameters as the publisher writes them: an open image, and a `vmbExam`
 * whose ciphertext the host cannot read. `media` lists the exam's own files
 * (`null` leaves it out: the older format without it).
 */
function examParams(
  media = [{ path: 'images/exam only.png', iv: 'aXY=', mac: 'bWFj' }],
  open = 'images/open.png'
) {
  return {
    media: open ? { image: { path: open, mime: 'image/png' } } : {},
    vmbExam: {
      alg: 'AES-256-CBC+HMAC-SHA256',
      page: 3,
      iv: 'aXY=',
      data: 'Y2lwaGVydGV4dA==',
      mac: 'bWFj',
      ...(media ? { media } : {})
    }
  };
}

const examFiles = {
  'images/open.png': 'open bytes',
  // Ciphertext as far as the host can tell.
  'images/exam only.png': 'exam ciphertext bytes',
  'images/q/x.svg': 'exam-only svg'
};

const examPackage = (
  params = examParams(),
  files = examFiles,
  overrides = {}
) =>
  packageOf(params, files, 'Exam', {
    preloadedDependencies: examDependencies,
    ...overrides
  });

/** Every file under `directory`, as sorted POSIX paths relative to it. */
async function filesUnder(directory) {
  const entries = await fs.readdir(directory, {
    recursive: true,
    withFileTypes: true
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(directory, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/')
    )
    .sort();
}

/** `{ path: bytes }` of every file under `directory`. */
async function snapshot(directory) {
  const result = {};
  for (const file of await filesUnder(directory)) {
    result[file] = await fs.readFile(path.join(directory, file));
  }
  return result;
}

const storedJson = async (content, id, name) =>
  JSON.parse(await fs.readFile(path.join(content, id, name), 'utf8'));

const declared = (metadata) =>
  metadata.preloadedDependencies
    .map((lib) => `${lib.machineName} ${lib.majorVersion}.${lib.minorVersion}`)
    .sort();

/** Content files, without the stored metadata and parameters. */
const mediaOf = async (content, id) =>
  (await filesUnder(path.join(content, id))).filter(
    (file) => file !== 'h5p.json' && file !== 'content.json'
  );

/**
 * Records the staging directories exam imports create, so a test can tell
 * that one was made before it checks that none is left.
 */
function trackStaging(t) {
  const created = [];
  const mkdtemp = fs.mkdtemp;
  t.mock.method(fs, 'mkdtemp', async (...args) => {
    const directory = await mkdtemp.apply(fs, args);
    if (path.basename(directory).startsWith('h5p-exam-')) {
      created.push(directory);
    }
    return directory;
  });
  return created;
}

async function leftoverStaging(directory) {
  return (await fs.readdir(directory)).filter((name) =>
    name.startsWith('h5p-exam-')
  );
}

const editorSave = (port, id, params, headers = {}) =>
  rawSend(
    port,
    'PATCH',
    `${CORE}/api/v1/content/${id}`,
    {
      library: 'H5P.MediaFixture 1.0',
      params,
      metadata: { title: 'Exam', license: 'U' }
    },
    { ...auth, 'idempotency-key': crypto.randomUUID(), ...headers }
  );

/** Stored exam content written straight to disk, as another host left it. */
async function storeOnDisk(content, id, params, preloadedDependencies, files) {
  const directory = path.join(content, id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'h5p.json'),
    JSON.stringify({ ...metadata, title: 'Exam', preloadedDependencies })
  );
  await fs.writeFile(
    path.join(directory, 'content.json'),
    JSON.stringify(params)
  );
  for (const [name, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), {
      recursive: true
    });
    await fs.writeFile(path.join(directory, name), bytes);
  }
}

/** A binary GET; `rawGet` decodes the body as text. */
function download(port, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get(
        { port, host: '127.0.0.1', path: requestPath, headers: auth },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              body: Buffer.concat(chunks)
            })
          );
        }
      )
      .on('error', reject);
  });
}

async function zipEntries(bytes) {
  const zip = await yauzl.fromBuffer(bytes);
  try {
    return (await zip.readEntries())
      .map((entry) => entry.fileName)
      .filter((name) => !name.endsWith('/'))
      .sort();
  } finally {
    await zip.close();
  }
}

test('an exam package keeps its declared dependencies and every content file under its own name', async (t) => {
  const tenant = await mediaTenant(t);
  const { content, tmp } = tenant.context.paths;
  await withHost(
    async (port) => {
      const created = await importPackage(port, await examPackage());
      assert.equal(created.status, 201, created.body);
      const { contentId, metadata: answered } = JSON.parse(created.body);
      assert.deepEqual(
        await mediaOf(content, contentId),
        Object.keys(examFiles).sort()
      );
      for (const [name, bytes] of Object.entries(examFiles)) {
        assert.equal(
          await fs.readFile(path.join(content, contentId, name), 'utf8'),
          bytes
        );
      }
      assert.deepEqual(
        await storedJson(content, contentId, 'content.json'),
        examParams()
      );
      const stored = await storedJson(content, contentId, 'h5p.json');
      assert.ok(declared(stored).includes('H5P.ExamFixture 1.0'));
      // The answer carries the merged metadata, not the recomputed one.
      assert.deepEqual(declared(answered), declared(stored));
      // Nothing went through the temporary storage.
      assert.deepEqual(await fs.readdir(tmp), []);

      const page = await rawGet(
        port,
        `${CORE}/api/v1/content/${contentId}/render`,
        auth
      );
      assert.equal(page.status, 200, page.body);
      assert.match(page.body, /H5P\.ExamFixture-1\.0\/exam\.js/);
    },
    { tenant }
  );
});

test('a package without vmbExam is imported as before', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  const plain = examParams();
  delete plain.vmbExam;
  await withHost(
    async (port) => {
      const created = await importPackage(
        port,
        await examPackage(plain, examFiles)
      );
      assert.equal(created.status, 201, created.body);
      const { contentId } = JSON.parse(created.body);
      const stored = await storedJson(content, contentId, 'content.json');
      assert.notEqual(stored.media.image.path, 'images/open.png');
      assert.deepEqual(await mediaOf(content, contentId), [
        stored.media.image.path
      ]);
      assert.ok(
        !declared(await storedJson(content, contentId, 'h5p.json')).includes(
          'H5P.ExamFixture 1.0'
        )
      );

      // A version without vmbExam over an exam book: the dependencies are
      // recomputed as usual, the old exam's files stay as orphans.
      const exam = await importPackage(port, await examPackage());
      assert.equal(exam.status, 201, exam.body);
      const book = JSON.parse(exam.body);
      const replaced = await importPackage(
        port,
        await examPackage(plain, examFiles),
        book.contentId,
        { 'if-match': book.revision }
      );
      assert.equal(replaced.status, 200, replaced.body);
      assert.deepEqual(
        declared(await storedJson(content, book.contentId, 'h5p.json')),
        ['H5P.MediaFixture 1.0']
      );
      const files = await mediaOf(content, book.contentId);
      assert.ok(files.includes('images/exam only.png'), files.join());
    },
    { tenant }
  );
});

test("a version import of an exam package replaces the files and dependencies with the new package's own", async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  const media = (...names) =>
    names.map((name) => ({ path: name, iv: 'aXY=', mac: 'bWFj' }));
  await withHost(
    async (port) => {
      const created = await importPackage(
        port,
        await examPackage(examParams(media('images/a.png', 'images/b.png')), {
          'images/open.png': 'open',
          'images/a.png': 'A',
          'images/b.png': 'B'
        })
      );
      assert.equal(created.status, 201, created.body);
      const first = JSON.parse(created.body);
      const replaced = await importPackage(
        port,
        await examPackage(
          examParams(media('images/b.png', 'images/c.png')),
          {
            'images/open.png': 'open',
            'images/b.png': 'B prime',
            'images/c.png': 'C'
          },
          { preloadedDependencies: [dependency('H5P.MediaFixture')] }
        ),
        first.contentId,
        { 'if-match': first.revision }
      );
      assert.equal(replaced.status, 200, replaced.body);
      const second = JSON.parse(replaced.body);
      assert.deepEqual(await mediaOf(content, first.contentId), [
        'images/b.png',
        'images/c.png',
        'images/open.png'
      ]);
      assert.equal(
        await fs.readFile(
          path.join(content, first.contentId, 'images/b.png'),
          'utf8'
        ),
        'B prime'
      );
      assert.deepEqual(
        declared(await storedJson(content, first.contentId, 'h5p.json')),
        ['H5P.MediaFixture 1.0']
      );

      const before = await snapshot(path.join(content, first.contentId));
      const stale = await importPackage(
        port,
        await examPackage(),
        first.contentId,
        { 'if-match': first.revision }
      );
      assert.equal(stale.status, 409, stale.body);
      assert.deepEqual(
        await snapshot(path.join(content, first.contentId)),
        before
      );
      assert.equal(
        await contentRevision(content, first.contentId),
        second.revision
      );
    },
    { tenant }
  );
});

test('an exam package declaring a library that is not installed is refused and stores nothing', async (t) => {
  const tenant = await mediaTenant(t, {
    libraries: {
      'H5P.ExamParent-1.0': library('H5P.ExamParent', 1, 0, {
        preloadedDependencies: [dependency('H5P.Gone')]
      })
    }
  });
  const { content, tmp } = tenant.context.paths;
  await withHost(
    async (port) => {
      // Declared in h5p.json: h5p-server's own check answers first.
      const direct = await importPackage(
        port,
        await examPackage(examParams(), examFiles, {
          preloadedDependencies: [...examDependencies, dependency('H5P.Absent')]
        })
      );
      assert.equal(direct.status, 400, direct.body);
      // Only in the tree of a declared, installed library.
      const transitive = await importPackage(
        port,
        await examPackage(examParams(), examFiles, {
          preloadedDependencies: [
            ...examDependencies,
            dependency('H5P.ExamParent')
          ]
        })
      );
      assert.equal(transitive.status, 422, transitive.body);
      assert.equal(JSON.parse(transitive.body).code, 'exam-library-missing');
      assert.deepEqual(await fs.readdir(content), []);
      assert.deepEqual(await fs.readdir(tmp), []);
    },
    { tenant }
  );
});

test('an exam package that declares another version of a library its open part uses is refused', async (t) => {
  const tenant = await mediaTenant(t, {
    mediaDependencies: [dependency('H5P.Common')],
    libraries: {
      'H5P.Common-1.0': library('H5P.Common', 1, 0),
      'H5P.Common-2.0': library('H5P.Common', 2, 0),
      'H5P.ExamDeep-1.0': library('H5P.ExamDeep', 1, 0, {
        preloadedDependencies: [dependency('H5P.Common', 2, 0)]
      })
    }
  });
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      for (const extra of [
        dependency('H5P.Common', 2, 0),
        dependency('H5P.ExamDeep')
      ]) {
        const refused = await importPackage(
          port,
          await examPackage(examParams(), examFiles, {
            preloadedDependencies: [...examDependencies, extra]
          })
        );
        assert.equal(refused.status, 422, refused.body);
        assert.equal(JSON.parse(refused.body).code, 'exam-library-conflict');
      }
      assert.deepEqual(await fs.readdir(content), []);
      // Without the second version the same book imports.
      const accepted = await importPackage(port, await examPackage());
      assert.equal(accepted.status, 201, accepted.body);
    },
    { tenant }
  );
});

test('an editor save of an exam book whose exam library is no longer installed is refused', async (t) => {
  for (const [label, options, declaredLibraries] of [
    ['the declared library', { examFixture: false }, examDependencies],
    [
      'a dependency of an installed declared library',
      {
        libraries: {
          'H5P.ExamParent-1.0': library('H5P.ExamParent', 1, 0, {
            preloadedDependencies: [dependency('H5P.Gone')]
          })
        }
      },
      [dependency('H5P.MediaFixture'), dependency('H5P.ExamParent')]
    ],
    [
      'a dependency whose library.json cannot be read',
      {
        libraries: {
          'H5P.ExamParent-1.0': library('H5P.ExamParent', 1, 0, {
            preloadedDependencies: [dependency('H5P.Broken')]
          }),
          'H5P.Broken-1.0': library('H5P.Broken', 1, 0)
        }
      },
      [dependency('H5P.MediaFixture'), dependency('H5P.ExamParent')]
    ]
  ]) {
    await t.test(label, async (t) => {
      const tenant = await mediaTenant(t, options);
      const { content } = tenant.context.paths;
      if (label.includes('cannot be read')) {
        await fs.writeFile(
          path.join(
            tenant.rootPath,
            'libraries',
            'H5P.Broken-1.0',
            'library.json'
          ),
          '{ not json'
        );
      }
      await storeOnDisk(
        content,
        '9',
        examParams(),
        declaredLibraries,
        examFiles
      );
      const before = await snapshot(path.join(content, '9'));
      const revision = await contentRevision(content, '9');
      await withHost(
        async (port) => {
          const refused = await editorSave(port, '9', examParams(), {
            'if-match': revision
          });
          assert.equal(refused.status, 422, refused.body);
          assert.equal(JSON.parse(refused.body).code, 'exam-library-missing');
        },
        { tenant }
      );
      assert.deepEqual(await snapshot(path.join(content, '9')), before);
      assert.equal(await contentRevision(content, '9'), revision);
    });
  }
});

test('an editor save of an exam book after its temporary file expired still saves', async (t) => {
  const tenant = await mediaTenant(t);
  const { content, tmp } = tenant.context.paths;
  const editor = tenant.context.h5pEditor;
  await withHost(
    async (port) => {
      const created = await importPackage(port, await examPackage());
      assert.equal(created.status, 201, created.body);
      const { contentId } = JSON.parse(created.body);
      const uploaded = await editor.temporaryFileManager.addFile(
        'fresh.png',
        Readable.from(['fresh bytes']),
        tenantUser
      );
      const params = {
        ...examParams(),
        media: { image: { path: `${uploaded}#tmp`, mime: 'image/png' } }
      };
      const saved = await editorSave(port, contentId, params);
      assert.equal(saved.status, 200, saved.body);
      await sweepExpired(tmp, 1, Date.now() + 1000);
      // The editor form still holds the `#tmp` path it uploaded under.
      const again = await editorSave(port, contentId, params);
      assert.equal(again.status, 200, again.body);
      const files = await mediaOf(content, contentId);
      assert.ok(files.includes(uploaded), files.join());
      assert.ok(files.includes('images/exam only.png'), files.join());
    },
    { tenant }
  );
});

test('a version import of an exam package may turn a file into a folder and back', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  const version = (file) =>
    examPackage(examParams([{ path: file, iv: 'aXY=', mac: 'bWFj' }]), {
      'images/open.png': 'open',
      [file]: file
    });
  await withHost(
    async (port) => {
      const created = await importPackage(port, await version('images/a.png'));
      assert.equal(created.status, 201, created.body);
      const { contentId } = JSON.parse(created.body);
      let { revision } = JSON.parse(created.body);
      for (const file of ['images/a.png/b.png', 'images/a.png']) {
        const replaced = await importPackage(
          port,
          await version(file),
          contentId,
          { 'if-match': revision }
        );
        assert.equal(replaced.status, 200, replaced.body);
        ({ revision } = JSON.parse(replaced.body));
        assert.deepEqual(await mediaOf(content, contentId), [
          file,
          'images/open.png'
        ]);
        assert.equal(
          await fs.readFile(path.join(content, contentId, file), 'utf8'),
          file
        );
      }
    },
    { tenant }
  );
});

test('an exam package with #, ?, % or a control character in a file name is refused', async (t) => {
  const tenant = await mediaTenant(t);
  const { content, tmp } = tenant.context.paths;
  await withHost(
    async (port) => {
      for (const name of [
        'images/a#b.png',
        'images/a?b.png',
        'images/a%20b.png',
        'images/a\nb.png',
        'images/a\tb.png',
        'images/a\u007fb.png'
      ]) {
        const refused = await importPackage(
          port,
          await examPackage(examParams(), { ...examFiles, [name]: 'x' })
        );
        assert.equal(
          refused.status,
          400,
          `${JSON.stringify(name)} ${refused.body}`
        );
        assert.match(JSON.parse(refused.body).error, /control character/);
      }
      assert.deepEqual(await fs.readdir(content), []);
      assert.deepEqual(await fs.readdir(tmp), []);
    },
    { tenant }
  );
});

test('files kept for an exam still pass the package checks', async (t) => {
  const tenant = await mediaTenant(t);
  const { content, tmp } = tenant.context.paths;
  const media = (name) => [{ path: name, iv: 'aXY=', mac: 'bWFj' }];
  const long = `images/${'a'.repeat(120)}/${'b'.repeat(130)}.png`;
  await withHost(
    async (port) => {
      const hidden = /names start with "\." or "_"/;
      const missing = /missing a file of its exam/;
      const ownMetadata = /its own metadata file/;
      const refusals = [
        // Not on the content whitelist, used or not.
        [
          examParams(),
          { ...examFiles, 'x.html': '<script></script>' },
          /not-in-whitelist/
        ],
        // A `#tmp` reference to a file the archive has without the suffix.
        [
          examParams(undefined, 'images/open.png#tmp'),
          examFiles,
          /temporary editor file/
        ],
        // References to the stored content's own metadata files.
        [examParams(undefined, 'content.json'), examFiles, ownMetadata],
        [
          examParams(undefined, 'h5p.json'),
          { ...examFiles, 'h5p.json': '{}' },
          ownMetadata
        ],
        [examParams(media(long)), { ...examFiles, [long]: 'x' }, /too long/],
        [examParams(media('images/absent.png')), examFiles, missing],
        [examParams(media('./images/exam only.png')), examFiles, missing],
        [examParams(media('IMAGES/exam only.png')), examFiles, missing],
        [
          examParams(media('images/_hidden.png')),
          { ...examFiles, 'images/_hidden.png': 'x' },
          hidden
        ],
        // The format without `media`: only the ciphertext could name these.
        [
          examParams(null),
          { ...examFiles, 'images/_only-in-exam.png': 'x' },
          hidden
        ],
        [examParams(null), { ...examFiles, '.hidden.png': 'x' }, hidden]
      ];
      for (const [params, files, reason] of refusals) {
        const refused = await importPackage(
          port,
          await examPackage(params, files)
        );
        assert.equal(refused.status, 400, refused.body);
        assert.match(JSON.parse(refused.body).error, reason);
      }
      assert.deepEqual(await fs.readdir(content), []);
      assert.deepEqual(await fs.readdir(tmp), []);

      // Finder litter is no reason to refuse.
      const litter = await importPackage(
        port,
        await examPackage(examParams(null), {
          ...examFiles,
          '.DS_Store': 'x',
          'images/.DS_Store': 'x'
        })
      );
      assert.equal(litter.status, 201, litter.body);
      // Without vmbExam the hidden entries are skipped silently, as before.
      const plain = examParams();
      delete plain.vmbExam;
      const old = await importPackage(
        port,
        await examPackage(plain, {
          ...examFiles,
          'images/_only-in-exam.png': 'x',
          '.hidden.png': 'x'
        })
      );
      assert.equal(old.status, 201, old.body);
    },
    { tenant }
  );
});

test('an exported exam book re-imports to the same files and dependencies', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      const created = await importPackage(port, await examPackage());
      assert.equal(created.status, 201, created.body);
      const { contentId } = JSON.parse(created.body);
      const exported = await download(
        port,
        `${CORE}/api/v1/content/${contentId}/download`
      );
      assert.equal(exported.status, 200, exported.body.toString());
      const entries = await zipEntries(exported.body);
      for (const name of Object.keys(examFiles)) {
        assert.ok(entries.includes(`content/${name}`), entries.join());
      }
      const again = await importPackage(port, exported.body);
      assert.equal(again.status, 201, again.body);
      const copy = JSON.parse(again.body).contentId;
      assert.deepEqual(
        await mediaOf(content, copy),
        await mediaOf(content, contentId)
      );
      assert.deepEqual(
        declared(await storedJson(content, copy, 'h5p.json')),
        declared(await storedJson(content, contentId, 'h5p.json'))
      );
      assert.deepEqual(
        await storedJson(content, copy, 'content.json'),
        examParams()
      );
    },
    { tenant }
  );
});

test('the staged exam tree is removed after the import, also when it is refused or times out', async (t) => {
  const staging = tmpDir(t, 'exam-staging-');
  withEnv(t, { TMPDIR: staging, H5P_HOST_IMPORT_TIMEOUT_MS: '200' });
  assert.equal(os.tmpdir(), staging);
  const tenant = await mediaTenant(t, {
    libraries: {
      'H5P.ExamParent-1.0': library('H5P.ExamParent', 1, 0, {
        preloadedDependencies: [dependency('H5P.Gone')]
      })
    }
  });
  const created = trackStaging(t);
  const editor = tenant.context.h5pEditor;
  await withHost(
    async (port) => {
      const accepted = await importPackage(port, await examPackage());
      assert.equal(accepted.status, 201, accepted.body);
      assert.equal(created.length, 1);
      assert.deepEqual(await leftoverStaging(staging), []);

      // Refused by the save, after the tree was staged.
      const refused = await importPackage(
        port,
        await examPackage(examParams(), examFiles, {
          preloadedDependencies: [
            ...examDependencies,
            dependency('H5P.ExamParent')
          ]
        })
      );
      assert.equal(refused.status, 422, refused.body);
      assert.equal(created.length, 2);
      assert.deepEqual(await leftoverStaging(staging), []);

      // The import outlasts its budget after staging its tree: the answer is
      // 504 at once, and the tree goes only when the abandoned import ends.
      // (Delaying before the unpacking would not stage anything: the request's
      // upload is removed with the answer.)
      const upload = editor.uploadPackage;
      let finished;
      const settled = new Promise((resolve) => {
        finished = resolve;
      });
      editor.uploadPackage = async function (...args) {
        try {
          const result = await upload.apply(this, args);
          await delay(600);
          return result;
        } finally {
          finished();
        }
      };
      t.after(() => {
        editor.uploadPackage = upload;
      });
      const late = await importPackage(port, await examPackage());
      assert.equal(late.status, 504, late.body);
      assert.equal(created.length, 3);
      assert.equal((await leftoverStaging(staging)).length, 1);
      await settled;
      for (let i = 0; i < 100 && (await leftoverStaging(staging)).length; i++) {
        await delay(20);
      }
      assert.deepEqual(await leftoverStaging(staging), []);
    },
    { tenant }
  );
});

test('an exam package over the delta budget is refused and the previous version stays whole', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      const created = await importPackage(port, await examPackage());
      assert.equal(created.status, 201, created.body);
      const { contentId, revision } = JSON.parse(created.body);
      const before = await snapshot(path.join(content, contentId));
      // A file no open parameter names still counts.
      const refused = await importPackage(
        port,
        await examPackage(examParams(), {
          ...examFiles,
          'images/exam large.png': Buffer.alloc(64 * 1024, 1)
        }),
        contentId,
        { 'if-match': revision, 'x-max-delta-bytes': String(16 * 1024) }
      );
      assert.equal(refused.status, 413, refused.body);
      assert.deepEqual(await snapshot(path.join(content, contentId)), before);
      assert.equal(await contentRevision(content, contentId), revision);
    },
    { tenant }
  );
});

test('an editor save of an exam book keeps its exam dependencies, files and vmbExam', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      const created = await importPackage(port, await examPackage());
      assert.equal(created.status, 201, created.body);
      const { contentId } = JSON.parse(created.body);
      const edit = JSON.parse(
        (await rawGet(port, `${CORE}/api/v1/content/${contentId}/edit`, auth))
          .body
      );
      const saved = await editorSave(port, contentId, edit.h5p.params, {
        'if-match': edit.revision
      });
      assert.equal(saved.status, 200, saved.body);
      assert.ok(
        declared(await storedJson(content, contentId, 'h5p.json')).includes(
          'H5P.ExamFixture 1.0'
        )
      );
      assert.ok(
        declared(JSON.parse(saved.body).metadata).includes(
          'H5P.ExamFixture 1.0'
        )
      );
      assert.deepEqual(
        await mediaOf(content, contentId),
        Object.keys(examFiles).sort()
      );
      assert.deepEqual(
        (await storedJson(content, contentId, 'content.json')).vmbExam,
        examParams().vmbExam
      );
    },
    { tenant }
  );
});

test('an editor save that drops the open reference to a file the exam shares keeps the file', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      const created = await importPackage(port, await examPackage());
      assert.equal(created.status, 201, created.body);
      const { contentId } = JSON.parse(created.body);
      const saved = await editorSave(
        port,
        contentId,
        examParams(undefined, null)
      );
      assert.equal(saved.status, 200, saved.body);
      assert.equal(
        await fs.readFile(
          path.join(content, contentId, 'images/open.png'),
          'utf8'
        ),
        'open bytes'
      );
    },
    { tenant }
  );
});

test('the editor Upload tab still imports an exam package the old way', async (t) => {
  const staging = tmpDir(t, 'exam-staging-');
  withEnv(t, { TMPDIR: staging });
  const tenant = await mediaTenant(t);
  const created = trackStaging(t);
  const { parameters } = await tenant.context.h5pEditor.uploadPackage(
    await examPackage(),
    tenantUser
  );
  assert.match(parameters.media.image.path, /#tmp$/);
  assert.equal(
    await tenant.context.h5pEditor.temporaryFileManager.fileExists(
      parameters.media.image.path.replace(/#tmp$/, ''),
      tenantUser
    ),
    true
  );
  assert.deepEqual(created, []);
  assert.deepEqual(await leftoverStaging(staging), []);
});
