export default class HostError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'HostError';
    this.statusCode = statusCode;
  }
}

/**
 * The answer to a caller that queued for a tenant's content lock for its whole
 * budget and never got it. A 503 rather than a 409: nothing is wrong with the
 * request, something else simply held the tenant for too long, and retrying is
 * the right thing to do.
 *
 * It lives here rather than beside the lock because both halves of the lock —
 * the in-process queue in `content-transactions` and the cross-process files
 * in `process-lock` — time out with it, and the latter must not import the
 * former.
 */
export class ContentLockTimeout extends HostError {
  public constructor() {
    super('Another change to this content is still running. Try again.', 503);
  }
}

/**
 * Normalizes a "content missing" failure into a clean 404. h5p-server signals a
 * missing content id with an `H5pError` whose `.message` is a raw, unlocalized
 * error id (e.g. `content-file-missing (filename: h5p.json, contentId: 5)`) that
 * the error handler would otherwise echo to the client. Every content route that
 * can hit a missing id passes its error through here so the response is a uniform
 * `Content not found.` instead of leaking h5p-server's internal error ids.
 */
export function mapContentNotFound(error: unknown): unknown {
  if ((error as { httpStatusCode?: number })?.httpStatusCode === 404) {
    return new HostError('Content not found.', 404);
  }
  return error;
}
