#!/usr/bin/env node
/*
 * Builds a versioned, checksummed bundle of the provisioned H5P libraries.
 *
 * Deployments and the legal sign-off need one fixed artifact rather than "the
 * libraries currently on the development machine": a lawyer signs off on a
 * specific library set, and a server must be provisioned from exactly that
 * set. This script turns a library directory into
 *
 *   <out>/h5p-libraries-<version>.tar.gz          the archive
 *   <out>/h5p-libraries-<version>.tar.gz.sha256   `sha256sum -c` line
 *
 * The archive holds `manifest.json` (version, creation time, every library's
 * directory, machine name, version and declared license), the generated
 * `THIRD-PARTY-LIBRARIES.md` license inventory of exactly this set, and the
 * libraries under `libraries/`. macOS metadata is excluded. Release artifacts
 * are stored outside Git and installed with
 *
 *   H5P_LIBRARY_SOURCE_BUNDLE=/path/h5p-libraries-<version>.tar.gz \
 *     npm run provision:libraries
 *
 * which verifies the checksum (sidecar file or H5P_LIBRARY_SOURCE_SHA256),
 * checks the manifest against the extracted tree and records the bundle
 * version in the runtime directory (reported by `GET /ready` as `bundle`).
 *
 * Usage:
 *   node scripts/bundle-libraries.mjs [--version <label>] [--out <dir>] [--source <dir>]
 *
 * Defaults: source = H5P_LIBRARIES_DIR (or <H5P_HOST_DATA_DIR|.host-data>/libraries),
 * out = ./dist (git-ignored), version = today's date (YYYYMMDD).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { LIBRARY_DIR_NAME, libraryDirs, sha256File } from './lib/libraries.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

const dataRoot = path.resolve(
  process.env.H5P_HOST_DATA_DIR || path.join(repoRoot, '.host-data')
);
const sourceDir = path.resolve(
  argValue('--source') ||
    process.env.H5P_LIBRARIES_DIR ||
    path.join(dataRoot, 'libraries')
);
const outDir = path.resolve(argValue('--out') || path.join(repoRoot, 'dist'));
const version = (
  argValue('--version') ||
  new Date().toISOString().slice(0, 10).replace(/-/g, '')
).trim();

const VERSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function describeLibrary(name) {
  const match = LIBRARY_DIR_NAME.exec(name);
  if (!match) {
    throw new Error(`${name}: directory name is not Machine.Name-major.minor`);
  }
  let meta;
  try {
    meta = JSON.parse(
      await fs.readFile(path.join(sourceDir, name, 'library.json'), 'utf8')
    );
  } catch {
    throw new Error(`${name}: missing or invalid library.json`);
  }
  const [, dirMachine, dirMajor, dirMinor] = match;
  if (
    meta?.machineName !== dirMachine ||
    !Number.isInteger(meta.majorVersion) ||
    !Number.isInteger(meta.minorVersion) ||
    `${meta.majorVersion}.${meta.minorVersion}` !== `${dirMajor}.${dirMinor}`
  ) {
    throw new Error(`${name}: library.json does not match the directory name`);
  }
  return {
    directory: name,
    machineName: meta.machineName,
    majorVersion: meta.majorVersion,
    minorVersion: meta.minorVersion,
    patchVersion: Number.isInteger(meta.patchVersion)
      ? meta.patchVersion
      : null,
    title: typeof meta.title === 'string' ? meta.title : name,
    license: typeof meta.license === 'string' ? meta.license : null
  };
}

async function main() {
  if (!VERSION_LABEL.test(version)) {
    throw new Error(
      `Bundle version "${version}" must be 1-64 characters of [A-Za-z0-9._-] and start with a letter or digit`
    );
  }
  const names = await libraryDirs(sourceDir).catch((error) => {
    throw new Error(
      `Cannot read the library directory ${sourceDir}: ${error.message}`
    );
  });
  if (names.length === 0) {
    throw new Error(`No library folders in ${sourceDir}`);
  }
  const libraries = [];
  for (const name of names) {
    libraries.push(await describeLibrary(name));
  }

  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'h5p-bundle-'));
  const archiveName = `h5p-libraries-${version}.tar.gz`;
  const archive = path.join(outDir, archiveName);
  try {
    const manifest = {
      format: 'h5p-library-bundle/1',
      version,
      createdAt: new Date().toISOString(),
      libraryCount: libraries.length,
      libraries
    };
    await fs.writeFile(
      path.join(staging, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    );
    // The license inventory of exactly this set travels inside the archive.
    // Its warnings — a library on unrecorded terms, an evidence entry gone
    // stale — are about the set being packaged, so they are forwarded instead
    // of captured and dropped: a bundle is the last place an unknown library
    // should slip through unnoticed.
    const inventory = await execFileAsync(
      process.execPath,
      [path.join(repoRoot, 'scripts/library-license-inventory.mjs')],
      {
        env: {
          ...process.env,
          H5P_LIBRARIES_DIR: sourceDir,
          LICENSE_INVENTORY_OUT: path.join(staging, 'THIRD-PARTY-LIBRARIES.md')
        }
      }
    );
    if (inventory.stderr) {
      process.stderr.write(inventory.stderr);
    }
    // `libraries/` inside the archive is a symlink to the source that tar
    // follows (-h), so nothing is copied twice on disk.
    await fs.symlink(sourceDir, path.join(staging, 'libraries'), 'dir');

    await fs.mkdir(outDir, { recursive: true });
    await fs.rm(archive, { force: true });
    await execFileAsync(
      'tar',
      [
        '--exclude=._*',
        '--exclude=.DS_Store',
        '--exclude=__MACOSX',
        '-h',
        '-czf',
        archive,
        '-C',
        staging,
        'manifest.json',
        'THIRD-PARTY-LIBRARIES.md',
        ...names.map((name) => path.join('libraries', name))
      ],
      {
        // No AppleDouble `._*` entries from a macOS tar.
        env: { ...process.env, COPYFILE_DISABLE: '1' },
        maxBuffer: 16 * 1024 * 1024
      }
    );
    const digest = await sha256File(archive);
    await fs.writeFile(`${archive}.sha256`, `${digest}  ${archiveName}\n`);
    const size = (await fs.stat(archive)).size;
    console.log(
      `Wrote ${archive} (${libraries.length} libraries, ${(size / 1024 / 1024).toFixed(1)} MiB)\n` +
        `sha256 ${digest}\n` +
        `Checksum file: ${archive}.sha256`
    );
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
