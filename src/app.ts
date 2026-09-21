import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import { pipeline } from 'stream/promises';
import type { Logger } from 'pino';
import express, { NextFunction, Request, Response } from 'express';
import fileUpload, { UploadedFile } from 'express-fileupload';

import {
  GENERATION_REASON,
  mutateContent,
  withContentLock,
  readOperation,
  acknowledgeOperation,
  pendingOperations,
  listContent
} from './content-transactions';
import envNumber, { editorMaxUploadBytes } from './env';
import HostError, { ContentLockTimeout, mapContentNotFound } from './errors';
import TenantManager, {
  HostTenant,
  distributorIdPattern
} from './tenant-manager';
import resolveLibraries, { containerLibraries } from './library-resolution';
import { directorySize, TempReservations } from './temp-storage';
import {
  assertUploadedImagesSafe,
  assertTemporaryUploadAllowed,
  assertUploadAllowed,
  mayDisplayInline
} from './upload-guard';
import {
  numericContentId,
  assertContentId,
  isSafeH5pSubPath
} from './content-id';
import getUbernameFromH5pJson from './h5p/ubername';
import { contentUserDataStub } from './h5p/user-data-stub';
import { editContent, saveEditorContent } from './routes/content';
import renderContent from './routes/player-html';
import { h5pHostRoutePrefix } from './route-prefix';
import { createLicensesHandler } from './licenses';
import ckeditorSource from '../sources/ckeditor5-source.json';

interface HostRequest extends Request {
  tenant: HostTenant;
  ctx: HostTenant['context'];
  user: HostTenant['user'];
  language: string;
  languages: string[];
  log: Logger;
  /**
   * Epoch ms after which this mutating request gives up, set when it arrived at
   * the per-tenant queue (`tenantLock`). One budget covers the whole wait: the
   * queue and the content lock inside `mutateContent` share it, so a save
   * answers within `H5P_HOST_MUTATION_WAIT_MS` instead of waiting that long in
   * each in turn.
   *
   * The mutating routes consume it: those that go on to `mutateContent`, and
   * `ack`, which takes the content lock too so a prune cannot delete a receipt
   * it is settling. Both thread the remaining budget on so the whole wait stays
   * within `H5P_HOST_MUTATION_WAIT_MS`.
   */
  mutationDeadline?: number;
}

function uploadedFile(req: Request): UploadedFile {
  const candidate = req.files?.file;
  if (!candidate || Array.isArray(candidate)) {
    throw new HostError('Exactly one file is required.', 400);
  }
  return candidate;
}

function uploadedFiles(req: Request): UploadedFile[] {
  return Object.values(
    (req.files || {}) as Record<string, UploadedFile | UploadedFile[]>
  ).flat();
}

/**
 * Runs `done` once the answer is written or the connection is gone, whichever
 * happens first: `close` fires when the response completes and when the socket
 * is dropped, while the wrapped `end` releases as soon as the answer is
 * written, without waiting for the socket. Both fire on a normal response, so
 * the call is made once — which is what lets a caller hand in something that
 * is not a promise resolve.
 */
function whenResponseSettled(res: Response, done: () => void): void {
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    done();
  };
  res.once('close', settle);
  const originalEnd = res.end;
  res.end = function (...args: Parameters<typeof originalEnd>) {
    try {
      return originalEnd.apply(this, args);
    } finally {
      settle();
    }
  } as typeof res.end;
}

function cleanupUpload(req: Request): void {
  const files = uploadedFiles(req);
  files.forEach((file) => {
    if (file.tempFilePath) {
      fs.rm(file.tempFilePath, { force: true }).catch(() => undefined);
    }
  });
}

// The embedder's correlation id, when it sends one; echoed on the response
// and carried by every log line of the request.
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdOf(req: Request): string | undefined {
  const value = req.headers['x-request-id'];
  return typeof value === 'string' && requestIdPattern.test(value)
    ? value
    : undefined;
}

/**
 * The usage reasons an embedder may declare on a mutating request
 * (`X-Usage-Reason`). The value is stored on the operation record and decides
 * how the embedder's own accounting treats the delta, so it is an allowlist,
 * not free text.
 */
const usageReasons = new Set(['rollback']);

