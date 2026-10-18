const assert = require('node:assert/strict');
const test = require('node:test');

const {
  bookIdMode,
  bookIdOf,
  canonicalBookId,
  isBookId,
  parseBookId
} = require('../build/src/book-id');
// Shared with the embedder, the catalogue and the device app, which copy it
// verbatim: every reader of a book id must agree with this host on it.
const fixture = require('./fixtures/book-id-fixture.json');

const uuid = '4d682a53-7e2e-4dd6-8314-d17719e5d3dc';
const fresh =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the book id parser agrees with the shared fixture', () => {
  assert.ok(fixture.length > 10);
  for (const { authorComments, expected, id } of fixture) {
    assert.deepEqual(
      parseBookId(authorComments),
      expected === 'valid' ? { state: 'valid', id } : { state: expected },
      JSON.stringify(authorComments)
    );
    assert.equal(
      bookIdOf(authorComments),
      expected === 'valid' ? id : undefined
    );
  }
  assert.deepEqual(parseBookId(undefined), { state: 'missing' });
  assert.deepEqual(parseBookId(42), { state: 'missing' });
});

test('a book id is a UUID other than the zero one; a mode is keep, new or one', () => {
  assert.equal(isBookId(uuid.toUpperCase()), true);
  assert.equal(isBookId('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(isBookId(`{${uuid}}`), false);
  assert.equal(isBookId(uuid.replace(/-/g, '')), false);
  assert.equal(bookIdMode('keep'), 'keep');
  assert.equal(bookIdMode('new'), 'new');
  assert.equal(bookIdMode(uuid.toUpperCase()), uuid);
  for (const value of [
    undefined,
    '',
    'KEEP',
    'not-a-uuid',
    '00000000-0000-0000-0000-000000000000',
    42
  ]) {
    assert.throws(
      () => bookIdMode(value),
      (error) => error.statusCode === 400 && error.code === 'invalid-book-id',
      String(value)
    );
  }
});

test('keep writes a valid id in its canonical form, where it stands', () => {
  const keep = (authorComments) =>
    canonicalBookId({ title: 'Book', authorComments }, 'keep');
  const canonical = { title: 'Book', authorComments: `@id=${uuid};` };
  // Already canonical: the same object back, nothing to write.
  assert.equal(canonicalBookId(canonical, 'keep').metadata, canonical);
  assert.equal(canonicalBookId(canonical, 'keep').bookId, uuid);
  const upper = uuid.toUpperCase();
  for (const [given, written] of [
    [`@id=${upper};`, `@id=${uuid};`],
    [`ID = ${upper} ;`, `@id=${uuid};`],
    [`@id=${upper};@popup=true;`, `@id=${uuid};\n@popup=true;`],
    [`popup=true; @id=${uuid}; note`, `popup=true;\n@id=${uuid};\nnote`],
    [`Text\n@id=${uuid};\n`, `Text\n@id=${uuid};\n`],
    [`Text\r\n  id=${upper};\r\nmore`, `Text\r\n@id=${uuid};\r\nmore`]
  ]) {
    const { metadata, bookId } = keep(given);
    assert.equal(metadata.authorComments, written, JSON.stringify(given));
    assert.equal(bookId, uuid);
    assert.equal(metadata.title, 'Book');
  }
  // The device app's older parser must find the canonical id as well.
  const pwa = /(?<=@id=\s*)(\S+)(?=\s*;)/;
  assert.equal(
    pwa.exec(keep(`@id=${upper};@popup=true;`).metadata.authorComments)[0],
    uuid
  );
});

test('keep gives a book without an id a fresh one and leaves an invalid one', () => {
  const appended = canonicalBookId(
    { authorComments: 'popup=true;  \n' },
    'keep'
  );
  assert.match(appended.bookId, fresh);
  assert.equal(
    appended.metadata.authorComments,
    `popup=true;\n@id=${appended.bookId};`
  );
  const bare = canonicalBookId({ title: 'Book' }, 'keep');
  assert.deepEqual(bare.metadata, {
    title: 'Book',
    authorComments: `@id=${bare.bookId};`
  });
  assert.equal(
    canonicalBookId({ authorComments: ' \r\n' }, 'keep').metadata.authorComments
      .length,
    41
  );
  for (const { authorComments, expected } of fixture) {
    if (expected !== 'invalid') continue;
    const metadata = { authorComments };
    assert.deepEqual(canonicalBookId(metadata, 'keep'), {
      metadata,
      bookId: null
    });
  }
});

test('new or a given id replaces every declaration, or is appended', () => {
  const other = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  for (const [given, written] of [
    [undefined, `@id=${other};`],
    ['note', `note\n@id=${other};`],
    [`@id=${uuid};`, `@id=${other};`],
    ['@id=not-a-uuid;', `@id=${other};`],
    [`a\n@id=${uuid};\n@id=${uuid};\nb`, `a\n@id=${other};\nb`],
    [`@id=${uuid};@id=x;@popup=true;`, `@id=${other};\n@popup=true;`],
    [`x @id=1; y id=2; z`, `x\n@id=${other};\ny z`]
  ]) {
    const { metadata, bookId } = canonicalBookId(
      { authorComments: given },
      other.toUpperCase()
    );
    assert.equal(metadata.authorComments, written, JSON.stringify(given));
    assert.equal(bookId, other);
  }
  const drawn = canonicalBookId({ authorComments: `@id=${uuid};` }, 'new');
  assert.match(drawn.bookId, fresh);
  assert.notEqual(drawn.bookId, uuid);
  assert.equal(drawn.metadata.authorComments, `@id=${drawn.bookId};`);
  assert.throws(
    () => canonicalBookId({}, 'not-a-uuid'),
    (error) => error.code === 'invalid-book-id'
  );
});

test('author comments that leave no room for the id refuse the write', () => {
  // h5p-server refuses author comments longer than 5000 characters; the
  // entry "\n@id=<uuid>;" takes 42 of them.
  const fits = canonicalBookId({ authorComments: 'x'.repeat(4958) }, uuid);
  assert.equal(fits.metadata.authorComments.length, 5000);
  assert.ok(fits.metadata.authorComments.endsWith(`\n@id=${uuid};`));
  for (const mode of ['keep', 'new', uuid]) {
    assert.throws(
      () => canonicalBookId({ authorComments: 'x'.repeat(4959) }, mode),
      (error) =>
        error.statusCode === 422 &&
        error.code === 'author-comments-too-long' &&
        error.message.includes('Shorten them by 1 character and')
    );
  }
  assert.throws(
    () => canonicalBookId({ authorComments: 'x'.repeat(4960) }, uuid),
    /Shorten them by 2 characters and/
  );
  // Trailing whitespace is dropped before the text is measured.
  assert.equal(
    canonicalBookId({ authorComments: `${'x'.repeat(4958)} \n ` }, uuid)
      .metadata.authorComments,
    fits.metadata.authorComments
  );
  // Putting an id on a line of its own counts too.
  assert.throws(
    () =>
      canonicalBookId(
        { authorComments: `${'x'.repeat(4963)}@id=${uuid};` },
        'keep'
      ),
    (error) => error.code === 'author-comments-too-long'
  );
  // An invalid id kept as it is is not measured here.
  const invalid = { authorComments: `${'x'.repeat(4990)}\nid=a;` };
  assert.equal(canonicalBookId(invalid, 'keep').metadata, invalid);
});
