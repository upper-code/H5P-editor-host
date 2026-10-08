const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Local fixes to the vendored H5P core and editor are kept as patch files in
// assets/h5p/patches/<tree>/ and re-applied by scripts/fetch-h5p-assets.sh on
// every upgrade, in file-name order. The committed trees must contain what
// that sequence produces: a patched hunk edited in the tree but not in its
// patch file would be lost on the next fetch, and a patch file the tree lacks
// was never applied. (A local edit outside every hunk is not visible here; the
// fetch script's parity check reports it.)
//
// The sequence is checked as a whole on a scratch copy of the patched files:
// peeled off in reverse order, then applied again in order. Checking each
// patch on its own against the final tree would fail falsely as soon as a
// later patch touches the context of an earlier one.

const appRoot = path.resolve(__dirname, '..');
const patchesDir = path.join(appRoot, 'assets/h5p/patches');

function patchesOf(tree) {
  const dir = path.join(patchesDir, tree);
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.patch'))
        .sort()
        .map((file) => path.join(dir, file))
    : [];
}

// Tree-relative paths a patch reads or writes (`--- a/x`, `+++ b/x`). A plain
// `diff -u` appends a tab and a timestamp to the name; `/dev/null` (a created
// or deleted file) has no `a/`/`b/` prefix and is skipped.
function touchedFiles(patch) {
  const files = new Set();
  for (const line of fs.readFileSync(patch, 'utf8').split('\n')) {
    const match = /^(?:---|\+\+\+) [ab]\/([^\t]+)/.exec(line);
    if (match) files.add(match[1]);
  }
  return [...files];
}

// Copies the files the patches touch into a scratch directory laid out like
// the tree, so `git apply` can run on it without touching the checkout.
function scratchCopy(t, tree, patches) {
  const treeDir = path.join(appRoot, 'assets/h5p', tree);
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), `asset-patches-${tree}-`)
  );
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const files = [...new Set(patches.flatMap(touchedFiles))];
  for (const file of files) {
    const source = path.join(treeDir, file);
    if (fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
      fs.copyFileSync(source, path.join(scratch, file));
    }
  }
  const snapshot = () =>
    Object.fromEntries(
      files.map((file) => {
        const target = path.join(scratch, file);
        return [
          file,
          fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
        ];
      })
    );
  return { scratch, snapshot };
}

function gitApply(cwd, patch, reverse) {
  execFileSync(
    'git',
    ['apply', ...(reverse ? ['-R'] : []), '--whitespace=nowarn', patch],
    { cwd, stdio: 'pipe' }
  );
}

test('only known trees carry patches, and core has some', () => {
  assert.deepEqual(
    fs
      .readdirSync(patchesDir)
      .filter((entry) => !entry.startsWith('.'))
      .sort(),
    ['core', 'editor']
  );
  assert.ok(patchesOf('core').length > 0);
});

for (const tree of ['core', 'editor']) {
  const patches = patchesOf(tree);
  if (patches.length === 0) continue;

  test(`the ${tree} patch sequence is applied to the committed tree`, (t) => {
    const { scratch, snapshot } = scratchCopy(t, tree, patches);
    const committed = snapshot();

    // Peel the patches off, last first. Each one must reverse cleanly and
    // change something, so a patch whose paths matched nothing cannot pass.
    for (const patch of [...patches].reverse()) {
      const before = snapshot();
      assert.doesNotThrow(
        () => gitApply(scratch, patch, true),
        `${path.basename(patch)} reverses on the tree`
      );
      assert.notDeepEqual(
        snapshot(),
        before,
        `${path.basename(patch)} changes nothing`
      );
    }

    // What is left is the upstream base; the sequence must rebuild the
    // committed files from it byte for byte.
    for (const patch of patches) {
      assert.doesNotThrow(
        () => gitApply(scratch, patch, false),
        `${path.basename(patch)} applies in sequence`
      );
    }
    assert.deepEqual(snapshot(), committed);
  });

  for (const patch of patches) {
    test(`${tree}/${path.basename(patch)} marks the patched file as modified`, () => {
      // Each patch adds the dated "Local patch" or "Host patch" note that
      // GPLv3 section 5a asks of a modified file.
      const added = fs
        .readFileSync(patch, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
      assert.ok(
        added.some((line) => /(Local|Host) patch/.test(line)),
        'the patch adds a modification notice'
      );
    });
  }
}
