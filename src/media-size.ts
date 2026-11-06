import path from 'path';
import { ContentFileScanner, LibraryName } from '@lumieducation/h5p-server';

import HostError from './errors';
import { assertContentId, isInsideDirectory } from './content-id';
import { assertMediaSize, bookSizeLimits } from './book-size';
import { parsePasteReference } from './paste-sources';
import { savePayload } from './save-payload';
import type { WebContext } from './h5p/context';
import type WebUser from './h5p/user';
import { examMediaPaths, isExamContent } from './h5p/exam-package';
import { isExternalReference } from './h5p/whole-package';

/**
 * Measure the current, unsaved form rather than the tenant's temporary folder:
 * removed/replaced media and uploads for other books must not consume its
 * allowance. Use H5P semantics, including original images and nested libraries,
 * just as the save does; media pasted from another book counts for nothing
 * here (see the loop). The caller holds the shared content lock.
 */
export async function checkMediaSize(
  ctx: WebContext,
  user: WebUser,
  rawId: string,
  body: Record<string, unknown>
): Promise<ReturnType<typeof bookSizeLimits> & { mediaBytes: number }> {
  assertContentId(rawId, { creatable: true });
  const id = rawId === 'new' ? undefined : rawId;
  const payload = savePayload(body);
  const incoming = body.incomingBytes;
  if (
    typeof incoming !== 'number' ||
    !Number.isSafeInteger(incoming) ||
    incoming < 0
  ) {
    throw new HostError(
      'incomingBytes must be a non-negative byte count.',
      400
    );
  }
  // A file that cannot fit by itself needs no semantics or storage reads.
  assertMediaSize(incoming);
  let library;
  try {
    library = LibraryName.fromUberName(payload.library, {
      useWhitespace: true
    });
  } catch {
    throw new HostError('Invalid library name.', 400);
  }
  const editor = ctx.h5pEditor;
  const scanned = await new ContentFileScanner(
    editor.libraryManager
  ).scanForFiles(payload.params, library);
  // Exam updates retain even files no open reference or manifest names: the
  // encrypted chapter may still need them (keepExamFilesOnUpdate).
  const retained =
    id !== undefined && isExamContent(payload.params)
      ? (await editor.contentStorage.listFiles(id, user))
          .map((file) => file.split(path.sep).join('/'))
          .filter((file) => file !== 'content.json' && file !== 'h5p.json')
      : [];
  const files = [
    // A legacy URL such as `host.tld/file` is ambiguous with a real local
    // directory. Let storage decide: H5P also keeps/copies a present local
    // file before treating a missing path as an external reference.
    ...scanned.map((file) => ({
      ...file,
      mayBeExternal:
        !file.temporary && isExternalReference(file.filePath, file.mimeType)
    })),
    // The exam manifest and disk listing contain local paths. A directory
    // like `assets.v1/` must not be mistaken for a legacy external video URL.
    ...[...examMediaPaths(payload.params), ...retained].map((filePath) => ({
      filePath,
      temporary: false,
      mimeType: '',
      mayBeExternal: false
    }))
  ];
  let mediaBytes = 0;
  const counted = new Set<string>();
  for (const file of files) {
    const pasted = parsePasteReference(file.filePath);
    // Another book's file is not opened at all: this route has no word on
    // whether the caller may read it, and its size would answer that it
    // exists and how large it is. The save names the allowed sources and
    // applies the limit to what it actually copied.
    if (pasted && pasted.sourceId !== id) continue;
    const filename = pasted?.filename ?? file.filePath;
    // A reference that climbs is judged as such first: resolved against the
    // working directory it would look inside if that directory were `/`.
    if (
      (!pasted && file.filePath.startsWith('../')) ||
      !isInsideDirectory('.', filename)
    ) {
      if (file.mayBeExternal) continue;
      throw new HostError('Invalid media path.', 400);
    }
    const stored =
      id !== undefined &&
      (await editor.contentStorage.fileExists(id, filename));
    const temporary = !stored && file.temporary;
    const key = temporary ? `tmp/${filename}` : `${id}/${filename}`;
    // H5P copies each pasted reference separately, but reuses a repeated
    // stored/temporary path. Count the bytes the final book will contain.
    if (!pasted) {
      if (counted.has(key)) continue;
      counted.add(key);
    }
    // Missing references occupy no bytes. Refusing them here would prevent
    // replacing expired uploads, including repairing several one at a time.
    // The save still checks that every referenced file exists before publish.
    if (!stored && !temporary) continue;
    try {
      const stats = temporary
        ? await editor.temporaryFileManager.getFileStats(filename, user)
        : await editor.contentStorage.getFileStats(id!, filename, user);
      mediaBytes += stats.size;
    } catch (error) {
      // The janitor can remove temporary files during this check; the shared
      // content lock protects saved files only. Propagate other storage errors
      // rather than admitting an upload whose existing bytes are unknown.
      const failure = error as NodeJS.ErrnoException & { errorId?: string };
      if (
        temporary &&
        (failure.code === 'ENOENT' ||
          failure.errorId ===
            'storage-file-implementations:temporary-file-not-found')
      ) {
        continue;
      }
      throw error;
    }
  }
  assertMediaSize(mediaBytes + incoming);
  return { ...bookSizeLimits(), mediaBytes };
}
