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
 * A library version stored content uses that the editor cannot open, and the
 * newest installed version that can replace it (`null` when there is none:
 * content is never downgraded).
 *
 * `reason` says why: `not-installed` — this host does not have the version;
 * `not-accepted` — it is installed, but the installed container the content
 * nests it in no longer lists it among the options of that field (a patch of
 * the container replaced in place, see `unacceptedLibraries`), and the
 * replacement is the version the container lists there.
 */
export interface MissingLibrary {
  library: string;
  upgrade: string | null;
  reason: 'not-installed' | 'not-accepted';
}

type InstalledLibraries = Awaited<
  ReturnType<H5PEditor['libraryManager']['listInstalledLibraries']>
>;

function parseUberName(ubername: string): LibraryName | undefined {
  try {
    return LibraryName.fromUberName(ubername, { useWhitespace: true });
  } catch {
    return undefined;
  }
}

function isInstalled(
  installed: InstalledLibraries,
  name: LibraryName
): boolean {
  return (installed[name.machineName] || []).some(
    (version) =>
      version.majorVersion === name.majorVersion &&
      version.minorVersion === name.minorVersion
  );
}

/**
 * Which `major.minor` versions named by the content — its main library and
 * every nested `{ library, params }` — the editor cannot open:
 *
 * - versions that are not installed (`uninstalledLibraries`): their
 *   semantics answer 404;
 * - installed versions that the field holding them no longer accepts
 *   (`unacceptedLibraries`): the editor would drop that part of the content.
 *
 * Each version is listed once, a missing installation taking precedence.
 */
export async function missingLibraries(
  editor: H5PEditor,
  mainLibrary: string | undefined,
  params: unknown
): Promise<MissingLibrary[]> {
  const installed = await editor.libraryManager.listInstalledLibraries();
  const missing = uninstalledIn(installed, mainLibrary, params);
  const listed = new Set(missing.map((entry) => entry.library));
  (await unacceptedLibraries(editor, installed, mainLibrary, params)).forEach(
    (entry) => {
      if (!listed.has(entry.library)) missing.push(entry);
    }
  );
  return missing;
}

/**
 * The versions named by the content — its main library first, then every
 * nested `{ library, params }` — that are not installed, each with the newest
 * installed version of the same library that is newer (`upgrade`, `null`
 * when there is none: content is never downgraded). Names that do not parse
 * are left to the editor, as before. Also what decides whether a package on
 * such versions may be imported as it is (h5p/outdated-package.ts).
 */
export async function uninstalledLibraries(
  editor: H5PEditor,
  mainLibrary: string | undefined,
  params: unknown
): Promise<MissingLibrary[]> {
  return uninstalledIn(
    await editor.libraryManager.listInstalledLibraries(),
    mainLibrary,
    params
  );
}

function uninstalledIn(
  installed: InstalledLibraries,
  mainLibrary: string | undefined,
  params: unknown
): MissingLibrary[] {
  // The main library first: it is the one the author recognises.
  const used = new Set(mainLibrary ? [mainLibrary] : []);
  nestedLibraries(params).forEach((_count, library) => used.add(library));
  const missing: MissingLibrary[] = [];
  used.forEach((ubername) => {
    const name = parseUberName(ubername);
    if (!name || isInstalled(installed, name)) return;
    missing.push({
      library: ubername,
      upgrade: newestNewer(installed, name),
      reason: 'not-installed'
    });
  });
  return missing;
}

/**
 * The newest installed `major.minor` of the library that is newer than
 * `name`, as `Name major.minor`, or `null` when there is none: content is
 * never downgraded.
 */
function newestNewer(
  installed: InstalledLibraries,
  name: LibraryName
): string | null {
  const newer = (installed[name.machineName] || []).filter((version) =>
    isNewer(version, name)
  );
  if (!newer.length) return null;
  const best = newer.reduce((left, right) =>
    isNewer(right, left) ? right : left
  );
  return `${name.machineName} ${best.majorVersion}.${best.minorVersion}`;
}

/**
 * A newer installed version of the content's main library, which the editor
 * page offers as an optional upgrade (web/editor-host.js
 * `offerNewerLibrary`): `library` is the stored main library, `upgrade` the
 * newest installed version of it that is newer.
 */
export interface AvailableUpgrade {
  library: string;
  upgrade: string;
}

/**
 * The optional upgrade of content the editor can open as it is — the caller
 * asks only when `missingLibraries` found nothing. Content on an installed
 * version opens on that version, and nothing else offers the newer one.
 *
 * Only the main library: the core's content upgrade moves the nested
 * libraries to the versions the new container's semantics name.
 *
 * `null` when the upgrade cannot or must not run:
 * - the main library is not a plain `Name major.minor` (the browser upgrade
 *   starts from that spelling) or not installed (then it is listed missing);
 * - the parameters carry a root `vmbExam` — any, not only one the exam mode
 *   recognises (`isExamContent`): the encrypted chapter is a chapter the
 *   upgrade cannot see into, so the book would move to the new version with
 *   that chapter's content left on the old one (the exam bridge contract of
 *   VMB.InteractiveBook, §1.5).
 */
export async function availableUpgrade(
  editor: H5PEditor,
  mainLibrary: string | undefined,
  params: unknown
): Promise<AvailableUpgrade | null> {
  if (!mainLibrary || !/^\S+ \d+\.\d+$/.test(mainLibrary)) return null;
  if (
    params !== null &&
    typeof params === 'object' &&
    !Array.isArray(params) &&
    (params as Record<string, unknown>).vmbExam !== undefined
  ) {
    return null;
  }
  const name = parseUberName(mainLibrary);
  if (!name) return null;
  const installed = await editor.libraryManager.listInstalledLibraries();
  if (!isInstalled(installed, name)) return null;
  const upgrade = newestNewer(installed, name);
  return upgrade ? { library: mainLibrary, upgrade } : null;
}

