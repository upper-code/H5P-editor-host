# Developing the H5P Editor Host

Maintainer procedures that matter only for particular kinds of change. The
everyday commands and rules are in [CLAUDE.md](../CLAUDE.md); the embedding
contract and operations are in [USAGE.md](USAGE.md).

## Tests

- `npm test` compiles `src/` into `build/` and runs `test/*.test.js` with
  `node:test`. The tests `require('../build/src/…')`, so a single file run
  (`node --test test/<name>.test.js`) needs `npm run build` first.
- `test/host.js` starts the real Express app on a socket with stubbed
  tenants. Requests go through `http.request`, not `fetch`, because `fetch`
  normalizes `..` and `%2e%2e` away and several tests are about such paths.
- `test/helpers.js` holds temp directories, environment overrides and script
  runners; each one undoes itself through `t.after`.
- The browser bridges (`web/editor-host.js`, `web/player-bridge.js`) and the
  core's content-upgrade code are tested in `node:vm` contexts with stubbed
  `window`/`H5P` (`test/editor-bridge.test.js`, `test/player-bridge.test.js`,
  `test/content-upgrade.test.js`, fixtures in `test/fixtures/`).
- `test/browser/` runs the committed core assets in headless Chromium through
  Playwright (`npm run test:browser`); use it for CSS, layout and real event
  behaviour that `node:vm` cannot show. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
  points it at an existing Chrome.
- One test in `test/process-lock.test.js` reads `/proc` and is skipped off
  Linux; that skip is expected.

## Changing the vendored H5P runtime

`assets/h5p/core` (upstream h5p-php-library, tag 1.28.0) and
`assets/h5p/editor` (upstream h5p-editor-php-library, the 1.27 line, with
the CKEditor build) are committed copies of upstream. A local fix:

1. Edit the file and mark the change in its header:
   `// Local patch (YYYY-MM-DD): <what it does>.`
2. Save the change as a unified diff relative to the tree root (`--- a/js/…`,
   `+++ b/js/…`) in `assets/h5p/patches/<core|editor>/NNNN-<slug>.patch`,
   numbered after the last one, with a short description above the first
   `---`. Patches apply in file-name order on top of each other.
3. Describe it in `assets/h5p/NOTICE` (the list of local patches).
4. **Bump `version` in `package.json`.** `h5pVersion` in `src/h5p/config.ts`
   is `1.28-<package version>` and is the `?version=` query of every asset URL,
   served with a one-year `max-age`; without the bump browsers keep the old
   file. If the change is one that must not meet an older cached copy of
   another file (a host page calling a function only the new core has), make
   the host check for it explicitly and fail with a clear message.
5. Run `npm test` (`test/asset-patches.test.js` peels the patches off a
   scratch copy in reverse order and re-applies them, so a hunk edited in the
   tree but not in its patch fails) and `npm run test:browser`.

Upgrading upstream:

```bash
bash scripts/fetch-h5p-assets.sh [--core-only] [--no-patches] [core-ref] [editor-ref]
```

fetches the trees, applies the patches and stages the result next to the
current tree for a parity review (details in the script header and in
`assets/h5p/NOTICE`). A patch that no
longer applies stops the script: rebase it, or delete it when upstream fixed
the issue. Then:

- keep the core pin in `src/h5p/config.ts` (`coreApiVersion`, `h5pVersion`)
  equal to the fetched core;
- check `src/h5p/core-assets-hotfix.ts`, the core files h5p-server does not
  register (`test/core-assets-hotfix.test.js` enforces the list);
- update `THIRD-PARTY-NOTICES.md` (`test/licenses.test.js` compares it with
  the bundled CKEditor, the pinned core and the installed h5p-server);
- for CKEditor itself follow [CKEDITOR_SOURCE.md](CKEDITOR_SOURCE.md);
  `npm run verify:ckeditor` (part of `npm test`) checks the shipped files.

## Changing the embedding contract

`EMBEDDING_CONTRACT_VERSION` in `src/app.ts` numbers everything an embedder
depends on: the flat save body (`src/save-payload.ts`), the postMessage DTOs
of `web/editor-host.js`, the `X-Distributor-Id` / `X-H5P-Host-Secret` and
transaction headers, the browser-facing route set and the shape of `/ready`.
`/ready` reports it so that an embedder built for another version can refuse
to go live; an embedder that does so stops working at a bump until it is
updated, so a bump means deploying host and embedder together.

- **Bump** when an embedder built for the current version would break: a
  field renamed, removed or made mandatory, a changed status code or header
  meaning, a route moved. Add a line to the history comment under the
  constant, update `contractVersion` in `test/host-routes.test.js` and
  `docs/USAGE.md`.
