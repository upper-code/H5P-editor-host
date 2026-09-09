const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertContentId,
  isSafeH5pSubPath
} = require('../build/src/content-id');

test('content-id-bearing H5P routes accept only numeric ids', () => {
  assert.equal(isSafeH5pSubPath('/content/5/images/pic.png'), true);
  assert.equal(isSafeH5pSubPath('/params/5'), true);
  assert.equal(isSafeH5pSubPath('/download/42'), true);

  // Non-numeric ids on these routes are rejected before the GPL router joins
  // them onto filesystem content storage.
  assert.equal(isSafeH5pSubPath('/content/abc/file.png'), false);
  assert.equal(isSafeH5pSubPath('/params/new'), false);
  assert.equal(isSafeH5pSubPath('/download/..'), false);
});

test('literal dot segments are rejected everywhere', () => {
  assert.equal(isSafeH5pSubPath('/params/..'), false);
  assert.equal(isSafeH5pSubPath('/content/../../etc/passwd'), false);
  assert.equal(isSafeH5pSubPath('/libraries/../secret'), false);
  assert.equal(isSafeH5pSubPath('/./ajax'), false);
});

// req.path is still percent-encoded, so the guard has to decode each segment;
// otherwise `%2e%2e` walks straight past a literal `..` comparison.
test('percent-encoded dot segments are rejected too', () => {
  assert.equal(isSafeH5pSubPath('/libraries/%2e%2e/secret'), false);
  assert.equal(isSafeH5pSubPath('/temp-files/%2E%2E/x'), false);
  assert.equal(isSafeH5pSubPath('/ajax/%2e'), false);
});

test('non-content H5P routes pass through untouched', () => {
  assert.equal(isSafeH5pSubPath('/ajax'), true);
  assert.equal(
    isSafeH5pSubPath('/libraries/H5P.Blanks-1.14/js/blanks.js'),
    true
  );
  assert.equal(isSafeH5pSubPath('/temp-files/abc123-file.png'), true);
});

test('assertContentId accepts stored ids and, when asked, the creation form', () => {
  assert.equal(assertContentId('42'), '42');
  assert.equal(assertContentId('new', { creatable: true }), 'new');

  for (const bad of ['..', '.', 'new', 'abc', '', '1/2', '1 ']) {
    assert.throws(() => assertContentId(bad), { statusCode: 400 }, bad);
  }
  // `new` is the only accepted creation form; the literal `undefined` (a client
  // that serialized a JS `undefined` into the URL) is rejected, not treated as
  // "create new".
  for (const bad of ['..', '.', 'abc', '', 'undefined']) {
    assert.throws(
      () => assertContentId(bad, { creatable: true }),
      { statusCode: 400 },
      bad
    );
  }
});

test('content ID checks follow the case-insensitive Express route matching', () => {
  for (const head of ['CONTENT', 'Params', 'Download']) {
    assert.equal(isSafeH5pSubPath(`/${head}/abc`), false);
    assert.equal(isSafeH5pSubPath(`/${head}/7`), true);
  }
});
