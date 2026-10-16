const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '../web/vmb-environment.js'),
  'utf8'
);

/** Runs the script in a fresh page realm with the given globals. */
function page(globals = {}) {
  const context = { ...globals };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SCRIPT, context);
  return context;
}

test('a page that loaded VMB.SyncLesson gets an empty, frozen ActivePackage', () => {
  const window = page({ VMB: { SyncLesson: class {} } });
  assert.equal(typeof window.ActivePackage, 'object');
  assert.deepEqual(Object.keys(window.ActivePackage), []);
  assert.equal(Object.isFrozen(window.ActivePackage), true);
  // VMB.Context resolves its own files through the H5P core unless this is
  // set: it must stay unset.
  assert.equal(window.VMB.isBookRT, undefined);
});

test('without VMB.SyncLesson the page is left alone', () => {
  for (const globals of [{}, { VMB: {} }, { VMB: { SyncLesson: 'x' } }]) {
    const window = page(globals);
    assert.equal('ActivePackage' in window, false, JSON.stringify(globals));
  }
});

test('an ActivePackage the page already has is kept', () => {
  const own = { getActiveLibrary() {} };
  const window = page({ VMB: { SyncLesson: class {} }, ActivePackage: own });
  assert.equal(window.ActivePackage, own);
});
