const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('the host includes its H5P dependencies and editor runtime', () => {
  const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.match(packageJson, /@lumieducation\/h5p-server/);
  assert.match(packageJson, /@lumieducation\/h5p-express/);

  // H5P core, the H5P editor runtime and its bundled CKEditor are the only
  // library-like assets tracked here.
  assert.equal(fs.existsSync(path.join(root, 'assets/h5p/core')), true);
  assert.equal(fs.existsSync(path.join(root, 'assets/h5p/editor')), true);
  assert.equal(
    fs.existsSync(path.join(root, 'assets/h5p/editor/ckeditor')),
    true
  );
});

test('content-type H5P libraries use the provisioned runtime directory', () => {
  // Check the deployment layout, not the licensing of an integration.
  assert.equal(fs.existsSync(path.join(root, 'assets/h5p/libraries')), false);

  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(
    gitignore,
    /^\.host-data\/?$/m,
    'the runtime library directory (.host-data) must be git-ignored'
  );
});
