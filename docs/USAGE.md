# Using the H5P Editor Host

This guide covers how to embed the host, provision its libraries, configure it
and deploy it.

The host is meant to run behind a surrounding application that supplies
authentication, the user-facing interface and a reverse proxy in front of the
API. Throughout this repository that surrounding application is called
**Shelf** — a placeholder name used for illustration, not a real product.
Replace it with your own editor application.

## Embedding the host in a Shelf

Shelf loads the editor page in an `<iframe>` and reverse-proxies the
`/h5p-editor-core/*` namespace to the host. The host manages the
H5P runtime and storage; Shelf provides authentication and the surrounding
interface:

- the H5P browser runtime is initialized by the editor page;
- the iframe and Shelf (the parent page) exchange `postMessage` events
  (`ready` / `changed` / `saving` / `saved` / `error`, and an inbound `save`;
  `changed` is posted once per dirty period when the editor holds unsaved
  input, so Shelf can warn before its page is left — it carries no content);
- `ready` (`{ contentId }`) means the editor form itself is usable, not just
  that its runtime scripts loaded: the content-type list has resolved and, for
  content that already names one, that type's semantics have too. `save()`
  refuses (an `error` DTO, not a `saving`/silence) before `ready` arrives, and
  `error` can itself arrive instead of `ready` — a content-type list or
  semantics load that fails, or one that simply never finishes within
  `EDITOR_READY_TIMEOUT_MS` (60 s after the editor's own internal iframe
  loads) — so a caller must not assume `ready` is coming just because nothing
  failed yet. Such a load failure's `error` carries the `revision` the page
  read for stored content, so the content can still be replaced by a version
  import conditioned on it;
