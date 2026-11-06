import path from 'path';

import HostError from './errors';

/**
 * Media pasted from another content arrives as a relative reference in the
 * parameters: H5P's clipboard writes `../<id>/<file>` into stored content and
 * `../content/<id>/<file>` into new content. h5p-server's save copies such a
 * file (`ContentStorer.copyFilesFromPasteSource`) by a looser pattern, whose
 * source may be `..`, and with no permission check. This host knows nothing
 * about who may read what, so it refuses every such reference by default;
 * the sources a request may copy from are named by the embedder, which does
 * know (`X-H5P-Paste-Sources`, `PATCH /api/v1/content/:contentId`).
 */

/** The one spelling a source may have: a stored content id and a file in it. */
const pasteReferencePattern = /^\.\.\/(?:content\/)?(\d+)\/(.+)$/;

/**
 * The source of a pasted reference, `undefined` for any other path: not
 * relative to the content root, a source that is no content id, or a file
 * name that is absolute or climbs. Judged by its segments, not by resolving
 * it: against the working directory an absolute name below it, and with `/`
 * as that directory any climb, would look inside.
 */
export function parsePasteReference(
  filePath: string
): { sourceId: string; filename: string } | undefined {
  const match = pasteReferencePattern.exec(filePath);
  if (
    !match ||
    // Also true of a POSIX absolute path, unlike the other way round.
    path.win32.isAbsolute(match[2]) ||
    match[2].split(/[\\/]/).includes('..')
  ) {
    return undefined;
  }
  return { sourceId: match[1], filename: match[2] };
}

/** The refusal of a reference no source was named for. Names no path. */
export function pasteSourceRefused(): HostError {
  return new HostError(
    'The content references media of another book that this request may ' +
      'not copy. No changes were saved.',
    422,
    { code: 'paste-source-refused' }
  );
}

/**
 * Refuses, before h5p-server's save can copy anything, every reference that
 * could be a paste unless it names an allowed source. Everything upstream
 * copies starts with `../`; any other spelling that climbs is not copied, and
 * is left to h5p-server's own file name check.
 */
export function assertPasteSources(
  files: readonly { filePath: string }[],
  allowed: ReadonlySet<string>
): void {
  for (const { filePath } of files) {
    if (!filePath.startsWith('../')) continue;
    const pasted = parsePasteReference(filePath);
    if (!pasted || !allowed.has(pasted.sourceId)) {
      throw pasteSourceRefused();
    }
  }
}

/**
 * `X-H5P-Paste-Sources`: stored content ids, comma-separated. An absent or
 * empty header names none, so a list the embedder builds may be empty. Parsed
 * strictly: a value the host misread could only widen or narrow what an
 * embedder decided, and either is better told than guessed.
 */
export function parsePasteSourcesHeader(
  raw: string | undefined
): ReadonlySet<string> {
  if (!raw) {
    return new Set();
  }
  if (!/^\d+(?:,\d+)*$/.test(raw)) {
    throw new HostError('Invalid X-H5P-Paste-Sources header.', 400);
  }
  return new Set(raw.split(','));
}