- **Do not bump** for a purely additive change an older embedder neither
  sends nor needs: an optional DTO field, a new opt-in channel. The player
  page's pick mode and the optional `revision`/`code` fields of the editor's
  `error` DTO shipped this way. Document such a change in `docs/USAGE.md`
  all the same.

The player page's own channel (`web/player-bridge.js`,
`source: 'h5p-player-host'`) is outside the numbered contract; see "The player page
and pick mode" in USAGE.md.

## Content writes and locks

Every content mutation (editor save, generated content, import, delete)
runs inside `mutateContent` (`src/content-transactions.ts`): it takes the
exclusive content lock, journals the transaction, answers idempotent replays
and checks `If-Match` and `X-Max-Delta-Bytes`; an operation ack takes the
exclusive `withContentLock` directly. Mutating routes also queue on the
per-tenant `tenantLock` in `src/app.ts`, which shares one wait budget
(`H5P_HOST_MUTATION_WAIT_MS`) with the content lock.

Reads that span several files take `withContentLock` in shared mode. The
middleware in `src/app.ts` already holds that lock for `GET`/`HEAD` requests
under `/api/v1/content/` and `/h5p/params/`, except the content `download`
route. Do not acquire it again inside those handlers: a queued writer waits
for the outer reader while the inner reader waits for that writer, causing
a lock timeout (or an indefinite wait if timeouts are disabled). The
`download` handler takes its own shared lock only while building the package
and releases it before streaming the temporary file to the client.
Single-file reads under `/h5p/…` and the editor page take no lock (an open
descriptor survives the publication rename).

The cross-process half lives in `src/process-lock.ts`;
the full model, including recovery of a stuck tenant, is in USAGE.md
("Configuration and operations").

A new mutating route therefore needs `tenantLock`, `mutateContent`, the
transaction headers and a test in `test/host-routes.test.js` or
`test/content-transactions.test.js` — and is a contract change (see above).

## Content upgrades in the browser

Content stored on a library version that is not installed opens with
"Upgrade to the installed version" (USAGE.md). The pieces:

- `GET /api/v1/content/:id/edit` (`src/routes/content.ts`) lists
  `missingLibraries` (`src/library-resolution.ts`);
  `src/h5p/missing-library-update.ts` lets such
  content be overwritten although h5p-server cannot read its semantics.
- `web/editor-host.js` runs the core's `H5P.ContentUpgradeProcess` and maps
  its errors (`upgradeError`); `UPGRADE_TIMEOUT_MS` bounds the run.
- Core patches 0003–0006 and editor patch 0002 change the upgrade process:
  cross-major hooks and nested same-version libraries, microtask stepping
  (browsers clamp nested timers, which made large books take tens of
  seconds), a named unsupported library, and per-version snapshots of the
  `upgrades.js` hooks (the global `H5PUpgrades` registry is keyed by machine
  name only, so two versions of one library would overwrite each other).
- `test/content-upgrade.test.js` runs the patched core against
  `test/fixtures/upgrade-libraries.js`.

## The image-size fix

h5p-server measures every uploaded image with `image-size`, whose ICNS and
JXL/HEIF parsers loop forever on crafted files (GHSA-w3rx-r6r6-pgpr,
GHSA-5p2g-fcmc-qvqq); the fix exists only in the 2.x line, whose API
h5p-server does not use (see
[DESIGN_DECISIONS.md](DESIGN_DECISIONS.md#the-image-size-dos-fix-is-maintained-locally)).
`scripts/patch-image-size.mjs`
(`postinstall`) patches the pinned copy, `src/image-size-patch.ts` refuses to
start on an unpatched one, `src/upload-guard.ts` rejects those formats with
`415`, and `scripts/audit-allowlist.mjs` lets `npm run audit:ci` pass these
two advisories only.

When a fixed `image-size` can be used, update the override and lockfile, then remove
the patch script, the `postinstall` hook, the startup check and the allowlist
entries. Remove or rewrite `test/image-size-patch.test.js` in the same change:
it imports the patch script and startup-check module and tests the local
patch mechanism, so it cannot remain unchanged after those files are deleted.
Keep the upload guard and the security regressions in
`test/image-size-security.test.js` and `test/upload-guard.test.js`. Adapt the
parser API calls and expected error text if the fixed release changes them,
while preserving the malformed-input cases and the child-process timeout
that catches synchronous parser hangs. Run `npm test` and `npm run audit:ci`
after retiring the patch.