- stored content that names a library version this host does not have
  installed (its main library or a nested one) opens no editor: `GET
/api/v1/content/:contentId/edit` lists them as `missingLibraries` (`[{
library, upgrade }]`, `upgrade` being the newest installed version of the
  same library, or `null` when only older ones are installed — content is
  never downgraded), and the page posts `error` with `code:
"library-missing"` and the `revision`. When every missing version has an
  upgrade, the page offers **Upgrade to the installed version**: it runs the
  H5P core's own content upgrade in the browser (the installed versions'
  `upgrades.js` hooks for every step from the stored version; a library
  without one only has its version replaced; nested libraries go to the
  version their installed container's semantics name) and opens the result
  in the editor unsaved — `ready`, then `changed` — so nothing is written
  until the author saves. A failed upgrade posts `error` with `code:
"library-upgrade-failed"` and leaves the button available. Such content
  can be overwritten at all — by that save or by a version import over its
  id — because an update whose stored parameters cannot be scanned for
  their media (h5p-server reads the stored library's semantics for that)
  takes the files actually stored with the content instead: those the new
  parameters reference stay, the rest are removed as unreferenced
  (`src/h5p/missing-library-update.ts`);
- Shelf authenticates each proxied request with an `X-Distributor-Id`
  tenant header and the shared `X-H5P-Host-Secret`;
- `GET /ready` reports `contractVersion` (the number of this save-body /
  DTO / header / route contract, currently **8**) so a Shelf built against
  another version can refuse to go live instead of failing on the first save,
  and `bundle` — the version and checksum of the library bundle the runtime
  directory was provisioned from (`null` for a plain-directory install);
- every content mutation is a journalled transaction. Shelf may send an
  `Idempotency-Key` (a replay returns the first answer instead of writing
  again), an `If-Match` revision (a save over content changed elsewhere is
  refused with `409`) and an `X-Max-Delta-Bytes` allowance (`413` when the
  write would exceed it). The answer carries an `operationId` — quoted back to
  `POST /api/v1/operations/:id/ack` once Shelf has accounted for the byte
  delta — and, for a save, the content's new `revision`; the `saved` DTO
  carries the `operationId` too. Completed writes nobody acknowledged are
  listed by `GET /api/v1/pending-usage`. Since contract version 8, a present
  `If-Match` always conditions a mutation of existing content: an empty value,
  `""` after unquoting, or whitespace trimmed by HTTP mismatches and is refused
  with `409`, just as a download refuses it with `412`. Only an absent header
  permits an unconditional operation. Version 7 treated empty values as no
  condition on mutations; embedders must now preserve them when forwarding.
  Deploy Host and Shelf together at version 8. Creating new content has no prior
  revision to compare; idempotent replays still return the recorded result of
  an already completed operation;
- a package is imported as new content with `POST /api/v1/import/h5p` (`201`)
  or over an existing content — a new version of it, under the same id — with
  `POST /api/v1/import/h5p/:contentId` (`200`; `404` for an unknown id, `400`
  for one that is not numeric, `new` included). Both answer `415` to a file
  not named `*.h5p`. The replacement is a mutation like a save: same headers,
  a signed `deltaBytes`, and the stored content stays as it was if the package
  cannot be unpacked or saved. Both import routes reject a package missing
  referenced local media with `422 media-missing`, before H5P can discard the
  references; a replacement leaves the previous content and media intact.
  `GET /api/v1/content/:contentId/metadata`
  answers `title`, `mainLibrary` and `authorComments` from the stored
  `h5p.json` (each `null` when absent; `400`/`404` as above), so a caller can
  compare them with a package before importing it over that content;
- content created by an editor save (`PATCH /api/v1/content/new`) or by
  `POST /api/v1/generated-content` gets a book id: an `@id=<uuid>;` line
  appended to `h5p.json`'s `authorComments`, unless the payload already names
  one (`@id=…;` or `id=…;`). An editor save of a stored book keeps its stored
  id when the payload names none (the editor form holds the metadata it was
  opened with); a book stored without an id is not given one, and an import
  stores the package's own `authorComments`. Author comments too long to hold
  the id as well (h5p-server allows 5000 characters) refuse the save with
  `422 author-comments-too-long`, so a book never loses its id to a save;
- `ready` and `saved` DTOs include the revision loaded or saved by the editor
  (`ready` for `new` content has none: nothing is stored until the first
  `saved`). A caller can pin `GET /api/v1/content/:contentId/download` to that
  revision with `If-Match`: the host checks it under the same shared lock as
  the export and answers `412 ContentRevisionMismatch` before exporting if it
  changed. `If-Match` carries the bare revision, optionally quoted; the host
  issues no ETags, so `W/` validators and `*` are not understood;
- an `X-Request-Id` Shelf forwards is carried by every log line of that
  request and echoed on the response, so one browser action can be followed
  through both the host's and Shelf's logs.

Logs are JSON lines (pino). On `SIGTERM`/`SIGINT` the host stops accepting
connections, lets in-flight requests finish (`H5P_HOST_SHUTDOWN_GRACE_MS`,
20 s by default) and exits.

### The player page and pick mode

`GET /api/v1/content/:contentId/render` is a standalone H5P player page. Shelf
opens it top-level as a preview. An embedder may instead frame it and let the
user pick an element of the content — the page then reports which
sub-content was clicked. That channel belongs to the player page alone and
does not change `contractVersion`: an embedder that does not use it sees the
page exactly as before.

- `?parentOrigin=<origin>` names the framing page, the only target the player
  posts to and the only origin it accepts messages from. It defaults to the
  page's own origin (the same-origin proxied deployment). With
  `H5P_HOST_ALLOWED_PARENTS` set, a value outside that list, one that does
  not parse or a repeated parameter is refused with
  `400 Parent origin is not allowed.`, as for the editor page; without the
  parameter the page opens as before.
- The page loads `web/player-bridge.js` after the libraries. The bridge stays
  inert unless the page is framed or opened with `?pickMode=1`. The latter
  turns pick mode on locally for a manual check and posts nothing when the
  page is top-level.
- While active, it tags the container each sub-content is attached to with
  `data-sub-content-id` and `data-sub-content-library` (the machine name). The
  tag goes on the container the library attaches into, not on the
  sub-content's own root; an outer tag is never overwritten.
- Framed, it also passes window resizes on to the content (the core only does
  that top-level or for a parent running h5p-resizer).

Messages carry `source: 'editor-embedder'` inbound and
`source: 'h5p-player-host'` outbound. The core's own `{ context: 'h5p' }`
messages travel on the same channel and are not part of this contract.

| Direction | DTO                                                          | Meaning                                                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| out       | `{ type: 'player-ready', contentId }`                        | Sent once, when the content has initialized.                                                                                                                                                                                                                                                                                                           |
| out       | `{ type: 'player-error', contentId }`                        | Document ready passed and the content did not initialize. If the page itself failed to load, neither message comes, so wait with a timeout.                                                                                                                                                                                                            |
| in        | `{ type: 'pick-mode', enabled, selectable? }`                | Turns pick mode on (`enabled: true`) or off; each message replaces the previous state, and turning it off clears the frame. `selectable` lists the ids the embedder can act on (compared case-insensitively); without it any tagged element is pickable, and an empty list makes nothing pickable. Accepted at any time; send it after `player-ready`. |
| in        | `{ type: 'pick-clear' }`                                     | Removes the frame from the picked element.                                                                                                                                                                                                                                                                                                             |
| out       | `{ type: 'picked', contentId, subContentId, library, path }` | A click picked `subContentId`, the innermost tagged ancestor of the click target that is in `selectable`. `path` lists the ids of all tagged ancestors, innermost first, so the enclosing chapter can be found when a book holds copies sharing an id.                                                                                                 |

In pick mode, a click inside tagged content is swallowed. If it has a
selectable ancestor, that element gets a yellow outline and `picked` is
posted; otherwise nothing happens. A click outside tagged content — the
book's navigation, table of contents and cover button — works as usual.
Presses and touches inside tagged content are stopped, so drags, swipes and
custom controls do not start; scrolling stays native and a tap still picks.
Embedded `iframe`/`video`/`audio` elements stop taking pointer events, so a
click on them picks their container. Keyboard input is not intercepted.

## Runtime assets and libraries

The H5P **editor runtime** is tracked in this repository: `assets/h5p/core`,
`assets/h5p/editor` and the CKEditor it bundles (`assets/h5p/editor/ckeditor`),
alongside that CKEditor build's own source inputs in `sources/ckeditor5`.
h5p-express serves these under `?version=<h5pVersion>` with `max-age` set to
one year, so a browser that has already fetched a file keeps that answer
until the query string changes. **Any change under `assets/h5p/{core,editor}`
must bump this package's own `version` in `package.json`** — `h5pVersion`
(`src/h5p/config.ts`) is `1.28-<package version>`, so a release bump is what
actually busts the cache; editing the assets alone does not.

H5P **library packages** (content types and editor widgets) are provisioned
separately into `.host-data/libraries` (git-ignored). These packages contain
third-party code and resources under their respective licenses. Review each
distributed package and preserve its notices and corresponding source where
required; excluding a directory from Git does not change those obligations.

```bash
H5P_LIBRARY_SOURCE_DIR=/path/to/library/bundle npm run provision:libraries
```

The source is a mounted volume or an unpacked release artifact; a CI/deploy step
fetches it before running the command. For a reproducible deployment — and for
a legal sign-off that names one fixed library set — build a **versioned
bundle** instead and install from it:

```bash
# on the machine that holds the vetted set
npm run bundle:libraries -- --version 2026.09 --out dist
#   → dist/h5p-libraries-2026.09.tar.gz + .sha256 (manifest and license
#     inventory inside the archive)

# on the server
H5P_LIBRARY_SOURCE_BUNDLE=/srv/bundles/h5p-libraries-2026.09.tar.gz npm run provision:libraries
```

The install verifies the checksum (the `.sha256` sidecar, or
`H5P_LIBRARY_SOURCE_SHA256`), checks the manifest against the archive and
records the version in `.bundle.json` beside the libraries; `GET /ready`
then reports it as `bundle`. The script strips macOS metadata (`._*`
AppleDouble twins, `.DS_Store`, `__MACOSX`) from the copies and from the target,
and fails while any other entry named like a library is not a library
directory: h5p-server lists libraries by entry name, and one such stray entry
crashes its content-type listing. Without `H5P_LIBRARY_SOURCE_DIR` the command
only checks (and cleans) the target. `npm run licenses` regenerates
`THIRD-PARTY-LIBRARIES.md` from whatever is provisioned. Recognized H5P license
codes and common SPDX ids establish coverage; a non-empty field alone does
not. Missing declarations are resolved through the hand-curated
`scripts/library-license-evidence.json` (upstream license text, holder, URL,
check date) and otherwise reported as `(none)`. `cr` (the library.json code
for copyright), `C`, `U` and unknown labels remain coverage gaps. A
public-domain marker (`pd`, `PD`, `CC PDM`) is a dedication rather than a
license text, so it requires recognized upstream evidence, as recorded for
H5P.TextUtilities and H5P.Timer (WTFPL).

That evidence file is tracked and deployment-independent, while the library
set is neither, so the run names on stderr where the two fail to meet: a
provisioned library with no recognized declaration, applicable evidence or
reviewed exception (its terms are unrecorded — read the upstream text and add
one, or drop the library), and an entry or reviewed exception it used whose
`checked` date is older than `LICENSE_EVIDENCE_MAX_AGE_DAYS` (default 365, `0`
disables). Both are
warnings and the inventory is written either way. Add `--strict`
(`npm run licenses -- --strict`, or `LICENSE_INVENTORY_STRICT=1`) to exit
non-zero on an unrecorded library. `npm run bundle:libraries` always enables
strict mode and forwards these warnings; a coverage gap stops it before an
archive is written.

The evidence file also records `reviewedExceptions`, approved by the maintainer
for H5PEditor.MultiLineSelect 1.0.9, H5PEditor.MultiMediaChoice 1.0.0,
VMB.Adapt 1.0.0 and VMB.InteractiveBook 1.6.8. Each exception matches the
major/minor directory, patch version and declared license, and appears in a
separate report section. It permits that entry through the strict gate without
claiming a license grant; the bundled-copyleft scan still runs. A changed
version or declaration needs a new review.

An existing library must match the bundle's files to be kept. A mismatch fails
before installing anything; use `--force` to replace it, or provision a new
empty directory. Extra libraries outside the bundle cause a refusal even with
`--force`, since saved content may still need them. Install a different library
set into a new `H5P_LIBRARIES_DIR` and restart the host after checking content
compatibility. Bundle identity is written only after the installed files match;
a failed replacement clears the old identity. Provision with the host stopped.

## Development

```bash
npm install
npm run build
npm run provision:libraries            # once H5P_LIBRARY_SOURCE_DIR is set
H5P_HOST_SHARED_SECRET=dev-secret npm start
```

Dependency installation must run lifecycle scripts: `postinstall` runs
`scripts/patch-image-size.mjs`, which applies the local `image-size` security
fix, including for production installs with `npm ci --omit=dev`. Copy
`scripts/` alongside `package.json` and `package-lock.json` before installing
in a deployment image. The host refuses to start on an unpatched copy, so an
install with `--ignore-scripts` fails at startup instead of running exposed.
`npm audit` still flags the published `image-size` version because it cannot
see the local fix; `npm run audit:ci` (used in CI) allows exactly those two
advisories, with a review date, and fails on any other high or critical one.

Defaults:

- listen address: `127.0.0.1:8090`;
- route prefix: `/h5p-editor-core`
  (`H5P_HOST_ROUTE_PREFIX` to override);
- data: `.host-data`, holding `tenants/<distributorId>/` (one directory per
  distributor: its `content`, its `operations` journal and its `locks`),
  `libraries/` and `upload-tmp/`;
- runtime libraries: `.host-data/libraries` (`H5P_LIBRARIES_DIR` to override).

Copy `.env.example` to `.env` for the full list of settings and their defaults.

## Configuration and operations

Set `H5P_HOST_SHARED_SECRET` to a long random secret shared with Shelf. Startup
requires it for every `NODE_ENV` value, including unset, except explicit
`NODE_ENV=development`, which allows the local `dev-secret` fallback.

`H5P_HOST_ALLOWED_PARENTS` is a comma-separated list of HTTP(S) URLs without
wildcard hosts. The host normalizes and deduplicates their origins for both
`frame-ancestors` and the postMessage allowlist reported as `allowedParents`
in `/ready`. Any other entry (a bare host, a wildcard, another scheme) stops
the start with the entry named: dropping it would leave the allowlist empty,
and an empty allowlist means the same-origin deployment, where every
`parentOrigin` is accepted. Use explicit origins for a deployment framed
across origins.

Every numeric setting is read once, before the port opens, and a value that is
not a number (or not a whole one, where a count is expected) stops the start
with the variable's name. An unset or blank variable takes the documented
default; a typo is never silently replaced by one.

Tenant editors are cached separately from pending initialization:
`H5P_HOST_TENANT_CACHE_MAX` defaults to 100 completed editors and
`H5P_HOST_TENANT_INIT_MAX` to 16 simultaneous constructions. Excess new-tenant
requests receive `503` and may be retried; cached tenants remain available.
Cache eviction never removes saved content.

One tenant is written by one process at a time. The in-memory queue orders
this process's own requests; a lock file under `tenants/<id>/locks` orders it
against every other process on the same data directory. Writers exclude
everybody, readers of more than one file share with each other, and a holder
keeps its lock file's mtime fresh while it works.

The lock owner is written and closed in a private `.claim-*` file before a
hard link publishes it at the lock's path. A competing claim cannot overwrite
that path, and an I/O failure only cleans up its own private file. The data
filesystem must support hard links: the host probes the tenant directory at
start and refuses to run on a mount that has none. The journal sweep also
removes abandoned claim files; deleting one never removes a published lock's
other link, and a claim that was only paused finds its file gone and starts
over.

A holder that dies leaves its file behind. For an owner on this machine the
answer is its process: gone means the lock is free at once, and _still there_
means the lock is honoured however old it is — a process that has been stopped,
swapped out or is simply slow is still holding the tenant, and taking its lock
would put two writers in one directory. The cost of that strictness is a tenant
answering 503 until someone deals with a stuck process, which is the failure
worth having. `H5P_HOST_LOCK_STALE_MS` (default 60 s without a heartbeat) is
the fallback for an owner on another machine, where a pid says nothing, and
`H5P_HOST_LOCK_MAX_HOLD_MS` (default 1 h) is the ceiling on the pid rule
itself: a pid is not an identity, and a machine that returns with the same
hostname and the same number on an unrelated process would otherwise leave a
lock nothing could ever take.

"This machine" means "the same hostname", and pids are compared within it, so
every process namespace sharing the data directory needs a hostname of its
own. Containers that share a volume must not be given the same explicit
hostname; Docker's default, the container id, is unique.

A writer that loses its lock while it is running — an hour of silence, or a
file somebody deleted — is refused before it writes a journal record and again
before it publishes one, and answers 503 (`content-lock-lost`). Each check
reads the current owner from disk; it does not wait for a heartbeat.

An additional `locks/content.pin` holds the tenant until the writer's entire
task ends, including staging and cleanup. Replacing an expired lock does not
let a second process enter while the old writer could still resume. The pin
is reclaimed automatically — and the tenant's journal replayed — when its
recorded owner is on this machine and is proven gone: its pid has exited; it
names this process's own pid (a restarted container is pid 1 again) with a
token this process never issued; or, on Linux, the machine has booted since,
or the pid now belongs to a process that started at another time. An old pin
that names no owner at all, left by an older host or a storage crash, is removed
once it is older than a few seconds. Current hosts publish a complete identity
atomically; an older host must be stopped before upgrading, since its empty
pin could still belong to a paused claim. The periodic journal sweep does the
same for tenants nobody is using.

An owner on another machine, or a pid that is alive and cannot be told apart
from the owner (off Linux, or a pin written by an older version), cannot be
proven dead: reads and writes then answer 503 (`content-locked`). Neither lock
age limit overrides this rule. To recover such a tenant:

1. stop every host process that shares the data directory;
2. read `<tenant>/locks/content.pin` — it names the owner's `hostname` and
   `pid` — and make sure that process is gone or can no longer reach the
   storage;
3. delete the pin and create an empty `<tenant>/locks/recovery-required`, so
   the next request replays the tenant's journal before it reads;
4. start the host.

Do not remove a pin while its owner can still access the storage. All
processes sharing the directory must run this protocol; stop older versions
before upgrading to it.

The host flushes staged file data and directory entries before preparing the
journal, then flushes the publication renames before recording `done`. Real
I/O errors fail the write and leave any prepared transaction for recovery.
On platforms that do not support directory fsync, that part of the durability
guarantee remains limited by the filesystem.

Taking a lock from a dead owner is also treated as evidence that its
publication may be half-applied: a flag is left in the tenant's `locks`
directory and the journal is replayed before anything reads it. A publication
that fails outright raises the same flag, so the repair is owed even if the
process that owed it is gone. `H5P_HOST_JOURNAL_SWEEP_INTERVAL_MS` (default 6 h) is how often
settled receipts and abandoned lock files are swept for tenants that have gone
quiet, and `H5P_HOST_RECOVERY_WAIT_MS` (default 5 s) how long a start waits for
a tenant another live process is holding before it leaves that tenant's journal
to it.

`H5P_HOST_MAX_TEMP_BYTES` defaults to 1 GiB per tenant (`0` disables it).
Editor uploads, API temporary-file uploads and imports count incoming bytes
and reserve space for concurrent requests, admitted first come, first served.
This is a per-tenant burst guard, not a hard disk quota: multipart data reaches
the shared staging directory before the check, and archive expansion or H5P
metadata can add bytes afterwards, so provision disk for the aggregate across
tenants and monitor it. Two request-level limits sit above it:
`H5P_HOST_MAX_MULTIPART_BYTES` refuses an over-large request from its
Content-Length before anything is staged, and `H5P_HOST_MAX_UPLOAD_FILES` caps
how many files one request may carry.

Temporary uploads expire even while an editor tab is open. A save that loses
a referenced local media file (expiry or a copy failure) answers 422 with
`media-missing` and publishes no changes. Re-upload the file and retry; media
already present in saved content can be reused after its temporary copy expires.

Content listings take the shared content lock, so a save cannot temporarily
remove an item from the list. Export through
`GET /api/v1/content/:id/download`; the vendor `/h5p/download/:id` route is
disabled because it cannot build a consistent snapshot under that lock.

## Deployment notes

The host is not intended to be exposed directly to the internet. Put it behind
an authenticated reverse proxy (Shelf), and give the proxy its own request-body
limit: the Content-Length guard cannot measure a chunked upload that sends no
length.

A deployment needs more than `build/`: `web/` and `assets/` are served to the
browser, and `COPYING`, `docs/CKEDITOR_SOURCE.md` and `sources/` are what the
`/licenses` page links to as corresponding source. Those routes answer 404 with
an explanation when a file is missing, so a stripped-down image shows up as a
broken obligation rather than a stack trace.

The content lock holds between processes as well as inside one, so a second
host started on the same data volume — a rolling restart whose old process has
not exited, a stray unit, an operator's script — waits its turn rather than
publishing over a save in flight. A failed publication is recovered under that
lock before the next content read or mutation, including when the process that
failed was a different one. If recovery still fails, queued work is refused
until it can succeed. User-supplied files have a sandbox CSP, including partial responses;
HTML and other documents are downloads, and the temporary upload API rejects
HTML and scripts. SVG can still be used as an image.

## Licenses page

The exact CKEditor build source, dependency commits and verified rebuild
commands are in [CKEDITOR_SOURCE.md](CKEDITOR_SOURCE.md). The custom build
inputs are preserved in `sources/ckeditor5/`. `npm run verify:ckeditor` checks
their hashes and all 73 shipped runtime files against the pinned upstream
snapshot; the normal test suite includes this check.

`GET <prefix>/licenses` serves `THIRD-PARTY-NOTICES.md` as an HTML page (the
Markdown source with `?format=md`), linked from the editor page. It describes
the browser components and their source locations, including the exact
CKEditor build inputs — the CKEditor 5 bundle in particular is minified object
code under the GPL, so that pointer is an obligation, not a courtesy. When
upgrading the H5P runtime or CKEditor, update the versions there;
`test/licenses.test.js` checks that the notices match the bundled CKEditor
version, the pinned H5P core version and the installed h5p-server.
