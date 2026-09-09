import { H5PEditor, LibraryName } from '@lumieducation/h5p-server';

import HostError from './errors';

interface Version {
  majorVersion: number;
  minorVersion: number;
}

function isNewer(a: Version, b: Version): boolean {
  return (
    a.majorVersion > b.majorVersion ||
    (a.majorVersion === b.majorVersion && a.minorVersion > b.minorVersion)
  );
}

export default async function resolveLibraries(
  editor: H5PEditor,
  machineNames: string[]
): Promise<Record<string, string>> {
  const installed = await editor.libraryManager.listInstalledLibraries();
  const resolved: Record<string, string> = {};

  machineNames.forEach((machineName) => {
    const versions = installed[machineName];
    if (!versions || versions.length === 0) {
      return;
    }
    const best = versions.reduce((left, right) =>
      isNewer(right, left) ? right : left
    );
    resolved[machineName] = LibraryName.toUberName(best, {
      useWhitespace: true
    });
  });

  return resolved;
}

/**
 * The container's semantics are the authority on supported nested libraries.
 *
 * The ubername is parsed in both spellings: `resolveLibraries` above hands the
 * rest of the contract the whitespace form (`H5P.Column 1.18`), while the H5P
 * runtime and stored parameters use the hyphenated one. h5p-server's own
 * failures here carry raw error ids, so an unparseable or unknown library is
 * translated into a plain host error instead.
 */
export async function containerLibraries(
  editor: H5PEditor,
  ubername: string
): Promise<string[]> {
  let name;
  try {
    name = LibraryName.fromUberName(ubername, {
      useHyphen: true,
      useWhitespace: true
    });
  } catch (error) {
    throw new HostError('Invalid library name.', 400);
  }
  let semantics;
  try {
    semantics = await editor.libraryManager.getSemantics(name);
  } catch (error) {
    throw new HostError('Unknown library.', 404);
  }
  if (!semantics) {
    throw new HostError('Unknown library.', 404);
  }
  const allowed = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.type === 'library' && Array.isArray(record.options)) {
      record.options.forEach((option) => {
        if (typeof option === 'string') allowed.add(option);
        else if (typeof option?.name === 'string') allowed.add(option.name);
      });
    }
    Object.values(record).forEach(walk);
  };
  walk(semantics);
  return Array.from(allowed);
}
