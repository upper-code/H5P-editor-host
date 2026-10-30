const assert = require('node:assert/strict');
const test = require('node:test');

const { savePayload } = require('../build/src/save-payload');
const { nestedLibraries } = require('../build/src/library-resolution');

/** `{ library, params: { child: { library, params: … } } }`, `levels` deep. */
function nested(levels) {
  let params = { text: 'leaf' };
  for (let level = 0; level < levels; level += 1) {
    params = { child: { library: 'H5P.Text 1.1', params } };
  }
  return params;
}

test('a save body nested beyond any real content is refused with 400', () => {
  assert.throws(
    () =>
      savePayload({
        library: 'H5P.Column 1.18',
        params: nested(8000),
        metadata: {}
      }),
    { statusCode: 400, message: 'The content is nested too deeply.' }
  );
});

test('a deeply nested real-world book is still accepted', () => {
  const body = { library: 'H5P.Column 1.18', params: nested(40), metadata: {} };
  assert.equal(savePayload(body).params, body.params);
});

test('counting nested libraries does not overflow the stack on stored content', () => {
  // Stored content — an imported package included — never passed the save
  // body's depth check.
  assert.equal(nestedLibraries(nested(8000)).get('H5P.Text 1.1'), 8000);
});
