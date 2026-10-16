import crypto from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

import envNumber from './env';
import { isInsideDirectory, numericContentId } from './content-id';
import patchZipStreams from './zip-stream-patch';

/**
 * Raw content archives (`vmbraw`): the files of a VMB library's content,
 * served from a zip the content stores as one file.
 *
 * `VMB.SyncLesson` and `VMB.EduDict` keep their sources in a zip renamed to an
 * extension the H5P whitelist allows (`{ vmbraw: { path: 'file-x.docx' } }`)
 * and load its files through `H5P.getPath('file-x/<entry>')` — a folder named
 * after the archive without its extension, next to `content.json`. The
 * CyberShelf viewer unpacks that folder when it installs a book; an H5P server
 * has no such step, so every one of those requests would be a 404.
 *
 * The archive cannot be unpacked into the content itself: h5p-server deletes
 * files the parameters do not reference on every editor save
 * (`deleteUnusedOldFiles`), an export would carry every file twice, and the
 * content would grow by the archive's size against the embedder's quota. So
 * the folder is derived data: unpacked on its first request into
 * `<tenant>/raw-archives/<contentId>/<key>/`, outside the content and its
 * transactions, keyed by the archive's content, and served from there with
 * Range support (a deflated video cannot be served from inside the zip). An
 * archive a save keeps unchanged keeps its folder, however the save copied
 * it; a replaced one gets a new folder and the old one is removed.
 *
 * No content lock is taken: the folder is consistent with the archive it was
 * unpacked from by construction (its key is the digest of that file, whose
 * identity on disk is checked again after hashing and after unpacking), and
 * a request that straddles a save sees either revision's archive, like any
 * single-file read under `/h5p/`.
 *
 * Only entries with an extension the content whitelist allows, plus HTML and
 * CSS (the libraries load their articles and styles from the archive), are
 * unpacked; scripts never are. A broken or over-limit archive unpacks
 * nothing and its files answer 404 — the library shows its own error, the rest
 * of the book plays — with a warning in the log.
 */

// The zip reader h5p-server's PackageImporter uses, read the way it reads it:
// `walkEntries`, and `promisepipe` into the file. Not `stream/promises`'
// `pipeline`: it destroys each entry stream once it is done, and on Node 26
// yauzl's destroy path left the next stored (uncompressed) entry ended but
// paused, never emitting `end` — the unpacking of a real archive hung there.
// `zip-stream-patch.ts` was written and is tested against this read path.
const h5pServer = path.dirname(
  require.resolve('@lumieducation/h5p-server/package.json')
);
const yauzl = require(
  path.dirname(
    require.resolve('yauzl-promise/package.json', { paths: [h5pServer] })
  )
);
const promisepipe: (
  ...streams: (NodeJS.ReadableStream | NodeJS.WritableStream)[]
) => Promise<unknown> = require(
  require.resolve('promisepipe', { paths: [h5pServer] })
);

/** What `promisepipe` rejects with: the failed stream and its own error. */
interface StreamError extends Error {
  source: unknown;
  originalError: Error;
}

interface RawEntry {
  fileName: string;
  uncompressedSize: number;
  openReadStream(): Promise<NodeJS.ReadableStream>;
}

/** A failure of this host's filesystem rather than of the archive. */
function isHostError(error: unknown): boolean {
  return (
    typeof (error as NodeJS.ErrnoException | undefined)?.syscall === 'string'
  );
}

/** A problem of the archive itself, not of this host: answered with a 404. */
class RawArchiveError extends Error {}

/** Extensions unpacked beyond the content whitelist: the libraries' articles
 *  and styles. Scripts are never among them. */
const extraExtensions = ['html', 'htm', 'css'];

/** A staging folder younger than this may belong to another process that is
 *  still unpacking; an older one is a crash's leftover. */
const stagingTtlMs = 60 * 60 * 1000;

/** Parsed `content.json` archive lists kept per process. */
const parsedCacheSize = 256;

/** Broken archives remembered per process, so each is read once. */
const refusedCacheSize = 1024;

