# Design decisions

Limits this host accepts on purpose, and behaviour that looks like a bug but
is not. Each decision names the condition under which it should be revisited:
before "fixing" one, check whether that condition holds. Facts about upstream
code were checked against the versions in `package-lock.json` and the
committed `assets/h5p`; re-check them after an upgrade.

## Accepted limits

### The number of tenants on disk is unbounded

Every new `X-Distributor-Id` creates a tenant directory (content, journal,
locks) and an editor/player pair (`src/tenant-manager.ts`). Built editors are
an LRU cache (`H5P_HOST_TENANT_CACHE_MAX`), concurrent constructions are
capped (`H5P_HOST_TENANT_INIT_MAX`, `503 tenant-busy` beyond it), and eviction
drops only the cache entry — the directory holds saved content and stays.
This is acceptable because every request needs the shared secret and an id
matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, and only the embedder's trusted
proxy reaches the host, so tenant creation is not open to anonymous callers.

**Revisit when** the host is reachable by anything other than one trusted
proxy, ids become attacker-influenced, or creating a tenant gets expensive.
Then add a tenant registry or a storage quota with its own retention policy
for directories — never tie deletion to cache eviction.

### One flat save body

Both save endpoints (`PATCH /api/v1/content/:id` and
`POST /api/v1/generated-content`) take `{ library, params, metadata }`, with
`params` holding the content parameters directly, never a nested
`params.params`. `src/save-payload.ts` validates it and answers `400` before
h5p-server is called. Producers are the editor bridge (`web/editor-host.js`)
and the embedder's own content generator.

