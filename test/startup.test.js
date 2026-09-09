const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');

const { repoRoot, tmpDir } = require('./helpers');

// A mistyped limit has to stop the start, not survive it: past `app.listen`
// the throw leaves a process that serves requests with no signal handler
// installed, so a deploy could only ever end it with SIGKILL — mid-save.
test('a mistyped shutdown grace period stops the start before the port opens', async (t) => {
  const dataDir = tmpDir(t, 'host-start-');
  const child = spawn(process.execPath, ['build/src/main.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: '0',
      H5P_HOST_DATA_DIR: dataDir,
      H5P_HOST_SHUTDOWN_GRACE_MS: '30_000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const code = await exited;
  clearTimeout(timer);
  assert.equal(code, 1, `the start failed: ${output}`);
  assert.match(output, /H5P_HOST_SHUTDOWN_GRACE_MS must be a number/);
  assert.doesNotMatch(
    output,
    /H5P editor host started/,
    'the port must not open before the configuration is read'
  );
});
