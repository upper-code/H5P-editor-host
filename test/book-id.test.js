const assert = require('node:assert/strict');
const test = require('node:test');

const { bookIdOf, withBookId } = require('../build/src/book-id');

test('the book id is the first @id entry of the author comments', () => {
  assert.equal(
    bookIdOf('@id=4D682A53-7E2E-4DD6-8314-D17719E5D3DC;'),
    '4D682A53-7E2E-4DD6-8314-D17719E5D3DC'
  );
  assert.equal(bookIdOf('popup=true;\n@id = abc-2 ;'), 'abc-2');
  assert.equal(bookIdOf('id=abc-4;'), 'abc-4', 'the "@" is optional');
  assert.equal(bookIdOf('@id=first;@id=second;'), 'first');
  assert.equal(bookIdOf('@id=abc-3'), undefined, 'the id ends with ";"');
  assert.equal(bookIdOf('bookid=abc;'), undefined);
  assert.equal(bookIdOf(undefined), undefined);
});

test('a book id is appended on its own line, never over an existing one', () => {
  assert.deepEqual(withBookId({ title: 'Book' }, 'abc'), {
    title: 'Book',
    authorComments: '@id=abc;'
  });
  assert.equal(
    withBookId({ authorComments: 'popup=true;  \n' }, 'abc').authorComments,
    'popup=true;\n@id=abc;'
  );
  assert.equal(
    withBookId({ authorComments: ' \r\n' }, 'abc').authorComments,
    '@id=abc;'
  );
  // CyberShelf-PWA reads the id with its own expression; it must find the
  // same one after the author's text.
  const pwa = /(?<=id=\s*)(\S+)(?=\s*;)/im;
  const uuid = '4d682a53-7e2e-4dd6-8314-d17719e5d3dc';
  for (const text of [undefined, 'popup=true;', 'a note']) {
    const { authorComments } = withBookId({ authorComments: text }, uuid);
    assert.equal(pwa.exec(authorComments)?.[0], uuid, String(text));
  }
  const named = { authorComments: 'popup=true;\nid=mine;' };
  assert.equal(withBookId(named, 'abc'), named);
});

test('author comments that leave no room for the id refuse the save', () => {
  // h5p-server refuses author comments longer than 5000 characters; the
  // entry "\n@id=<uuid>;" takes 42 of them.
  const uuid = '4d682a53-7e2e-4dd6-8314-d17719e5d3dc';
  const fits = withBookId({ authorComments: 'x'.repeat(4958) }, uuid);
  assert.equal(fits.authorComments.length, 5000);
  assert.ok(fits.authorComments.endsWith(`\n@id=${uuid};`));
  assert.throws(
    () => withBookId({ authorComments: 'x'.repeat(4959) }, uuid),
    (error) =>
      error.statusCode === 422 &&
      error.code === 'author-comments-too-long' &&
      error.message.includes('Shorten them by 1 character and')
  );
  assert.throws(
    () => withBookId({ authorComments: 'x'.repeat(4960) }, uuid),
    /Shorten them by 2 characters and/
  );
  // Trailing whitespace is dropped before the text is measured.
  assert.equal(
    withBookId({ authorComments: `${'x'.repeat(4958)} \n ` }, uuid)
      .authorComments,
    fits.authorComments
  );
  // Comments that already name an id are not measured here.
  const named = { authorComments: `${'x'.repeat(4990)}\nid=a;` };
  assert.equal(withBookId(named, uuid), named);
});
