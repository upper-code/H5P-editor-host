#!/usr/bin/env node
/*
 * Provisions the untracked H5P runtime library directory.
 *
 * Installs a reviewed set of content types and editor widgets at deploy time.
 * Libraries retain their own licenses and source-distribution requirements.
 * The runtime directory is untracked because it is a deployment artifact.
 *
 * Target (untracked):
 *   H5P_LIBRARIES_DIR   default: <H5P_HOST_DATA_DIR|.host-data>/libraries
 *
 * Source (set one):
 *   H5P_LIBRARY_SOURCE_DIR      a directory whose children are library folders
 *                               (a mounted volume or an unpacked artifact)
 *   H5P_LIBRARY_SOURCE_BUNDLE   a versioned bundle built by
 *                               scripts/bundle-libraries.mjs. Its sha256 must
 *                               be known: from the `<bundle>.sha256` file next
 *                               to it or from H5P_LIBRARY_SOURCE_SHA256. The
 *                               archive's manifest is checked against the
 *                               extracted tree, and the bundle version is
 *                               recorded in `<target>/.bundle.json`, which the
 *                               host reports on `GET /ready`.
 *
 * In production a CI/deploy step fetches the library bundle (from an internal
 * artifact store or the H5P Hub) into H5P_LIBRARY_SOURCE_DIR, then runs this.
 * The running application never fetches libraries itself — the editor is pinned
 * offline (contentHubEnabled:false, fetchingDisabled:1), so this out-of-band
 * copy is the only way libraries reach the runtime directory.
 *
 * Directory-source installs keep existing libraries unless --force is passed,
 * provided they still
 * look provisioned (readable library.json, matching machineName/version); a
 * corrupted existing copy is reported and left in place until --force is
 * used. Each library is staged and validated in a hidden temp directory, then
 * swapped into place via two renames (previous copy aside, staged copy in),
 * so an interrupted run never leaves a partial library where the next run
 * would mistake it for a complete install, and a crash mid-swap leaves the
 * previous copy recoverable at its backup path rather than gone.
 * Bundle installs additionally compare file hashes before keeping a library
 * and after installation, and reject any installed libraries outside the bundle.
 *
 * A bundle copied from a Mac without `--exclude` carries macOS metadata:
 * AppleDouble twins (`._H5P.Foo-1.0`), `.DS_Store` files and the `__MACOSX`
 * folder Finder writes into zip archives. h5p-server lists installed libraries
 * by directory-entry NAME (FileLibraryStorage.getInstalledLibraryNames never
 * checks the entry type), so a `._H5P.Foo-1.0` file is taken for a library and
 * the content-type listing crashes once its library.json turns out missing
 * ("Cannot read properties of undefined (reading 'patchVersion')"). This
 * script therefore strips such entries from the target and from every staged
 * copy, and refuses to finish while any other entry that h5p-server would
 * mistake for a library (a stray file named like one) remains in the target.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  LIBRARY_DIR_NAME,
  isMacosMetadata,
  libraryDirs as listLibraryDirs,
  sha256File
} from './lib/libraries.mjs';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const force = process.argv.includes('--force');

const dataRoot = path.resolve(
  process.env.H5P_HOST_DATA_DIR || path.join(repoRoot, '.host-data')
);
const targetDir = path.resolve(
  process.env.H5P_LIBRARIES_DIR || path.join(dataRoot, 'libraries')
);
const configuredSourceDir = process.env.H5P_LIBRARY_SOURCE_DIR
  ? path.resolve(process.env.H5P_LIBRARY_SOURCE_DIR)
  : undefined;
const bundlePath = process.env.H5P_LIBRARY_SOURCE_BUNDLE
  ? path.resolve(process.env.H5P_LIBRARY_SOURCE_BUNDLE)
  : undefined;

// Written into the target after a successful install from a bundle; the host's
// readiness probe reports it. The name never matches a library directory.
const BUNDLE_RECORD = '.bundle.json';
const BUNDLE_FORMAT = 'h5p-library-bundle/1';

// The pattern h5p-server matches directory entries against when it lists
// installed libraries (FileLibraryStorage.getInstalledLibraryNames). Every
// entry it matches must be a valid library directory, or the listing crashes.
const H5P_SERVER_LIBRARY_NAME = /^[\w.]+-\d+\.\d+$/i;

// A directory that cannot be read holds no libraries: every caller here goes on
// to say so in its own words ("Source has no library folders", "the manifest
// and the archive disagree"), which tells an operator more than an ENOENT.
const libraryDirs = (dir) => listLibraryDirs(dir).catch(() => []);

/** True when the path exists, a dangling symlink included. */
async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Deletes macOS metadata under `dir` (recursively); returns how many entries went. */
async function removeMacosMetadata(dir) {
  let removed = 0;
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (isMacosMetadata(entry)) {
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
    } else if (entry.isDirectory()) {
      removed += await removeMacosMetadata(full);
    }
  }
  return removed;
}

