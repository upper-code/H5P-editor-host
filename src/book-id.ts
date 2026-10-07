import HostError from './errors';

/**
 * A book keeps its identity across versions as an `@id=<id>;` entry in
 * `h5p.json`'s `authorComments` (the `@` is optional): what a reader of the
 * package recognises the book by, and what an embedder compares before it
 * imports a package over a stored book as that book's new version.
 */
const BOOK_ID = /(?:^|[\s;])@?id\s*=\s*([^\s;]+)\s*;/i;

// h5p-server's save schema caps `authorComments` at this many characters.
const MAX_AUTHOR_COMMENTS = 5000;

/** The book id in `authorComments`, the first one if several; `undefined` when there is none. */
export function bookIdOf(authorComments: unknown): string | undefined {
  if (typeof authorComments !== 'string') return undefined;
  return BOOK_ID.exec(authorComments)?.[1];
}

/**
 * `metadata` whose `authorComments` carries the book id `id`, appended on its
 * own line after the author's text; unchanged when it already names a book id
 * (which may differ from `id`). When the author's text leaves no room for the
 * entry within the schema's length limit the save is refused (`422
 * author-comments-too-long`): saving without the entry would store a new book
 * without an id, or drop the id a stored book already has.
 */
export function withBookId(
  metadata: Record<string, unknown>,
  id: string
): Record<string, unknown> {
  if (bookIdOf(metadata.authorComments) !== undefined) return metadata;
  const text =
    typeof metadata.authorComments === 'string'
      ? metadata.authorComments.trimEnd()
      : '';
  const entry = `@id=${id};`;
  const authorComments = text ? `${text}\n${entry}` : entry;
  const excess = authorComments.length - MAX_AUTHOR_COMMENTS;
  if (excess > 0) {
    throw new HostError(
      `The author comments leave no room for the book id "${entry}". ` +
        `Shorten them by ${excess} character${excess === 1 ? '' : 's'} and ` +
        'save again. No changes ' +
        'were saved.',
      422,
      { code: 'author-comments-too-long' }
    );
  }
  return { ...metadata, authorComments };
}
