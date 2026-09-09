const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function box(type, data = Buffer.alloc(0), size = 8 + data.length) {
  return Buffer.concat([uint32(size), Buffer.from(type), data]);
}

function iconEntry(size) {
  return Buffer.concat([Buffer.from('icp4'), uint32(size)]);
}

function icns(...entries) {
  const body = Buffer.concat(entries);
  return Buffer.concat([Buffer.from('icns'), uint32(8 + body.length), body]);
}

const jxlHeader = Buffer.concat([
  box('JXL ', Buffer.from([0x0d, 0x0a, 0x87, 0x0a])),
  box('ftyp', Buffer.from('jxl '))
]);
const heifHeader = box('ftyp', Buffer.from('avif'));

// A test-runner timeout cannot interrupt a synchronous parser loop. Resolve
// the dependency as H5P does, then parse in a child with a hard time/memory cap.
function measure(input) {
  const child = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=64',
      '-e',
      `
        const fs = require('node:fs');
        const { createRequire } = require('node:module');
        const requireFromH5p = createRequire(require.resolve('@lumieducation/h5p-server'));
        const sizeOf = requireFromH5p('image-size');
        const input = JSON.parse(fs.readFileSync(0, 'utf8'));
        try {
          const size = sizeOf(input.file || Buffer.from(input.hex, 'hex'));
          process.stdout.write(JSON.stringify({ size }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ error: error.message }));
        }
      `
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      input: JSON.stringify(
        Buffer.isBuffer(input) ? { hex: input.toString('hex') } : input
      ),
      encoding: 'utf8',
      timeout: 3000,
      killSignal: 'SIGKILL'
    }
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('ICNS rejects zero and undersized entries, including after a valid entry', () => {
  for (const size of [0, 1, 7]) {
    for (const entries of [
      [iconEntry(size)],
      [iconEntry(8), iconEntry(size)]
    ]) {
      assert.match(measure(icns(...entries)).error, /Invalid ICNS entry size/);
    }
  }
  assert.match(
    measure(icns(Buffer.from('icp4'))).error,
    /Invalid ICNS entry header/
  );
});

test('JXL rejects zero and undersized partial-stream boxes', () => {
  for (const size of [0, 1, 7]) {
    const input = Buffer.concat([
      jxlHeader,
      box('jxlp', Buffer.alloc(4), size)
    ]);
    assert.match(measure(input).error, /Invalid box size/);
  }
});

test('HEIF rejects malformed boxes both while searching and inside metadata', () => {
  for (const size of [0, 1, 7]) {
    for (const body of [
      box('free', Buffer.alloc(0), size),
      box(
        'meta',
        Buffer.concat([Buffer.alloc(4), box('iprp', Buffer.alloc(0), size)])
      )
    ]) {
      assert.match(
        measure(Buffer.concat([heifHeader, body])).error,
        /Invalid box size/
      );
    }
  }
});

test('patched image-size still measures valid images from buffers and file paths', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-size-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64'
  );
  const gif = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"></svg>'
  );
  const codestream = Buffer.from([0xff, 0x0a, 0x01, 0x00]);
  const heif = Buffer.concat([
    heifHeader,
    box(
      'meta',
      Buffer.concat([
        Buffer.alloc(4),
        box(
          'iprp',
          box(
            'ipco',
            box(
              'ispe',
              Buffer.concat([Buffer.alloc(4), uint32(20), uint32(10)])
            )
          )
        )
      ])
    )
  ]);
  const fixtures = [
    ['png', png, 1, 1],
    ['gif', gif, 1, 1],
    ['svg', svg, 20, 10],
    ['icns', icns(iconEntry(8), iconEntry(8)), 16, 16],
    ['jxl', Buffer.concat([jxlHeader, box('jxlc', codestream)]), 8, 8],
    [
      'jxl-partial',
      Buffer.concat([
        jxlHeader,
        box('jxlp', Buffer.concat([uint32(0x80000000), codestream]))
      ]),
      8,
      8
    ],
    ['avif', heif, 20, 10]
  ];
  for (const [type, bytes, width, height] of fixtures) {
    const file = path.join(dir, `image.${type}`);
    fs.writeFileSync(file, bytes);
    for (const input of [bytes, { file }]) {
      const result = measure(input);
      assert.equal(result.error, undefined, result.error);
      assert.equal(result.size.width, width, type);
      assert.equal(result.size.height, height, type);
    }
  }
});

test('malformed images are also rejected on the H5P temporary-file path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-size-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, bytes] of [
    ['icns', icns(iconEntry(0))],
    ['jxl', Buffer.concat([jxlHeader, box('jxlp', Buffer.alloc(4), 0)])],
    ['heif', Buffer.concat([heifHeader, box('free', Buffer.alloc(0), 0)])]
  ]) {
    // A misleading extension must not affect detection.
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, bytes);
    assert.match(measure({ file }).error, /Invalid (ICNS entry|box) size/);
  }
});
