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
 * Counts every `{ library, params }` pair nested anywhere in the value.
 *
 * Walked with a stack of its own rather than by recursion: stored content —
 * an imported package included — is not depth-checked, and a recursive walk
 * of a few thousand levels ends in a stack overflow.
 */
export function nestedLibraries(value: unknown): Map<string, number> {
  const result = new Map<string, number>();
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object') continue;
    const record = next as Record<string, unknown>;
    if (typeof record.library === 'string' && record.library && record.params) {
      result.set(record.library, (result.get(record.library) || 0) + 1);
    }
    // Not `push(...values)`: a long array would exceed the argument limit.
    for (const child of Object.values(record)) pending.push(child);
  }
  return result;
}

/**
 * A library version stored content uses but this host does not have, and the
 * newest installed version of the same library that can replace it (`null`
 * when only older versions, or none, are installed: content is never
 * downgraded).
 */
export interface MissingLibrary {
  library: string;
  upgrade: string | null;
}

/**
 * Which `major.minor` versions named by the content — its main library and
 * every nested `{ library, params }` — are not installed. The editor can open
 * none of those: their semantics answer 404. Names that do not parse are left
 * to the editor, as before.
 */
export async function missingLibraries(
  editor: H5PEditor,
  mainLibrary: string | undefined,
  params: unknown
): Promise<MissingLibrary[]> {
  const installed = await editor.libraryManager.listInstalledLibraries();
  // The main library first: it is the one the author recognises.
  const used = new Set(mainLibrary ? [mainLibrary] : []);
  nestedLibraries(params).forEach((_count, library) => used.add(library));
  const missing: MissingLibrary[] = [];
  used.forEach((ubername) => {
    let name;
    try {
      name = LibraryName.fromUberName(ubername, { useWhitespace: true });
    } catch {
      return;
    }
    const versions = installed[name.machineName] || [];
    if (
      versions.some(
        (version) =>
          version.majorVersion === name.majorVersion &&
          version.minorVersion === name.minorVersion
      )
    ) {
      return;
    }
    const newer = versions.filter((version) => isNewer(version, name));
    const best = newer.length
      ? newer.reduce((left, right) => (isNewer(right, left) ? right : left))
      : undefined;
    missing.push({
      library: ubername,
      upgrade: best
        ? `${name.machineName} ${best.majorVersion}.${best.minorVersion}`
        : null
    });
  });
  return missing;
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
