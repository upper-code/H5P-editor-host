import path from 'path';
import type { Logger } from 'pino';
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { Router } from 'express';
import { h5pAjaxExpressRouter } from '@lumieducation/h5p-express';

import { recoverTransactionsLocked } from './content-transactions';
import syncDirectory from './durable-write';
import acquireProcessLock from './process-lock';
import envNumber, { editorMaxUploadBytes } from './env';
import WebUser from './h5p/user';
import initI18n from './h5p/i18n';
import createH5PConfig from './h5p/config';
import createH5PEditor, { createLibraryStorage } from './h5p/editor';
import createH5PPlayer from './h5p/player';
import type { WebContext } from './h5p/context';
import type { ILibraryStorage } from '@lumieducation/h5p-server';
import HostError from './errors';

/**
 * A distributor id is a single path segment of a tenant's data directory, so
 * it may hold nothing that could climb out of it or name a hidden entry.
 * Shared by the request middleware and every route that resolves a tenant
 * directory without going through `get`.
 */
export const distributorIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface HostTenant {
  distributorId: string;
  rootPath: string;
  context: WebContext;
  user: WebUser;
  h5pRouter: Router;
}

interface TenantCacheEntry {
  tenant: Promise<HostTenant>;
  lastAccess: number;
}

/** The bundle the libraries were provisioned from, when it was one. */
export interface LibraryBundleRecord {
  version: string;
  sha256: string;
  provisionedAt: string | null;
}

/**
 * The readiness snapshot, as `/ready` and `/api/v1/readiness` both project it
 * (see `answerReadiness` in app.ts). It carries nothing internal: the library
 * directory is a server-side path, so it stays out of here rather than being
 * carried this far and then filtered out by each route.
 */
export interface HostReadiness {
  ready: boolean;
  libraryCount: number;
  storageWritable: boolean;
  /** `null` when the libraries were installed from a plain directory. */
  bundle: LibraryBundleRecord | null;
}

/**
 * True when `child` is `parent` or lies under it. Compared without regard to
 * case, as a case-insensitive disk would resolve the two paths.
 */
function sameOrInside(parent: string, child: string): boolean {
  const lowerParent = parent.toLowerCase();
  const lowerChild = child.toLowerCase();
  return (
    lowerChild === lowerParent ||
    lowerChild.startsWith(`${lowerParent}${path.sep}`)
  );
}

/** Whether a path is there at all, without caring what it is. */
async function pathExists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

/**
 * Whether a directory is one this service created for a tenant. `content` is
 * written when the tenant is first resolved and `operations` on its first
 * save, so either one identifies ours; a directory with neither is somebody
 * else's and is left alone.
 */
async function isTenantDirectory(directory: string): Promise<boolean> {
  const markers = await Promise.all(
    ['content', 'operations'].map((name) =>
      fs.stat(path.join(directory, name)).then(
        (stats) => stats.isDirectory(),
        () => false
      )
    )
  );
  return markers.some(Boolean);
}

/** Whether any child of `directory` is a tenant — i.e. it is a container. */
async function holdsTenants(directory: string): Promise<boolean> {
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await isTenantDirectory(path.join(directory, entry.name)))
    ) {
      return true;
    }
  }
  return false;
}

export default class TenantManager {
  private readonly tenants = new Map<string, TenantCacheEntry>();

  // Pending construction must survive LRU eviction and remain deduplicated.
  private readonly pendingTenants = new Map<string, Promise<HostTenant>>();

  private readonly maxPendingTenants: number;

  private readonly dataRoot: string;

  /** `<dataRoot>/tenants`: the one place a distributor's directory can be. */
  private readonly tenantsRoot: string;

  private readonly librariesPath: string;

  private readonly maxTenants: number;

  private readonly tenantTtlMs: number;

  private readonly translatePromise: ReturnType<typeof initI18n>;

  private readonly uploadTmpPath: string;

  private readonly readinessCacheMs: number;

  /** How long the start waits for one tenant's lock before moving on. */
  private readonly recoveryWaitMs: number;

  /** How long the start waits for another process's migration to finish. */
  private readonly migrationWaitMs: number;

  private readinessCache: { at: number; value: HostReadiness } | undefined;

  private libraryStorage: ILibraryStorage | undefined;

  private readinessInFlight: Promise<HostReadiness> | undefined;

