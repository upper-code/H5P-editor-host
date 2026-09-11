import path from 'path';
import type { Logger } from 'pino';
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { Router } from 'express';
import { h5pAjaxExpressRouter } from '@lumieducation/h5p-express';

import { recoverTransactionsLocked } from './content-transactions';
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
    // name one of them.
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
   * Ensures the tenant container exists and is marked.
   *
   * Every distributor's directory lives one level down, under `tenants/`. The
   * dot-prefixed `.container.json` marker names the directory for an operator,
   * cannot collide with a distributor id, and is skipped by every pass that
   * walks this directory looking for tenants.
   */
  private async openTenantsRoot(): Promise<void> {
    await fs.mkdir(this.tenantsRoot, { recursive: true });
    const marker = path.join(this.tenantsRoot, '.container.json');
    if (!(await pathExists(marker))) {
      await fs.writeFile(
        marker,
        `${JSON.stringify({ layout: 'tenants', since: new Date().toISOString() }, null, 2)}\n`
      );
    }
  }

  public async initialize(): Promise<void> {
    await fs.mkdir(this.dataRoot, { recursive: true });
    await this.openTenantsRoot();
    await fs.mkdir(this.librariesPath, { recursive: true });
    await fs.mkdir(this.uploadTmpPath, { recursive: true });
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
