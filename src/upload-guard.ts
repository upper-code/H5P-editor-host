import fs from 'fs/promises';
import path from 'path';
import type { UploadedFile } from 'express-fileupload';

import HostError from './errors';

// HTML documents and scripts are not editor media and must not acquire a URL
// on the application's origin. h5p-server's own `contentWhitelist` refuses
// them on its upload route, but that is a configurable list; this is the same
// answer stated once, for every route that accepts a file.
const activeDocumentExtension =
  /\.(?:html?|xhtml|xht|shtml|mhtml?|js|mjs|cjs)$/i;
const activeDocumentMime =
  /^(?:text\/html|application\/xhtml\+xml|(?:text|application)\/(?:javascript|ecmascript))$/i;

export function assertUploadAllowed(files: UploadedFile[]): void {
  files.forEach(assertTemporaryUploadAllowed);
}

export function assertTemporaryUploadAllowed(file: UploadedFile): void {
  if (
    activeDocumentExtension.test(file.name) ||
    activeDocumentMime.test(String(file.mimetype).split(';')[0].trim())
  ) {
    throw new HostError(
      'HTML documents and scripts are not accepted as temporary files.',
      415
    );
  }
}

/**
 * Only media and supporting resources need inline delivery. SVG remains usable
 * as an image; the response sandbox disables scripts when it is opened as a
 * document. Everything else is an attachment — legacy HTML, but deliberately
 * also the document formats H5P's own whitelist allows (PDF, office files,
 * text): the browser renders those with parsers of their own, and none of them
 * has to be viewed in place for the editor or the player to work.
 */
export function mayDisplayInline(filename: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|tiff?|svg|webm|mp4|m4v|ogg|ogv|oga|mp3|m4a|wav|flac|aac|opus|vtt|webvtt|eot|ttf|woff2?|otf|gltf|glb)$/i.test(
    path.basename(filename)
  );
}

/**
 * Formats whose `image-size` parsers can be driven into an infinite loop by a
 * crafted file (GHSA-w3rx-r6r6-pgpr for ICNS, GHSA-5p2g-fcmc-qvqq for JXL and
 * HEIF; no fixed release exists as of image-size 2.0.2). h5p-server measures
 * every editor upload whose *declared* mimetype is `image/*` with that
 * library, sniffing the real format from the bytes — so a file uploaded as
 * `image/png` with an ICNS body would hang this whole process, every tenant
 * included. None of the three is something a browser renders inside H5P
 * content anyway, so refusing them costs nothing.
 *
 * The signatures mirror the library's own detectors, which is what decides
 * which parser runs.
 */
const heifBrands = new Set([
  'avif',
  'mif1',
  'msf1',
  'heic',
  'heix',
  'hevc',
  'hevx'
]);

/** How many leading bytes the detectors below need. */
export const SNIFF_LENGTH = 12;

/** The blocked format a header belongs to, or `undefined` when it is fine. */
export function blockedImageFormat(header: Buffer): string | undefined {
  if (header.length >= 4 && header.toString('latin1', 0, 4) === 'icns') {
    return 'ICNS';
  }
  if (header.length >= 2 && header[0] === 0xff && header[1] === 0x0a) {
    return 'JPEG XL';
  }
  if (header.length >= 8 && header.toString('latin1', 4, 8) === 'JXL ') {
    return 'JPEG XL';
  }
  if (
    header.length >= 12 &&
    header.toString('latin1', 4, 8) === 'ftyp' &&
    heifBrands.has(header.toString('latin1', 8, 12))
  ) {
    return 'HEIF';
  }
  return undefined;
}

async function headerOf(file: UploadedFile): Promise<Buffer> {
  if (file.data && file.data.length > 0) {
    return file.data.subarray(0, SNIFF_LENGTH);
  }
  if (!file.tempFilePath) {
    return Buffer.alloc(0);
  }
  const handle = await fs.open(file.tempFilePath, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_LENGTH);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_LENGTH, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Rejects (415) any uploaded file declared as an image whose bytes are one of
 * the formats above. Only image uploads are inspected: that is the only path
 * on which h5p-server runs the vulnerable parsers.
 *
 * Takes the request's files already flattened — the same list
 * `assertUploadAllowed` is given, so the two guards on a route agree on what
 * "the uploaded files" are.
 */
export async function assertUploadedImagesSafe(
  files: UploadedFile[]
): Promise<void> {
  for (const file of files) {
    if (!file || !String(file.mimetype || '').startsWith('image/')) {
      continue;
    }
    const format = blockedImageFormat(await headerOf(file));
    if (format) {
      throw new HostError(
        `${format} images are not accepted; upload a PNG, JPEG, GIF, WebP or SVG instead.`,
        415
      );
    }
  }
}