function createErrorHandler(baseLog: Logger) {
  return (
    error: Error & { statusCode?: number; httpStatusCode?: number },
    req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    const status = error.statusCode || error.httpStatusCode || 500;
    // A request rejected before its tenant was resolved (bad credentials, a
    // malformed path) has no request logger yet; it is still worth a line.
    const log = (req as HostRequest).log ?? baseLog;
    log.error(
      { err: error, path: req.path, status, requestId: requestIdOf(req) },
      'Editor service request failed'
    );
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(status).json({
      error: status >= 500 ? 'Editor service request failed.' : error.message,
      detail:
        process.env.NODE_ENV === 'development' || status < 500
          ? error.message
          : undefined
    });
  };
}

export { isSafeH5pSubPath };

/**
 * The version of the embedding contract this service implements: the flat
 * save-body shape, the postMessage DTOs, the `X-Distributor-Id` /
 * `X-H5P-Host-Secret` headers, the browser-facing route set and the shape of
 * `/ready`. Reported on `/ready` so an embedder built against another version
 * can refuse to go live instead of failing on the first save.
 */
export const EMBEDDING_CONTRACT_VERSION = 4;
// History: 1 — flat save body, ready/saving/saved/error DTOs; 2 (2026-09-07) —
// the bridge also posts `changed` once the editor has unsaved input, and
// `/ready` reports the provisioned library `bundle`; 3 (2026-09-08) — content
// mutations became journalled transactions with an at-most-once contract:
// request headers `Idempotency-Key`, `If-Match` (the revision),
// `X-Max-Delta-Bytes` and `X-Usage-Reason`; the save/delete responses carry
// `operationId` (and `revision` for a save); `GET …/edit` carries the current
// `revision`; new routes `GET /api/v1/operations/:id`,
// `POST /api/v1/operations/:id/ack` and `GET /api/v1/pending-usage`; the
// browser bridge's `saved` DTO carries `operationId`.

