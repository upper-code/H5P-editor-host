# H5P Editor Host

A **GPL-3.0-or-later** service for editing, importing, storing, playing and
exporting H5P content. It exposes an editor page and an HTTP API, with
per-tenant storage, controlled library provisioning and offline H5P runtime
assets.

The host is designed to be embedded. It manages the H5P runtime and storage,
while a surrounding application supplies authentication, the user-facing
interface and a reverse proxy in front of the API. Throughout this repository
that surrounding application is called **Shelf** — a placeholder name used for
illustration, not a real product. Build your own editor by putting your own
Shelf around this host.

## Quick start (development)

```bash
npm install
npm run build
npm run provision:libraries            # once H5P_LIBRARY_SOURCE_DIR is set
H5P_HOST_SHARED_SECRET=dev-secret npm start
```

By default the host listens on `127.0.0.1:8090`, serves the API under the
`/h5p-editor-core` prefix (`H5P_HOST_ROUTE_PREFIX` to override),
and keeps its data in `.host-data`. Copy `.env.example` to `.env` for the full
list of settings.

H5P **library packages** (content types and editor widgets) are provisioned
separately into `.host-data/libraries` (git-ignored) and are not part of this
repository; see the usage guide for how to provision or bundle them.

## Documentation

- **[docs/USAGE.md](docs/USAGE.md)** — embedding the host in a Shelf,
  provisioning libraries, configuration and operations, deployment.
- **[docs/CKEDITOR_SOURCE.md](docs/CKEDITOR_SOURCE.md)** — the exact CKEditor
  build source and verified rebuild steps.
- **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)** — browser components and
  their corresponding source, also served at `<prefix>/licenses`.

## License

GPL-3.0-or-later. See [COPYING](COPYING). Licensing an integration depends on
the actual relationship between its components: an iframe, proxy or separate
repository does not by itself decide whether the host and its surrounding
application form a combined work under the GPL. This project grants no
additional exception to the licenses of its dependencies.
