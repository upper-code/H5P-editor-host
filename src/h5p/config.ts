import { H5PConfig, fsImplementations } from '@lumieducation/h5p-server';
import type { IH5PConfig } from '@lumieducation/h5p-server';

import packageJson from '../../package.json';
import { hostRoute } from '../route-prefix';

/**
 * Builds an H5P server configuration for the web editor.
 *
 * The H5PConfig constructor applies the `defaults` argument over its built-in
 * defaults for every key that already has a value, so there is no need to call
 * `.load()` (which would only read the — empty — in-memory storage back).
 *
 * `coreApiVersion`/`h5pVersion` MUST be pinned to 1.27 to match the checked-in
 * core/editor assets and the installed content-type libraries; the package
 * default is 1.24. `fetchingDisabled` plus `contentHubEnabled: false` keep the
 * editor fully offline so it never contacts the H5P Hub.
 *
 * `setFinishedEnabled` and `contentUserStateSaveInterval` are disabled because
 * this app stores no per-viewer state: the package defaults (true / 5000ms)
 * make the player POST `/h5p/setFinished` and GET+POST `/h5p/contentUserData`
 * every five seconds per viewer, which — with no `contentUserDataStorage`
 * wired up — only produces useless traffic and log noise against 200 stubs.
 * With the interval off, h5p-express refuses `/h5p/contentUserData` with an
 * empty 403; the editor core still calls it, so app.ts answers that route
 * itself (see user-data-stub.ts).
 */
export default function createH5PConfig(
  overrides: Partial<IH5PConfig> = {}
): H5PConfig {
  return new H5PConfig(new fsImplementations.InMemoryStorage(), {
    // This prefix is public: the embedding application proxies it byte-for-byte
    // to this service, so URLs emitted into the browser must include the mount.
    baseUrl: hostRoute('/h5p'),
    platformName: 'Interactive Book Editor',
    platformVersion: packageJson.version,
    siteType: 'internet',
    coreApiVersion: { major: 1, minor: 27 },
    h5pVersion: '1.27',
    contentHubEnabled: false,
    fetchingDisabled: 1,
    setFinishedEnabled: false,
    contentUserStateSaveInterval: false,
    ...overrides
  });
}
