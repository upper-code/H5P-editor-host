import path from 'path';
import pino from 'pino';

import createHostApp from './app';
import {
  assertContentJournalConfig,
  startJournalJanitor
} from './content-transactions';
import envNumber from './env';
import { assertImageSizePatched } from './image-size-patch';
import TenantManager from './tenant-manager';
import { startTemporaryFileJanitor } from './temp-storage';

async function main(): Promise<void> {
  const appRoot = path.resolve(__dirname, '../..');
  const port = envNumber('PORT', 8090);
  const host = process.env.HOST || '127.0.0.1';
  const log = pino({
    name: 'h5p-editor-host',
    level: process.env.LOG_LEVEL || 'info'
  });
  // Refuse to serve with an unpatched image-size: one crafted upload would
  // otherwise hang the process for every tenant — its ICNS and JXL/HEIF parsers
  // can be driven into an infinite loop and have no fixed release.
  await assertImageSizePatched();
  // Every numeric limit is read here rather than at first use, so a typo in the
  // environment stops the start instead of failing one save hours later.
  assertContentJournalConfig();
  const tenants = new TenantManager(appRoot, log);
  await tenants.initialize();

  // h5p-server expires temporary files only when something calls cleanUp();
  // nothing does, and an evicted tenant has no editor instance left to call it.
  // Sweeping the tenant tmp directories by age covers both cases.
  const lifetimeMs = envNumber(
    'H5P_HOST_TEMP_FILE_LIFETIME_MS',
    120 * 60 * 1000
  );
  const stopJanitor = startTemporaryFileJanitor({
    dataRoot: tenants.dataDirectory,
    tenantSubdirectory: 'tmp',
    extraDirectories: [tenants.uploadStagingDirectory],
    maxAgeMs: lifetimeMs,
    intervalMs: envNumber('H5P_HOST_TEMP_SWEEP_INTERVAL_MS', 15 * 60 * 1000),
    log
  });

  // Settled journal receipts and the lock files a crash left behind are only
  // ever cleaned up on the back of a save, so a tenant that goes quiet keeps
  // both for the life of the deployment. This sweep is the one pass that does
  // not need a request to happen first; its windows are days, so hours between
  // passes is enough.
  const stopJournalJanitor = startJournalJanitor({
    dataRoot: tenants.dataDirectory,
    intervalMs: envNumber(
      'H5P_HOST_JOURNAL_SWEEP_INTERVAL_MS',
      6 * 60 * 60 * 1000
    ),
    log
  });

  // How long a graceful stop lets in-flight requests (a save, an import, a
  // download) finish. Read before the port opens: a typo throws, and past
  // `listen` that leaves a process that serves requests but has no signal
  // handler — it would answer nothing but SIGKILL, mid-save.
  const graceMs = envNumber('H5P_HOST_SHUTDOWN_GRACE_MS', 20_000);

  const app = createHostApp(appRoot, log, tenants);

  const server = app.listen(port, host, () => {
    log.info({ host, port }, 'H5P editor host started');
  });

  // Graceful stop: stop accepting, let in-flight requests finish within the
  // grace period, then exit.
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    log.info({ signal }, 'H5P editor host stopping');
    stopJanitor();
    stopJournalJanitor();
    const deadline = setTimeout(() => {
      log.warn(
        'Shutdown grace period elapsed; exiting with requests in flight'
      );
      process.exit(1);
    }, graceMs);
    deadline.unref();
    server.close(() => {
      log.info('H5P editor host stopped');
      process.exit(0);
    });
    // Idle keep-alive connections would otherwise hold `close` open for the
    // whole grace period; active requests keep their sockets.
    server.closeIdleConnections();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