  constructor(
    private readonly appRoot: string,
    private readonly log: Logger
  ) {
    this.dataRoot = path.resolve(
      process.env.H5P_HOST_DATA_DIR || path.join(appRoot, '.host-data')
    );
    // Tenant directories live one level down, in a directory of their own, so
    // the data root can hold anything else a deployment needs — the shared
    // libraries, upload staging, an operator's notes — without any of it being
    // mistakable for a tenant, and without a distributor id ever being able to
    // name one of them. The layout is migrated on the way up (`initialize`).
    this.tenantsRoot = path.join(this.dataRoot, 'tenants');
    // Content types and editor widgets are provisioned at deploy time into
    // this runtime directory (see scripts/provision-libraries.mjs), so tenants
    // share one controlled set of library versions.
    this.librariesPath = path.resolve(
      process.env.H5P_LIBRARIES_DIR || path.join(this.dataRoot, 'libraries')
    );
    this.uploadTmpPath = path.resolve(
      process.env.H5P_HOST_UPLOAD_TMP_DIR ||
        path.join(this.dataRoot, 'upload-tmp')
    );
    // The shared directories may live inside the data root (the defaults do),
    // but neither may overlap the tenant root in either direction: a shared
    // directory *inside* it would read as a tenant, and a tenant root inside a
    // shared directory would make every save collide with library storage.
    [this.librariesPath, this.uploadTmpPath].forEach((reserved) => {
      if (
        sameOrInside(reserved, this.tenantsRoot) ||
        sameOrInside(this.tenantsRoot, reserved)
      ) {
        throw new Error(
          `The tenant directory (${this.tenantsRoot}) must not be inside the ` +
            `library or upload staging directory (${reserved}), or contain ` +
            'it. Check H5P_HOST_DATA_DIR, H5P_LIBRARIES_DIR and ' +
            'H5P_HOST_UPLOAD_TMP_DIR.'
        );
      }
    });
    // Read here, in the constructor, so a typo stops the start rather than
    // quietly halving a cache; `main` builds the manager before it listens.
    this.maxTenants = envNumber('H5P_HOST_TENANT_CACHE_MAX', 100, {
      min: 1,
      integer: true
    });
    this.maxPendingTenants = envNumber('H5P_HOST_TENANT_INIT_MAX', 16, {
      min: 1,
      integer: true
    });
    this.tenantTtlMs = envNumber(
      'H5P_HOST_TENANT_CACHE_TTL_MS',
      30 * 60 * 1000
    );
    this.readinessCacheMs = envNumber('H5P_HOST_READINESS_CACHE_MS', 5000);
    this.recoveryWaitMs = envNumber('H5P_HOST_RECOVERY_WAIT_MS', 5000);
    this.migrationWaitMs = envNumber('H5P_HOST_MIGRATION_WAIT_MS', 60_000);
    this.translatePromise = initI18n(
      process.env.EDITOR_LANGUAGE || 'en',
      process.env.NODE_ENV === 'development'
    );
  }

  /** Root holding one directory per tenant; also the janitors' sweep root. */
  public get dataDirectory(): string {
    return this.tenantsRoot;
  }

  /** Where multipart uploads are staged before H5P takes them over. */
  public get uploadStagingDirectory(): string {
    return this.uploadTmpPath;
  }

  /**
   * Readiness, not liveness: an editor with no provisioned libraries answers
   * requests but cannot actually edit anything, so a deployment must be able to
   * tell the two apart.
   *
   * The probe reads every provisioned manifest, and `/ready` is unauthenticated,
   * so the answer is cached for a few seconds (`H5P_HOST_READINESS_CACHE_MS`)
   * rather than recomputed for every caller.
   */
  public async readiness(): Promise<HostReadiness> {
    const now = Date.now();
    if (
      this.readinessCache &&
      now - this.readinessCache.at < this.readinessCacheMs
    ) {
      return this.readinessCache.value;
    }
    if (!this.readinessInFlight) {
      this.readinessInFlight = this.checkReadiness().finally(() => {
        this.readinessInFlight = undefined;
      });
    }
    return this.readinessInFlight;
  }

