const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
  sweepExpired,
  directorySize,
  TempReservations
} = require('../build/src/temp-storage');
const { tmpDir } = require('./helpers');

function tmpTree(t) {
  const root = tmpDir(t, 'host-temp-');
  fs.mkdirSync(path.join(root, 'user-1/nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'user-1/fresh.png'), 'ab');
  fs.writeFileSync(path.join(root, 'user-1/nested/old.png'), 'abcd');
  fs.writeFileSync(path.join(root, 'user-1/nested/old.png.metadata'), '{}');
  const old = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(
    path.join(root, 'user-1/nested/old.png'),
    old / 1000,
    old / 1000
  );
  fs.utimesSync(
    path.join(root, 'user-1/nested/old.png.metadata'),
    old / 1000,
    old / 1000
  );
  return root;
}

test('expired temporary files and the directories they leave empty are removed', async (t) => {
  const root = tmpTree(t);
  const removed = await sweepExpired(root, 30 * 60 * 1000);

  assert.equal(removed, 2, 'the expired file and its metadata sidecar');
  assert.equal(fs.existsSync(path.join(root, 'user-1/nested')), false);
  assert.equal(fs.existsSync(path.join(root, 'user-1/fresh.png')), true);
});

test('a sweep leaves everything alone while nothing has expired', async (t) => {
  const root = tmpTree(t);
  assert.equal(await sweepExpired(root, 24 * 60 * 60 * 1000), 0);
  assert.equal(fs.existsSync(path.join(root, 'user-1/nested/old.png')), true);
});

test('a missing directory is not an error', async () => {
  assert.equal(await sweepExpired('/definitely/not/here', 1000), 0);
});

test('directorySize sums nested files', async (t) => {
  const root = tmpTree(t);
  assert.equal(await directorySize(root), 2 + 4 + 2);
});

test('directorySize treats an absent directory as empty but propagates storage errors', async (t) => {
  const root = tmpTree(t);
  assert.equal(await directorySize(path.join(root, 'missing')), 0);
  await assert.rejects(directorySize(path.join(root, 'user-1/fresh.png')), {
    code: 'ENOTDIR'
  });
});

test('directorySize retains its partial total if the janitor removes a scanned file', async (t) => {
  const root = tmpTree(t);
  const original = fsp.lstat;
  t.mock.method(fsp, 'lstat', async (filename, ...args) => {
    if (filename.endsWith('fresh.png')) {
      await fsp.rm(filename, { force: true });
    }
    return original(filename, ...args);
  });
  assert.equal(await directorySize(root), 4 + 2);
});

test('temp reservations are budgeted first come, first served and released per request', () => {
  const reservations = new TempReservations();
  const first = reservations.reserve('tenant', 6);
  const second = reservations.reserve('tenant', 6);
  const other = reservations.reserve('other', 3);
  assert.equal(first.budget, 6, 'a request is not charged for a later arrival');
  assert.equal(second.budget, 12, 'but is charged for the ones ahead of it');
  assert.equal(other.budget, 3, 'tenants do not share a budget');
  first.release();
  first.release();
  assert.equal(
    reservations.reservedFor('tenant'),
    6,
    'a second release is a no-op'
  );
  assert.equal(reservations.reserve('tenant', 1).budget, 7);
  second.release();
  assert.equal(reservations.reservedFor('tenant'), 1);
  other.release();
  assert.equal(reservations.reservedFor('other'), 0);
});

test('overlapping uploads share one measurement; released uploads count as landed until idle', async () => {
  const reservations = new TempReservations();
  let measurements = 0;
  const measure = async () => {
    measurements += 1;
    return 100;
  };
  const first = reservations.reserve('tenant', 6);
  assert.equal(await reservations.used('tenant', measure), 100);
  const second = reservations.reserve('tenant', 1);
  assert.equal(
    await reservations.used('tenant', measure),
    100,
    'an in-flight upload counts by its reservation only'
  );
  second.release();
  const third = reservations.reserve('tenant', 4);
  assert.equal(third.budget, 6 + 4);
  assert.equal(
    await reservations.used('tenant', measure),
    101,
    'a released upload is assumed to have landed'
  );
  assert.equal(measurements, 1, 'one measurement per burst');
  first.release();
  third.release();
  const fourth = reservations.reserve('tenant', 1);
  assert.equal(
    await reservations.used('tenant', measure),
    100,
    'idle again: measured afresh'
  );
  assert.equal(measurements, 2);
  await assert.rejects(
    reservations.used('other', async () => {
      throw new Error('EIO');
    })
  );
  assert.equal(
    await reservations.used('other', measure),
    100,
    'a failed measurement is retried'
  );
  fourth.release();
});