/**
 * Top-level entries of `dir` that h5p-server would list as libraries although
 * they are not library directories (`known` is what libraryDirs returned):
 * stray files, symlinks and dot-directories named like a library.
 */
async function strayLibraryEntries(dir, known) {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  return entries
    .filter(
      (entry) =>
        H5P_SERVER_LIBRARY_NAME.test(entry.name) && !known.includes(entry.name)
    )
    .map((entry) => entry.name);
}

/** Resolves a path through symlinks; returns the input if it does not exist. */
async function realOrSelf(p) {
  return fs.realpath(p).catch(() => p);
}

/** True if `child` is `parent` or lives inside it. */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True if any entry under `dir` (recursively) is a symlink. */
async function containsSymlink(dir) {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      return true;
    }
    if (entry.isDirectory()) {
      if (await containsSymlink(path.join(dir, entry.name))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validates a staged library copy before it is swapped into place. Rejects a
 * copy that has no readable `library.json`, whose declared machineName/version
 * disagree with the directory name, or that contains symlinks (untrusted source
 * content must not smuggle a link out of the runtime tree).
 *
 * Returns an error string, or null when the copy is acceptable.
 */
async function validateLibrary(stagedDir, name) {
  let meta;
  try {
    meta = JSON.parse(
      await fs.readFile(path.join(stagedDir, 'library.json'), 'utf8')
    );
  } catch {
    return 'missing or invalid library.json';
  }

  if (typeof meta?.machineName !== 'string' || meta.machineName.trim() === '') {
    return 'library.json has no machineName';
  }
  // The same rule the host's readiness probe applies (src/tenant-manager.ts,
  // isLibraryDirectory): a manifest that passes here must count there.
  if (
    !Number.isInteger(meta.majorVersion) ||
    meta.majorVersion < 0 ||
    !Number.isInteger(meta.minorVersion) ||
    meta.minorVersion < 0
  ) {
    return 'library.json majorVersion and minorVersion must be non-negative integers';
  }

  const match = LIBRARY_DIR_NAME.exec(name);
  if (!match) {
    return `directory name does not match Machine.Name-major.minor`;
  }
  const [, dirMachine, dirMajor, dirMinor] = match;
  const metaVersion = `${meta.majorVersion}.${meta.minorVersion}`;
  if (
    meta.machineName !== dirMachine ||
    metaVersion !== `${dirMajor}.${dirMinor}`
  ) {
    return (
      `library.json (${meta.machineName} ${metaVersion}) ` +
      `does not match directory name`
    );
  }

  if (await containsSymlink(stagedDir)) {
    return 'contains a symlink';
  }
  return null;
}

/** True if `dir` holds a directory whose own contents look like a valid library. */
async function looksProvisioned(dir, name) {
  const problem = await validateLibrary(path.join(dir, name), name);
  return problem === null;
}

/**
 * The checksum a bundle must have: H5P_LIBRARY_SOURCE_SHA256, or the first
 * hex token of the `<bundle>.sha256` file the bundling script writes. Neither
 * is a hard error here; the caller refuses to install without one.
 */
async function expectedBundleDigest(file) {
  const fromEnv = (process.env.H5P_LIBRARY_SOURCE_SHA256 || '')
    .trim()
    .toLowerCase();
  if (fromEnv) {
    return { digest: fromEnv, origin: 'H5P_LIBRARY_SOURCE_SHA256' };
  }
  const sidecar = `${file}.sha256`;
  const text = await fs.readFile(sidecar, 'utf8').catch(() => '');
  const match = /^\s*([0-9a-fA-F]{64})\b/.exec(text);
  return match
    ? { digest: match[1].toLowerCase(), origin: sidecar }
    : { digest: undefined, origin: sidecar };
}

/**
 * Verifies and unpacks a bundle into a temporary directory. Returns the
 * library source directory inside it, the manifest and a cleanup function.
 * Throws with a readable message on any mismatch; nothing is installed then.
 */
async function extractBundle(file) {
  await fs.access(file).catch(() => {
    throw new Error(`Bundle not found: ${file}`);
  });
  const { digest: expected, origin } = await expectedBundleDigest(file);
  if (!expected) {
    throw new Error(
      `Refusing to install ${file}: no checksum. Put the bundling script's ` +
        `.sha256 file next to it (${origin}) or set H5P_LIBRARY_SOURCE_SHA256.`
    );
  }
  const actual = await sha256File(file);
  if (actual !== expected) {
    throw new Error(
      `Refusing to install ${file}: sha256 ${actual} does not match ` +
        `${expected} (from ${origin}).`
    );
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h5p-bundle-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true });
  try {
    await execFileAsync('tar', ['-xzf', file, '-C', dir], {
      maxBuffer: 16 * 1024 * 1024
    });
    let manifest;
    try {
      manifest = JSON.parse(
        await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')
      );
    } catch {
      throw new Error(
        `${file} has no readable manifest.json; not a library bundle.`
      );
    }
    if (
      manifest?.format !== BUNDLE_FORMAT ||
      !Array.isArray(manifest.libraries)
    ) {
      throw new Error(
        `${file}: unsupported bundle format ${JSON.stringify(manifest?.format)}.`
      );
    }
    const sourceDir = path.join(dir, 'libraries');
    const extracted = await libraryDirs(sourceDir);
    const listed = manifest.libraries
      .map((library) => library?.directory)
      .filter(Boolean);
    const missing = listed.filter((name) => !extracted.includes(name));
    const extra = extracted.filter((name) => !listed.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `${file}: the manifest and the archive disagree` +
          (missing.length ? `; listed but absent: ${missing.join(', ')}` : '') +
          (extra.length ? `; present but unlisted: ${extra.join(', ')}` : '') +
          '.'
      );
    }
    return { sourceDir, manifest, digest: actual, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function recordBundle(bundle) {
  const record = {
    version: String(bundle.manifest.version),
    sha256: bundle.digest,
    libraryCount:
      bundle.manifest.libraryCount ?? bundle.manifest.libraries.length,
    createdAt: bundle.manifest.createdAt ?? null,
    provisionedAt: new Date().toISOString()
  };
  await fs.writeFile(
    path.join(targetDir, BUNDLE_RECORD),
    JSON.stringify(record, null, 2) + '\n'
  );
  return record;
}

// A bundle identifies bytes, not just major/minor directory names. Use the
// same normalized file tree for the extracted source and installed copy.
//
// The source tree is read twice per run — once before the install and once to
// verify it — and it does not change in between, so its digests are computed
// once. The target's are not cached: verifying it is the whole point.
const sourceDigests = new Map();

async function sourceDigest(directory) {
  let digest = sourceDigests.get(directory);
  if (!digest) {
    digest = await libraryDigest(directory);
    sourceDigests.set(directory, digest);
  }
  return digest;
}

async function libraryDigest(directory) {
  const hash = crypto.createHash('sha256');
  async function walk(dir, relative = '') {
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => !isMacosMetadata(entry))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const name = path.posix.join(relative, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(JSON.stringify(['directory', name]));
        await walk(full, name);
      } else if (entry.isFile()) {
        hash.update(JSON.stringify(['file', name, await sha256File(full)]));
      } else {
        // `validateLibrary` names this case for the source tree; an installed
        // copy can reach it too, and an operator needs the same words.
        throw new Error(`${full} is a symlink or device, not a library file.`);
      }
    }
  }
  await walk(directory);
  return hash.digest('hex');
}

async function checkBundleTarget(
  sourceDir,
  names,
  { allowReplacement = false, allowMissing = false } = {}
) {
  const installed = await libraryDirs(targetDir);
  const extra = installed.filter((name) => !names.includes(name));
  if (extra.length) {
    throw new Error(
      `Target contains libraries outside the bundle: ${extra.join(', ')}. Install into a new empty H5P_LIBRARIES_DIR and restart the host.`
    );
  }
  for (const name of names) {
    const problem = await validateLibrary(path.join(sourceDir, name), name);
    if (problem) throw new Error(`${name}: ${problem}`);
    if (!installed.includes(name)) {
      if (allowMissing) continue;
      throw new Error(`Installed bundle is missing ${name}.`);
    }
    if (allowReplacement) continue;
    if (
      (await sourceDigest(path.join(sourceDir, name))) !==
      (await libraryDigest(path.join(targetDir, name)))
    ) {
      throw new Error(
        `Installed ${name} differs from the bundle. Use --force to replace it, or install into a new empty H5P_LIBRARIES_DIR.`
      );
    }
  }
}

async function main() {
  if (bundlePath && configuredSourceDir) {
    console.error(
      'Set either H5P_LIBRARY_SOURCE_DIR or H5P_LIBRARY_SOURCE_BUNDLE, not both.'
    );
    process.exitCode = 1;
    return;
  }
  let bundle;
  if (bundlePath) {
    try {
      bundle = await extractBundle(bundlePath);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Installing bundle ${bundle.manifest.version} (${bundle.manifest.libraries.length} libraries, sha256 ${bundle.digest})`
    );
  }
  try {
    await provision(bundle ? bundle.sourceDir : configuredSourceDir, bundle);
  } finally {
    await bundle?.cleanup();
  }
}

async function provision(sourceDir, bundle) {
  await fs.mkdir(targetDir, { recursive: true });
  // A terminated process may have moved the old copy aside without installing
  // its replacement, or installed it without removing the backup. Settle both
  // before validation, even with no source set.
  for (const entry of await fs.readdir(targetDir, { withFileTypes: true })) {
    const prefix = '.provision-backup-';
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const name = entry.name.slice(prefix.length);
    if (!LIBRARY_DIR_NAME.test(name)) continue;
    const backup = path.join(targetDir, entry.name);
    const dest = path.join(targetDir, name);
    if (!(await exists(dest))) {
      await fs.rename(backup, dest);
      console.warn(`Recovered ${name} from an interrupted library replacement`);
    } else if (await looksProvisioned(targetDir, name)) {
      // The swap completed; only the cleanup was lost. A backup beside an
      // invalid installed copy is kept: it may be the only good copy left.
      await fs.rm(backup, { recursive: true, force: true });
      console.warn(
        `Removed the stale backup of ${name} left by an interrupted run`
      );
    }
  }
  const removedMetadata = await removeMacosMetadata(targetDir);
  if (removedMetadata > 0) {
    console.warn(
      `Removed ${removedMetadata} macOS metadata entr${removedMetadata === 1 ? 'y' : 'ies'} ` +
        `(._*, .DS_Store, __MACOSX) from ${targetDir}`
    );
  }
  const present = await libraryDirs(targetDir);
  const stray = await strayLibraryEntries(targetDir, present);
  if (stray.length > 0) {
    console.error(
      `${stray.length} entr${stray.length === 1 ? 'y' : 'ies'} in ${targetDir} ` +
        'would be listed as libraries by h5p-server but are not library ' +
        `directories: ${stray.join(', ')}.\n` +
        'Remove them by hand and re-run.'
    );
    process.exitCode = 1;
    return;
  }

  if (!sourceDir) {
    if (present.length === 0) {
      console.error(
        `No libraries in ${targetDir} and H5P_LIBRARY_SOURCE_DIR is unset.\n` +
          'Point H5P_LIBRARY_SOURCE_DIR at a directory of H5P library folders ' +
          '(a mounted volume or an unpacked release artifact) and re-run.'
      );
      process.exitCode = 1;
      return;
    }
    const invalid = [];
    for (const name of present) {
      if (!(await looksProvisioned(targetDir, name))) {
        invalid.push(name);
      }
    }
    if (invalid.length > 0) {
      console.error(
        `${invalid.length} of ${present.length} librar${invalid.length === 1 ? 'y' : 'ies'} ` +
          `in ${targetDir} do not look provisioned: ${invalid.join(', ')}.\n` +
          'Set H5P_LIBRARY_SOURCE_DIR and re-run with --force to replace them.'
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Libraries already provisioned: ${present.length} in ${targetDir}`
    );
    return;
  }

  // Refuse a source that is the target (or nested in it): otherwise --force
  // would delete the library it is meant to install from.
  const [realSource, realTarget] = await Promise.all([
    realOrSelf(sourceDir),
    realOrSelf(targetDir)
  ]);
  if (isInside(realTarget, realSource) || isInside(realSource, realTarget)) {
    console.error(
      `Refusing to provision: source (${sourceDir}) and target (${targetDir}) ` +
        'overlap. Point H5P_LIBRARY_SOURCE_DIR at a separate directory.'
    );
    process.exitCode = 1;
    return;
  }

  const available = await libraryDirs(sourceDir);
  if (available.length === 0) {
    console.error(`Source has no library folders: ${sourceDir}`);
    process.exitCode = 1;
    return;
  }

  if (bundle) {
    // Validate the entire set before writing anything. A rejected upgrade
    // keeps its old bundle identity; once replacement begins that identity
    // must disappear until the final installed bytes have been verified.
    await checkBundleTarget(sourceDir, available, {
      allowReplacement: force,
      allowMissing: true
    });
  }

  let identityCleared = false;
  let copied = 0;
  let skipped = 0;
  let rejected = 0;
  let stripped = 0;
  for (const name of available) {
    const dest = path.join(targetDir, name);
    if (present.includes(name) && !force) {
      if (await looksProvisioned(targetDir, name)) {
        skipped += 1;
      } else {
        console.warn(
          `Not replacing ${name}: existing copy does not look provisioned ` +
            '(re-run with --force to replace it)'
        );
        rejected += 1;
      }
      continue;
    }

    // Stage into a hidden temp dir (invisible to libraryDirs), validate the
    // full copy, then swap it in. If the run dies during the copy, `dest`
    // still holds the previous complete library (or stays absent on a fresh
    // install) — never a half-written one. The swap itself is two renames
    // (dest -> backup, staging -> dest) rather than a delete-then-rename, so
    // a crash between them leaves the previous library recoverable at the
    // backup path instead of gone.
    const staging = path.join(targetDir, `.provision-tmp-${name}`);
    const backup = path.join(targetDir, `.provision-backup-${name}`);
    await fs.rm(staging, { recursive: true, force: true });
    let movedExisting = false;
    let installed = false;
    try {
      await fs.cp(path.join(sourceDir, name), staging, {
        recursive: true,
        dereference: false,
        errorOnExist: false
      });
      stripped += await removeMacosMetadata(staging);
      const problem = await validateLibrary(staging, name);
      if (problem) {
        console.warn(`Skipping ${name}: ${problem}`);
        rejected += 1;
        continue;
      }
      // Even a failed partial deployment no longer represents the old bundle.
      // Once, before the first replacement: the record cannot come back until
      // the whole installed set has been verified against the bundle.
      if (!identityCleared) {
        await fs.rm(path.join(targetDir, BUNDLE_RECORD), { force: true });
        identityCleared = true;
      }
      if (await exists(dest)) {
        // A backup left beside the installed copy by an interrupted run is
        // normally stale. But when the installed copy is invalid and the
        // backup is a valid library, the backup is the only good copy there
        // is: keep it as the rollback target and let the broken copy go, or a
        // failed swap would roll back to the broken one.
        const backupIsOnlyGoodCopy =
          (await exists(backup)) &&
          (await validateLibrary(backup, name)) === null &&
          !(await looksProvisioned(targetDir, name));
        if (backupIsOnlyGoodCopy) {
          await fs.rm(dest, { recursive: true, force: true });
        } else {
          await fs.rm(backup, { recursive: true, force: true });
          await fs.rename(dest, backup);
        }
        movedExisting = true;
      }
      await fs.rename(staging, dest);
      installed = true;
      copied += 1;
    } catch (error) {
      if (movedExisting && !installed) {
        try {
          await fs.rename(backup, dest);
        } catch (rollbackError) {
          // Preserve the only surviving copy for recovery on the next run.
          console.error(
            `Could not restore ${name}; previous copy remains at ${backup}`,
            rollbackError
          );
        }
      }
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
      if (installed) await fs.rm(backup, { recursive: true, force: true });
    }
  }
  console.log(
    `Provisioned ${targetDir}: ${copied} copied, ${skipped} kept, ` +
      `${rejected} rejected, ${available.length} available in source` +
      (stripped > 0
        ? `, ${stripped} macOS metadata entr${stripped === 1 ? 'y' : 'ies'} stripped from the copies.`
        : '.')
  );
  if (rejected > 0) {
    process.exitCode = 1;
    return;
  }
  if (bundle) {
    await checkBundleTarget(sourceDir, available);
    const record = await recordBundle(bundle);
    console.log(
      `Recorded bundle ${record.version} in ${path.join(targetDir, BUNDLE_RECORD)}`
    );
  } else if (copied > 0) {
    // The target no longer corresponds to any bundle.
    await fs.rm(path.join(targetDir, BUNDLE_RECORD), { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
