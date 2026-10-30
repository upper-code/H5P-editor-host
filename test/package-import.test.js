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
const { markRecoveryRequired } = require('../build/src/process-lock');

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
const { stageExamPackage } = require('../build/src/h5p/exam-package');
const { storePackageContent } = require('../build/src/h5p/whole-package');
const { h5pAjaxExpressRouter } = require('@lumieducation/h5p-express');
const { appRoot } = require('./host');

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

test('two versions of a library within the open part or within what the exam adds are no conflict', async (t) => {
  // As H5P.AdvancedBlanks 1.2 and H5P.MultiChoice 1.16 need H5P.Question 1.4
  // and 1.5: two libraries, each on its own version of a third.
  const libraries = {
    'H5P.Common-1.0': library('H5P.Common', 1, 0),
    'H5P.Common-1.1': library('H5P.Common', 1, 1),
    'H5P.UsesOld-1.0': library('H5P.UsesOld', 1, 0, {
      preloadedDependencies: [dependency('H5P.Common', 1, 0)]
    }),
    'H5P.UsesNew-1.0': library('H5P.UsesNew', 1, 0, {
      preloadedDependencies: [dependency('H5P.Common', 1, 1)]
    })
  };
  const both = [
    dependency('H5P.UsesOld'),
    dependency('H5P.UsesNew'),
    dependency('H5P.Common', 1, 0),
    dependency('H5P.Common', 1, 1)
  ];
  await t.test('in the open part', async (t) => {
    const tenant = await mediaTenant(t, {
      libraries,
      mediaDependencies: [dependency('H5P.UsesOld'), dependency('H5P.UsesNew')]
    });
    const { content } = tenant.context.paths;
    await withHost(
      async (port) => {
        // A package lists the open part's whole tree in its h5p.json.
        const created = await importPackage(
          port,
          await examPackage(examParams(), examFiles, {
            preloadedDependencies: [...examDependencies, ...both]
          })
        );
        assert.equal(created.status, 201, created.body);
        const { contentId, revision } = JSON.parse(created.body);
        const stored = declared(
          await storedJson(content, contentId, 'h5p.json')
        );
        assert.ok(stored.includes('H5P.ExamFixture 1.0'), stored.join());
        assert.ok(stored.includes('H5P.Common 1.0'), stored.join());
        assert.ok(stored.includes('H5P.Common 1.1'), stored.join());
        // The editor save that follows keeps it so.
        const saved = await editorSave(port, contentId, examParams(), {
          'if-match': revision
        });
        assert.equal(saved.status, 200, saved.body);
      },
      { tenant }
    );
  });
  await t.test('in what the exam adds', async (t) => {
    const tenant = await mediaTenant(t, { libraries });
    const { content } = tenant.context.paths;
    await withHost(
      async (port) => {
        const created = await importPackage(
          port,
          await examPackage(examParams(), examFiles, {
            preloadedDependencies: [...examDependencies, ...both]
          })
        );
        assert.equal(created.status, 201, created.body);
        const { contentId } = JSON.parse(created.body);
        const stored = declared(
          await storedJson(content, contentId, 'h5p.json')
        );
        assert.ok(stored.includes('H5P.UsesOld 1.0'), stored.join());
        assert.ok(stored.includes('H5P.UsesNew 1.0'), stored.join());
      },
      { tenant }
    );
  });
});

test(
  'a dependency cycle in the declared tree does not stall the import',
  { timeout: 30000 },
  async (t) => {
    const tenant = await mediaTenant(t, {
      libraries: {
        'H5P.CycleA-1.0': library('H5P.CycleA', 1, 0, {
          preloadedDependencies: [dependency('H5P.CycleB')]
        }),
        'H5P.CycleB-1.0': library('H5P.CycleB', 1, 0, {
          preloadedDependencies: [dependency('H5P.CycleA')]
        })
      }
    });
    const { content } = tenant.context.paths;
    await withHost(
      async (port) => {
        const created = await importPackage(
          port,
          await examPackage(examParams(), examFiles, {
            preloadedDependencies: [
              ...examDependencies,
              dependency('H5P.CycleA')
            ]
          })
        );
        assert.equal(created.status, 201, created.body);
        const { contentId } = JSON.parse(created.body);
        const stored = declared(
          await storedJson(content, contentId, 'h5p.json')
        );
        assert.ok(stored.includes('H5P.CycleA 1.0'), stored.join());
      },
      { tenant }
    );
  }
);

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

test('a version import of an exam package replaces a directory an earlier save left empty', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  // h5p-server deletes unused files, not the directories they were in.
  await storeOnDisk(content, '9', examParams(), examDependencies, examFiles);
  await fs.mkdir(path.join(content, '9', 'images', 'a.png'));
  const revision = await contentRevision(content, '9');
  await withHost(
    async (port) => {
      const replaced = await importPackage(
        port,
        await examPackage(
          examParams([{ path: 'images/a.png', iv: 'aXY=', mac: 'bWFj' }]),
          { 'images/open.png': 'open', 'images/a.png': 'a file now' }
        ),
        '9',
        { 'if-match': revision }
      );
      assert.equal(replaced.status, 200, replaced.body);
      assert.equal(
        await fs.readFile(path.join(content, '9', 'images/a.png'), 'utf8'),
        'a file now'
      );
      assert.deepEqual(await mediaOf(content, '9'), [
        'images/a.png',
        'images/open.png'
      ]);
    },
    { tenant }
  );
});

