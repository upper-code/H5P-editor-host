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
`params.params`. `src/save-payload.ts` checks the top-level shape (a library
string, `params` and `metadata` objects) and the nesting depth, and answers
`400` before h5p-server is called. It cannot reject a nested `params.params`
by itself: a content type may well have a field named `params`, so the
producers must keep that rule. Producers are the editor bridge
(`web/editor-host.js`) and the embedder's own content generator.

**Revisit when** a new producer or consumer appears. Any change to the shape
is a contract change (see [DEVELOPMENT.md](DEVELOPMENT.md#changing-the-embedding-contract)).

### Temporary storage is measured by walking the directory

`directorySize` (`src/temp-storage.ts`) is a recursive `O(files)` walk on hot
paths: temporary uploads under `H5P_HOST_MAX_TEMP_BYTES`, and the byte delta
of every content mutation (`src/content-transactions.ts`). Within one
process the count is consistent — incoming bytes are reserved
(`TempReservations`), the walk runs only with nothing in flight, and a file
vanishing mid-walk is skipped. What remains is by design: the reservations
live in that process's memory, so two processes accepting uploads for one
tenant on a shared volume do not see each other's in-flight bytes; the cap is
per tenant (N tenants may stage N × cap); and it is a burst guard rather than
a quota (multipart data is staged before the check; unpacking and metadata
add bytes after it).

**Revisit when** profiling shows the walk is hot, aggregate staging threatens
the disk, or several processes accept uploads for the same tenants at once
(the counter below would then need cross-process coordination too). Then
keep an in-memory per-tenant byte counter (added on upload, resynchronised by
the janitor sweep) and sum it for an aggregate cap.
Do not build incremental accounting into the content save itself: it would
couple to h5p-server's write internals. A directory-mtime cache does not work
(a growing file does not change its directory's mtime).

### Distributor ids are case-sensitive

The host keys tenants by the `X-Distributor-Id` string exactly as received.
The embedder passes through an id minted by its own identity source, and uses
the same string for its quota accounting, so lower-casing it here alone would
split one distributor's content from its quota.

A data directory on a case-insensitive filesystem would still resolve two
spellings of one id to one directory, so there the host serves an id only
under the spelling its directory was created with and answers `409` to the
other (`TenantManager.ownsTenantDirectory`).

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
h5p-server adds the file. If h5p-server ships it, upgrading is enough. Until
then, commit a `client/ru.json` to the repository and have the backend's
`loadPath` (a single path template today; i18next-fs-backend also accepts a
function) resolve that one namespace and language to the committed file,
everything else to h5p-server's translations; drop the copy once h5p-server
ships its own.

### Save, import and render are synchronous

Each endpoint answers within its own HTTP request; the host has no job or
polling API. Long-running work (generating a book) is queued by the embedder,
which calls the host only for the short final steps. The one host-side step
that can run long, unpacking an imported package, has a backstop:
`H5P_HOST_IMPORT_TIMEOUT_MS` bounds only the wait for h5p-server's
`uploadPackage`, so the request fails and the content lock is released. It
does not bound the whole request — hashing the upload comes before it, the
save after it — nor cancel the unpacking, which keeps running; should it
finish, its files land in the tenant's temporary storage and expire unused
(see the comment above `importTimeoutMs` in `src/app.ts`).

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

### Indexed access is not checked by the compiler

`tsconfig.json` sets `strict` but not `noUncheckedIndexedAccess`. Checked
2026-10-10: each of its 27 reports in `src/` was an index that cannot be
missing — `split(...)[0]`, a bounds-checked loop, a group of a regular
expression that matched, a parameter the route itself declares — so the
flag would add assertions, not catch bugs.

**Revisit when** `src/` starts indexing data whose shape it does not control
(parsed packages, request bodies) without validating it first.

### The framing parent controls the book

On the framed player page `web/player-bridge.js` adds the parent's origin to a
VMB.InteractiveBook's `behaviour.remoteOrigins`, and takes plain exam media
from the parent (`exam-media`). Through the book's `injectExam` and through
`exam-media` the parent can therefore render any chapter (HTML text
included) and any bytes on the host's origin. That is the purpose, not a side
effect: the parent shows a decrypted exam the host never sees. It is
acceptable because the parent is already trusted — it must be in
`H5P_HOST_ALLOWED_PARENTS`, and it drives the editor on the same origin
anyway. Without that allowlist `frame-ancestors 'self'` keeps a foreign page
from framing the player, and the book's own `isSenderTrusted` refuses any
sender that is not an ancestor of the frame.

**Revisit when** a parent that is not trusted with the host's origin may frame
the player page (a public embed, a third-party allowlist entry). Then the
book channel needs its own opt-in per parent, and `exam-media` a check of
what it serves (types, sizes) or a separate origin for the player.

### Exam packages are kept whole

A package with a root `vmbExam` keeps every file of its `content/` and the
dependencies its `h5p.json` declares (`src/h5p/exam-package.ts`), although
the open parameters reference only part of them. The host cannot see what
the encrypted chapter references, so it keeps everything that chapter might
use. The cost is quota for files nothing uses, and every declared library's
whole tree loaded by the player page. A content upgrade does not rewrite the
ciphertext either: a conflict it causes is refused with
`exam-library-conflict`, and the backend re-publishes the exam. Only a
conflict between the open part and what the exam adds is refused; two
versions within either alone are ordinary H5P and stay.

The editor's "Upload" tab does not know this mode: it keeps only what the
open part references, as for any package. Whether the exam's files exist
cannot tell such a save apart — a new publication may reuse the old names
with new ciphertext — so a save that does not come from an import must carry
the stored `vmbExam` unchanged (`exam-import-required`), and the files of
`vmbExam.media` must be stored (`exam-media-missing`).

**Revisit when** the publisher sends an open manifest of the libraries and
files the exam chapter uses: then only those need keeping.

### Exam media are substituted only through `H5P.getPath`

The player bridge maps the exam's own files to blob URLs of the parent's
plain bytes in `H5P.getPath` (`web/player-bridge.js`), where the standard
libraries resolve content files. A library that builds a file URL by itself
gets the ciphertext; one that resolves relative links against the address of
a file it loaded gets nothing for them: `VMB.SyncLesson` 1.4 loads an HTML
file from the content, and when that file is exam media its address is a
`blob:` URL, against which a `./x` link to a neighbouring file does not
resolve. The parameters cannot carry the blob URLs instead: the core's
`hasProtocol` does not take `blob:` for a protocol.

**Revisit when** an exam needs such a library: the bridge would then have to
serve the plain files under their own paths (a service worker, or a route
the parent fills), so relative links keep resolving.

## Looks like a bug, is not

Host code — each has a comment at the spot:

- `TenantManager.get` cannot construct one tenant twice: nothing between the
  cache lookups and `pendingTenants.set` awaits.
- The secret check compares lengths before `crypto.timingSafeEqual`, which
  throws on unequal lengths; only the length is revealed.
- Browser requests carry neither `X-H5P-Host-Secret` nor `X-Distributor-Id`
  (`web/editor-host.js`): the embedder's proxy adds both, replacing any value
  a browser sent.
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
- The player bridge does not revoke the blob URLs of a replaced `exam-media`
  set, only all of them on an unload that does not enter the back/forward
  cache: library instances may still hold the old URLs, and a repeated
  `injectExam` of the same run rebuilds nothing. `exam-cipher` downloads
  through the core's unwrapped `H5P.getPath` on purpose, so it reads the
  stored ciphertext even after plain media are mapped.
- `watchEditorInput` (`web/editor-host.js`) binds on every form-iframe
  load without an "already bound" mark: each load brings a document the
  bridge has not bound (a reload starts a new one; `document.open()` drops
  the listeners of the one it reuses). A doubled listener would only add
  two to `editVersion` within one dispatch, so a save's `submittedVersion`
  holds both increments or neither.
- The editor bridge has no deadline of its own before the form iframe loads
  (`bootstrap` in `web/editor-host.js`): a hung edit-model request or script
  leaves it `loading`, and a `save` is refused as not ready. The embedder
  needs a handshake timeout anyway — a host that is down sends no message at
  all — and that timeout covers this case.
- The media of an exam package keep their packaged names, and files no open
  parameter references stay stored (`src/h5p/exam-package.ts`): the
  encrypted chapter names them by those paths. An editor save of exam
  content deletes no files on purpose; only a new version of the package
  does.
- The editor page's check that the upgrade left no listed version in place
  (`runUpgrade` in `web/editor-host.js`) skips `not-accepted` entries of
  `missingLibraries`: such a version may legitimately stay in another field
  of the container that still lists it, and the core's upgrade moves or
  refuses every occurrence in a field that does not — it enters each
  container that nests a library, the same-version ones included (patch
  0003).
- Provisioning refuses a replacement copy whose library field disappeared
  or was renamed (`scripts/provision-libraries.mjs`), although the editor
  only stops showing such a field: the script cannot tell what stored
  content still holds under it, and `--allow-dropped-options` exists for a
  reviewed change.
- The pages' CSP says `base-uri 'self'`, not `'none'` (`src/app.ts`): the
  core's jQuery 3.5 `parseHTML` sets a `<base href>` with the page's own URL
  on its scratch document, and `'none'` logs a violation for every call
  (`test/browser/core-runtime.test.js` checks both). `'self'` still refuses
  a base on another origin. Revisit after a jQuery upgrade: that test fails
  once `'none'` no longer trips.

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
- i18next resolves `init` even when a translation file cannot be read, and
  the strings then render as bare keys; `src/h5p/i18n.ts` therefore refuses
  to start without the English files (`test/i18n.test.js`). h5p-server ships
  none for `library-metadata` on purpose: that namespace translates library
  titles out of English.
- Upstream h5p-php-library (master, checked 2026-10-09) still compares minor
  versions without the major in `processParams` and does not descend into a
  container whose version is unchanged; core patch `0003` stays until
  upstream fixes both.
