const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(__dirname, '../scripts/patch-image-size.mjs');
const {
  assertImageSizePatched,
  imageSizeDirectory
} = require('../build/src/image-size-patch');

const patchModule = () => import(pathToFileURL(scriptPath).href);

function runScript(...args) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve(__dirname, '..')
  }).catch((error) => error);
}

// Rebuilds the unpatched sources from the installed copy by reversing the
// script's own edits, so the suite needs no second copy of the package.
async function pristineCopy(t) {
  const { EDITS, resolveImageSizeDirectory } = await patchModule();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-size-pristine-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.cp(resolveImageSizeDirectory(), dir, { recursive: true });
  for (const { file, replacements } of EDITS) {
    const target = path.join(dir, file);
    let text = await fs.readFile(target, 'utf8');
    for (const { from, to } of replacements) {
      assert.ok(text.includes(to), `${file} in node_modules carries the fix`);
      text = text.replace(to, () => from);
    }
    await fs.writeFile(target, text);
  }
  return dir;
}

test('the installed image-size is the fixed version and both resolvers agree on it', async () => {
  const { PATCHED_VERSION, resolveImageSizeDirectory } = await patchModule();
  const directory = resolveImageSizeDirectory();
  assert.equal(imageSizeDirectory(), directory);
  const { version } = JSON.parse(
    await fs.readFile(path.join(directory, 'package.json'), 'utf8')
  );
  assert.equal(version, PATCHED_VERSION);
  await assertImageSizePatched();
  const check = await runScript('--check');
  assert.equal(check.code ?? 0, 0, check.stderr);
  assert.match(check.stdout, /already applied/);
});

test('the script patches a clean copy to exactly the installed sources and is idempotent', async (t) => {
  const { EDITS, applyImageSizePatch, resolveImageSizeDirectory } =
    await patchModule();
  const pristine = await pristineCopy(t);
  await assert.rejects(assertImageSizePatched(pristine), /is not patched/);
  assert.deepEqual(
    await applyImageSizePatch(pristine, { check: true }),
    EDITS.map((edit) => edit.file),
    '--check reports without writing'
  );
  await assert.rejects(assertImageSizePatched(pristine), /is not patched/);
  assert.deepEqual(
    await applyImageSizePatch(pristine),
    EDITS.map((edit) => edit.file)
  );
  for (const { file } of EDITS) {
    assert.equal(
      await fs.readFile(path.join(pristine, file), 'utf8'),
      await fs.readFile(path.join(resolveImageSizeDirectory(), file), 'utf8'),
      file
    );
  }
  await assertImageSizePatched(pristine);
  assert.deepEqual(await applyImageSizePatch(pristine), []);
});

test('a foreign version or altered text is refused without writing', async (t) => {
  const { EDITS, applyImageSizePatch } = await patchModule();
  const pristine = await pristineCopy(t);
  const manifest = path.join(pristine, 'package.json');
  const original = await fs.readFile(manifest, 'utf8');
  await fs.writeFile(
    manifest,
    original.replace(/"version": "[^"]+"/, '"version": "9.9.9"')
  );
  await assert.rejects(applyImageSizePatch(pristine), /written for 1\.2\.1/);
  await fs.writeFile(manifest, original);

  const { file, replacements } = EDITS[0];
  const target = path.join(pristine, file);
  const text = await fs.readFile(target, 'utf8');
  await fs.writeFile(
    target,
    text.replace(replacements[0].from, () => '/* unexpected */')
  );
  await assert.rejects(
    applyImageSizePatch(pristine),
    /does not contain the text/
  );
  for (const edit of EDITS.slice(1)) {
    assert.ok(
      !(await fs.readFile(path.join(pristine, edit.file), 'utf8')).includes(
        edit.replacements[0].to
      ),
      'nothing is written when one file cannot be patched'
    );
  }
});
