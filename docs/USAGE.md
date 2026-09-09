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
- Shelf authenticates each proxied request with an `X-Distributor-Id`
  tenant header and the shared `X-H5P-Host-Secret`;
- `GET /ready` reports `contractVersion` (the number of this save-body /
  DTO / header / route contract, currently **3**) so a Shelf built against
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
  listed by `GET /api/v1/pending-usage`;
- an `X-Request-Id` Shelf forwards is carried by every log line of that
  request and echoed on the response, so one browser action can be followed
  through both the host's and Shelf's logs.

Logs are JSON lines (pino). On `SIGTERM`/`SIGINT` the host stops accepting
connections, lets in-flight requests finish (`H5P_HOST_SHUTDOWN_GRACE_MS`,
20 s by default) and exits.

## Runtime assets and libraries

The H5P **editor runtime** is tracked in this repository: `assets/h5p/core`,
`assets/h5p/editor` and the CKEditor it bundles (`assets/h5p/editor/ckeditor`),
alongside that CKEditor build's own source inputs in `sources/ckeditor5`.

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
`THIRD-PARTY-LIBRARIES.md` from whatever is provisioned.

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
- data: `.host-data`;
- runtime libraries: `.host-data/libraries` (`H5P_LIBRARIES_DIR` to override).

Copy `.env.example` to `.env` for the full list of settings and their defaults.

## Configuration and operations

Every numeric setting is read once, before the port opens, and a value that is
not a number (or not a whole one, where a count is expected) stops the start
with the variable's name. An unset or blank variable takes the documented
default; a typo is never silently replaced by one.

Tenant editors are cached separately from pending initialization:
`H5P_HOST_TENANT_CACHE_MAX` defaults to 100 completed editors and
`H5P_HOST_TENANT_INIT_MAX` to 16 simultaneous constructions. Excess new-tenant
requests receive `503` and may be retried; cached tenants remain available.
Cache eviction never removes saved content.

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

Use one host process per data volume: the content lock is process-local. A
failed publication is recovered under that lock before the next content read
or mutation. If recovery still fails, queued work is refused until it can
succeed. User-supplied files have a sandbox CSP, including partial responses;
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
