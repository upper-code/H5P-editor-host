const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { repoRoot, tmpDir } = require('./helpers');

async function runHost(t, settings, stopWhenStarted = false) {
  const dataDir = tmpDir(t, 'host-start-');
  if (stopWhenStarted) {
    // Exercise recovery's wait timer and the process-lock heartbeat at startup.
    fs.mkdirSync(path.join(dataDir, 'tenants', 'existing', 'content'), {
      recursive: true
    });
  }
  const child = spawn(process.execPath, ['build/src/main.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'info',
      H5P_HOST_SHARED_SECRET: 'startup-test-secret',
      H5P_HOST_DATA_DIR: dataDir,
      H5P_LIBRARIES_DIR: path.join(dataDir, 'libraries'),
      H5P_HOST_UPLOAD_TMP_DIR: path.join(dataDir, 'upload-tmp'),
      ...settings
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let stopping = false;
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (
      stopWhenStarted &&
      !stopping &&
      output.includes('H5P editor host started')
    ) {
      stopping = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  t.after(() => {
    clearTimeout(timer);
    child.kill('SIGKILL');
  });
  const code = await exited;
  clearTimeout(timer);
  return { code, output };
}

const timerSettings = [
  'H5P_HOST_MUTATION_WAIT_MS',
  'H5P_HOST_RECOVERY_WAIT_MS',
  'H5P_HOST_TEMP_SWEEP_INTERVAL_MS',
  'H5P_HOST_JOURNAL_SWEEP_INTERVAL_MS',
  'H5P_HOST_SHUTDOWN_GRACE_MS',
  'H5P_HOST_IMPORT_TIMEOUT_MS'
];

// Invalid limits must stop the process before it listens, including on a fresh
// deployment where no request has acquired a content lock yet.
for (const [name, value] of [
  ['H5P_HOST_SHUTDOWN_GRACE_MS', '30_000'],
  ...timerSettings.map((name) => [name, String(2 ** 31)]),
  ['H5P_HOST_LOCK_STALE_MS', String(3 * (2 ** 31 - 1) + 1)],
  ['H5P_HOST_LOCK_MAX_HOLD_MS', '1h']
]) {
  test(`${name}=${value} stops startup before the port opens`, async (t) => {
    const { code, output } = await runHost(t, { [name]: value });
    assert.equal(code, 1, `the start failed: ${output}`);
    assert.match(output, new RegExp(`${name} must be a number`));
    assert.doesNotMatch(output, /H5P editor host started/);
    assert.doesNotMatch(output, /TimeoutOverflowWarning/);
  });
}

for (const limit of [0, 2 ** 31 - 1]) {
  test(`timer budgets of ${limit} allow startup and graceful shutdown`, async (t) => {
    const settings = Object.fromEntries(
      timerSettings.map((name) => [name, String(limit)])
    );
    settings.H5P_HOST_IMPORT_TIMEOUT_MS = String(Math.max(1, limit));
    settings.H5P_HOST_LOCK_STALE_MS = String(Math.max(1000, 3 * limit));
    // These values are ages, not timer delays; they may exceed 2^31 - 1.
    for (const name of [
      'H5P_HOST_TENANT_CACHE_TTL_MS',
      'H5P_HOST_READINESS_CACHE_MS',
      'H5P_HOST_OPERATION_RETENTION_MS',
      'H5P_HOST_TEMP_FILE_LIFETIME_MS',
      'H5P_HOST_LOCK_MAX_HOLD_MS'
    ]) {
      settings[name] = String(2 ** 32);
    }
    const { code, output } = await runHost(t, settings, true);
    assert.equal(code, 0, output);
    assert.match(output, /H5P editor host started/);
    assert.match(output, /H5P editor host stopped/);
    assert.doesNotMatch(output, /TimeoutOverflowWarning/);
  });
}
