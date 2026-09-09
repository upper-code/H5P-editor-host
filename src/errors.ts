export default class HostError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'HostError';
    this.statusCode = statusCode;
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