test('a staged exam file a refused write never read is closed', async (t) => {
  const directory = tmpDir(t, 'exam-staged-');
  await fs.mkdir(path.join(directory, 'images'));
  await fs.writeFile(path.join(directory, 'images', 'a.png'), 'bytes');
  const handles = [];
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open.apply(fs, args);
    handles.push(handle);
    return handle;
  });
  const editor = {
    contentStorage: {
      addFile: async () => {
        throw new Error('refused before reading');
      }
    }
  };
  await assert.rejects(
    storePackageContent(editor, '9', directory, tenantUser, {
      replace: false
    }),
    /refused before reading/
  );
  assert.equal(handles.length, 1);
  // A closed FileHandle reports -1.
  assert.equal(handles[0].fd, -1);
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
  withEnv(t, { TMPDIR: staging, H5P_HOST_IMPORT_TIMEOUT_MS: '1000' });
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
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      let finished;
      const settled = new Promise((resolve) => {
        finished = resolve;
      });
      editor.uploadPackage = async function (...args) {
        try {
          const result = await upload.apply(this, args);
          // Held until the test has seen the 504 and the tree still there.
          await held;
          return result;
        } finally {
          finished();
        }
      };
      t.after(() => {
        // Should an assertion below fail, the held import still ends.
        release();
        editor.uploadPackage = upload;
      });
      const late = await importPackage(port, await examPackage());
      assert.equal(late.status, 504, late.body);
      assert.equal(created.length, 3);
      assert.equal((await leftoverStaging(staging)).length, 1);
      release();
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

/** The tenant's own h5p-express router, so `/h5p/ajax` reaches h5p-server. */
function withAjaxRouter(tenant) {
  tenant.h5pRouter = h5pAjaxExpressRouter(
    tenant.context.h5pEditor,
    path.join(appRoot, 'assets/h5p/core'),
    path.join(appRoot, 'assets/h5p/editor'),
    { routeGetDownload: false },
    'auto'
  );
  return tenant;
}

/** The editor's "Upload" tab: `library-upload` at the AJAX endpoint. */
async function uploadTab(port, bytes) {
  const response = await multipart(
    port,
    `${CORE}/h5p/ajax?action=library-upload`,
    [
      {
        name: 'h5p',
        filename: 'book.h5p',
        contentType: 'application/zip',
        data: bytes
      }
    ]
  );
  assert.equal(response.status, 200, response.body);
  return JSON.parse(response.body).data;
}