**Revisit when** a new producer or consumer appears. Any change to the shape
is a contract change (see [DEVELOPMENT.md](DEVELOPMENT.md#changing-the-embedding-contract)).

### Temporary storage is measured by walking the directory

`directorySize` (`src/temp-storage.ts`) is a recursive `O(files)` walk on hot
paths: temporary uploads under `H5P_HOST_MAX_TEMP_BYTES`, and the byte delta
of every content mutation (`src/content-transactions.ts`). Correctness is
covered — incoming bytes are reserved (`TempReservations`), the walk runs
only with nothing in flight, and a file vanishing mid-walk is skipped. What
remains is by design: the cap is per tenant (N tenants may stage N × cap) and
a burst guard rather than a quota (multipart data is staged before the check;
unpacking and metadata add bytes after it).

**Revisit when** profiling shows the walk is hot, or aggregate staging
threatens the disk. Then keep an in-memory per-tenant byte counter (added on
upload, resynchronised by the janitor sweep) and sum it for an aggregate cap.
Do not build incremental accounting into the content save itself: it would
couple to h5p-server's write internals. A directory-mtime cache does not work
(a growing file does not change its directory's mtime).

### Distributor ids are case-sensitive

The host keys tenants by the `X-Distributor-Id` string exactly as received.
The embedder passes through an id minted by its own identity source, and uses
the same string for its quota accounting, so lower-casing it here alone would
split one distributor's content from its quota.

**Revisit when** the id source stops producing case-stable ids. Normalise at
the source (the embedder's resolver), not only in the host; the host may then
additionally reject an unexpected case.

### The image-size DoS fix is maintained locally

h5p-server measures every image upload with `image-size`, whose ICNS
(GHSA-w3rx-r6r6-pgpr) and JXL/HEIF (GHSA-5p2g-fcmc-qvqq) parsers loop forever
on a crafted file. The host pins `image-size` 1.2.1 through `overrides`,
patches it in `postinstall` (`scripts/patch-image-size.mjs`), refuses to start
on an unpatched copy (`src/image-size-patch.ts`) and rejects the three
signatures with `415` before the upload reaches h5p-server
(`src/upload-guard.ts`). `npm run audit:ci` allows exactly these two
advisories until the expiry date in `scripts/audit-allowlist.mjs`.

`image-size` 2.0.3 fixes both advisories, but there is no fixed 1.x release,
and h5p-server (9.3.3, and 10.x as well) depends on `^1.0.2` and calls the
1.x default export synchronously with a buffer or a temporary file path. The
2.x API differs, so raising the override alone would break image uploads.

**Revisit when** a fixed 1.x release appears, h5p-server moves to 2.x, or a
compatibility adapter around 2.x is adopted — and before the allowlist
expires. Retirement steps are in
[DEVELOPMENT.md](DEVELOPMENT.md#the-image-size-fix).

### Russian player strings fall back to English

`EDITOR_LANGUAGE=ru` localises the editor, but h5p-server ships no
`client/ru.json` (about 160 strings of player chrome: fullscreen, download,
copyright, embed), so with `fallbackLng: 'en'` (`src/h5p/i18n.ts`) that part
of the player stays English. Acceptable while Russian deployments give their
authors the editor rather than end users the player.

**Revisit when** a Russian deployment serves the player to end users, or
h5p-server adds the file. Vendor the translation into the `loadPath` ahead of
the package's own.

### Save, import and render are synchronous

Each endpoint answers within its own HTTP request; the host has no job or
polling API. Long-running work (generating a book) is queued by the embedder,
which calls the host only for the short final steps. The one host-side step
that can run long, unpacking an imported package, is bounded by
`H5P_HOST_IMPORT_TIMEOUT_MS`.

**Revisit when** a host operation itself outgrows the embedder's proxy
timeout (upgrading content types across a tenant, importing hundreds of
megabytes of media). Then add an explicit job endpoint for that operation,
not a general job system.

### Operation receipts outlive their requests

A completed mutation keeps its receipt (fingerprint and result) so that a
late retry or a recovered embedder job gets the first answer instead of
writing twice or losing a charge. Unacknowledged receipts are never removed
by age; acknowledged ones move to `operations/acked/` and are deleted after
`H5P_HOST_OPERATION_RETENTION_MS` (`pruneOperations` describes the one
exception, generation writes). Back up `tenants/*/operations/` consistently
with the embedder's own job and usage records, and watch its size.

## Looks like a bug, is not

Host code — each has a comment at the spot:

- `TenantManager.get` cannot construct one tenant twice: nothing between the
  cache lookups and `pendingTenants.set` awaits.
- The secret check compares lengths before `crypto.timingSafeEqual`, which
  throws on unequal lengths; only the length is revealed.
- Browser requests carry neither `X-H5P-Host-Secret` nor `X-Distributor-Id`
  (`web/editor-host.js`): the embedder's proxy adds both.
- Upload cleanup on `res.once('close')` runs per request on keep-alive
  connections too (`close` fires after every response, not only on a
  dropped connection).
- The `Promise.race` that bounds a package import handles a late rejection
  of the abandoned `uploadPackage`; the abandoned import keeps running on
  purpose.
- The `openReadStream` wrapper in `src/zip-stream-patch.ts` reports one
  `error`, not two: yauzl's own listeners drop the inner stream's error.
- The lock heartbeat (`fs.utimes`, `src/process-lock.ts`) is not fsynced:
  other users of the mount see the new mtime without it, a crashed owner's
  lock is meant to go stale, and a local owner is judged by its pid.
- `acquireShared` checks for a writer, marks itself, then checks again: that
  is the protocol ("mark first, then look again"), not a duplicate.
- Reads under `/api/v1/content/…` and `/h5p/params/…` hold the shared
  content lock in the middleware of `src/app.ts`; the download route takes
  its own.
- A content upgrade that loses its race against `UPGRADE_TIMEOUT_MS` keeps
  running unobserved; its result is discarded and the next click starts a
  fresh run.
- The player bridge's `player-error` check after document ready cannot fire
  early: `H5P.init` triggers `initialized` synchronously.

Upstream behaviour the host relies on:

- h5p-server's `ContentFileScanner` strips the `#tmp` suffix from file
  references, so a missing temporary file is reported by its plain name.
- The library storage is wrapped in h5p-server's `CachedLibraryStorage`
  (`src/h5p/editor.ts`), so installed-library listings on every edit page
  are cached, not read from disk.
- `H5P.ContentUpgradeProcess` parses the parameters with `JSON.parse` before
  `upgrade()` runs, so everything below works on objects, not strings, and
  the tree has no cycles.
- The core's `processField` walks `list` fields item by item, so a list of
  `library` fields is upgraded too.
- h5p-server's `getLibraryData` answers with `name` (the machine name), not
  `machineName`.
- Upstream h5p-php-library (master, checked 2026-10-09) still compares minor
  versions without the major in `processParams` and does not descend into a
  container whose version is unchanged; core patch `0003` stays until
  upstream fixes both.