export default function createHostApp(
  appRoot: string,
  log: Logger,
  tenants: TenantManager
): express.Express {
  const app = express();
  const root = express.Router();
  const routePrefix = h5pHostRoutePrefix();
  const sharedSecret =
    process.env.H5P_HOST_SHARED_SECRET ||
    (process.env.NODE_ENV === 'production' ? '' : 'dev-secret');
  if (!sharedSecret) {
    throw new Error('H5P_HOST_SHARED_SECRET is required in production.');
  }
  // The per-tenant staging budget; 0 disables it.
  const maxTempBytes = envNumber('H5P_HOST_MAX_TEMP_BYTES', 1024 * 1024 * 1024);
  const tempReservations = new TempReservations();
  const uploadTmp = tenants.uploadStagingDirectory;

  // Coarse admission for a whole multipart request, above the per-file
  // `EDITOR_MAX_UPLOAD_BYTES` and the per-tenant `H5P_HOST_MAX_TEMP_BYTES`
  // budget. `H5P_HOST_MAX_MULTIPART_BYTES` (0 disables) is checked from
  // Content-Length before anything is written to `tmp/`, so an over-large
  // request is refused without staging any of it; a chunked request that sends
  // no length is bounded only by the per-file limit and must be capped by the
  // reverse proxy. `H5P_HOST_MAX_UPLOAD_FILES` bounds how many files one
  // request may carry — under both byte caps a burst of tiny files still
  // cannot fill the staging directory; H5P uploads one file per request.
  const maxMultipartBytes = envNumber(
    'H5P_HOST_MAX_MULTIPART_BYTES',
    1024 * 1024 * 1024
  );
  const maxUploadFiles = envNumber('H5P_HOST_MAX_UPLOAD_FILES', 64, {
    min: 1
  });

  app.disable('x-powered-by');
  // This service is framed by an embedder, so `frame-ancestors` (not
  // X-Frame-Options, which cannot express an allowlist) decides who may embed
  // it. Default 'self' covers the reverse-proxied, same-origin deployment;
  // point H5P_HOST_ALLOWED_PARENTS at the embedder's origin when the host runs
  // on an origin of its own.
  const allowedParents = (process.env.H5P_HOST_ALLOWED_PARENTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const allowedParentOrigins = new Set(
    allowedParents
      .map((entry) => {
        try {
          return new URL(entry).origin;
        } catch (error) {
          return '';
        }
      })
      .filter(Boolean)
  );
  const frameAncestors = allowedParents.length
    ? allowedParents.join(' ')
    : "'self'";
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      `frame-ancestors ${frameAncestors}`
    );
    next();
  });

  // The readiness answer, in the one shape both routes below give it: the
  // probe's own fields plus the contract version, and 503 while the service
  // cannot actually edit anything.
  async function answerReadiness(res: Response): Promise<void> {
    const { ready, libraryCount, storageWritable, bundle } =
      await tenants.readiness();
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      contractVersion: EMBEDDING_CONTRACT_VERSION,
      libraryCount,
      storageWritable,
      bundle,
      // The origins this service will let frame its editor, so an embedder on
      // a sibling origin can check at boot that it is actually on the list
      // rather than discover the mismatch as a silent handshake timeout in the
      // browser. Already public: every response carries them in
      // `Content-Security-Policy: frame-ancestors`. Empty means `'self'` only.
      allowedParents: [...allowedParentOrigins]
    });
  }

  // Liveness: the process is up. Readiness additionally requires provisioned
  // libraries and writable storage — an editor without libraries can answer
  // requests but cannot edit anything.
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (req, res, next) => {
    try {
      await answerReadiness(res);
    } catch (error) {
      next(error);
    }
  });

  // Reject separators before a content id reaches H5P's filesystem storage.
  app.use((req, res, next) => {
    const rawPath = req.originalUrl.split('?')[0];
    if (
      /%2f|%5c|%00|\\/i.test(rawPath) ||
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(rawPath)
    ) {
      next(new HostError('Invalid request path.', 400));
      return;
    }
    next();
  });

  const expectedSecret = Buffer.from(sharedSecret);
  root.use((req, res, next) => {
    // Dynamic URLs identify content only within the tenant selected by headers.
    // Express routes are case-insensitive, so this policy must be as well.
    if (
      /^\/(?:api(?:\/|$)|editor(?:\/|$)|h5p\/(?:content|temp-files|params|download)(?:\/|$))/i.test(
        req.path
      )
    ) {
      res.setHeader('Cache-Control', 'private, no-store');
    }
    const presented = Buffer.from(
      String(req.headers['x-h5p-host-secret'] || '')
    );
    if (
      presented.length !== expectedSecret.length ||
      !crypto.timingSafeEqual(presented, expectedSecret)
    ) {
      next(new HostError('Invalid host credentials.', 401));
      return;
    }
    next();
  });
  // The authenticated twin of `/ready`, answering from the same projection.
  root.get('/api/v1/readiness', async (req, res, next) => {
    try {
      await answerReadiness(res);
    } catch (error) {
      next(error);
    }
  });
  // Writes this service completed but whose result the embedder may never have
  // seen (its request died in flight). Acknowledging one removes it from this
  // list; see `pruneOperations` for how long records are kept afterwards.
  //
  // `?distributorId=` narrows the answer to one tenant. The embedder settles
  // its own pending writes before admitting a save, and that call should
  // neither walk nor download every other tenant's journal; omitting it keeps
  // the cross-tenant answer the background reconciler wants.
  root.get('/api/v1/pending-usage', async (req, res, next) => {
    try {
      const distributorId = req.query.distributorId;
      if (
        distributorId !== undefined &&
        (typeof distributorId !== 'string' ||
          !distributorIdPattern.test(distributorId))
      ) {
        throw new HostError('Invalid distributor id.', 400);
      }
      const pending = await pendingOperations(
        tenants.dataDirectory,
        distributorId
      );
      res.json({ pending });
    } catch (error) {
      next(error);
    }
  });
  root.use(async (req, res, next) => {
    try {
      const distributorId = String(req.headers['x-distributor-id'] || '');
      if (!distributorIdPattern.test(distributorId)) {
        throw new HostError('Invalid distributor id.', 400);
      }
      const tenant = await tenants.get(distributorId);
      const hostReq = req as HostRequest;
      hostReq.tenant = tenant;
      hostReq.ctx = tenant.context;
      hostReq.user = tenant.user;
      hostReq.language = tenant.context.language_code;
      hostReq.languages = [tenant.context.language_code, 'en'];
      // Tag every log line for this request with its tenant (and the
      // embedder's request id, when it sent one) so multi-tenant logs can be
      // correlated back to one distributor and one browser action.
      const requestId = requestIdOf(req);
      if (requestId) {
        res.setHeader('X-Request-Id', requestId);
      }
      hostReq.log = log.child(
        requestId ? { distributorId, requestId } : { distributorId }
      );
      next();
    } catch (error) {
      next(error);
    }
  });
  // Refuse an over-large multipart request before express-fileupload streams
  // any part of it to the staging directory. Only the total request size is
  // knowable this early (from Content-Length); the per-file size limit and the
  // per-tenant temp budget are enforced once parsing begins. A request with no
  // Content-Length (chunked) cannot be measured here — the reverse proxy must
  // cap the body in that case.
  root.use((req, res, next) => {
    if (maxMultipartBytes > 0) {
      const type = String(req.headers['content-type'] || '').toLowerCase();
      if (type.startsWith('multipart/')) {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxMultipartBytes) {
          next(new HostError('Upload is too large.', 413));
          return;
        }
      }
    }
    next();
  });
  root.use(
    fileUpload({
      useTempFiles: true,
      tempFileDir: uploadTmp,
      limits: { fileSize: editorMaxUploadBytes() },
      abortOnLimit: true
    })
  );
  root.use((req, res, next) => {
    if (req.files) {
      // 'close' fires once the response is complete as well as on a dropped
      // connection (Node >= 16), so this runs per request on keep-alive
      // connections too; the janitor only covers what a crash leaves behind.
      res.once('close', () => cleanupUpload(req));
    }
    next();
  });
  root.use(express.json({ limit: '64mb' }));
  root.use(express.urlencoded({ extended: true, limit: '64mb' }));

  // Reads that span more than one file take the content lock *shared*: the
  // revision is `h5p.json` plus `content.json`, and an export walks the whole
  // directory, so either could otherwise straddle the rename that publishes a
  // save and answer with a mixture of two revisions. Shared holders run
  // concurrently with one another, so the assets of one book are not queued
  // one behind the next; a write waits for them, but only for
  // `H5P_HOST_MUTATION_WAIT_MS`, after which it is answered 503 instead of
  // hanging for as long as a slow client keeps its socket open.
  //
  // Single-file reads under `/h5p/...` deliberately take no lock at all: an
  // open descriptor survives the rename, so a streamed file is consistent on
  // its own, and locking them would serialize every image of a book.
  //
  // The `.../download` export is excluded here and takes its own shared lock
  // (see the route): holding this one for the whole response would keep the
  // lock for as long as the client's download, and a slow client would then
  // block every save of the tenant. The route builds the package under the
  // lock but streams it out from a temp file with the lock already released.
  root.use((req, res, next) => {
    if (
      !['GET', 'HEAD'].includes(req.method) ||
      !/^\/api\/v1\/content\//i.test(req.path) ||
      /^\/api\/v1\/content\/[^/]+\/download$/i.test(req.path)
    ) {
      next();
      return;
    }
    void withContentLock(
      (req as HostRequest).ctx.paths.content,
      () =>
        new Promise<void>((resolve) => {
          if (res.destroyed) {
            resolve();
            return;
          }
          whenResponseSettled(res, resolve);
          next();
        }),
      { mode: 'shared' }
    ).catch(next);
  });
  // One tenant's *mutating* requests run one at a time and in arrival order:
  // the content transaction journal assumes a single writer per tenant
  // (`mutateContent`). This queue is the HTTP-level half of that; the content
  // lock inside `mutateContent` is the half that also excludes the shared
  // readers above and the recovery pass after a crash.
  //
  // The two halves share one deadline: it is set here, when the request
  // arrives, and `mutationOptions` hands the *remaining* budget on to
  // `mutateContent`. Without that a request could wait the whole
  // `H5P_HOST_MUTATION_WAIT_MS` in this queue and then the whole of it again on
  // the lock file — twice as late as the budget names.
  const mutationWaitMs = envNumber('H5P_HOST_MUTATION_WAIT_MS', 30_000);
  const tails = new Map<string, Promise<void>>();
  function tenantLock(req: Request, res: Response, next: NextFunction): void {
    (req as HostRequest).mutationDeadline = Date.now() + mutationWaitMs;
    const key = (req as HostRequest).tenant.distributorId;
    const previous = tails.get(key) || Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    tails.set(key, tail);
    void tail.finally(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });
    // A queue that never drains must not turn into a hanging request: give up
    // the turn after the bounded wait and let the embedder retry.
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), mutationWaitMs);
      timer.unref?.();
    });
    void Promise.race([previous.then(() => 'turn' as const), waited])
      .then((outcome) => {
        clearTimeout(timer);
        if (outcome === 'timeout') {
          // Releasing keeps the queue moving: the requests behind this one
          // still wait for the holder, not for the request that gave up.
          release();
          next(
            new HostError(
              'Another change to this content is still running. Try again.',
              503
            )
          );
          return;
        }
        whenResponseSettled(res, release);
        next();
      })
      .catch(next);
  }
  root.get('/api/v1/operations/:operationId', async (req, res, next) => {
    try {
      const record = await readOperation(
        (req as HostRequest).ctx.paths.content,
        req.params.operationId
      );
      if (!record || record.state !== 'done') {
        throw new HostError('Operation not found.', 404);
      }
      res.json(record.result);
    } catch (error) {
      next(error);
    }
  });
  root.post(
    '/api/v1/operations/:operationId/ack',
    tenantLock,
    async (req, res, next) => {
      try {
        const hostReq = req as HostRequest;
        const content = hostReq.ctx.paths.content;
        // The read and the acknowledgement run under the content lock — the one
        // the journal janitor prunes settled receipts under. A completed
        // generation write expires by age (see `pruneOperations`), so without
        // the lock a prune could delete the directory in the window between this
        // call reading the record, rewriting it as acknowledged and moving it
        // into `acked/`: the ack would answer `ok` with the receipt gone, and a
        // replayed idempotency key would then write the content a second time.
        // The queue and the lock draw on one budget, as a save does — see
        // `mutationDeadline`; a budget already spent is a 503, not the "no
        // limit" a non-positive `waitMs` would mean to `withContentLock`.
        const remaining =
          hostReq.mutationDeadline === undefined
            ? undefined
            : hostReq.mutationDeadline - Date.now();
        if (remaining !== undefined && remaining <= 0) {
          throw new ContentLockTimeout();
        }
        await withContentLock(
          content,
          async () => {
            const record = await readOperation(content, req.params.operationId);
            // Mirrors the read route: a record that is still `prepared` has not
            // been completed, so there is nothing an embedder could have
            // accounted for yet.
            if (!record || record.state !== 'done') {
              throw new HostError('Operation not found.', 404);
            }
            await acknowledgeOperation(
              content,
              req.params.operationId,
              record,
              hostReq.log
            );
          },
          { waitMs: remaining }
        );
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    }
  );
  function mutationOptions(req: Request, reason: string) {
    const rawLimit = req.get('x-max-delta-bytes');
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new HostError('Invalid byte allowance.', 400);
    }
    // What is left of the budget `tenantLock` started when the request
    // arrived. `mutateContent` treats a value that has already run out as an
    // immediate 503, so the whole acquisition stays inside one wait.
    const deadline = (req as HostRequest).mutationDeadline;
    return {
      root: (req as HostRequest).ctx.paths.content,
      reason,
      operationId: req.get('idempotency-key'),
      revision: req.get('if-match')?.replace(/^"|"$/g, ''),
      maxDeltaBytes: limit,
      waitMs: deadline === undefined ? undefined : deadline - Date.now()
    };
  }

  /** The declared usage reason of a mutating request, validated. */
  function usageReason(req: Request): string | undefined {
    const raw = req.get('x-usage-reason');
    if (raw === undefined) {
      return undefined;
    }
    if (!usageReasons.has(raw)) {
      throw new HostError('Unknown usage reason.', 400);
    }
    return raw;
  }

  // Include API uploads as well as the editor AJAX route. Reserve incoming
  // bytes before measuring so concurrent requests cannot all use the same free
  // space; the budget is fixed at reservation time (see TempReservations), so
  // a later arrival never counts against an earlier request. The directory is
  // measured only while no upload is in flight: an earlier upload is counted
  // by its reservation alone, whether its bytes are still on their way to
  // `tmp/` or already there, never by both. This remains a burst guard: H5P
  // adds metadata and may unpack files.
  root.use(
    ['/h5p', '/api/v1/temporary-files', '/api/v1/import/h5p'],
    async (req, res, next) => {
      const files = uploadedFiles(req);
      // A file count is not in the request headers, so this is enforced after
      // parsing — but under the byte caps above, so the staging a rejected
      // request occupies is bounded, and the staged files are removed when the
      // response closes (the cleanup handler registered above).
      if (files.length > maxUploadFiles) {
        next(
          new HostError(
            `A request may carry at most ${maxUploadFiles} file${
              maxUploadFiles === 1 ? '' : 's'
            }.`,
            413
          )
        );
        return;
      }
      if (maxTempBytes <= 0 || files.length === 0) {
        next();
        return;
      }
      const hostReq = req as HostRequest;
      const incoming = files.reduce((total, file) => total + file.size, 0);
      const reservation = tempReservations.reserve(
        hostReq.tenant.distributorId,
        incoming
      );
      res.once('finish', reservation.release);
      res.once('close', reservation.release);
      try {
        const used = await tempReservations.used(
          hostReq.tenant.distributorId,
          () => directorySize(hostReq.ctx.paths.tmp)
        );
        if (used + reservation.budget > maxTempBytes) {
          throw new HostError(
            'Temporary storage is full. Save or discard the current draft and try again.',
            413
          );
        }
        // A client gone mid-scan has already released; do not start H5P work
        // for it.
        if (!res.destroyed) next();
      } catch (error) {
        reservation.release();
        next(error);
      }
    }
  );

  root.get('/editor/:contentId', (req, res, next) => {
    try {
      assertContentId(req.params.contentId, { creatable: true });
      // The page echoes `parentOrigin` back as its postMessage target, so a
      // caller-chosen value would decide who receives the editor's status
      // messages. With no allowlist configured the deployment is the
      // same-origin proxied one and `frame-ancestors 'self'` already prevents a
      // foreign page from framing this; when an allowlist IS configured, the
      // requested parent must be on it.
      const requested = req.query.parentOrigin;
      if (typeof requested === 'string' && allowedParentOrigins.size > 0) {
        let origin = '';
        try {
          origin = new URL(requested).origin;
        } catch (error) {
          origin = '';
        }
        if (!allowedParentOrigins.has(origin)) {
          throw new HostError('Parent origin is not allowed.', 400);
        }
      }
    } catch (error) {
      next(error);
      return;
    }
    res.sendFile(path.join(appRoot, 'web/editor-host.html'));
  });
  // The notices the editor UI links to: what GPL code this page ships to the
  // browser, at which version, and where its corresponding source is. HTML
  // for people, the Markdown source on request (`?format=md`).
  root.get('/licenses', createLicensesHandler(appRoot));
  // Only explicitly pinned source files are exposed. A developer running npm
  // inside sources/ must not accidentally publish node_modules or build output.
  // One route over a fixed set rather than one route per file: the set decides
  // what is served, so a name in the manifest can never widen the surface.
  const sourceDocuments = new Set([
    'COPYING',
    'docs/CKEDITOR_SOURCE.md',
    'sources/ckeditor5-source.json',
    ...Object.keys(ckeditorSource.sourceFiles).map(
      (name) => `sources/ckeditor5/${name}`
    )
  ]);
  root.get(/^\/(COPYING|docs\/.+|sources\/.+)$/, (req, res, next) => {
    const file = req.path.slice(1);
    if (!sourceDocuments.has(file)) {
      next(new HostError('Not found.', 404));
      return;
    }
    // The corresponding source is an obligation, so a deployment that shipped
    // without it has to say so rather than answer with a stack trace.
    res.type('text/plain').sendFile(path.join(appRoot, file), (error) => {
      if (!error) return;
      next(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new HostError(
              `${file} is not present in this deployment. Ship the repository's ` +
                'COPYING, docs/ and sources/ directories alongside build/.',
              404
            )
          : error
      );
    });
  });
  root.use('/web', express.static(path.join(appRoot, 'web')));

  root.get('/api/v1/contents', async (req, res, next) => {
    try {
      res.json({
        content: await listContent((req as HostRequest).ctx.paths.content)
      });
    } catch (error) {
      next(error);
    }
  });

  root.post('/api/v1/libraries/resolve', async (req, res, next) => {
    try {
      const machineNames = Array.isArray(req.body?.machineNames)
        ? req.body.machineNames.filter(
            (name: unknown) => typeof name === 'string'
          )
        : [];
      if (machineNames.length === 0 || machineNames.length > 256) {
        throw new HostError('machineNames must be a non-empty array.', 400);
      }
      const hostReq = req as HostRequest;
      res.json({
        libraries: await resolveLibraries(
          hostReq.ctx.h5pEditor,
          machineNames as string[]
        )
      });
    } catch (error) {
      next(error);
    }
  });

  root.post('/api/v1/libraries/capabilities', async (req, res, next) => {
    try {
      if (typeof req.body?.library !== 'string') {
        throw new HostError('Library is required.', 400);
      }
      res.json({
        allowed: await containerLibraries(
          (req as HostRequest).ctx.h5pEditor,
          req.body.library
        )
      });
    } catch (error) {
      next(error);
    }
  });

  root.post('/api/v1/temporary-files', async (req, res, next) => {
    try {
      const file = uploadedFile(req);
      assertTemporaryUploadAllowed(file);
      const hostReq = req as HostRequest;
      const source = file.tempFilePath
        ? fsSync.createReadStream(file.tempFilePath)
        : file.data;
      const stored = await hostReq.ctx.h5pEditor.temporaryFileManager.addFile(
        path.basename(file.name),
        source,
        hostReq.user
      );
      res.status(201).json({ path: `${stored}#tmp` });
    } catch (error) {
      next(error);
    }
  });

  root.post('/api/v1/generated-content', tenantLock, async (req, res, next) => {
    try {
      const hostReq = req as HostRequest;
      usageReason(req);
      const result = await mutateContent({
        ...mutationOptions(req, GENERATION_REASON),
        fingerprint: req.body,
        save: () =>
          saveEditorContent(hostReq.ctx, hostReq.user, 'new', req.body)
      });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  root.post('/api/v1/import/h5p', tenantLock, async (req, res, next) => {
    try {
      const file = uploadedFile(req);
      if (!/\.h5p$/i.test(file.name)) {
        throw new HostError('Only .h5p files are accepted.', 415);
      }
      const hostReq = req as HostRequest;
      usageReason(req);
      const hash = crypto.createHash('sha256');
      if (file.tempFilePath) {
        for await (const chunk of fsSync.createReadStream(file.tempFilePath)) {
          hash.update(chunk);
        }
      } else {
        hash.update(file.data);
      }
      const result = await mutateContent({
        ...mutationOptions(req, 'h5p-import'),
        fingerprint: hash.digest('hex'),
        save: async () => {
          const { metadata, parameters } =
            await hostReq.ctx.h5pEditor.uploadPackage(
              file.data?.length ? file.data : file.tempFilePath,
              hostReq.user
            );
          const library = getUbernameFromH5pJson(metadata);
          if (!library) {
            throw new HostError(
              'The uploaded package does not declare a resolvable main library.',
              400
            );
          }
          return saveEditorContent(hostReq.ctx, hostReq.user, 'new', {
            library,
            params: parameters,
            metadata
          });
        }
      });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  root.get('/api/v1/content/:contentId/download', async (req, res, next) => {
    const hostReq = req as HostRequest;
    let tempFile: string | undefined = path.join(
      os.tmpdir(),
      `h5p-export-${crypto.randomUUID()}.h5p`
    );
    try {
      assertContentId(req.params.contentId);
      const contentId = req.params.contentId;
      // Build the package under a *shared* content lock — an export walks the
      // whole content directory, so it must not straddle the rename that
      // publishes a save — but only for as long as the bytes take to reach a
      // local temp file, never for as long as the client takes to download
      // them. `exportContent` resolves before its pipe finishes (see
      // PackageExporter), so the write stream's `finish` is the true end of
      // the build, and the lock is held until then. The cost is one export's
      // worth of temp disk in exchange for saves that a slow download can no
      // longer block.
      const filename = await withContentLock(
        hostReq.ctx.paths.content,
        async () => {
          const content = await hostReq.ctx.h5pEditor.getContent(
            contentId,
            hostReq.user
          );
          const out = fsSync.createWriteStream(tempFile!);
          const written = new Promise<void>((resolve, reject) => {
            out.once('finish', resolve);
            out.once('error', reject);
          });
          try {
            await hostReq.ctx.h5pEditor.exportContent(
              contentId,
              out,
              hostReq.user
            );
            await written;
          } catch (error) {
            out.destroy();
            throw error;
          }
          return `${String(content.h5p.title || 'interactive-book')
            .replace(/[^A-Za-z0-9._-]+/g, '-')
            .slice(0, 100)}.h5p`;
        },
        { mode: 'shared' }
      );
      // The lock is gone; hand ownership of the temp file to the response and
      // remove it once the download completes or the client drops.
      const file = tempFile;
      tempFile = undefined;
      res.once('close', () => {
        fs.rm(file, { force: true }).catch(() => undefined);
      });
      res.attachment(filename);
      res.setHeader('Content-Length', (await fs.stat(file)).size);
      await pipeline(fsSync.createReadStream(file), res);
    } catch (error) {
      if (tempFile)
        await fs.rm(tempFile, { force: true }).catch(() => undefined);
      next(mapContentNotFound(error));
    }
  });

  root.delete(
    '/api/v1/content/:contentId',
    tenantLock,
    async (req, res, next) => {
      try {
        assertContentId(req.params.contentId);
        // Undoing a generation the embedder is about to charge back is booked
        // against that generation, not as a separate deletion.
        const reason =
          usageReason(req) === 'rollback'
            ? GENERATION_REASON
            : 'content-delete';
        res.json(
          await mutateContent({
            ...mutationOptions(req, reason),
            id: req.params.contentId,
            fingerprint: null,
            deleted: true,
            save: async () => ({ contentId: req.params.contentId })
          })
        );
      } catch (error) {
        next(mapContentNotFound(error));
      }
    }
  );

  root.use(editContent);
  // The editor save, with the size accounting the embedder charges to its
  // quota: the content directory is measured before and after the write and
  // the response carries `savedBytes` and the signed `deltaBytes`, alongside
  // the `operationId` and the new `revision` of contract version 3.
  root.patch(
    '/api/v1/content/:contentId',
    tenantLock,
    async (req, res, next) => {
      try {
        assertContentId(req.params.contentId, { creatable: true });
        const hostReq = req as HostRequest;
        usageReason(req);
        const result = await mutateContent({
          ...mutationOptions(req, 'editor-save'),
          id: numericContentId.test(req.params.contentId)
            ? req.params.contentId
            : undefined,
          fingerprint: req.body,
          save: () =>
            saveEditorContent(
              hostReq.ctx,
              hostReq.user,
              req.params.contentId,
              req.body
            )
        });
        res.json(result);
      } catch (error) {
        next(mapContentNotFound(error));
      }
    }
  );
  root.use(renderContent);
  root.use('/h5p', (req, res, next) => {
    if (!isSafeH5pSubPath(req.path)) {
      next(new HostError('Invalid content id.', 400));
      return;
    }
    // These are user-controlled files, including files uploaded before the
    // current validation policy. Apply the same policy to full and Range
    // responses. Never apply this sandbox to the trusted editor/library JS.
    const file = /^\/(?:content\/\d+|temp-files)\/(.+)$/i.exec(req.path);
    if (file) {
      let filename: string;
      try {
        filename = decodeURIComponent(file[1]);
      } catch {
        next(new HostError('Invalid request path.', 400));
        return;
      }
      res.setHeader(
        'Content-Security-Policy',
        `sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors ${frameAncestors}`
      );
      if (!mayDisplayInline(filename)) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    }
    next();
  });
  // h5p-server measures every image upload with `image-size`, whose ICNS,
  // JPEG XL and HEIF parsers can be looped forever by a crafted file (see
  // upload-guard.ts); refuse those before the GPL router ever sees them. The
  // editor's own uploads land here too, so they answer to the same rule about
  // HTML and scripts as `/api/v1/temporary-files`.
  root.use('/h5p', async (req, res, next) => {
    try {
      if (req.files) {
        const files = uploadedFiles(req);
        assertUploadAllowed(files);
        await assertUploadedImagesSafe(files);
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  // No per-viewer state is kept, and h5p-express answers its state route with
  // an empty 403 in that case; the editor core asks anyway (user-data-stub.ts).
  root.use('/h5p/contentUserData', contentUserDataStub());
  // These AJAX actions are the only routes in the bundled adapter that can
  // contact the remote catalogue directly. They are rejected before the
  // third-party router, so a crafted request cannot bypass the offline UI.
  const remoteCatalogueActions = new Set([
    'content-hub-metadata-cache',
    'library-install',
    'get-content'
  ]);
  root.use('/h5p', (req, res, next) => {
    const action = typeof req.query.action === 'string' ? req.query.action : '';
    if (
      /^\/ajax\/?$/i.test(req.path) &&
      remoteCatalogueActions.has(action.toLowerCase())
    ) {
      next(new HostError('External content catalogue is disabled.', 404));
      return;
    }
    next();
  });
  root.use('/h5p', (req, res, next) => {
    (req as HostRequest).tenant.h5pRouter(req, res, next);
  });

  app.use(routePrefix, root);
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(createErrorHandler(log));
  return app;
}
