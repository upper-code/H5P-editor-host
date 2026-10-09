# CLAUDE.md

Project instructions for AI coding agents and reviewers. `AGENTS.md` and
`QWEN.md` are symlinks to this file, so every agent reads the same text.

## What this is

A GPL-3.0-or-later Node.js service (TypeScript, Express, h5p-server) that
hosts the H5P editor and player, stores content per tenant and imports/exports
`.h5p` packages. It is embedded: a surrounding application — called **Shelf**
throughout the repository, a placeholder name — frames the editor page, proxies
`/h5p-editor-core/*` to the host and supplies authentication. See
[README.md](README.md) and, for the embedding contract and operations,
[docs/USAGE.md](docs/USAGE.md).

## Commands

Node >= 24 (`engines`; CI runs 24).

```bash
npm install                 # must run lifecycle scripts (postinstall patches image-size)
npm run build               # rm -rf build/ && tsc
npm test                    # build, then all Node tests (test/*.test.js)
npm run test:browser        # Playwright/Chromium tests on the committed core assets
npm run lint                # eslint .
npm run format:check        # prettier; `npm run format` writes
npm run audit:ci            # npm audit with the dated image-size allowlist
```

CI (`.github/workflows/ci.yml`) runs lint, format:check, `npm test`,
`npm run test:browser` and `audit:ci`; run the same set before committing.
One test file: `npm run build && node --test test/<name>.test.js` — the tests
load the compiled `build/src/`, so rebuild after every change under `src/`.
Neither suite needs a running host or provisioned libraries; the browser suite
needs Chromium once (`npx playwright install chromium`).

## Layout

- `src/` — the service (compiled to `build/`). `app.ts` holds the routes,
  auth, the per-tenant queue and `EMBEDDING_CONTRACT_VERSION`;
  `content-transactions.ts` the journal, revisions and content lock;
  `process-lock.ts` the cross-process lock files; `tenant-manager.ts` the
  per-tenant editor cache; `env.ts` numeric settings; `src/h5p/` the
  h5p-server integration (config, storage, permission system, importer,
  i18n); `src/routes/` content and player-page routes.
- `web/` — browser code served as-is, no build step: `editor-host.js` (the
  editor-iframe bridge, an ES module) and `player-bridge.js` (a classic
  script; an `import` there breaks the page).
- `assets/h5p/{core,editor}` — vendored upstream H5P runtime with local
  patches kept in `assets/h5p/patches/`; provenance in `assets/h5p/NOTICE`.
- `sources/` — CKEditor build inputs (corresponding source).
- `scripts/` — provisioning, bundling, license inventory, asset fetch,
  image-size patch, audit allowlist.
- `test/` — `node:test` suites (`helpers.js`, `host.js` = the app over a real
  socket, `fixtures/`), `test/browser/` — Playwright.
- `.host-data/` (runtime data and provisioned libraries), `build/`, `dist/`
  are git-ignored.

## Rules

- **Vendored assets.** `assets/h5p/{core,editor}` is upstream code: a local
  change there is also kept as a patch file in `assets/h5p/patches/`, listed
  in `assets/h5p/NOTICE`, and **bumps `version` in `package.json`** (the
  one-year cache buster) — see
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#changing-the-vendored-h5p-runtime).
  The CKEditor build and `sources/` change only by the procedure in
  [docs/CKEDITOR_SOURCE.md](docs/CKEDITOR_SOURCE.md);
  `npm run verify:ckeditor` checks their hashes.
- **Embedding contract.** A change to the save body, postMessage DTOs, proxy
  headers, the browser-facing route set or `/ready` may need an
  `EMBEDDING_CONTRACT_VERSION` bump — read
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#changing-the-embedding-contract)
  first; `docs/USAGE.md` must describe the result.
- **Content writes** go through `mutateContent` (journalled, idempotent,
  under the exclusive content lock); multi-file reads take the shared
  `withContentLock`. Never write tenant content directly.
- **Errors** meant for the caller are `HostError` (`src/errors.ts`) with a
  status, plus a `code` when the embedder has to branch on it.
  `createErrorHandler` (`src/app.ts`) sends a 4xx message verbatim and masks
  a 5xx without `code`, so a 4xx message must never carry paths or internals.
- **Settings.** Numeric ones go through `envNumber`/`envTimerMs`
  (`src/env.ts`: a malformed value stops the start, never falls back to the
  default). Every setting is documented in `.env.example`.
- **Licensing.** Runtime or CKEditor upgrades update
  `THIRD-PARTY-NOTICES.md` (`test/licenses.test.js` checks it). Keep the
  image-size fix (`scripts/patch-image-size.mjs`, `src/image-size-patch.ts`)
  until a fixed release ships.
- **Naming.** In prose call the upstream package "h5p-server"; its full npm
  name belongs only where an identifier is needed (`package.json`, imports,
  notices). Do not name its vendor or other applications built on it.
- **Language.** Code, comments, docs and commit messages in English.

## Style

TypeScript in `src/` is CommonJS output, `es2022`. Prettier: single quotes,
no trailing commas, 80 columns, 2 spaces. Comments explain _why_ — match the
existing density: modules and non-obvious functions carry a header comment
with the reason and the failure it prevents. Tests name the behaviour
(`'a lost writer cannot prepare or publish over a replacement revision'`)
and clean up after themselves through `t.after`.

## More documentation

- [docs/USAGE.md](docs/USAGE.md) — embedding contract, provisioning,
  configuration, lock model, deployment.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — maintainer procedures:
  runtime patches, contract changes, content upgrades, tests.
- [docs/CKEDITOR_SOURCE.md](docs/CKEDITOR_SOURCE.md) — CKEditor source and
  rebuild.
