const assert = require('node:assert/strict');
const test = require('node:test');

const HostError = require('../build/src/errors').default;
const { mapContentNotFound } = require('../build/src/errors');

// h5p-server reports a missing content id with an H5pError whose `.message` is a
// raw error id (e.g. `content-file-missing (filename: h5p.json, contentId: 5)`).
// The content routes pass such errors through mapContentNotFound so the client
// sees a uniform 404 instead of that internal id.
test('mapContentNotFound rewrites a 404 into a clean HostError', () => {
  const original = new Error('content-file-missing (contentId: 5)');
  original.httpStatusCode = 404;

  const mapped = mapContentNotFound(original);

  assert.ok(mapped instanceof HostError);
  assert.equal(mapped.statusCode, 404);
  assert.equal(mapped.message, 'Content not found.');
});

test('mapContentNotFound leaves non-404 errors untouched', () => {
  const serverError = new Error('h5p-server:something-internal');
  serverError.httpStatusCode = 500;
  assert.equal(mapContentNotFound(serverError), serverError);

  const validationError = new HostError('Bad request.', 400);
  assert.equal(mapContentNotFound(validationError), validationError);
});

test('mapContentNotFound tolerates a missing or non-error value', () => {
  assert.equal(mapContentNotFound(undefined), undefined);
  assert.equal(mapContentNotFound(null), null);
});
