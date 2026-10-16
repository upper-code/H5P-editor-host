const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');

const createApp = require('../build/src/app').default;
const TenantManager = require('../build/src/tenant-manager').default;
const {
  rawArchivePrefixes,
  rawArchivesIn
} = require('../build/src/raw-archives');
const { tmpDir, withEnv } = require('./helpers');
const { appRoot, log } = require('./host');

// The zip writer h5p-server uses for exports.
const { ZipFile } = require(
  require.resolve('yazl', {
    paths: [
      path.dirname(require.resolve('@lumieducation/h5p-server/package.json'))
    ]
  })
);

const DISTRIBUTOR = 'raw';
const headers = {
  'x-h5p-host-secret': 'test-secret',
  'x-distributor-id': DISTRIBUTOR
};

/** A zip of `entries` ({ name, data, compress }), as yazl writes it. */
async function zipOf(entries) {
  const zip = new ZipFile();
  for (const { name, data, compress = true } of entries) {
    zip.addBuffer(Buffer.from(data), name, { compress });
  }
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * A zip of stored entries written by hand: yazl refuses the names a crafted
 * archive carries (`../x`), which is exactly what these tests need.
 */
function rawZipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name);
    const body = Buffer.from(data);
    const crc = zlib.crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, body);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + body.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

/** The parameters of a book whose lesson keeps its sources in `archive`. */
function lessonParameters(archive) {
  return {
    chapters: [
      {
        library: 'VMB.Column 1.5',
        params: {
          content: [
            {
              content: {
                library: 'VMB.SyncLesson 1.4',
                params: {
                  vmbraw: {
                    path: archive,
                    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                  }
                }
              }
            }
          ]
        }
      }
    ]
  };
}

/** The host over a real TenantManager, and a way to store content in it. */
async function rawHost(t, env = {}) {
  const scratch = tmpDir(t, 'host-raw-');
  withEnv(t, {
    H5P_HOST_DATA_DIR: scratch,
    H5P_LIBRARIES_DIR: path.join(scratch, 'libraries'),
    H5P_HOST_UPLOAD_TMP_DIR: path.join(scratch, 'upload-tmp'),
    H5P_HOST_SHARED_SECRET: 'test-secret',
    ...env
  });
  const tenants = new TenantManager(appRoot, log);
  await tenants.initialize();
  const server = createApp(appRoot, log, tenants).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const tenant = await tenants.get(DISTRIBUTOR);
  const contentRoot = tenant.context.paths.content;
  const base = `http://127.0.0.1:${server.address().port}/h5p-editor-core`;
  return {
    contentRoot,
    cacheRoot: path.join(path.dirname(contentRoot), 'raw-archives'),
    async store(id, { parameters, files = {} }) {
      const directory = path.join(contentRoot, id);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, 'h5p.json'),
        JSON.stringify({
          title: 'Lesson',
          mainLibrary: 'VMB.InteractiveBook',
          preloadedDependencies: []
        })
      );
      await fs.writeFile(
        path.join(directory, 'content.json'),
        JSON.stringify(parameters)
      );
      for (const [name, data] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(directory, name)), {
          recursive: true
        });
        await fs.writeFile(path.join(directory, name), data);
      }
    },
    get: (url, extra = {}) =>
      fetch(`${base}/${url}`, { headers: { ...headers, ...extra } }),
    delete: (url) => fetch(`${base}/${url}`, { method: 'DELETE', headers })
  };
}

const text = async (response) => ({
  status: response.status,
  body: await response.text()
});

test('the folder the libraries derive from vmbraw.path', () => {
  assert.deepEqual(rawArchivePrefixes('file-x.docx'), ['file-x/']);
  assert.deepEqual(rawArchivePrefixes('files/x.y.docx'), ['files/x.y/']);
  // VMB.SyncLesson cuts at the last dot anywhere, VMB.EduDict only in the
  // file name: both folders are served.
  assert.deepEqual(rawArchivePrefixes('a.b/archive'), ['a/', 'a.b/archive/']);
  assert.deepEqual(rawArchivePrefixes('archive'), ['archive/']);
});

test('archives are found at any depth, and only files of the content count', () => {
  const found = rawArchivesIn({
    a: [{ b: { vmbraw: { path: 'file-a.docx' } } }],
    c: { vmbraw: { path: 'file-a.docx' } },
    d: { vmbraw: { path: 'https://cdn.example/x.docx' } },
    e: { vmbraw: { path: '../outside.docx' } },
    f: { vmbraw: { path: '/etc/x.docx' } },
    g: { vmbraw: { path: 'file-b.docx#tmp' } },
    h: { vmbraw: { path: 42 } },
    i: { vmbraw: 'file-c.docx' }
  });
  assert.deepEqual(found, [{ file: 'file-a.docx', prefixes: ['file-a/'] }]);
});

