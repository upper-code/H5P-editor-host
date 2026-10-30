# CKEditor corresponding source and build instructions

The browser runtime is CKEditor 5 **43.3.0**, built by H5P with its custom
editor configuration and table plugin. The 73 shipped files (`ckeditor.js`,
`ckeditor.js.map` and 71 translations) match the H5P editor repository at
commit **2db790c4df5398883492f49be5820522e22e1866** (2024-11-04).

This was established by comparing every file with that commit, not by inferring
the source from the CKEditor version string. Runtime SHA-256 checksums and the
checksums of the vendored build inputs are recorded in
`sources/ckeditor5-source.json`.

## Exact source locations

- [H5P custom build, including entry point, webpack configuration, TypeScript configuration and lockfile](https://github.com/h5p/h5p-editor-php-library/tree/2db790c4df5398883492f49be5820522e22e1866/ckeditor5).
- [CKEditor 5 source, version 43.3.0](https://github.com/ckeditor/ckeditor5/tree/v43.3.0).
- [H5P table plugin source, commit fdd5814fc267d7df44443c03046c5623c0bb6088](https://github.com/h5p/h5p-ckeditor-table/tree/fdd5814fc267d7df44443c03046c5623c0bb6088).
- [Original browser files at the same H5P commit](https://github.com/h5p/h5p-editor-php-library/tree/2db790c4df5398883492f49be5820522e22e1866/ckeditor).

The table dependency is requested as tag `0.0.13`, while its package metadata
says `0.0.12`. The authoritative identity for this build is the resolved commit
in the lockfile, reproduced above. Do not replace it with the similarly named
standard CKEditor table package.

`sources/ckeditor5/` contains verbatim copies of the custom build entry point,
package and lockfile, webpack/TypeScript configuration, upstream README and
license notice. Other dependency versions, registry archive URLs and integrity
hashes are in its lockfile. The distributed source map embeds 1130 source
entries, including the custom entry point and the dependency modules. The
source map supplements these build inputs and exact source locations.

The host's `/licenses` page links to these sources, the local build inputs,
this document and the GPL text. Operators distributing this runtime must keep
the corresponding sources available to recipients, including any local
changes; the location of a repository or artifact does not remove that duty.

## Build from the source included in this repository

Requirements: Node.js 24 or newer, npm, Git and network access to the registry
and the public GitHub dependency. The commands below were verified using
Node.js 26.0.0 and npm 11.12.1 on 2026-09-09.

From the H5P Editor Host repository root:

```sh
npm run verify:ckeditor
ckeditor_work="$(mktemp -d)"
cp -R sources/ckeditor5 "$ckeditor_work/ckeditor5"
(
  cd "$ckeditor_work/ckeditor5"
  npm ci --ignore-scripts --no-audit --no-fund
  npm run build
)
npm run verify:ckeditor -- --built "$ckeditor_work/ckeditor"
```

The explicit `npm run build` runs webpack and its `postbuild` TypeScript
declaration step. Browser files are written to the sibling `ckeditor/`
directory; declarations go to `ckeditor5/build/`. A fresh temporary directory
is necessary because this historical translation plugin refuses to remove an
existing translations directory outside its working directory. The commands
do not replace the runtime shipped by the host.

The independent rebuild reproduced the source map and all translations byte
for byte. The only difference in `ckeditor.js` was the automatically generated
copyright banner year: the upstream build helper uses the current calendar
year, while the shipped file says 2024. `verify:ckeditor -- --built` normalizes
only that banner year **for comparison**, then checks the complete file hash.
It does not rewrite the output. All executable code matches. Keep the original
notices with the source and with any redistributed build.

To obtain the same build inputs directly from upstream, use a fresh checkout
of the exact commit above and copy its `ckeditor5` directory into a new working
directory before installing dependencies. Use `npm ci` with its lockfile;
`npm update` or a new lockfile would describe a different build.

## Updating the runtime

For a new CKEditor release, identify the H5P build commit and table-plugin
commit, preserve the source and notices, rebuild in an empty work directory,
and review the results. Update the runtime, source inputs, checksum manifest
and `THIRD-PARTY-NOTICES.md` together. The checksum manifest describes the
specific shipped files; it is not a substitute for reviewing their origin.
