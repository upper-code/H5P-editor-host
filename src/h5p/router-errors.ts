import type { Request, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { AjaxErrorResponse } from '@lumieducation/h5p-server';

import { maskedServerErrorMessage } from '../errors';

/**
 * The 5xx policy of `createErrorHandler` (app.ts) for the GPL router's
 * subtree.
 *
 * h5p-express ends its router with an error handler of its own, which answers
 * every error that is not an H5pError with the error's `message` — for a
 * failed read under `/h5p/content`, `/h5p/temp-files` or `/h5p/params` that
 * is a raw `EACCES`/`EIO`/`EMFILE` with an absolute path. Errors never reach
 * the host's handler from there. Switching the router's handler off
 * (`handleErrors: false`) is no way out under Express 4: its routes then hand
 * their rejected promise back to Express, which ignores it, and the request
 * hangs on an unhandled rejection.
 *
 * So the answer itself is rewritten: a 5xx `AjaxErrorResponse` keeps its
 * envelope (the editor core reads `message` from it) and its public
 * `errorCode`, but loses the text and the details, and the original goes to
 * the log, where h5p-server's own logger does not write by default. A 4xx is
 * an H5pError the router translated for the user and stays as it is.
 * `NODE_ENV=development` keeps the original text, as the host's handler does.
 */
export default function maskRouterServerErrors(
  baseLog: Logger
): RequestHandler {
  return (req, res, next) => {
    if (process.env.NODE_ENV !== 'development') {
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        if (res.statusCode < 500 || !(body instanceof AjaxErrorResponse)) {
          return json(body);
        }
        const log = (req as Request & { log?: Logger }).log ?? baseLog;
        log.error(
          {
            path: req.path,
            status: res.statusCode,
            message: body.message,
            details: body.details
          },
          'H5P request failed'
        );
        return json(
          new AjaxErrorResponse(
            body.errorCode,
            body.httpStatusCode,
            maskedServerErrorMessage
          )
        );
      };
    }
    next();
  };
}
