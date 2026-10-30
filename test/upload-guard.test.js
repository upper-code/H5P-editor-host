const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  blockedImageFormat,
  assertUploadedImagesSafe
} = require('../build/src/upload-guard');
const { tmpDir } = require('./helpers');

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0
]);
const icns = Buffer.concat([Buffer.from('icns'), Buffer.alloc(8)]);
const jxlStream = Buffer.from([0xff, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const jxlBox = Buffer.concat([
  Buffer.from([0, 0, 0, 0x0c]),
  Buffer.from('JXL '),
  Buffer.from([0x0d, 0x0a, 0x87, 0x0a])
]);
const heic = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftyp'),
  Buffer.from('heic')
]);
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftyp'),
  Buffer.from('isom')
]);

test('only the formats with looping parsers are recognised', () => {
  assert.equal(blockedImageFormat(png), undefined);
  assert.equal(
    blockedImageFormat(mp4),
    undefined,
    'other ISO BMFF brands pass'
  );
  assert.equal(blockedImageFormat(Buffer.alloc(0)), undefined);
  assert.equal(blockedImageFormat(icns), 'ICNS');
  assert.equal(blockedImageFormat(jxlStream), 'JPEG XL');
  assert.equal(blockedImageFormat(jxlBox), 'JPEG XL');
  assert.equal(blockedImageFormat(heic), 'HEIF');
});

test('an image upload with a blocked body is refused, whatever its declared type', async (t) => {
  // The guard is given the request's files already flattened, the way the
  // route hands the same list to both upload guards.
  const dir = tmpDir(t, 'upload-guard-');
  const tempFilePath = path.join(dir, 'a.png');
  fs.writeFileSync(tempFilePath, Buffer.concat([icns, Buffer.alloc(100)]));

  // Staged on disk (useTempFiles) and declared as PNG: the bytes decide.
  await assert.rejects(
    assertUploadedImagesSafe([{ mimetype: 'image/png', tempFilePath }]),
    (error) => error.statusCode === 415 && /ICNS/.test(error.message)
  );
  // Held in memory, and not the only file in the request.
  await assert.rejects(
    assertUploadedImagesSafe([
      { mimetype: 'text/plain', data: png },
      { mimetype: 'image/jpeg', data: heic }
    ]),
    (error) => error.statusCode === 415 && /HEIF/.test(error.message)
  );
  // A real PNG passes; a non-image upload is not inspected at all.
  await assertUploadedImagesSafe([{ mimetype: 'image/png', data: png }]);
  await assertUploadedImagesSafe([
    { mimetype: 'application/octet-stream', data: icns }
  ]);
  await assertUploadedImagesSafe([]);
});