/** One `type: "library"` field's accepted versions, as `Name major.minor`. */
function fieldOptions(field: Record<string, unknown>): string[] {
  if (!Array.isArray(field.options)) return [];
  return field.options
    .map((option: unknown) =>
      typeof option === 'string'
        ? option
        : typeof (option as { name?: unknown })?.name === 'string'
          ? (option as { name: string }).name
          : undefined
    )
    .filter((option): option is string => Boolean(option))
    .map((option) => option.trim());
}

/**
 * Installed library versions the content nests in a field whose installed
 * semantics no longer list them.
 *
 * Provisioning replaces a container's `Name-major.minor` directory in place
 * for a patch release, and no content upgrade runs then. When the patch drops
 * or re-versions an entry in a library field's `options`, the editor offers
 * only the listed versions in that field; it finds no match for the stored
 * one and clears the field (`H5PEditor.Library#loadLibrary('-')` deletes the
 * nested library, params, sub-content id and metadata), so the next save
 * loses that part of the book for good. The H5P core's content upgrade, by
 * contrast, moves such a library to the version the field lists — with its
 * upgrade hooks — or fails, so these versions are offered to it like missing
 * ones.
 *
 * The walk follows the semantics like the editor and the content upgrade do:
 * a library field, a list item, a group's fields — a group of one field
 * (and not `isSubContent`) holding that field's value directly. It starts at
 * the main library and enters a nested library only when that version is
 * accepted and installed: a missing version is reported on its own, and the
 * libraries nested in an unaccepted one are judged by the version it is
 * upgraded to, not by this one. A stack of its own, as in `nestedLibraries`.
 */
async function unacceptedLibraries(
  editor: H5PEditor,
  installed: InstalledLibraries,
  mainLibrary: string | undefined,
  params: unknown
): Promise<MissingLibrary[]> {
  const semanticsCache = new Map<string, Promise<unknown>>();
  const fieldsOf = async (
    name: LibraryName
  ): Promise<Record<string, unknown>[]> => {
    const key = LibraryName.toUberName(name, { useWhitespace: true });
    if (!semanticsCache.has(key)) {
      // Fail closed: skipping a library whose semantics did not load would
      // pass the check, and a later read by the editor that succeeds could
      // still clear what this one never saw. (Not a 404: h5p-server reports
      // a missing file as one, which would read as missing content.)
      semanticsCache.set(
        key,
        editor.libraryManager.getSemantics(name).catch((error: unknown) => {
          throw Object.assign(
            new HostError(`Could not read the semantics of ${key}.`, 500),
            { cause: error }
          );
        })
      );
    }
    const semantics = await semanticsCache.get(key);
    return Array.isArray(semantics)
      ? semantics.filter(
          (field): field is Record<string, unknown> =>
            Boolean(field) && typeof field === 'object'
        )
      : [];
  };
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  const found = new Map<string, MissingLibrary>();
  const pending: { field: Record<string, unknown>; value: unknown }[] = [];
  const enter = async (name: LibraryName, value: unknown): Promise<void> => {
    if (!isRecord(value)) return;
    for (const field of await fieldsOf(name)) {
      if (typeof field.name === 'string') {
        pending.push({ field, value: value[field.name] });
      }
    }
  };

  const main = mainLibrary ? parseUberName(mainLibrary) : undefined;
  if (!main || !isInstalled(installed, main)) return [];
  await enter(main, params);
  while (pending.length) {
    const { field, value } = pending.pop()!;
    if (field.type === 'list') {
      if (Array.isArray(value) && isRecord(field.field)) {
        for (const item of value)
          pending.push({ field: field.field, value: item });
      }
    } else if (field.type === 'group') {
      const fields = Array.isArray(field.fields)
        ? field.fields.filter(isRecord)
        : [];
      if (fields.length === 1 && field.isSubContent !== true) {
        pending.push({ field: fields[0], value });
      } else if (isRecord(value)) {
        for (const child of fields) {
          if (typeof child.name === 'string') {
            pending.push({ field: child, value: value[child.name] });
          }
        }
      }
    } else if (field.type === 'library' && isRecord(value)) {
      const ubername = value.library;
      if (typeof ubername !== 'string' || !ubername || !value.params) continue;
      const name = parseUberName(ubername);
      if (!name) continue;
      const options = fieldOptions(field);
      if (options.includes(ubername)) {
        if (isInstalled(installed, name)) await enter(name, value.params);
        continue;
      }
      if (!isInstalled(installed, name)) continue; // reported as missing
      // The version the content upgrade would move it to: the field's FIRST
      // entry for the same library — the core's processField takes that one
      // and refuses (errorTooHighVersion) when it is not newer, even if a
      // later entry is — provided it is newer and installed.
      const target = options
        .map(parseUberName)
        .find((option) => option?.machineName === name.machineName);
      const upgrade =
        target && isNewer(target, name) && isInstalled(installed, target)
          ? `${target.machineName} ${target.majorVersion}.${target.minorVersion}`
          : null;
      const previous = found.get(ubername);
      found.set(ubername, {
        library: ubername,
        // One place it cannot be upgraded in is enough to block the upgrade.
        upgrade: previous && previous.upgrade === null ? null : upgrade,
        reason: 'not-accepted'
      });
    }
  }
  return Array.from(found.values());
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