  private async checkReadiness(): Promise<HostReadiness> {
    // Three independent reads of three different places on disk; nothing here
    // depends on the answer to another, and the probe is on the critical path
    // of every deployment's health check.
    const [libraryCount, storageWritable, bundle] = await Promise.all([
      this.countLibraries(),
      this.storageWritable(),
      this.readBundleRecord()
    ]);
    const value = {
      ready: libraryCount > 0 && storageWritable,
      libraryCount,
      storageWritable,
      bundle
    };
    this.readinessCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Whether saved content can still be written.
   *
   * Probes the tenant root, because that is where every write actually lands
   * and a parent directory's permissions say nothing about it — but falls back
   * to the data root before the first start has created it, so a probe that
   * beats `initialize` reports on the configured directory rather than on a
   * path that does not exist yet.
   */
  private async storageWritable(): Promise<boolean> {
    const writable = (directory: string): Promise<boolean> =>
      fs.access(directory, fsConstants.W_OK).then(
        () => true,
        () => false
      );
    return (await pathExists(this.tenantsRoot))
      ? writable(this.tenantsRoot)
      : writable(this.dataRoot);
  }

  /**
   * The `.bundle.json` the provisioning script writes after installing a
   * versioned bundle (`scripts/provision-libraries.mjs`). Lets an operator
   * confirm from `/ready` which signed-off library set a deployment runs.
   */
  private async readBundleRecord(): Promise<LibraryBundleRecord | null> {
    try {
      const record = JSON.parse(
        await fs.readFile(path.join(this.librariesPath, '.bundle.json'), 'utf8')
      );
      if (
        typeof record?.version !== 'string' ||
        typeof record.sha256 !== 'string'
      ) {
        return null;
      }
      return {
        version: record.version,
        sha256: record.sha256,
        provisionedAt:
          typeof record.provisionedAt === 'string' ? record.provisionedAt : null
      };
    } catch {
      return null;
    }
  }

  /**
   * Counts genuinely-provisioned libraries: a non-dot subdirectory carrying a
   * readable, valid `library.json`. A stray file or a half-copied directory
   * with no valid manifest is not a library, so readiness cannot flip to true
   * on junk in the library root.
   */
  private async countLibraries(): Promise<number> {
    const entries = await fs
      .readdir(this.librariesPath, { withFileTypes: true })
      .catch(() => []);
    const candidates = entries.filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith('.')
    );
    const checks = await Promise.all(
      candidates.map((entry) => this.isLibraryDirectory(entry.name))
    );
    return checks.filter(Boolean).length;
  }

  /** A directory is a library when its `library.json` parses and names one. */
  private async isLibraryDirectory(name: string): Promise<boolean> {
    try {
      const meta = JSON.parse(
        await fs.readFile(
          path.join(this.librariesPath, name, 'library.json'),
          'utf8'
        )
      );
      return (
        typeof meta?.machineName === 'string' &&
        meta.machineName.trim() !== '' &&
        Number.isInteger(meta.majorVersion) &&
        meta.majorVersion >= 0 &&
        Number.isInteger(meta.minorVersion) &&
        meta.minorVersion >= 0 &&
        name === `${meta.machineName}-${meta.majorVersion}.${meta.minorVersion}`
      );
    } catch {
      return false;
    }
  }

  /**
   * Prepares `tenants/` and settles the one name that means two things.
   *
   * `tenants` was a perfectly good distributor id under the earlier layout, so
   * the directory this release wants for its container may already be a
   * tenant's. Telling the two apart needs a mark: a container carries
   * `.container.json`, and one that does not — and holds no tenant of its own
   * — is the old distributor, which is moved inside the new container under
   * its own name rather than being quietly shadowed by it.
   *
   * The dot-prefixed marker cannot collide with a distributor id, is skipped
   * by every pass that walks this directory looking for tenants, and tells an
   * operator what they are looking at.
   */
  private async openTenantsRoot(): Promise<void> {
    const marker = path.join(this.tenantsRoot, '.container.json');
    await this.finishInterruptedContainerMove();
    if (
      (await pathExists(this.tenantsRoot)) &&
      !(await pathExists(marker)) &&
      (await isTenantDirectory(this.tenantsRoot)) &&
      !(await holdsTenants(this.tenantsRoot))
    ) {
      const aside = `${this.tenantsRoot}.legacy`;
      await fs.rename(this.tenantsRoot, aside);
      await fs.mkdir(this.tenantsRoot, { recursive: true });
      await fs.rename(aside, path.join(this.tenantsRoot, 'tenants'));
      await syncDirectory(this.dataRoot);
      this.log.info(
        { tenantsRoot: this.tenantsRoot },
        'Moved the tenant named "tenants" inside the new tenant directory'
      );
    } else {
      await fs.mkdir(this.tenantsRoot, { recursive: true });
    }
    if (!(await pathExists(marker))) {
      await fs.writeFile(
        marker,
        `${JSON.stringify({ layout: 'tenants', since: new Date().toISOString() }, null, 2)}\n`
      );
    }
  }

