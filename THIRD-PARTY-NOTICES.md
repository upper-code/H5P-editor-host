# Open-source licenses

This service is free software, licensed under the GNU General Public License
version 3 or (at your option) any later version; the license text is in
[COPYING](./COPYING). Copyright (c) 2026 Egor Surov. You may redistribute and
modify this service under those terms; it is provided without warranty.
Third-party components retain their respective licenses. The browser programs
and their source locations are listed below. Deployment through an iframe,
proxy or separate repository does not grant an exception to those licenses.

## What your browser receives

Loading the editor delivers these programs to the browser. Their source is
available as follows:

- `web/editor-host.js` (the browser bridge of this service): served exactly as
  written, unminified; it is its own source. License: GPL-3.0-or-later.
- `assets/h5p/core`: the H5P core runtime, version **1.27.0**, served
  unminified. License: GPL-3.0 (The H5P Group / Joubel AS and contributors;
  text in `assets/h5p/core/LICENSE.txt`). Corresponding source:
  https://github.com/h5p/h5p-php-library/tree/1.27.0
- `assets/h5p/editor`: the H5P editor client, the **1.27** line, served
  unminified. Upstream declares its license inconsistently — its README says
  MIT while its Composer metadata says GPL-3.0 (details in
  `assets/h5p/editor/LICENSE.txt`). This service preserves those notices and
  does not resolve that upstream discrepancy by changing deployment layout.
  Source: https://github.com/h5p/h5p-editor-php-library (the upstream
  repository does not tag a matching 1.27 release; the tree served here is
  the one recorded in `assets/h5p/NOTICE`).