/** Archive digests remembered per process, by file identity. */
const digestCacheSize = 1024;

export interface RawArchiveLimits {
  /** Most bytes one archive may unpack to. */
  maxBytes: number;
  /** Most entries one archive may hold. */
  maxEntries: number;
}

/** Read once at startup, like every numeric setting (src/env.ts). */
export function rawArchiveLimits(): RawArchiveLimits {
  return {
    maxBytes: envNumber('H5P_HOST_RAW_ARCHIVE_MAX_BYTES', 1024 * 1024 * 1024, {
      min: 1
    }),
    maxEntries: envNumber('H5P_HOST_RAW_ARCHIVE_MAX_ENTRIES', 10000, {
      min: 1,
      integer: true
    })
  };
}

/** The tenant's cache root, beside its `content` directory. */
export function rawArchiveCacheRoot(contentRoot: string): string {
  return path.join(path.dirname(contentRoot), 'raw-archives');
}

/** Drops the unpacked archives of one content item (after its deletion). */
export async function removeRawArchives(
  contentRoot: string,
  contentId: string
): Promise<void> {
  if (!numericContentId.test(contentId)) return;
  await fs.rm(path.join(rawArchiveCacheRoot(contentRoot), contentId), {
    recursive: true,
    force: true
  });
}

interface RawArchive {
  /** The archive's path inside the content, as the parameters name it. */
  file: string;
  /** The folder prefixes the libraries request its entries under. */
  prefixes: string[];
}

const hash = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

/**
 * The folder the libraries derive from `vmbraw.path`, by both of their rules:
 * `VMB.SyncLesson` cuts at the last dot of the whole path, `VMB.EduDict` only
 * at a dot in the file name. They differ only for a dotted folder name.
 */
export function rawArchivePrefixes(file: string): string[] {
  const lastDot = file.lastIndexOf('.');
  const lastSlash = file.lastIndexOf('/');
  const syncLesson = (file.substring(0, lastDot) || file) + '/';
  const eduDict = (lastDot > lastSlash ? file.slice(0, lastDot) : file) + '/';
  return syncLesson === eduDict ? [syncLesson] : [syncLesson, eduDict];
}

/**
 * Every `{ vmbraw: { path } }` in the parameters that names a file of the
 * content itself (not a URL, not outside the folder). Walked iteratively:
 * the parameters are authored data of any depth.
 */
export function rawArchivesIn(parameters: unknown): RawArchive[] {
  const found = new Map<string, RawArchive>();
  const stack: unknown[] = [parameters];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    const raw = record.vmbraw as Record<string, unknown> | undefined;
    const file = raw && typeof raw === 'object' ? raw.path : undefined;
    if (
      typeof file === 'string' &&
      file &&
      !/^[a-z][a-z0-9+.-]*:/i.test(file) &&
      !file.includes('#') &&
      !file.includes('\\') &&
      !path.posix.isAbsolute(file) &&
      // A check of the string alone (no `..` climbing out); `/content` only
      // anchors the resolution. `serve` resolves against the real folder.
      isInsideDirectory('/content', file)
    ) {
      found.set(file, { file, prefixes: rawArchivePrefixes(file) });
    }
    for (const key of Object.keys(record)) stack.push(record[key]);
  }
  return [...found.values()];
}

/**
 * Whether an entry is unpacked: a plain relative path of visible segments
 * (no dotfiles, no macOS resource forks) with an allowed extension. A name
 * with `%` is left out as unreachable: `H5P.getPath` does not encode the path,
 * so the browser sends its `%xx` as is and the route decodes it into another
 * name.
 */