  /**
   * Finishes a move of the tenant named `tenants` that a crash interrupted.
   *
   * That move is two renames with the tenant living under a temporary name in
   * between, and a process that dies there leaves the directory at that name —
   * where nothing looks for it, and where the next start would happily create
   * an empty container over the top and hand the distributor a blank shelf.
   * Finishing it is the same second rename; a destination that already exists
   * is two histories for one tenant, which stops the start rather than being
   * merged.
   */
  private async finishInterruptedContainerMove(): Promise<void> {
    const aside = `${this.tenantsRoot}.legacy`;
    // Only a tenant of ours is ever moved. The name is ours by convention, not
    // by right: a deployment is free to point `H5P_LIBRARIES_DIR` at it, and
    // moving a library directory into a tenant would take every content type
    // with it.
    if (
      !(await pathExists(aside)) ||
      [this.librariesPath, this.uploadTmpPath].some(
        (reserved) =>
          sameOrInside(reserved, aside) || sameOrInside(aside, reserved)
      ) ||
      !(await isTenantDirectory(aside))
    ) {
      return;
    }
    const destination = path.join(this.tenantsRoot, 'tenants');
    if (await pathExists(destination)) {
      throw new Error(
        `Both ${aside} and ${destination} exist; an interrupted migration of ` +
          'the tenant named "tenants" left two copies. Merge them by hand and ' +
          `remove ${aside}.`
      );
    }
    await fs.mkdir(this.tenantsRoot, { recursive: true });
    try {
      await fs.rename(aside, destination);
    } catch (error) {
      // Another start finished it between the check above and here.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await syncDirectory(this.dataRoot);
    this.log.warn(
      { aside, destination },
      'Finished an interrupted move of the tenant named "tenants"'
    );
  }

  /**
   * Moves tenant directories an earlier layout left beside the shared ones
   * into `tenants/`.
   *
   * Deployments that predate the nested layout have `<dataDir>/<distributorId>`
   * directories sitting next to `libraries/` and `upload-tmp/`, and nothing
   * else can tell them apart from whatever else an operator has put there. So
   * the move is deliberately timid: a directory is a tenant only if its name
   * could have been a distributor id *and* it holds the `content` or
   * `operations` directory this service creates. Anything else is left where
   * it is, which for a false negative costs one tenant its history rather than
   * moving a directory that was never ours.
   *
   * A name already taken under `tenants/` is never merged — two candidates for
   * one tenant is a situation only a human should resolve — and a rename that
   * fails stops the start rather than serving half a layout.
   */
  private async gatherFlatTenants(): Promise<void> {
    const reserved = [this.librariesPath, this.uploadTmpPath];
    const entries = await fs.readdir(this.dataRoot, { withFileTypes: true });
    let moved = 0;
    for (const entry of entries) {
      const from = path.join(this.dataRoot, entry.name);
      if (
        !entry.isDirectory() ||
        from === this.tenantsRoot ||
        !distributorIdPattern.test(entry.name) ||
        reserved.some(
          (directory) =>
            sameOrInside(directory, from) || sameOrInside(from, directory)
        ) ||
        !(await isTenantDirectory(from))
      ) {
        continue;
      }
      const to = path.join(this.tenantsRoot, entry.name);
      if (await pathExists(to)) {
        this.log.warn(
          { from, to },
          'Both layouts hold this tenant; leaving the old copy in place'
        );
        continue;
      }
      // A directory that is gone by the time we get to it was moved by another
      // process between the listing and here; that is the outcome we wanted.
      try {
        await fs.rename(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      moved += 1;
    }
    if (moved > 0) {
      // The renames have to reach the device before anything writes into the
      // new layout: a crash in between would otherwise leave a tenant in
      // neither directory.
      await syncDirectory(this.tenantsRoot);
      await syncDirectory(this.dataRoot);
      this.log.info(
        { moved, tenantsRoot: this.tenantsRoot },
        'Moved tenant directories into the nested layout'
      );
    }
  }

  public async initialize(): Promise<void> {
    await fs.mkdir(this.dataRoot, { recursive: true });
    // Two processes starting at once would otherwise both walk the data root
    // and both try to move the same directory; the loser's rename fails and
    // takes its whole start with it. The data root's own lock makes the
    // migration one process's business at a time — and the renames below
    // tolerate having been done by the other one anyway.
    const migration = await acquireProcessLock(this.dataRoot, {
      mode: 'exclusive',
      deadline: Date.now() + this.migrationWaitMs
    });
    try {
      await this.openTenantsRoot();
      await fs.mkdir(this.librariesPath, { recursive: true });
      await fs.mkdir(this.uploadTmpPath, { recursive: true });
      await this.gatherFlatTenants();
    } finally {
      await migration.release();
    }
    // Finish or discard the content transactions a crash left half-applied,
    // and drop the journal entries that have expired. This is the only pass
    // over the tenant directories: a tenant that was never written to has no
    // `operations` directory, so it costs one failed `readdir` and no more
    // (`recoverTransactions`).
    //
    // Under the cross-process lock, and skipped for a tenant another live
    // process holds — that process has already recovered it, and repairing
    // underneath a running writer is the corruption this lock exists to stop.
    for (const entry of await fs.readdir(this.tenantsRoot, {
      withFileTypes: true
    })) {
      if (!entry.isDirectory()) continue;
      const content = path.join(this.tenantsRoot, entry.name, 'content');
      if (!(await recoverTransactionsLocked(content, this.recoveryWaitMs))) {
        this.log.warn(
          { distributorId: entry.name },
          'Another process holds this tenant; leaving its journal to it'
        );
      }
    }
    const libraryCount = await this.countLibraries();
    if (libraryCount === 0) {
      this.log.warn(
        { librariesPath: this.librariesPath },
        'No H5P libraries provisioned. Run "npm run provision:libraries" to ' +
          'populate the runtime library directory before editing content.'
      );
    } else {
      this.log.info(
        { librariesPath: this.librariesPath, libraryCount },
        'H5P runtime libraries detected'
      );
    }
  }

  public get(distributorId: string): Promise<HostTenant> {
    // A distributor id is one path segment under the tenant root and nothing
    // else: no separator, no `..`, no leading dot. Nothing there is shared with
    // the runtime directories — that is what `tenants/` buys — so an id that
    // happens to read like `libraries` is an ordinary tenant.
    if (!distributorIdPattern.test(distributorId)) {
      return Promise.reject(new HostError('Invalid distributor id.', 400));
    }
    this.evictExpired();
    const existing = this.tenants.get(distributorId);
    if (existing) {
      existing.lastAccess = Date.now();
      this.tenants.delete(distributorId);
      this.tenants.set(distributorId, existing);
      return existing.tenant;
    }
    const pending = this.pendingTenants.get(distributorId);
    if (pending) {
      return pending;
    }
    if (this.pendingTenants.size >= this.maxPendingTenants) {
      return Promise.reject(
        new HostError('Tenant initialization is busy. Try again shortly.', 503)
      );
    }
    const tenant = this.createTenant(distributorId)
      .then((created) => {
        this.tenants.set(distributorId, {
          tenant: Promise.resolve(created),
          lastAccess: Date.now()
        });
        while (this.tenants.size > this.maxTenants) {
          this.tenants.delete(this.tenants.keys().next().value!);
        }
        return created;
      })
      .finally(() => {
        this.pendingTenants.delete(distributorId);
      });
    this.pendingTenants.set(distributorId, tenant);
    return tenant;
  }

  private evictExpired(): void {
    if (this.tenantTtlMs <= 0) {
      return;
    }
    const now = Date.now();
    Array.from(this.tenants.entries()).forEach(([id, entry]) => {
      if (now - entry.lastAccess > this.tenantTtlMs) {
        this.tenants.delete(id);
      }
    });
  }

  private async createTenant(distributorId: string): Promise<HostTenant> {
    const rootPath = path.join(this.tenantsRoot, distributorId);
    const paths = {
      content: path.join(rootPath, 'content'),
      tmp: path.join(rootPath, 'tmp')
    };
    await Promise.all([
      fs.mkdir(paths.content, { recursive: true }),
      fs.mkdir(paths.tmp, { recursive: true })
    ]);

    const maxFileSize = editorMaxUploadBytes();
    const publicBaseUrl =
      process.env.EDITOR_PUBLIC_URL || 'http://localhost:8080/editor';
    const config = createH5PConfig({
      maxFileSize,
      maxTotalSize: maxFileSize
    });
    const { translationCallback } = await this.translatePromise;
    if (!this.libraryStorage) {
      this.libraryStorage = createLibraryStorage(this.librariesPath);
    }
    const h5pEditor = await createH5PEditor(
      config,
      this.libraryStorage,
      paths.content,
      paths.tmp,
      translationCallback,
      publicBaseUrl
    );
    const h5pPlayer = createH5PPlayer(
      h5pEditor,
      config,
      translationCallback,
      publicBaseUrl
    );
    const user = new WebUser(distributorId, 'H5P Editor Host User');
    const context: WebContext = {
      h5pEditor,
      h5pPlayer,
      language_code: process.env.EDITOR_LANGUAGE || 'en',
      paths
    };
    const h5pRouter = h5pAjaxExpressRouter(
      h5pEditor,
      path.join(this.appRoot, 'assets/h5p/core'),
      path.join(this.appRoot, 'assets/h5p/editor'),
      undefined,
      'auto'
    );
    this.log.info({ distributorId, rootPath }, 'H5P tenant initialized');
    return { distributorId, rootPath, context, user, h5pRouter };
  }
}