- `assets/h5p/editor/ckeditor`: **CKEditor 5, version 43.3.0**, as a minified
  bundle shipped with the H5P editor client (`ckeditor.js`, its source map
  `ckeditor.js.map` and `translations/`). CKEditor 5 is dual-licensed,
  GPL-2.0-or-later or a commercial CKSource license; this distribution uses
  the copyleft option and, as "or later" permits, conveys it under GPL
  version 3. The 73 browser files match H5P commit
  **2db790c4df5398883492f49be5820522e22e1866**. Corresponding source includes
  the [H5P custom build and its lockfile](https://github.com/h5p/h5p-editor-php-library/tree/2db790c4df5398883492f49be5820522e22e1866/ckeditor5),
  the [CKEditor 43.3.0 packages](https://github.com/ckeditor/ckeditor5/tree/v43.3.0),
  and the [H5P table plugin at its locked commit](https://github.com/h5p/h5p-ckeditor-table/tree/fdd5814fc267d7df44443c03046c5623c0bb6088).
  See the [verified build instructions](./docs/CKEDITOR_SOURCE.md) and
  [source/runtime checksum manifest](./sources/ckeditor5-source.json).
  Local copies of the build inputs are available below; the shipped source
  map also embeds the source modules.
- H5P content-type and editor-widget libraries (e.g. `H5P.InteractiveBook`,
  `H5P.MultiChoice`): loaded on demand from this deployment's provisioned
  library set, each under its own upstream license (next section).

The operator of this service is responsible for keeping the corresponding
source above obtainable for as long as the object code is offered (GPL v3,
section 6d); the upstream servers are named here as the designated place.

## Local CKEditor build inputs

These files are verbatim copies from the pinned H5P commit above:

- [Custom editor entry point](./sources/ckeditor5/src/ckeditor.ts)
- [Package manifest](./sources/ckeditor5/package.json)
- [Dependency lockfile](./sources/ckeditor5/package-lock.json)
- [Webpack configuration](./sources/ckeditor5/webpack.config.js)
- [TypeScript configuration](./sources/ckeditor5/tsconfig.json)
- [TypeScript declaration configuration](./sources/ckeditor5/tsconfig.types.json)
- [Upstream build README](./sources/ckeditor5/README.md)
- [Upstream build license notice](./sources/ckeditor5/LICENSE.md)

## Server-side components (not conveyed to browsers)

- `@lumieducation/h5p-server` and `@lumieducation/h5p-express`, version
  **9.3.3**: GPL-3.0-or-later according to their npm metadata. Source:
  https://github.com/Lumieducation/H5P-Nodejs-library
- `express`, `express-fileupload`, `i18next`, `i18next-fs-backend`, `pino`:
  MIT-licensed; their notices are in `node_modules/<name>/LICENSE` of the
  installed tree.

## Runtime libraries (untracked, provisioned per deployment)

H5P library packages contain executable code and resources under their own
upstream licenses. They are provisioned into `.host-data/libraries` separately
from this repository. Operators must establish the distribution terms for
each package, preserve notices and provide corresponding source when required.
Packages with unknown or incompatible terms must be resolved or excluded from
the distributed set. Git exclusions and running in a GPL service do not change
those requirements. Representative examples seen in practice:

- `H5P.MaterialDesignIcons-*`: declares `GPL3` in its `library.json`, while
  the upstream README (https://github.com/h5p/h5p-material-design-icons)
  states only that the icons are Google's Material Icons under Apache-2.0.
  The two are not in conflict — the font files are Apache-2.0 and Joubel's
  one-file CSS wrapper is what the `GPL3` declaration can cover. Its
  corresponding source is the library directory itself — CSS and font files,
  nothing is compiled.
- `H5P.CKEditor-*`: wrapper metadata says MIT, but its bundled CKEditor 5
  packages (43.3.0, the same version this host's editor build uses) declare
  GPL-2.0-or-later — a mixed-license library. The `LICENSE.md` that ships
  inside it is CKSource's online-builder agreement: it puts only the builder's
  glue code under MIT and says nothing about the CKEditor 5 packages, whose
  terms come from the packages themselves. The corresponding source of the
  bundled build is the upstream repository https://github.com/h5p/h5p-ckeditor
  (build configuration, pinned package versions) plus the CKEditor 5 43.3.0
  source already offered above.
- `H5P.MultiChoice-*`: library metadata says MIT, but the bundled IcoMoon font
  is marked GPL in `css/multichoice.css`; that header is the notice and ships
  with the library, and font files are their own source.
- `flowplayer-*`: bundles Flowplayer under GPL-3.0-or-later. It is reachable
  only from `H5P.Audio-1.2`, an old duplicate that nothing in an Interactive
  Book deployment offers, so it is excluded from the provisioned set together
  with `H5P.Audio-1.2` and that one's sole dependent, `H5P.ImageSequencing-1.1`.

- `TimelineJS-*` (Knight Lab's TimelineJS 2.36.0 packaged for `H5P.Timeline`)
  and `H5P.ImageJuxtaposition-*`: Mozilla Public License 2.0 — file-level
  copyleft. The files may be conveyed inside this deployment under its own
  terms (MPL-2.0 §3.3); their notices stay in place and the recipient is
  pointed to the Source Code Form, which for these unmodified files is the
  upstream repository (https://github.com/h5p/timelinejs, itself from
  https://github.com/NUKnightLab/TimelineJS, and
  https://github.com/otacke/h5p-image-juxtaposition). The inventory lists
  every MPL library with that pointer in its own section.
- `H5P.TextUtilities-*`, `H5P.Timer-*`: declare `pd`; upstream
  (https://github.com/otacke/h5p-text-utilities,
  https://github.com/otacke/h5p-timer) states the WTFPL — no conditions.

Many H5P Group infrastructure libraries (`H5P.JoubelUI`, `H5P.FontIcons`,
`H5P.Text`, `H5P.Image`, `H5P.Table`, the `H5PEditor.*` widgets…) declare no
license in their `library.json` at all. Their upstream license texts were read
and recorded, with URL, copyright holder and check date, in
`scripts/library-license-evidence.json`; the inventory reports such a library
as `<license> (upstream evidence)` instead of `(none)`. Add to that file only
after reading the upstream text yourself.

Run `npm run licenses` to regenerate `THIRD-PARTY-LIBRARIES.md`, a full
inventory of whatever a given deployment has provisioned; a library bundle
built with `npm run bundle:libraries` carries that inventory inside the
archive, so the inventory of a deployment is the one of the bundle it was
provisioned from.
