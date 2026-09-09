#!/usr/bin/env node
// Verifies the vendored build inputs and the browser files against the pinned
// upstream snapshot. --built additionally checks an independently rebuilt tree.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  await fs.readFile(path.join(root, 'sources/ckeditor5-source.json'), 'utf8')
);
const runtime = path.join(root, 'assets/h5p/editor/ckeditor');
const source = path.join(root, 'sources/ckeditor5');
const sha256 = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');

for (const [directory, files] of [
  [source, manifest.sourceFiles],
  [runtime, manifest.runtimeFiles]
]) {
  for (const [name, hash] of Object.entries(files)) {
    assert.equal(
      sha256(await fs.readFile(path.join(directory, name))),
      hash,
      `Changed pinned file: ${name}`
    );
  }
}
const translations = (await fs.readdir(path.join(runtime, 'translations')))
  .filter((name) => name.endsWith('.js'))
  .sort();
assert.deepEqual(
  translations,
  Object.keys(manifest.runtimeFiles)
    .filter((name) => name.startsWith('translations/'))
    .map((name) => name.slice('translations/'.length))
    .sort()
);
const map = JSON.parse(
  await fs.readFile(path.join(runtime, 'ckeditor.js.map'), 'utf8')
);
const entry = map.sources.indexOf('webpack://ClassicEditor/./src/ckeditor.ts');
assert.ok(
  entry >= 0,
  'The bundle must map to the custom H5P editor entry point'
);
assert.equal(
  map.sourcesContent[entry],
  await fs.readFile(path.join(source, 'src/ckeditor.ts'), 'utf8')
);
const lock = JSON.parse(
  await fs.readFile(path.join(source, 'package-lock.json'), 'utf8')
);
const table = lock.packages['node_modules/@h5p/ckeditor5-table'];
assert.ok(
  table?.resolved,
  'The lockfile must resolve @h5p/ckeditor5-table: it is the table plugin whose commit identifies this build.'
);
assert.ok(
  table.resolved.endsWith(`#${manifest.tablePlugin.commit}`),
  `The lockfile resolves the table plugin to ${table.resolved}, not the pinned commit ${manifest.tablePlugin.commit}.`
);

const builtIndex = process.argv.indexOf('--built');
if (builtIndex >= 0) {
  const directory = process.argv[builtIndex + 1];
  assert.ok(
    directory && !directory.startsWith('--'),
    '--built needs a directory'
  );
  for (const [name, hash] of Object.entries(manifest.runtimeFiles)) {
    let bytes = await fs.readFile(path.resolve(directory, name));
    if (name === 'ckeditor.js') {
      // Upstream's getLicenseBanner() inserts the current calendar year. Only
      // normalize that generated copyright banner for comparison; never rewrite
      // the supplied build or any executable code.
      bytes = Buffer.from(
        bytes
          .toString('utf8')
          .replace(
            /(@license Copyright \(c\) 2003-)\d{4}(, CKSource Holding sp\. z o\.o\. All rights reserved\.)/g,
            `$1${manifest.generatedBannerYear}$2`
          )
      );
    }
    assert.equal(sha256(bytes), hash, `Rebuilt file differs: ${name}`);
  }
  console.log(
    `Rebuilt ${Object.keys(manifest.runtimeFiles).length} files match (generated banner year normalized for comparison).`
  );
}
console.log(
  `CKEditor ${manifest.ckeditorVersion}: pinned source and runtime verified at ${manifest.upstreamCommit}.`
);