test('files of a raw archive are served like content files, with Range', async (t) => {
  const host = await rawHost(t);
  const video = crypto.randomBytes(300 * 1024);
  const archive = await zipOf([
    { name: 'config.json', data: '{"areas":[]}' },
    // A stored entry after a deflated one: the order that hung the unpacking
    // when each entry went through `stream/promises` pipeline.
    { name: 'media/clip.mp4', data: video },
    { name: 'speakers/a eto marina@man.mp3', data: 'mp3', compress: false },
    { name: 'guide/guide.html', data: '<p>Guide</p>' },
    { name: 'styles/lesson.css', data: 'p{}' },
    { name: 'tool.js', data: 'alert(1)' },
    { name: '.hidden.json', data: '{}' },
    { name: '__MACOSX/media/._clip.mp4', data: 'x' }
  ]);
  await host.store('11', {
    parameters: lessonParameters('file-ab.docx'),
    files: { 'file-ab.docx': archive }
  });

  const prefix = 'h5p/content/11/file-ab';
  assert.deepEqual(await text(await host.get(`${prefix}/config.json`)), {
    status: 200,
    body: '{"areas":[]}'
  });
  const speaker = await host.get(`${prefix}/speakers/a%20eto%20marina@man.mp3`);
  assert.equal(speaker.status, 200);
  assert.equal(speaker.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await speaker.text(), 'mp3');

  const range = await host.get(`${prefix}/media/clip.mp4`, {
    range: 'bytes=10-19'
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal(
    range.headers.get('content-range'),
    `bytes 10-19/${video.length}`
  );
  assert.equal(range.headers.get('cache-control'), 'private, no-store');
  assert.match(range.headers.get('content-security-policy'), /^sandbox;/);
  assert.deepEqual(
    Buffer.from(await range.arrayBuffer()),
    video.subarray(10, 20)
  );

  // Documents keep the content files' policy: sandboxed downloads.
  const guide = await host.get(`${prefix}/guide/guide.html`);
  assert.equal(guide.status, 200);
  assert.equal(guide.headers.get('content-disposition'), 'attachment');
  assert.match(guide.headers.get('content-security-policy'), /^sandbox;/);
  assert.equal(await guide.text(), '<p>Guide</p>');
  assert.equal((await host.get(`${prefix}/styles/lesson.css`)).status, 200);

  // Scripts, dotfiles and resource forks are never unpacked.
  for (const name of ['tool.js', '.hidden.json', '__MACOSX/media/._clip.mp4']) {
    const response = await host.get(`${prefix}/${name}`);
    assert.equal(response.status, 404, name);
    await response.arrayBuffer();
  }
  const missing = await host.get(`${prefix}/nothing.json`);
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
});

test('a file stored in the content itself wins over the archive', async (t) => {
  const host = await rawHost(t);
  await host.store('12', {
    parameters: lessonParameters('file-ab.docx'),
    files: {
      'file-ab.docx': await zipOf([{ name: 'config.json', data: 'archive' }]),
      'file-ab/config.json': 'stored'
    }
  });
  assert.deepEqual(
    await text(await host.get('h5p/content/12/file-ab/config.json')),
    { status: 200, body: 'stored' }
  );
  // Nothing was unpacked for it.
  await assert.rejects(fs.access(path.join(host.cacheRoot, '12')));
});

test('only an archive the parameters name is unpacked', async (t) => {
  const host = await rawHost(t);
  const archive = await zipOf([{ name: 'config.json', data: '{}' }]);
  await host.store('13', {
    parameters: lessonParameters('file-ab.docx'),
    files: { 'file-ab.docx': archive, 'file-other.docx': archive }
  });
  const response = await host.get('h5p/content/13/file-other/config.json');
  assert.equal(response.status, 404);
  await response.arrayBuffer();
  await assert.rejects(fs.access(path.join(host.cacheRoot, '13')));
});

test('a replaced archive is unpacked again and its old folder removed', async (t) => {
  const host = await rawHost(t);
  await host.store('14', {
    parameters: lessonParameters('file-ab.docx'),
    files: {
      'file-ab.docx': await zipOf([{ name: 'config.json', data: 'first' }])
    }
  });
  const url = 'h5p/content/14/file-ab/config.json';
  assert.equal((await text(await host.get(url))).body, 'first');
  const [before] = await fs.readdir(path.join(host.cacheRoot, '14'));

  // A save publishes a new file, never rewrites the old one in place.
  const file = path.join(host.contentRoot, '14', 'file-ab.docx');
  await fs.rm(file);
  await fs.writeFile(
    file,
    await zipOf([{ name: 'config.json', data: 'second' }])
  );
  assert.equal((await text(await host.get(url))).body, 'second');
  const after = await fs.readdir(path.join(host.cacheRoot, '14'));
  assert.equal(after.length, 1);
  assert.notEqual(after[0], before);
});

test('an archive a save copies unchanged keeps its folder', async (t) => {
  // Where the file system has reflinks, a save gives an unchanged archive a
  // new inode and mtime (`cloneDirectory`).
  const host = await rawHost(t);
  const archive = await zipOf([{ name: 'config.json', data: 'same' }]);
  await host.store('18', {
    parameters: lessonParameters('file-ab.docx'),
    files: { 'file-ab.docx': archive }
  });
  const url = 'h5p/content/18/file-ab/config.json';
  assert.equal((await text(await host.get(url))).body, 'same');
  const folder = path.join(host.cacheRoot, '18');
  const [name] = await fs.readdir(folder);
  const before = await fs.stat(path.join(folder, name, 'config.json'));

  const file = path.join(host.contentRoot, '18', 'file-ab.docx');
  await fs.rm(file);
  await fs.writeFile(file, archive);
  assert.equal((await text(await host.get(url))).body, 'same');
  assert.deepEqual(await fs.readdir(folder), [name]);
  const after = await fs.stat(path.join(folder, name, 'config.json'));
  assert.equal(after.ino, before.ino, 'not unpacked again');
});

test('concurrent first requests unpack the archive once', async (t) => {
  const host = await rawHost(t);
  await host.store('15', {
    parameters: lessonParameters('file-ab.docx'),
    files: {
      'file-ab.docx': await zipOf(
        Array.from({ length: 20 }, (_, index) => ({
          name: `entries/${index}.json`,
          data: String(index)
        }))
      )
    }
  });
  const answers = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      host.get(`h5p/content/15/file-ab/entries/${index}.json`).then(text)
    )
  );
  answers.forEach((answer, index) =>
    assert.deepEqual(answer, { status: 200, body: String(index) })
  );
  assert.equal((await fs.readdir(path.join(host.cacheRoot, '15'))).length, 1);
});

