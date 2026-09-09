import HostError from './errors';

/** A stored content id. H5P assigns numeric ids, and every read/write path
 *  joins the id straight onto filesystem storage, so nothing else is accepted. */
export const numericContentId = /^\d+$/;

/** Routes that may also *create* content accept `new`, the id-less spelling the
 *  editor bridge sends for an unsaved item. The literal string `undefined` is
 *  NOT accepted: it is what a buggy client produces by serializing a JS
 *  `undefined` into the URL, and silently treating it as "create new" would mask
 *  that bug instead of surfacing it as a 400. */
export const creatableContentId = /^(?:\d+|new)$/;

/**
 * Validates a content id taken from a URL segment.
 *
 * Express neither normalizes `..` nor rejects it, and `req.params` arrives
 * percent-decoded — so `/content/../edit` and `/content/%2e%2e/edit` both reach
 * a handler with `contentId === '..'`. Every route that forwards an id into H5P
 * storage must therefore check it explicitly; a separator guard on `%2f`/`%5c`
 * is not enough.
 */
export function assertContentId(
  raw: string,
  options: { creatable?: boolean } = {}
): string {
  const pattern = options.creatable ? creatableContentId : numericContentId;
  if (typeof raw !== 'string' || !pattern.test(raw)) {
    throw new HostError('Invalid content id.', 400);
  }
  return raw;
}

// Percent-decodes one path segment for comparison. An undecodable segment is
// returned as-is; it will simply fail the checks below, which is the safe side.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    return segment;
  }
}

/**
 * Guards the H5P AJAX URL space before the GPL h5p-express router.
 *
 * Content ids ride inside `/content/:id/:file`, `/params/:id` and
 * `/download/:id`, which the router joins straight onto filesystem content
 * storage. `req.path` is still percent-encoded here, so each segment is decoded
 * before it is compared — otherwise `%2e%2e` would slip past a literal `..`
 * check. The remaining routes (`/ajax`, `/libraries/...`, `/temp-files/...`)
 * are validated by h5p-server itself, which rejects `../` in filenames.
 */
export function isSafeH5pSubPath(subPath: string): boolean {
  const segments = subPath.split('/').filter(Boolean).map(decodeSegment);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return false;
  }
  const [rawHead, id] = segments;
  // Express matches literal route names without regard to case.
  const head = rawHead?.toLowerCase();
  if (head === 'content' || head === 'params' || head === 'download') {
    return numericContentId.test(id || '');
  }
  return true;
}
