import fs from 'fs/promises';
import path from 'path';

/**
 * The local image-size denial-of-service fix is a `postinstall` step
 * (scripts/patch-image-size.mjs). An install that skipped lifecycle scripts
 * leaves h5p-server with parsers a crafted upload can loop forever, so the host
 * refuses to start rather than run unprotected.
 *
 * The check reads the parser source for the markers the fix leaves behind.
 * Exercising the parser on a crafted buffer instead would hang an unpatched
 * process — the very failure being guarded against.
 */
const PATCH_MARKERS: ReadonlyArray<{
  file: string;
  present: string[];
  absent: string[];
}> = [
  {
    file: 'dist/types/utils.js',
    present: ["throw new TypeError('Invalid box size')"],
    absent: ['box.size > 0 ? box.size : 8']
  },
  {
    file: 'dist/types/icns.js',
    present: [
      "throw new TypeError('Invalid ICNS entry header')",
      "throw new TypeError('Invalid ICNS entry size')"
    ],
    absent: []
  }
];

/** The image-size package directory h5p-server loads, hoisted or nested. */
export function imageSizeDirectory(): string {
  const h5pServer = path.dirname(
    require.resolve('@lumieducation/h5p-server/package.json')
  );
  return path.dirname(
    require.resolve('image-size/package.json', { paths: [h5pServer] })
  );
}

export async function assertImageSizePatched(
  directory = imageSizeDirectory()
): Promise<void> {
  for (const { file, present, absent } of PATCH_MARKERS) {
    const source = await fs.readFile(path.join(directory, file), 'utf8');
    const patched =
      present.every((marker) => source.includes(marker)) &&
      absent.every((marker) => !source.includes(marker));
    if (!patched) {
      throw new Error(
        `image-size at ${directory} is not patched (${file}). Run ` +
          '"node scripts/patch-image-size.mjs" or reinstall dependencies ' +
          'with lifecycle scripts enabled.'
      );
    }
  }
}
