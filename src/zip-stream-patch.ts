import fs from 'fs';
import path from 'path';

/**
 * Two defects in the zip reader under h5p-server's package import
 * (`PackageImporter.extractPackage` → yauzl-promise 2.1 → yauzl 2.10 →
 * fd-slicer 1.1) make an import hang forever instead of finishing or failing.
 * A hung import never releases the tenant's content lock (its heartbeat keeps
 * refreshing it), so every later save and import of that tenant answers 503
 * until the process restarts. Neither package has a fixed release.
 *
 * 1. fd-slicer's read stream marks end of file by setting `this.destroyed`,
 *    which on current Node is Readable's own destroyed state. Since Node 26.1
 *    pause() and resume() are no-ops on a destroyed stream, so an entry large
 *    enough for pipe() to pause it for backpressure reaches EOF while paused
 *    and never delivers its buffered tail or 'end'. Every package with a
 *    sizeable file under `content/` hangs. Fixed by tracking EOF in a private
 *    flag.
 * 2. yauzl replaces each entry stream's destroy() with one that ignores its
 *    error. Node reports a Transform failure — yauzl's byte-count check on a
 *    corrupt or crafted entry — through destroy(err), so the error is lost and
 *    the stream neither ends nor errors, on every Node version. Fixed by
 *    re-emitting that error.
 *
 * Applied at load time rather than as a postinstall edit because the defect is
 * in behaviour a small wrapper can correct without touching vendored sources.
 * The replacement `_read` is a copy of fd-slicer 1.1.0's, so the patch refuses
 * to start against any other version of the chain rather than overwrite code
 * it has not been checked against; see `expectedVersions`.
 * The regression test (test/zip-stream-patch.test.js) extracts a package with a
 * large entry and a corrupted one and requires both to settle.
 */

const packageDirectory = (id: string, from: string): string =>
  path.dirname(require.resolve(`${id}/package.json`, { paths: [from] }));

/**
 * The versions this patch was written and tested against. Their semver ranges
 * (h5p-server → `yauzl-promise ^2.1.3` → `yauzl ^2.9.1` → `fd-slicer ~1.1.0`)
 * have no newer release, so a different version means an upgrade of
 * h5p-server itself — the moment to re-check both defects and this patch.
 */
const expectedVersions: Record<string, string> = {
  'yauzl-promise': '2.1.3',
  yauzl: '2.10.0',
  'fd-slicer': '1.1.0'
};

function assertVersion(id: string, directory: string): void {
  const { version } = require(path.join(directory, 'package.json'));
  if (version !== expectedVersions[id]) {
    throw new Error(
      `zip-stream-patch was written for ${id} ${expectedVersions[id]}, but ` +
        `${version} is installed. Re-check the defects it corrects and ` +
        'update src/zip-stream-patch.ts.'
    );
  }
}

export default function patchZipStreams(): void {
  const h5pServer = packageDirectory('@lumieducation/h5p-server', __dirname);
  const yauzlPromiseDirectory = packageDirectory('yauzl-promise', h5pServer);
  const yauzlDirectory = packageDirectory('yauzl', yauzlPromiseDirectory);
  const fdSlicerDirectory = packageDirectory('fd-slicer', yauzlDirectory);
  assertVersion('yauzl-promise', yauzlPromiseDirectory);
  assertVersion('yauzl', yauzlDirectory);
  assertVersion('fd-slicer', fdSlicerDirectory);
  const { FdSlicer } = require(fdSlicerDirectory);

  // The read stream class is not exported; take it from an instance. The
  // constructor refs the slicer, which a stream normally releases at EOF.
  const probe = new FdSlicer(-1).createReadStream();
  probe.context.unref();
  const ReadStream = Object.getPrototypeOf(probe);
  // Marked on the patched class itself, not in this module: a second copy of
  // this module (another build loaded in the same process) must not wrap
  // openReadStream twice.
  if (ReadStream.__hostZipStreamsPatched) return;
  ReadStream.__hostZipStreamsPatched = true;

  // fd-slicer 1.1.0's _read, with EOF kept in `_eof` instead of `destroyed`.
  ReadStream._read = function (this: any, size: number): void {
    const self = this;
    if (self._eof || self.destroyed) return;
    let toRead = Math.min(self._readableState.highWaterMark, size);
    if (self.endOffset != null) {
      toRead = Math.min(toRead, self.endOffset - self.pos);
    }
    const finish = () => {
      self._eof = true;
      self.push(null);
      self.context.unref();
    };
    if (toRead <= 0) {
      finish();
      return;
    }
    self.context.pend.go((done: () => void) => {
      if (self._eof || self.destroyed) {
        done();
        return;
      }
      const buffer = Buffer.allocUnsafe(toRead);
      fs.read(
        self.context.fd,
        buffer,
        0,
        toRead,
        self.pos,
        (err, bytesRead) => {
          // Destroyed while this read was in flight: destroy() has already
          // released the slicer, and releasing it again from finish() would
          // throw "invalid unref" here or close the file under another entry.
          if (self._eof || self.destroyed) {
            done();
            return;
          }
          if (err) {
            self.destroy(err);
          } else if (bytesRead === 0) {
            finish();
          } else {
            self.pos += bytesRead;
            self.push(buffer.subarray(0, bytesRead));
          }
          done();
        }
      );
    });
  };

  ReadStream.destroy = function (this: any, err?: Error): unknown {
    // Node's autoDestroy calls destroy() after 'end'. fd-slicer treated a
    // stream that had reached EOF as already destroyed, and so does this.
    if (this.destroyed || this._eof) return this;
    this._eof = true;
    this.destroyed = true;
    this.emit('error', err || new Error('stream destroyed'));
    this.context.unref();
    return this;
  };

  const { ZipFile } = require(yauzlPromiseDirectory);
  const openReadStream = ZipFile.prototype.openReadStream;
  ZipFile.prototype.openReadStream = function (
    this: unknown,
    ...args: unknown[]
  ) {
    return openReadStream.apply(this, args).then((stream: any) => {
      // One of yauzl's own wrappers (the inflate or byte-count stream), never
      // the fd-slicer stream: even a stored entry is read through the byte
      // counter yauzl puts around every range read. The one exception, an
      // empty stored entry, is a plain PassThrough with nothing to fail.
      const yauzlDestroy = stream.destroy;
      let failed = false;
      stream.destroy = function (this: any, err?: Error) {
        yauzlDestroy.call(this);
        if (err && !failed) {
          failed = true;
          process.nextTick(() => this.emit('error', err));
        }
        return this;
      };
      return stream;
    });
  };
}