test('the editor Upload tab still imports an exam package the old way', async (t) => {
  const staging = tmpDir(t, 'exam-staging-');
  withEnv(t, { TMPDIR: staging });
  const tenant = withAjaxRouter(await mediaTenant(t));
  const created = trackStaging(t);
  await withHost(
    async (port) => {
      const { content: parameters } = await uploadTab(
        port,
        await examPackage()
      );
      assert.match(parameters.media.image.path, /#tmp$/);
      assert.equal(
        await tenant.context.h5pEditor.temporaryFileManager.fileExists(
          parameters.media.image.path.replace(/#tmp$/, ''),
          tenantUser
        ),
        true
      );
      assert.deepEqual(parameters.vmbExam, examParams().vmbExam);
    },
    { tenant }
  );
  assert.deepEqual(created, []);
  assert.deepEqual(await leftoverStaging(staging), []);
});

test('an editor save of an exam package loaded through the Upload tab is refused', async (t) => {
  const tenant = withAjaxRouter(await mediaTenant(t));
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      const created = await importPackage(port, await examPackage());
      assert.equal(created.status, 201, created.body);
      const { contentId, revision } = JSON.parse(created.body);
      const before = await snapshot(path.join(content, contentId));

      // The tab copies only what the open part references: a new exam's own
      // file never reaches the content, and a new publication under the old
      // names would leave the old ciphertext in place.
      const newFile = examParams([
        { path: 'images/exam v2.png', iv: 'aXY=', mac: 'bWFj' }
      ]);
      const sameNames = examParams();
      sameNames.vmbExam.data = 'bmV3IGNpcGhlcnRleHQ=';
      const plain = examParams();
      delete plain.vmbExam;
      for (const [label, params, files] of [
        [
          'new file',
          newFile,
          { ...examFiles, 'images/exam v2.png': 'exam v2 ciphertext' }
        ],
        ['same names', sameNames, examFiles],
        ['old format', examParams(null), examFiles]
      ]) {
        const { content: parameters } = await uploadTab(
          port,
          await examPackage(params, files)
        );
        for (const [id, headers] of [
          [contentId, { 'if-match': revision }],
          ['new', {}]
        ]) {
          const refused = await editorSave(port, id, parameters, headers);
          assert.equal(refused.status, 422, `${label}: ${refused.body}`);
          const body = JSON.parse(refused.body);
          assert.equal(body.code, 'exam-import-required', label);
          assert.match(body.detail, /import route/, label);
        }
      }
      assert.deepEqual(await snapshot(path.join(content, contentId)), before);
      assert.equal(await contentRevision(content, contentId), revision);
      assert.deepEqual(await fs.readdir(content), [contentId]);

      // Nor does generated content bring an exam.
      const generated = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/generated-content`,
        {
          library: 'H5P.MediaFixture 1.0',
          params: examParams(),
          metadata: { title: 'Exam', license: 'U' }
        },
        { ...auth, 'idempotency-key': crypto.randomUUID() }
      );
      assert.equal(generated.status, 422, generated.body);
      assert.equal(JSON.parse(generated.body).code, 'exam-import-required');
      assert.deepEqual(await fs.readdir(content), [contentId]);

      // An exam over a plain book is no editor save either.
      const book = JSON.parse(
        (await importPackage(port, await examPackage(plain))).body
      );
      const { content: parameters } = await uploadTab(
        port,
        await examPackage()
      );
      const overPlain = await editorSave(port, book.contentId, parameters, {
        'if-match': book.revision
      });
      assert.equal(overPlain.status, 422, overPlain.body);
      assert.equal(JSON.parse(overPlain.body).code, 'exam-import-required');

      // The imported book itself saves as before.
      const saved = await editorSave(port, contentId, examParams(), {
        'if-match': revision
      });
      assert.equal(saved.status, 200, saved.body);
    },
    { tenant }
  );
});

test('an editor save of exam content whose exam files are not stored is refused', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  const withoutExamFile = { ...examFiles };
  delete withoutExamFile['images/exam only.png'];
  for (const [id, label, media, files] of [
    // As a host before exam mode imported it: the exam's own file dropped.
    ['21', 'missing', undefined, withoutExamFile],
    // Neither a directory nor the content's own JSON is an exam file.
    [
      '22',
      'a directory',
      [{ path: 'images/q', iv: 'aXY=', mac: 'bWFj' }],
      examFiles
    ],
    [
      '23',
      'content.json',
      [{ path: 'content.json', iv: 'aXY=', mac: 'bWFj' }],
      examFiles
    ]
  ]) {
    await storeOnDisk(content, id, examParams(media), examDependencies, files);
    const before = await snapshot(path.join(content, id));
    const revision = await contentRevision(content, id);
    await withHost(
      async (port) => {
        const refused = await editorSave(port, id, examParams(media), {
          'if-match': revision
        });
        assert.equal(refused.status, 422, `${label}: ${refused.body}`);
        assert.equal(JSON.parse(refused.body).code, 'exam-media-missing');
      },
      { tenant }
    );
    assert.deepEqual(await snapshot(path.join(content, id)), before, label);
  }
});

test('with a stored library missing, an update still deletes no exam file', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  // Stored on H5P.MediaFixture 0.9, which this host does not have: the scan
  // of the stored parameters fails, and missing-library-update.ts offers
  // every stored file as an old one.
  await storeOnDisk(
    content,
    '9',
    examParams(),
    [dependency('H5P.MediaFixture', 0, 9), dependency('H5P.ExamFixture')],
    examFiles
  );
  const storer = tenant.context.h5pEditor.contentStorer;
  const oldFiles = await storer.getFilesInParams('9', tenantUser);
  assert.deepEqual([...oldFiles].sort(), Object.keys(examFiles).sort());
  await storer.deleteUnusedOldFiles('9', oldFiles, []);
  assert.deepEqual(await mediaOf(content, '9'), Object.keys(examFiles).sort());

  // Content without an exam loses them as before.
  const plain = examParams();
  delete plain.vmbExam;
  await fs.writeFile(
    path.join(content, '9', 'content.json'),
    JSON.stringify(plain)
  );
  await storer.deleteUnusedOldFiles('9', oldFiles, ['images/open.png']);
  assert.deepEqual(await mediaOf(content, '9'), ['images/open.png']);
});

test(
  'an exam package is staged in a private directory',
  { skip: process.platform === 'win32' },
  async (t) => {
    const staging = tmpDir(t, 'exam-staging-');
    withEnv(t, { TMPDIR: staging });
    const extracted = tmpDir(t, 'exam-extracted-');
    await fs.mkdir(path.join(extracted, 'images'));
    await fs.writeFile(path.join(extracted, 'images/exam only.png'), 'exam');
    await fs.writeFile(path.join(extracted, 'content.json'), '{}');
    await fs.chmod(extracted, 0o755);
    const exam = { hidden: [] };
    t.after(() =>
      exam.staging
        ? fs.rm(exam.staging, { recursive: true, force: true })
        : undefined
    );
    await stageExamPackage(extracted, examParams(), [], exam);
    assert.equal(path.dirname(exam.staging), staging);
    assert.match(path.basename(exam.staging), /^h5p-exam-/);
    assert.equal((await fs.stat(exam.staging)).mode & 0o777, 0o700);
    assert.equal(exam.content, path.join(exam.staging, 'content'));
    assert.deepEqual(await filesUnder(exam.content), [
      'content.json',
      'images/exam only.png'
    ]);
    assert.deepEqual(await leftoverStaging(staging), [
      path.basename(exam.staging)
    ]);
  }
);

test('a failed move of the staged package is cleaned up, and a move across devices copies', async (t) => {
  for (const code of ['EXDEV', 'EACCES']) {
    await t.test(code, async (t) => {
      const staging = tmpDir(t, 'exam-staging-');
      withEnv(t, { TMPDIR: staging });
      const tenant = await mediaTenant(t);
      const { content } = tenant.context.paths;
      const created = trackStaging(t);
      const rename = fs.rename;
      t.mock.method(fs, 'rename', async (from, to, ...rest) => {
        // Only the move into the staging directory; the request's own
        // upload is staged under the same TMPDIR.
        if (path.basename(path.dirname(String(to))).startsWith('h5p-exam-')) {
          throw Object.assign(new Error(`${code}: refused`), { code });
        }
        return rename.call(fs, from, to, ...rest);
      });
      const cp = t.mock.method(fs, 'cp');
      await withHost(
        async (port) => {
          const answer = await importPackage(port, await examPackage());
          assert.equal(created.length, 1);
          assert.deepEqual(await leftoverStaging(staging), []);
          if (code === 'EXDEV') {
            assert.equal(answer.status, 201, answer.body);
            assert.equal(cp.mock.callCount(), 1);
            const { contentId } = JSON.parse(answer.body);
            assert.deepEqual(
              await mediaOf(content, contentId),
              Object.keys(examFiles).sort()
            );
          } else {
            assert.equal(answer.status, 500, answer.body);
            assert.equal(cp.mock.callCount(), 0);
            assert.deepEqual(await fs.readdir(content), []);
          }
        },
        { tenant }
      );
    });
  }
});

// --- Outdated packages (src/h5p/outdated-package.ts) ------------------------

const keepOutdated = { 'x-import-outdated-libraries': 'keep' };
// Exported where H5P.MediaFixture was 0.9; this host has only 1.0.
const outdatedDependencies = [dependency('H5P.MediaFixture', 0, 9)];
const outdatedParams = {
  media: {
    image: { path: 'images/old pixel.png', mime: 'image/png' },
    file: { path: 'https://example.invalid/file.pdf', mime: 'application/pdf' }
  }
};
const outdatedFiles = {
  'images/old pixel.png': 'old pixel bytes',
  // Referenced by nothing the host can see; kept with the package.
  'files/unreferenced.txt': 'unreferenced'
};
const outdatedPackage = (
  params = outdatedParams,
  files = outdatedFiles,
  dependencies = outdatedDependencies
) =>
  packageOf(params, files, 'Outdated', {
    preloadedDependencies: dependencies
  });

async function leftoverOutdatedStaging(directory) {
  return (await fs.readdir(directory)).filter((name) =>
    name.startsWith('h5p-outdated-')
  );
}

test('a package on a library version that is not installed is refused without the keep header', async (t) => {
  const tenant = await mediaTenant(t);
  const { content, tmp } = tenant.context.paths;
  await withHost(
    async (port) => {
      for (const headers of [{}, { 'x-import-outdated-libraries': 'yes' }]) {
        const refused = await importPackage(
          port,
          await outdatedPackage(),
          '',
          headers
        );
        assert.equal(refused.status, 400, refused.body);
        assert.match(
          JSON.parse(refused.body).error,
          /install-missing-libraries .*H5P\.MediaFixture-0\.9/
        );
      }
      assert.deepEqual(await fs.readdir(content), []);
      assert.deepEqual(await fs.readdir(tmp), []);
    },
    { tenant }
  );
});

test('with the keep header an outdated package is stored as it is, opens with the upgrade and saves upgraded', async (t) => {
  const staging = tmpDir(t, 'outdated-staging-');
  withEnv(t, { TMPDIR: staging });
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  const bytes = await outdatedPackage();
  await withHost(
    async (port) => {
      // The usual transaction: the delta budget applies.
      const tooLarge = await importPackage(port, bytes, '', {
        ...keepOutdated,
        'x-max-delta-bytes': '10'
      });
      assert.equal(tooLarge.status, 413, tooLarge.body);
      assert.deepEqual(await fs.readdir(content), []);

      const operationId = crypto.randomUUID();
      const created = await importPackage(port, bytes, '', {
        ...keepOutdated,
        'idempotency-key': operationId
      });
      assert.equal(created.status, 201, created.body);
      const answer = JSON.parse(created.body);
      assert.ok(answer.deltaBytes > 0);
      assert.deepEqual(
        answer.metadata.preloadedDependencies,
        outdatedDependencies
      );
      const directory = path.join(content, answer.contentId);
      // Exactly the package: its h5p.json and content.json, every file
      // under its own name.
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(directory, 'h5p.json'))),
        {
          ...metadata,
          title: 'Outdated',
          preloadedDependencies: outdatedDependencies
        }
      );
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(directory, 'content.json'))),
        outdatedParams
      );
      assert.deepEqual(await mediaOf(content, answer.contentId), [
        'files/unreferenced.txt',
        'images/old pixel.png'
      ]);
      assert.deepEqual(await leftoverOutdatedStaging(staging), []);
      // An idempotent replay answers the first result.
      const replay = await importPackage(port, bytes, '', {
        ...keepOutdated,
        'idempotency-key': operationId
      });
      assert.deepEqual(JSON.parse(replay.body), answer);

      const edit = await rawGet(
        port,
        `${CORE}/api/v1/content/${answer.contentId}/edit`,
        auth
      );
      assert.equal(edit.status, 200, edit.body);
      const model = JSON.parse(edit.body);
      assert.equal(model.h5p.library, 'H5P.MediaFixture 0.9');
      assert.deepEqual(model.missingLibraries, [
        {
          library: 'H5P.MediaFixture 0.9',
          upgrade: 'H5P.MediaFixture 1.0',
          reason: 'not-installed'
        }
      ]);

      // What the editor page saves after its upgrade: the parameters on the
      // installed version, the media referenced as stored.
      const saved = await rawSend(
        port,
        'PATCH',
        `${CORE}/api/v1/content/${answer.contentId}`,
        {
          library: 'H5P.MediaFixture 1.0',
          params: model.h5p.params,
          metadata: model.h5p.metadata
        },
        {
          ...auth,
          'idempotency-key': crypto.randomUUID(),
          'if-match': model.revision
        }
      );
      assert.equal(saved.status, 200, saved.body);
      assert.equal(
        await fs.readFile(path.join(directory, 'images/old pixel.png'), 'utf8'),
        'old pixel bytes'
      );
      // The save keeps what the upgraded parameters reference.
      assert.deepEqual(await mediaOf(content, answer.contentId), [
        'images/old pixel.png'
      ]);
      const stored = JSON.parse(
        await fs.readFile(path.join(directory, 'h5p.json'))
      );
      assert.deepEqual(stored.preloadedDependencies, [
        dependency('H5P.MediaFixture', 1, 0)
      ]);
      const reopened = await rawGet(
        port,
        `${CORE}/api/v1/content/${answer.contentId}/edit`,
        auth
      );
      assert.deepEqual(JSON.parse(reopened.body).missingLibraries, []);
    },
    { tenant }
  );
});

test('with the keep header an outdated package replaces stored content by id', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      const created = await importPackage(
        port,
        await packageOf(
          {
            media: { image: { path: 'images/current.png', mime: 'image/png' } }
          },
          { 'images/current.png': 'current bytes' }
        )
      );
      assert.equal(created.status, 201, created.body);
      const first = JSON.parse(created.body);
      const stale = await importPackage(
        port,
        await outdatedPackage(),
        first.contentId,
        { ...keepOutdated, 'if-match': 'stale' }
      );
      assert.equal(stale.status, 409, stale.body);

      const replaced = await importPackage(
        port,
        await outdatedPackage(),
        first.contentId,
        { ...keepOutdated, 'if-match': first.revision }
      );
      assert.equal(replaced.status, 200, replaced.body);
      const answer = JSON.parse(replaced.body);
      assert.equal(answer.contentId, first.contentId);
      assert.equal(typeof answer.deltaBytes, 'number');
      assert.notEqual(answer.revision, first.revision);
      // The stored files the package does not have are gone.
      assert.deepEqual(await mediaOf(content, first.contentId), [
        'files/unreferenced.txt',
        'images/old pixel.png'
      ]);
      assert.deepEqual(
        JSON.parse(
          await fs.readFile(path.join(content, first.contentId, 'content.json'))
        ),
        outdatedParams
      );
    },
    { tenant }
  );
});

test('an outdated package is refused when a version its content names has no newer installed one', async (t) => {
  const staging = tmpDir(t, 'outdated-staging-');
  withEnv(t, { TMPDIR: staging });
  const tenant = await mediaTenant(t);
  const { content, tmp } = tenant.context.paths;
  await withHost(
    async (port) => {
      for (const [params, dependencies, named] of [
        // Newer than the installed 1.0: never downgraded.
        [
          outdatedParams,
          [dependency('H5P.MediaFixture', 2, 0)],
          /H5P\.MediaFixture 2\.0\./
        ],
        // The main library could be upgraded, a nested one could not.
        [
          {
            ...outdatedParams,
            extra: { library: 'H5P.Nowhere 1.0', params: {} }
          },
          outdatedDependencies,
          /installed version: H5P\.Nowhere 1\.0\./
        ]
      ]) {
        const refused = await importPackage(
          port,
          await outdatedPackage(params, outdatedFiles, dependencies),
          '',
          keepOutdated
        );
        assert.equal(refused.status, 422, refused.body);
        const body = JSON.parse(refused.body);
        assert.equal(body.code, 'library-missing');
        assert.match(body.error, named);
        assert.match(body.error, /No changes were saved\.$/);
      }
      assert.deepEqual(await fs.readdir(content), []);
      assert.deepEqual(await fs.readdir(tmp), []);
      assert.deepEqual(await leftoverOutdatedStaging(staging), []);
    },
    { tenant }
  );
});

test('an outdated package whose files cannot be kept as they are is refused', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  const image = (file) => ({
    media: { image: { path: file, mime: 'image/png' } }
  });
  await withHost(
    async (port) => {
      for (const [params, files, status, expected] of [
        [image('images/gone.png'), {}, 422, /missing the media file gone\.png/],
        [
          image('images/../x.png'),
          { 'x.png': 'x' },
          422,
          /missing the media file x\.png/
        ],
        [
          image('images/a.png#tmp'),
          { 'images/a.png': 'a' },
          400,
          /temporary editor file/
        ],
        // Not an HTTP(S) URL: a missing file, as in an ordinary import.
        [
          image('data:image/png;base64,AAAA'),
          {},
          422,
          /missing the media file/
        ],
        [image('content.json'), {}, 400, /its own metadata file/],
        [
          outdatedParams,
          { ...outdatedFiles, 'images/_x.png': 'x' },
          400,
          /start with "\." or "_"/
        ],
        [
          outdatedParams,
          { ...outdatedFiles, 'images/a%20b.png': 'x' },
          400,
          /"#", "\?", "%"/
        ]
      ]) {
        const refused = await importPackage(
          port,
          await outdatedPackage(params, files),
          '',
          keepOutdated
        );
        assert.equal(refused.status, status, refused.body);
        assert.match(JSON.parse(refused.body).error, expected);
        assert.doesNotMatch(JSON.parse(refused.body).error, /\/tmp|\\/);
      }
      assert.deepEqual(await fs.readdir(content), []);
    },
    { tenant }
  );
});

test('with the keep header, versions only h5p.json declares take the usual import', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  // Declared where the package was exported, as a dependency of the media
  // fixture there; the content names only the installed 1.0.
  const dependencies = [
    dependency('H5P.MediaFixture'),
    dependency('H5P.Gone', 1, 2)
  ];
  const params = {
    media: { image: { path: 'images/pixel.png', mime: 'image/png' } }
  };
  const bytes = await packageOf(
    params,
    { 'images/pixel.png': 'pixel', 'files/unreferenced.txt': 'x' },
    'Declared',
    { preloadedDependencies: dependencies }
  );
  await withHost(
    async (port) => {
      const refused = await importPackage(port, bytes);
      assert.equal(refused.status, 400, refused.body);
      assert.match(JSON.parse(refused.body).error, /H5P\.Gone-1\.2/);

      const created = await importPackage(port, bytes, '', keepOutdated);
      assert.equal(created.status, 201, created.body);
      const { contentId, metadata: answered } = JSON.parse(created.body);
      assert.deepEqual(answered.preloadedDependencies, [
        dependency('H5P.MediaFixture')
      ]);
      // h5p-server's save: dependencies of the installed libraries, only
      // the referenced media.
      const stored = JSON.parse(
        await fs.readFile(path.join(content, contentId, 'h5p.json'))
      );
      assert.deepEqual(stored.preloadedDependencies, [
        dependency('H5P.MediaFixture')
      ]);
      const media = await mediaOf(content, contentId);
      assert.equal(media.length, 1);
      assert.match(media[0], /^images\/pixel.*\.png$/);
    },
    { tenant }
  );
});

test('with the keep header an exam package on a missing version is still refused', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      for (const dependencies of [
        // The content names the missing version.
        [dependency('H5P.MediaFixture', 0, 9), dependency('H5P.ExamFixture')],
        // Only declared: the exam keeps its declared dependencies.
        [...examDependencies, dependency('H5P.Gone', 1, 2)]
      ]) {
        const refused = await importPackage(
          port,
          await examPackage(examParams(), examFiles, {
            preloadedDependencies: dependencies
          }),
          '',
          keepOutdated
        );
        assert.equal(refused.status, 422, refused.body);
        assert.equal(JSON.parse(refused.body).code, 'exam-library-missing');
      }
      assert.deepEqual(await fs.readdir(content), []);
    },
    { tenant }
  );
});

// --- Book ids (src/book-id.ts) ----------------------------------------------

const bookUuid = '4d682a53-7e2e-4dd6-8314-d17719e5d3dc';
const otherUuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const freshUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const storedComments = async (content, id) =>
  JSON.parse(await fs.readFile(path.join(content, id, 'h5p.json'), 'utf8'))
    .authorComments;

test('an import writes the package book id in its canonical form, a fresh one for a package without one', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  const named = await packageOf({}, {}, 'Named', {
    authorComments: `note @ID=${bookUuid.toUpperCase()};@popup=true;`
  });
  const bare = await packageOf({}, {}, 'Bare', { authorComments: 'note' });
  await withHost(
    async (port) => {
      // `keep`, the default: the package's own id, canonical.
      const kept = await importPackage(port, named);
      assert.equal(kept.status, 201, kept.body);
      const keptAnswer = JSON.parse(kept.body);
      assert.equal(keptAnswer.bookId, bookUuid);
      assert.equal(
        await storedComments(content, keptAnswer.contentId),
        `note\n@id=${bookUuid};\n@popup=true;`
      );
      const explicit = await importPackage(port, named, '', {
        'x-book-id': 'keep'
      });
      assert.equal(JSON.parse(explicit.body).bookId, bookUuid);

      // A package without one gets a fresh one even under `keep`.
      const given = JSON.parse((await importPackage(port, bare)).body);
      assert.match(given.bookId, freshUuid);
      assert.equal(
        await storedComments(content, given.contentId),
        `note\n@id=${given.bookId};`
      );

      // `new` replaces the package's id with a fresh one, where it stands.
      const renewed = await importPackage(port, named, '', {
        'x-book-id': 'new'
      });
      assert.equal(renewed.status, 201, renewed.body);
      const renewedAnswer = JSON.parse(renewed.body);
      assert.match(renewedAnswer.bookId, freshUuid);
      assert.notEqual(renewedAnswer.bookId, bookUuid);
      assert.equal(
        await storedComments(content, renewedAnswer.contentId),
        `note\n@id=${renewedAnswer.bookId};\n@popup=true;`
      );

      // A UUID aligns an import over stored content with that id.
      const aligned = await importPackage(port, named, keptAnswer.contentId, {
        'if-match': keptAnswer.revision,
        'x-book-id': otherUuid.toUpperCase()
      });
      assert.equal(aligned.status, 200, aligned.body);
      assert.equal(JSON.parse(aligned.body).bookId, otherUuid);
      assert.equal(
        await storedComments(content, keptAnswer.contentId),
        `note\n@id=${otherUuid};\n@popup=true;`
      );
      const metadata = JSON.parse(
        (
          await rawGet(
            port,
            `${CORE}/api/v1/content/${keptAnswer.contentId}/metadata`,
            auth
          )
        ).body
      );
      assert.equal(metadata.bookId, otherUuid);
      assert.equal(metadata.revision, JSON.parse(aligned.body).revision);

      // An invalid id is stored as it is under `keep`, for the embedder to
      // report; the answer names none.
      const invalid = await importPackage(
        port,
        await packageOf({}, {}, 'Invalid', {
          authorComments: `@id=${bookUuid};@id=${otherUuid};`
        })
      );
      assert.equal(invalid.status, 201, invalid.body);
      assert.equal(JSON.parse(invalid.body).bookId, null);
      assert.equal(
        await storedComments(content, JSON.parse(invalid.body).contentId),
        `@id=${bookUuid};@id=${otherUuid};`
      );
    },
    { tenant }
  );
});

test('a new version without a book id keeps the stored book id under keep', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      const first = JSON.parse(
        (
          await importPackage(
            port,
            await packageOf({}, {}, 'Book', {
              authorComments: `@id=${bookUuid};`
            })
          )
        ).body
      );
      const bare = await packageOf({}, {}, 'Book v2', {
        authorComments: 'note'
      });
      const over = await importPackage(port, bare, first.contentId, {
        'if-match': first.revision
      });
      assert.equal(over.status, 200, over.body);
      assert.equal(JSON.parse(over.body).bookId, bookUuid);
      assert.equal(
        await storedComments(content, first.contentId),
        `note\n@id=${bookUuid};`
      );
      // The same for a package stored as it is.
      const outdated = await importPackage(
        port,
        await packageOf(outdatedParams, outdatedFiles, 'Outdated', {
          preloadedDependencies: outdatedDependencies,
          authorComments: 'old note'
        }),
        first.contentId,
        { ...keepOutdated, 'if-match': JSON.parse(over.body).revision }
      );
      assert.equal(outdated.status, 200, outdated.body);
      assert.equal(JSON.parse(outdated.body).bookId, bookUuid);
      // A package with an invalid id keeps that, for the embedder to report.
      const invalid = await importPackage(
        port,
        await packageOf({}, {}, 'Book v3', { authorComments: '@id=;' }),
        first.contentId,
        { 'if-match': JSON.parse(outdated.body).revision }
      );
      assert.equal(invalid.status, 200, invalid.body);
      assert.equal(JSON.parse(invalid.body).bookId, null);
      assert.equal(await storedComments(content, first.contentId), '@id=;');
      // `new` still replaces it.
      const renewed = await importPackage(port, bare, first.contentId, {
        'if-match': JSON.parse(invalid.body).revision,
        'x-book-id': 'new'
      });
      assert.equal(renewed.status, 200, renewed.body);
      assert.match(JSON.parse(renewed.body).bookId, freshUuid);
      assert.notEqual(JSON.parse(renewed.body).bookId, bookUuid);
    },
    { tenant }
  );
});

test('an import with an unusable X-Book-Id, or no room for the id, stores nothing', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      const bytes = await packageOf({}, {}, 'Book', {
        authorComments: `@id=${bookUuid};`
      });
      for (const value of [
        'KEEP',
        'not-a-uuid',
        '00000000-0000-0000-0000-000000000000',
        ''
      ]) {
        const refused = await importPackage(port, bytes, '', {
          'x-book-id': value
        });
        assert.equal(refused.status, 400, refused.body);
        assert.equal(JSON.parse(refused.body).code, 'invalid-book-id');
      }
      // Appending the id would take the comments past h5p-server's 5000
      // characters: refused, as an editor save would be.
      const long = await packageOf({}, {}, 'Long', {
        authorComments: 'x'.repeat(4959)
      });
      for (const value of ['keep', 'new', otherUuid]) {
        const refused = await importPackage(port, long, '', {
          'x-book-id': value
        });
        assert.equal(refused.status, 422, refused.body);
        assert.equal(JSON.parse(refused.body).code, 'author-comments-too-long');
      }
      assert.deepEqual(
        (await fs.readdir(content)).filter((name) => /^\d+$/.test(name)),
        []
      );

      // The mode is part of the operation: a replay under another one is
      // refused rather than answered with the first import's id.
      const operationId = crypto.randomUUID();
      const first = await importPackage(port, bytes, '', {
        'idempotency-key': operationId,
        'x-book-id': 'new'
      });
      assert.equal(first.status, 201, first.body);
      const replay = await importPackage(port, bytes, '', {
        'idempotency-key': operationId,
        'x-book-id': 'new'
      });
      assert.deepEqual(JSON.parse(replay.body), JSON.parse(first.body));
      const other = await importPackage(port, bytes, '', {
        'idempotency-key': operationId
      });
      assert.equal(other.status, 409, other.body);
      assert.equal(JSON.parse(other.body).code, 'operation-id-reused');

      // `keep`, with the header or without, keeps the fingerprint of
      // contract version 9: an import completed before an upgrade replays.
      const kept = crypto.randomUUID();
      const plain = await importPackage(port, bytes, '', {
        'idempotency-key': kept
      });
      assert.equal(plain.status, 201, plain.body);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      assert.equal(
        (await readOperation(content, kept)).fingerprint,
        crypto
          .createHash('sha256')
          .update(JSON.stringify([undefined, 'h5p-import', hash, undefined]))
          .digest('hex')
      );
      const explicit = await importPackage(port, bytes, '', {
        'idempotency-key': kept,
        'x-book-id': 'keep'
      });
      assert.deepEqual(JSON.parse(explicit.body), JSON.parse(plain.body));
    },
    { tenant }
  );
});

test('a contract-9 import record replays under the UUID it recorded and its content carries, nothing else', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  const operations = path.join(path.dirname(content), 'operations');
  const verbatim = `note @ID=${bookUuid.toUpperCase()};`;
  const bytes = await packageOf({}, {}, 'Named', { authorComments: verbatim });
  const contentIds = async () =>
    (await fs.readdir(content)).filter((name) => /^\d+$/.test(name)).sort();
  const refusedAsReused = (answer) => {
    assert.equal(answer.status, 409, answer.body);
    assert.deepEqual(
      [JSON.parse(answer.body).error, JSON.parse(answer.body).code],
      [
        'Operation id was already used for a different save.',
        'operation-id-reused'
      ]
    );
  };
  /**
   * Turns what this host left for an import without the header — the same
   * fingerprint version 9 derived — into what a version 9 host left: the
   * package's comments stored verbatim, and a record whose answer has no
   * `bookId` and whose `metadata`, `revision` and sizes describe that
   * content. Answers the recorded result.
   */
  const asContract9 = async (key) => {
    const file = path.join(operations, key, 'record.json');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    const { contentId } = record.result;
    const h5pJson = path.join(content, contentId, 'h5p.json');
    const before = await fs.readFile(h5pJson);
    const after = Buffer.from(
      JSON.stringify({ ...JSON.parse(before), authorComments: verbatim })
    );
    await fs.writeFile(h5pJson, after);
    const grown = after.length - before.length;
    delete record.result.bookId;
    record.result.metadata = {
      ...record.result.metadata,
      authorComments: verbatim
    };
    record.result.revision = await contentRevision(content, contentId);
    record.result.savedBytes += grown;
    record.result.deltaBytes += grown;
    await fs.writeFile(file, JSON.stringify(record));
    return record.result;
  };
  await withHost(
    async (port) => {
      // New content: the request a contract-9 embedder sent, no header.
      const key = crypto.randomUUID();
      const created = await importPackage(port, bytes, '', {
        'idempotency-key': key
      });
      assert.equal(created.status, 201, created.body);
      const createdAnswer = await asContract9(key);
      const { contentId } = createdAnswer;
      const record = await readOperation(content, key);
      const ids = await contentIds();
      const stored = await snapshot(path.join(content, contentId));

      // The upgraded embedder retries with the package's own id: the
      // recorded answer, no second content, the record as it was.
      const replayed = await importPackage(port, bytes, '', {
        'idempotency-key': key,
        'x-book-id': bookUuid.toUpperCase()
      });
      assert.equal(replayed.status, 201, replayed.body);
      assert.deepEqual(JSON.parse(replayed.body), createdAnswer);
      // Version 9 did not answer `bookId`; the replay is its answer as is.
      assert.equal(JSON.parse(replayed.body).bookId, undefined);
      assert.deepEqual(await contentIds(), ids);
      assert.deepEqual(await readOperation(content, key), record);
      assert.deepEqual(await snapshot(path.join(content, contentId)), stored);

      // Another id, `new`, or another file under the key: refused, coded.
      refusedAsReused(
        await importPackage(port, bytes, '', {
          'idempotency-key': key,
          'x-book-id': otherUuid
        })
      );
      refusedAsReused(
        await importPackage(port, bytes, '', {
          'idempotency-key': key,
          'x-book-id': 'new'
        })
      );
      refusedAsReused(
        await importPackage(port, await packageOf({}, {}, 'Other'), '', {
          'idempotency-key': key,
          'x-book-id': bookUuid
        })
      );
      assert.deepEqual(await contentIds(), ids);
      assert.deepEqual(await readOperation(content, key), record);

      // Acknowledged since (a reconciler can charge an import whose answer
      // was lost): the record moved to `operations/acked/` still replays,
      // and still refuses another id.
      const ack = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/operations/${key}/ack`,
        {},
        auth
      );
      assert.equal(ack.status, 200, ack.body);
      const acked = await importPackage(port, bytes, '', {
        'idempotency-key': key,
        'x-book-id': bookUuid
      });
      assert.equal(acked.status, 201, acked.body);
      assert.deepEqual(JSON.parse(acked.body), createdAnswer);
      refusedAsReused(
        await importPackage(port, bytes, '', {
          'idempotency-key': key,
          'x-book-id': otherUuid
        })
      );
      assert.deepEqual(await contentIds(), ids);

      // Over stored content: the contract-9 request with `If-Match`.
      const versionKey = crypto.randomUUID();
      const version = await packageOf({}, {}, 'Version', {
        authorComments: verbatim
      });
      const over = await importPackage(port, version, contentId, {
        'idempotency-key': versionKey,
        'if-match': createdAnswer.revision
      });
      assert.equal(over.status, 200, over.body);
      const overAnswer = await asContract9(versionKey);
      const overRecord = await readOperation(content, versionKey);
      const overStored = await snapshot(path.join(content, contentId));
      const retried = await importPackage(port, version, contentId, {
        'idempotency-key': versionKey,
        'if-match': createdAnswer.revision,
        'x-book-id': bookUuid
      });
      assert.equal(retried.status, 200, retried.body);
      assert.deepEqual(JSON.parse(retried.body), overAnswer);
      assert.equal(
        await contentRevision(content, contentId),
        overAnswer.revision
      );
      assert.deepEqual(
        await snapshot(path.join(content, contentId)),
        overStored
      );
      assert.deepEqual(await readOperation(content, versionKey), overRecord);
      refusedAsReused(
        await importPackage(port, version, contentId, {
          'idempotency-key': versionKey,
          'if-match': createdAnswer.revision,
          'x-book-id': otherUuid
        })
      );

      // The book's id changed since: neither the recorded id nor the new
      // one is shown to be this operation's.
      const changedKey = crypto.randomUUID();
      const changed = await importPackage(port, bytes, '', {
        'idempotency-key': changedKey
      });
      assert.equal(changed.status, 201, changed.body);
      const changedId = (await asContract9(changedKey)).contentId;
      const reassigned = await rawSend(
        port,
        'POST',
        `${CORE}/api/v1/content/${changedId}/book-id`,
        { bookId: otherUuid },
        auth
      );
      assert.equal(reassigned.status, 200, reassigned.body);
      for (const value of [otherUuid, bookUuid]) {
        refusedAsReused(
          await importPackage(port, bytes, '', {
            'idempotency-key': changedKey,
            'x-book-id': value
          })
        );
      }

      // A legacy record whose content is gone since: nothing shows it was
      // this operation, so it is the plain conflict, and nothing is created.
      const goneKey = crypto.randomUUID();
      const gone = await importPackage(port, bytes, '', {
        'idempotency-key': goneKey
      });
      assert.equal(gone.status, 201, gone.body);
      const goneId = (await asContract9(goneKey)).contentId;
      await fs.rm(path.join(content, goneId), { recursive: true });
      const remaining = await contentIds();
      refusedAsReused(
        await importPackage(port, bytes, '', {
          'idempotency-key': goneKey,
          'x-book-id': bookUuid
        })
      );
      assert.deepEqual(await contentIds(), remaining);

      // A version 9 import that crashed before publishing: prepared, its
      // content staged beside the record. Without the repair flag the check
      // reads the staged copy and, confirmed, the replay finishes the
      // publication; with it (a crash leaves it raised) the lock's recovery
      // publishes first and the check reads the live content.
      for (const flagged of [false, true]) {
        const crashedKey = crypto.randomUUID();
        const crashed = await importPackage(port, bytes, '', {
          'idempotency-key': crashedKey
        });
        assert.equal(crashed.status, 201, crashed.body);
        const crashedAnswer = await asContract9(crashedKey);
        const crashedId = crashedAnswer.contentId;
        const crashedStored = await snapshot(path.join(content, crashedId));
        const crashedFile = path.join(operations, crashedKey, 'record.json');
        const crashedRecord = JSON.parse(
          await fs.readFile(crashedFile, 'utf8')
        );
        crashedRecord.state = 'prepared';
        delete crashedRecord.completedAt;
        await fs.writeFile(crashedFile, JSON.stringify(crashedRecord));
        await fs.mkdir(path.join(operations, crashedKey, 'content'));
        await fs.rename(
          path.join(content, crashedId),
          path.join(operations, crashedKey, 'content', crashedId)
        );
        if (flagged) await markRecoveryRequired(path.dirname(content));
        refusedAsReused(
          await importPackage(port, bytes, '', {
            'idempotency-key': crashedKey,
            'x-book-id': otherUuid
          })
        );
        assert.equal(
          (await contentIds()).includes(crashedId),
          flagged,
          flagged
            ? 'the repair publishes what was prepared'
            : 'a refused replay publishes nothing'
        );
        const finished = await importPackage(port, bytes, '', {
          'idempotency-key': crashedKey,
          'x-book-id': bookUuid
        });
        assert.equal(finished.status, 201, finished.body);
        assert.deepEqual(JSON.parse(finished.body), crashedAnswer);
        assert.deepEqual(
          await snapshot(path.join(content, crashedId)),
          crashedStored
        );
        assert.equal((await readOperation(content, crashedKey)).state, 'done');
      }
    },
    { tenant }
  );
});

test('an outdated package stored as it is still gets its book id canonical', async (t) => {
  const tenant = await mediaTenant(t);
  const { content } = tenant.context.paths;
  await withHost(
    async (port) => {
      const created = await importPackage(port, await outdatedPackage(), '', {
        ...keepOutdated,
        'x-book-id': bookUuid
      });
      assert.equal(created.status, 201, created.body);
      const answer = JSON.parse(created.body);
      assert.equal(answer.bookId, bookUuid);
      // The package's `@id=media-fixture;` is replaced; the rest is the
      // package's own.
      const stored = JSON.parse(
        await fs.readFile(
          path.join(content, answer.contentId, 'h5p.json'),
          'utf8'
        )
      );
      assert.deepEqual(stored, {
        ...metadata,
        title: 'Outdated',
        preloadedDependencies: outdatedDependencies,
        authorComments: `@id=${bookUuid};`
      });
    },
    { tenant }
  );
});
