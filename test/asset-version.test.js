const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Every `/h5p/core` and `/h5p/editor` URL carries `?version=1.28-<package
// version>` and is cached for a year (src/h5p/config.ts), so a change to the
// committed trees that ships without a version bump stays invisible to every
// browser that has the old file. The record below ties the trees' digest to
// the version that serves them; it is updated together with every version
// bump, so a tree change can only pass under a version nobody has cached yet.

const appRoot = path.resolve(__dirname, '..');
const recordFile = path.join(__dirname, 'fixtures/runtime-assets.json');

function treeDigest() {
  const hash = crypto.createHash('sha256');
  for (const tree of ['core', 'editor']) {
    const root = path.join(appRoot, 'assets/h5p', tree);
    const files = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== '.DS_Store')
      .map((entry) =>
        path
          .relative(root, path.join(entry.parentPath, entry.name))
          .split(path.sep)
          .join('/')
      )
      .sort();
    for (const file of files) {
      const content = fs.readFileSync(path.join(root, file));
      hash.update(`${tree}/${file}\0`);
      hash.update(crypto.createHash('sha256').update(content).digest('hex'));
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

test('a change to the vendored runtime ships under a new package version', () => {
  const { version } = require('../package.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const sha256 = treeDigest();
  const update = `set ${path.relative(appRoot, recordFile)} to ${JSON.stringify({ version, sha256 })}`;
  if (record.sha256 !== sha256 && record.version === version) {
    assert.fail(
      `assets/h5p/{core,editor} changed under version ${version}: bump ` +
        `"version" in package.json (docs/DEVELOPMENT.md), then ${update}.`
    );
  }
  assert.deepEqual(
    record,
    { version, sha256 },
    `The record names another version or tree: ${update}.`
  );
});