test('deleting the content removes its unpacked archives', async (t) => {
  const host = await rawHost(t);
  await host.store('16', {
    parameters: lessonParameters('file-ab.docx'),
    files: {
      'file-ab.docx': await zipOf([{ name: 'config.json', data: '{}' }])
    }
  });
  assert.equal(
    (await host.get('h5p/content/16/file-ab/config.json')).status,
    200
  );
  await fs.access(path.join(host.cacheRoot, '16'));

  const deleted = await host.delete('api/v1/content/16');
  assert.equal(deleted.status, 200, await deleted.text());
  await assert.rejects(fs.access(path.join(host.cacheRoot, '16')));
});

test('a broken or over-limit archive answers 404 and the content still plays', async (t) => {
  const host = await rawHost(t, {
    H5P_HOST_RAW_ARCHIVE_MAX_ENTRIES: '3',
    H5P_HOST_RAW_ARCHIVE_MAX_BYTES: '1000'
  });
  const cases = {
    'not-a-zip.docx': Buffer.from('plain text'),
    'many.docx': await zipOf(
      Array.from({ length: 4 }, (_, index) => ({
        name: `${index}.json`,
        data: '{}'
      }))
    ),
    'large.docx': await zipOf([
      { name: 'config.json', data: '{}' },
      { name: 'big.json', data: 'x'.repeat(2000) }
    ]),
    // yauzl refuses an entry that climbs out of the folder: the whole
    // archive is refused, and nothing is written outside it.
    'slip.docx': rawZipOf([
      { name: 'config.json', data: '{}' },
      { name: '../../escaped.json', data: '{}' }
    ])
  };
  await host.store('17', {
    parameters: {
      lessons: Object.keys(cases).map((name) => ({ vmbraw: { path: name } }))
    },
    files: { ...cases, 'images/cover.png': 'png' }
  });
  for (const name of Object.keys(cases)) {
    const folder = name.slice(0, -'.docx'.length);
    const response = await host.get(`h5p/content/17/${folder}/config.json`);
    assert.equal(response.status, 404, name);
    await response.arrayBuffer();
  }
  // Refused archives leave no folder, staged or published.
  assert.deepEqual(await fs.readdir(path.join(host.cacheRoot, '17')), []);
  await assert.rejects(fs.access(path.join(host.cacheRoot, 'escaped.json')));
  await assert.rejects(
    fs.access(path.join(path.dirname(host.cacheRoot), 'escaped.json'))
  );
  // The content's own files are untouched by any of it.
  assert.deepEqual(
    await text(await host.get('h5p/content/17/images/cover.png')),
    { status: 200, body: 'png' }
  );
});
