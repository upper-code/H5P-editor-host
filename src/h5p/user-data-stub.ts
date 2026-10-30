import type { RequestHandler } from 'express';

/**
 * Answers the H5P core's per-viewer state requests without storing anything.
 *
 * This host keeps no per-viewer state (`contentUserStateSaveInterval: false`,
 * see config.ts), and with the interval off h5p-express refuses every
 * `/h5p/contentUserData/*` request with an empty 403. The editor core still
 * sends them: `ns.storage.get` in h5peditor.js calls `H5P.getUserData(0, …)`
 * for each field that carries an "important description" panel (Blanks and
 * the like) to refine the open/closed flag it has already read from
 * localStorage, and `ns.storage.set` posts the flag back when the panel is
 * toggled. Each call lands as a red 403 in the browser console although
 * nothing is lost. So answer the way a platform with nothing stored does:
 * `data: false` makes h5p.js call back without a value, keeping the
 * localStorage one; a bare `success` acknowledges a save that goes nowhere.
 * Other methods fall through to the GPL router, which has no route for them.
 */
export function contentUserDataStub(): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET') {
      res.json({ success: true, data: false });
      return;
    }
    if (req.method === 'POST') {
      res.json({ success: true });
      return;
    }
    next();
  };
}
