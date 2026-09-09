/*
 * Fixtures shared by the test files here.
 *
 * Everything that creates state takes the test context and undoes itself
 * through `t.after`: a temp tree or an environment variable left behind is
 * invisible until it makes another test fail — or fills the disk.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/** The repository root; the scripts and tracked assets live under it. */
const repoRoot = path.resolve(__dirname, '..');

/** One of the repository's scripts, by file name. */
const script = (name) => path.join(repoRoot, 'scripts', name);

/** A temp directory of this test's own, removed when the test ends. */
function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Sets environment variables for one test and puts the previous values back
 * afterwards — including "was not set at all", which every variable the host
 * reads treats differently from an empty one.
 */
function withEnv(t, values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * Writes one H5P library directory under `root`: `library.json` from `meta`,
 * plus any `{ 'relative/path': contents }` files. Returns its path.
 */
async function writeLibrary(root, name, meta, files = {}) {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'library.json'),
    JSON.stringify(meta, null, 2)
  );
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(dir, file);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, contents);
  }
  return dir;
}

/**
 * Runs one of the scripts/ to completion. A non-zero exit is not an exception
 * here: the exit code and the output are what these tests assert on, so a
 * failure comes back like a result.
 */
function runScript(scriptPath, args = [], env = {}) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, ...env }
  }).catch((error) => error);
}

module.exports = {
  repoRoot,
  runScript,
  script,
  tmpDir,
  withEnv,
  writeLibrary
};
