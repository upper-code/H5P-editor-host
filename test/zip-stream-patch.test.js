const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Writable } = require('node:stream');

const { tmpDir } = require('./helpers');
const patchZipStreams = require('../build/src/zip-stream-patch').default;

// The zip reader exactly as h5p-server's PackageImporter loads it.
const h5pServer = path.dirname(
  require.resolve('@lumieducation/h5p-server/package.json')
);
const yauzl = require(require.resolve('yauzl-promise', { paths: [h5pServer] }));
const promisepipe = require(
  require.resolve('promisepipe', { paths: [h5pServer] })
);

/**
 * A one-entry deflated zip. `declaredSize` overrides the uncompressed size the
 * headers claim, which is how a corrupt or crafted entry looks to the reader.
 */
function zipOf(name, data, declaredSize = data.length) {
  const fileName = Buffer.from(name);
  const compressed = zlib.deflateRawSync(data);
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(fileName.length, 28);
  const centralOffset = local.length + fileName.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, compressed, central, fileName, end]);
}

/** A sink slow enough that the pipe has to pause the entry stream. */
const slowSink = (received) =>
  new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _encoding, callback) {
      received.bytes += chunk.length;
      setTimeout(callback, 1);
    }
  });

/** Reads every entry the way PackageImporter.extractPackage does. */
async function extract(zipPath, received) {
  const zipFile = await yauzl.open(zipPath);
  try {
    await zipFile.walkEntries(async (entry) => {
      await promisepipe(await entry.openReadStream(), slowSink(received));
    });
  } finally {
    await zipFile.close();
  }
}

/** Fails instead of hanging the suite when extraction never settles. */
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`extraction did not settle within ${ms} ms`)),
        ms
      );
    })
  ]).finally(() => clearTimeout(timer));
}

patchZipStreams();

test('an entry large enough to be paused for backpressure is read to the end', async (t) => {
  // Incompressible, so the compressed entry spans many reads of the file.
  const data = crypto.randomBytes(2 * 1024 * 1024);
  const zipPath = path.join(tmpDir(t, 'zip-large-'), 'large.h5p');
  fs.writeFileSync(zipPath, zipOf('content/audio.wav', data));
  const received = { bytes: 0 };

  await settlesWithin(extract(zipPath, received), 20_000);
  assert.equal(received.bytes, data.length);
});

test('an entry whose size does not match its headers fails instead of hanging', async (t) => {
  const data = crypto.randomBytes(256 * 1024);
  const zipPath = path.join(tmpDir(t, 'zip-corrupt-'), 'corrupt.h5p');
  fs.writeFileSync(zipPath, zipOf('content/audio.wav', data, data.length + 1));

  await assert.rejects(
    settlesWithin(extract(zipPath, { bytes: 0 }), 20_000),
    /not enough bytes/
  );
});

test('applying the patch twice is harmless', async (t) => {
  patchZipStreams();
  const data = crypto.randomBytes(512 * 1024);
  const zipPath = path.join(tmpDir(t, 'zip-twice-'), 'twice.h5p');
  fs.writeFileSync(zipPath, zipOf('content/file.bin', data));
  const received = { bytes: 0 };

  await settlesWithin(extract(zipPath, received), 20_000);
  assert.equal(received.bytes, data.length);
});

test('a stream destroyed while a read is in flight releases the file once', async (t) => {
  const { FdSlicer } = require(
    require.resolve('fd-slicer', {
      paths: [path.dirname(require.resolve('yauzl', { paths: [h5pServer] }))]
    })
  );
  // An empty file read as if it were longer: the in-flight read comes back
  // with no bytes, the answer that marks end of file.
  const filePath = path.join(tmpDir(t, 'zip-destroy-'), 'empty.bin');
  fs.writeFileSync(filePath, '');
  const fd = fs.openSync(filePath, 'r');
  t.after(() => fs.closeSync(fd));
  const slicer = new FdSlicer(fd);
  const stream = slicer.createReadStream({ start: 0, end: 16 });
  stream.on('error', () => {});

  stream._read(16);
  stream.destroy();
  // Wait for the read itself, not for a guess at how long it takes: the slicer
  // runs one read at a time, and its queue drains once the callback is done.
  // A second release would have thrown "invalid unref" from that callback.
  await settlesWithin(
    new Promise((resolve) => slicer.pend.wait(resolve)),
    20_000
  );
  assert.equal(slicer.refCount, 0);
});