function acceptedEntry(name: string, extensions: Set<string>): boolean {
  if (
    !name ||
    name.endsWith('/') ||
    /[\\%\0]/.test(name) ||
    name.startsWith('/')
  ) {
    return false;
  }
  const segments = name.split('/');
  if (
    segments[0] === '__MACOSX' ||
    segments.some((segment) => !segment || segment.startsWith('.'))
  ) {
    return false;
  }
  const basename = segments[segments.length - 1];
  const dot = basename.lastIndexOf('.');
  return dot > 0 && extensions.has(basename.slice(dot + 1).toLowerCase());
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Prepares `destination` in a staging folder for a new file: creates its folders
 * and says whether the name is still free. False when the archive already put
 * a file where a folder is needed, or anything at the name itself.
 */
async function freshPath(destination: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTDIR') return false;
    throw error;
  }
  try {
    await fs.lstat(destination);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

/** A file's identity on disk: a new or rewritten file is a new identity. */
async function identity(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

export interface RawArchiveRequest {
  contentRoot: string;
  contentId: string;
  /** The requested file, relative to the content folder, decoded. */
  file: string;
  /** h5p-server's `contentWhitelist` (space-separated extensions), read only
   *  when an archive is unpacked: most requests never get that far. */
  contentWhitelist: () => string;
  log: Logger;
}

export class RawArchives {
  private readonly limits: RawArchiveLimits;

  /** Archive lists by `content.json` identity. */
  private readonly parsed = new Map<string, RawArchive[]>();

  /** Unpacking in flight, by target folder and source identity. */
  private readonly unpacking = new Map<string, Promise<boolean>>();

  /** Targets whose archive is broken or over a limit; not retried. */
  private readonly refused = new Set<string>();

  /** Archive content digests by file identity, so each copy is read once. */
  private readonly digests = new Map<string, string>();

  /** Digests being computed, by file identity. */
  private readonly hashing = new Map<string, Promise<string | null>>();

  constructor(limits: RawArchiveLimits) {
    this.limits = limits;
    patchZipStreams();
  }

  /**
   * Answers a content file request from an unpacked archive, or passes it on
   * (`next()`) to the GPL router: a file that exists in the content itself
   * always wins, and anything this cannot serve becomes that router's 404.
   */
  public async serve(
    request: RawArchiveRequest,
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const { contentRoot, contentId, file } = request;
    const contentDirectory = path.join(contentRoot, contentId);
    if (
      !numericContentId.test(contentId) ||
      !file ||
      !isInsideDirectory(contentDirectory, file) ||
      (await isFile(path.join(contentDirectory, file)))
    ) {
      next();
      return;
    }
    const archives = await this.archivesOf(contentDirectory);
    let archive: RawArchive | undefined;
    let entry = '';
    for (const candidate of archives) {
      const prefix = candidate.prefixes.find((p) => file.startsWith(p));
      if (prefix) {
        archive = candidate;
        entry = file.slice(prefix.length);
        break;
      }
    }
    if (!archive || !entry) {
      next();
      return;
    }
    const folder = await this.unpacked(request, archive, archives);
    if (!folder || !(await isFile(path.join(folder, entry)))) {
      next();
      return;
    }
    res.sendFile(
      entry,
      {
        root: folder,
        dotfiles: 'deny',
        // The host's own `Cache-Control: private, no-store` for content
        // files stays; `send` would replace it with `public, max-age=0`.
        cacheControl: false
      },
      (error?: Error & { status?: number }) => {
        if (!error || res.headersSent) return;
        next(error.status === 404 ? undefined : error);
      }
    );
  }

  private async archivesOf(contentDirectory: string): Promise<RawArchive[]> {
    const file = path.join(contentDirectory, 'content.json');
    const key = await identity(file);
    if (!key) return [];
    const cached = this.parsed.get(`${file}\0${key}`);
    if (cached) return cached;
    let archives: RawArchive[];
    try {
      archives = rawArchivesIn(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
      // A save publishes by rename, so a half-written file is a crash's
      // leftover at worst: nothing here to serve from it.
      if (error instanceof SyntaxError) return [];
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw error;
    }
    if (this.parsed.size >= parsedCacheSize) {
      this.parsed.delete(this.parsed.keys().next().value!);
    }
    this.parsed.set(`${file}\0${key}`, archives);
    return archives;
  }

  /**
   * The archive's content digest, with the identity it was read under; null
   * while the file is missing or changing under the read.
   *
   * The folder is keyed by content, not by the file's identity: a save
   * publishes a new revision as a reflink copy where one succeeds (XFS,
   * Btrfs), else as a hardlink farm, else as a byte copy (`cloneDirectory`),
   * and a reflink or a copy gives an unchanged archive a new inode. Keyed by
   * identity, each such save would unpack it again; keyed by content, it
   * costs one read of the archive per process, and a hardlinked one not even
   * that.
   */
  private async fingerprint(
    file: string
  ): Promise<{ identity: string; digest: string } | null> {
    const before = await identity(file);
    if (!before) return null;
    const known = this.digests.get(before);
    if (known) return { identity: before, digest: known };
    // The first requests of a lesson arrive together: one read serves them.
    let pending = this.hashing.get(before);
    if (!pending) {
      pending = this.digest(file, before).finally(() =>
        this.hashing.delete(before)
      );
      this.hashing.set(before, pending);
    }
    const digest = await pending;
    return digest ? { identity: before, digest } : null;
  }

  private async digest(file: string, before: string): Promise<string | null> {
    const sha = crypto.createHash('sha256');
    try {
      for await (const chunk of fsSync.createReadStream(file))
        sha.update(chunk);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    }
    if ((await identity(file)) !== before) return null;
    const digest = sha.digest('hex').slice(0, 32);
    if (this.digests.size >= digestCacheSize) {
      this.digests.delete(this.digests.keys().next().value!);
    }
    this.digests.set(before, digest);
    return digest;
  }

  /** The unpacked folder of `archive`, unpacking it first if need be. */
  private async unpacked(
    request: RawArchiveRequest,
    archive: RawArchive,
    current: RawArchive[],
    retry = true
  ): Promise<string | null> {
    const { contentRoot, contentId } = request;
    const source = path.join(contentRoot, contentId, archive.file);
    const print = await this.fingerprint(source);
    if (!print) return null;
    const base = path.join(rawArchiveCacheRoot(contentRoot), contentId);
    const name = `${hash(archive.file)}-${print.digest}`;
    const target = path.join(base, name);
    if (this.refused.has(target)) return null;
    if (await isDirectory(target)) return target;
    // Shared by the file's identity, not by the folder alone: an unpacking
    // that a save overtakes gives up (the file it read is gone), and a request
    // that came after the save must not wait for that one's verdict.
    const key = `${target}\0${print.identity}`;
    let pending = this.unpacking.get(key);
    if (!pending) {
      pending = this.unpack(request, archive, source, print.identity, target)
        .then(async (done) => {
          if (done) await this.sweep(base, name, current, request.log);
          return done;
        })
        .finally(() => this.unpacking.delete(key));
      this.unpacking.set(key, pending);
    }
    if (await pending) return target;
    // Overtaken by a save: once more with the file now published.
    if (retry && (await identity(source)) !== print.identity) {
      return this.unpacked(request, archive, current, false);
    }
    return null;
  }

  private async unpack(
    request: RawArchiveRequest,
    archive: RawArchive,
    source: string,
    sourceIdentity: string,
    target: string
  ): Promise<boolean> {
    const extensions = new Set(
      [...request.contentWhitelist().split(/\s+/), ...extraExtensions]
        .map((extension) => extension.trim().toLowerCase())
        .filter((extension) => extension && extension !== 'js')
    );
    const staging = path.join(
      path.dirname(target),
      `.staging-${crypto.randomUUID()}`
    );
    await fs.mkdir(staging, { recursive: true });
    try {
      let zip;
      try {
        zip = await yauzl.open(source);
      } catch (error) {
        // The file system's failures are not the archive's: they are not
        // remembered as a refusal. One that vanished under a save is simply
        // not served by this request.
        if (isHostError(error)) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') return false;
          throw error;
        }
        throw new RawArchiveError(
          `not a readable zip archive (${(error as Error).message})`
        );
      }
      let entries = 0;
      let bytes = 0;
      let skipped = 0;
      try {
        await zip.walkEntries(async (entry: RawEntry) => {
          entries += 1;
          if (entries > this.limits.maxEntries) {
            throw new RawArchiveError(
              `more than ${this.limits.maxEntries} entries`
            );
          }
          const name = entry.fileName;
          if (name.endsWith('/')) return;
          if (!acceptedEntry(name, extensions)) {
            skipped += 1;
            return;
          }
          // yauzl checks the bytes it inflates against this declared size
          // (`validateEntrySizes`), so the sum is a bound, not a promise.
          bytes += entry.uncompressedSize;
          if (bytes > this.limits.maxBytes) {
            throw new RawArchiveError(
              `unpacks to more than ${this.limits.maxBytes} bytes`
            );
          }
          const destination = path.join(staging, name);
          // A name given twice, or both as a file and as a folder, keeps
          // what came first: the staging folder is this call's own, so only
          // the archive can have put something there.
          if (
            !isInsideDirectory(staging, name) ||
            !(await freshPath(destination))
          ) {
            skipped += 1;
            return;
          }
          let stream;
          try {
            stream = await entry.openReadStream();
          } catch (error) {
            if (isHostError(error)) throw error;
            throw new RawArchiveError((error as Error).message);
          }
          const file = fsSync.createWriteStream(destination, { flags: 'wx' });
          try {
            await promisepipe(stream, file);
          } catch (error) {
            file.destroy();
            const { source, originalError } = error as StreamError;
            // A write error is this host's (disk full, permissions); one the
            // entry stream raised is the archive's.
            if (source === file || isHostError(originalError)) {
              throw originalError;
            }
            throw new RawArchiveError((error as Error).message);
          }
        });
      } catch (error) {
        if (error instanceof RawArchiveError || isHostError(error)) throw error;
        // yauzl's own refusals while walking: a malformed central directory,
        // an unsafe or invalid entry name.
        throw new RawArchiveError((error as Error).message);
      } finally {
        await zip.close().catch(() => undefined);
      }
      if ((await identity(source)) !== sourceIdentity) {
        // Replaced while it was being read: the next request unpacks the new
        // one under its own key.
        return false;
      }
      try {
        await fs.rename(staging, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Another process published the same key first.
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      }
      if (skipped) {
        request.log.info(
          { contentId: request.contentId, archive: archive.file, skipped },
          'Raw archive entries left out (hidden, unsafe or not allowed)'
        );
      }
      return true;
    } catch (error) {
      if (error instanceof RawArchiveError) {
        // The key names the content that was hashed: a file replaced since
        // is another archive, whose failure says nothing about that one.
        if ((await identity(source)) !== sourceIdentity) return false;
        // Past the bound the oldest refusal is forgotten and read once more.
        if (this.refused.size >= refusedCacheSize) {
          this.refused.delete(this.refused.values().next().value!);
        }
        this.refused.add(target);
        request.log.warn(
          {
            contentId: request.contentId,
            archive: archive.file,
            reason: error.message
          },
          'Raw archive not unpacked; its files answer 404'
        );
        return false;
      }
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Removes the content's folders that no longer belong to an archive its
   * current parameters name, and older unpackings of the archive just
   * unpacked; also stale staging folders a crash left behind.
   */
  private async sweep(
    base: string,
    keep: string,
    current: RawArchive[],
    log: Logger
  ): Promise<void> {
    const prefix = keep.split('-')[0];
    const named = new Set(current.map((archive) => hash(archive.file)));
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === keep) continue;
      const folder = path.join(base, entry.name);
      try {
        if (entry.name.startsWith('.staging-')) {
          const { mtimeMs } = await fs.stat(folder);
          if (Date.now() - mtimeMs < stagingTtlMs) continue;
        } else {
          const owner = entry.name.split('-')[0];
          if (named.has(owner) && owner !== prefix) continue;
        }
        await fs.rm(folder, { recursive: true, force: true });
      } catch (error) {
        log.warn(
          { folder, err: error },
          'Could not remove an outdated raw archive folder'
        );
      }
    }
  }
}
