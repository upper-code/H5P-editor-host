import crypto from 'crypto';

import HostError from './errors';

/**
 * A book keeps its identity across versions as an `@id=<uuid>;` entry in
 * `h5p.json`'s `authorComments` (the `@` is optional): what a reader of the
 * package recognises the book by, what an embedder compares before it
 * imports a package over a stored book as that book's new version, and the
 * id the catalogue stores the book under.
 *
 * Every reader of the id (this host, the embedder, the catalogue, the device
 * app) parses it the same way, pinned by the shared fixture
 * `test/fixtures/book-id-fixture.json`: every declaration is collected — the
 * lookbehind keeps the `;` that ends one declaration available as the
 * boundary of the next, which a consuming `(?:^|[\s;])` would swallow, so
 * `@id=A;@id=B;` would look like one id — and the result is a tri-state.
 * `valid` needs exactly one declaration holding a UUID other than the zero
 * one; several declarations, even equal ones, are `invalid`, since a reader
 * that takes another one than this host would see another book.
 */
// The value may be empty: `@id=;` declares no usable id, so it is
// `invalid`, and `@id=;@id=<uuid>;` holds two declarations, not one.
const DECLARATION = /(?<=^|[\s;])@?id\s*=\s*([^\s;]*)\s*;/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** The import routes' request header carrying a `BookIdMode`. */
export const bookIdHeader = 'x-book-id';

// h5p-server's save schema caps `authorComments` at this many characters.
const MAX_AUTHOR_COMMENTS = 5000;

export type BookIdState =
  | { state: 'missing' }
  | { state: 'invalid' }
  | { state: 'valid'; id: string };

/**
 * What a write does with the book id: `keep` the one the metadata names
 * (canonicalised, a fresh one when it names none), `new` replace it with a
 * fresh one, or replace it with the given UUID.
 */
export type BookIdMode = 'keep' | 'new' | string;

interface Declaration {
  start: number;
  end: number;
  value: string;
}

function declarations(text: string): Declaration[] {
  return [...text.matchAll(DECLARATION)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    value: match[1]
  }));
}

/** Whether `value` is a book id: a `8-4-4-4-12` UUID, not the zero one. */
export function isBookId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    UUID.test(value) &&
    value.toLowerCase() !== ZERO_UUID
  );
}

/** The book id `authorComments` declares, as a tri-state (see above). */
export function parseBookId(authorComments: unknown): BookIdState {
  if (typeof authorComments !== 'string') return { state: 'missing' };
  const found = declarations(authorComments);
  if (found.length === 0) return { state: 'missing' };
  if (found.length > 1 || !isBookId(found[0].value)) {
    return { state: 'invalid' };
  }
  return { state: 'valid', id: found[0].value.toLowerCase() };
}

/** The valid book id in `authorComments`, lower-cased, else `undefined`. */
export function bookIdOf(authorComments: unknown): string | undefined {
  const parsed = parseBookId(authorComments);
  return parsed.state === 'valid' ? parsed.id : undefined;
}

/**
 * Validates a requested mode: `keep`, `new` or a book id (lower-cased).
 * `400 invalid-book-id` otherwise.
 */
export function bookIdMode(value: unknown): BookIdMode {
  if (value === 'keep' || value === 'new') return value;
  if (isBookId(value)) return value.toLowerCase();
  throw new HostError(
    'The book id must be "new" or a UUID other than the zero one.',
    400,
    { code: 'invalid-book-id' }
  );
}

const HORIZONTAL_TAIL = /[ \t]+$/;
const HORIZONTAL_HEAD = /^[ \t]+/;
const BREAK_TAIL = /[\r\n]$/;
const BREAK_HEAD = /^[\r\n]/;

/** `left` and `right` joined where a declaration was removed. */
function closeGap(left: string, right: string): string {
  const head = left.replace(HORIZONTAL_TAIL, '');
  let tail = right.replace(HORIZONTAL_HEAD, '');
  // A declaration that had a line to itself leaves no empty line behind.
  if (head === '' || BREAK_TAIL.test(head)) tail = tail.replace(/^\r?\n/, '');
  if (head && tail && !BREAK_TAIL.test(head) && !BREAK_HEAD.test(tail)) {
    return `${head} ${tail}`;
  }
  return head + tail;
}

/** `entry` put between `left` and `right` on a line of its own. */
function ownLine(left: string, entry: string, right: string): string {
  const head = left.replace(HORIZONTAL_TAIL, '');
  const tail = right.replace(HORIZONTAL_HEAD, '');
  return (
    head +
    (head && !BREAK_TAIL.test(head) ? '\n' : '') +
    entry +
    (tail && !BREAK_HEAD.test(tail) ? '\n' : '') +
    tail
  );
}

/**
 * `metadata` whose `authorComments` declares the book id in its canonical
 * form, `@id=<lower-case uuid>;` on a line of its own, and the id it
 * declares — `null` when `keep` finds an invalid declaration, which is left
 * as it is for the embedder to report (it offers to regenerate the id).
 *
 * The canonical form is what every reader finds: the device app's older
 * parser misses `id=x;`, keeps the case and reads `@id=x;@popup=true;` as
 * `x;@popup=true`. With `keep` a valid id is rewritten in that form where it
 * stands, moved onto a line of its own (the text around it split there);
 * with `new` or a UUID the first declaration is replaced the same way and any
 * further ones are removed; an id the text does not declare at all is
 * appended on its own line after the author's text.
 *
 * When the result exceeds the schema's length limit the write is refused
 * (`422 author-comments-too-long`): writing without the entry would store a
 * book without an id, or drop the id a stored book already has.
 */
export function canonicalBookId(
  metadata: Record<string, unknown>,
  mode: BookIdMode
): { metadata: Record<string, unknown>; bookId: string | null } {
  const text =
    typeof metadata.authorComments === 'string' ? metadata.authorComments : '';
  const found = declarations(text);
  let id: string;
  if (mode === 'keep') {
    const parsed = parseBookId(text);
    if (parsed.state === 'invalid') return { metadata, bookId: null };
    id = parsed.state === 'valid' ? parsed.id : crypto.randomUUID();
  } else {
    id = mode === 'new' ? crypto.randomUUID() : bookIdMode(mode);
  }
  const entry = `@id=${id};`;
  let authorComments: string;
  if (found.length === 0) {
    const kept = text.trimEnd();
    authorComments = kept ? `${kept}\n${entry}` : entry;
  } else {
    authorComments = text;
    // From the last one back, so the offsets of the earlier ones still hold.
    for (let index = found.length - 1; index > 0; index--) {
      const { start, end } = found[index];
      authorComments = closeGap(
        authorComments.slice(0, start),
        authorComments.slice(end)
      );
    }
    authorComments = ownLine(
      authorComments.slice(0, found[0].start),
      entry,
      authorComments.slice(found[0].end)
    );
  }
  const excess = authorComments.length - MAX_AUTHOR_COMMENTS;
  if (excess > 0) {
    throw new HostError(
      `The author comments leave no room for the book id "${entry}". ` +
        `Shorten them by ${excess} character${excess === 1 ? '' : 's'} and ` +
        'save again. No changes were saved.',
      422,
      { code: 'author-comments-too-long' }
    );
  }
  return {
    metadata:
      authorComments === metadata.authorComments
        ? metadata
        : { ...metadata, authorComments },
    bookId: id
  };
}
