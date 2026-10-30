import fs from 'fs/promises';
import path from 'path';

import { maxBookBytes } from './env';
import HostError from './errors';

/** Reserve 4% for parameters and metadata; shared by preflight and publish. */
export function bookSizeLimits(): {
  maxBookBytes: number;
  maxMediaBytes: number;
} {
  const maximum = maxBookBytes();
  return {
    maxBookBytes: maximum,
    maxMediaBytes: maximum - Math.ceil(maximum / 25)
  };
}

function mib(bytes: number): string {
  return `${Number((bytes / 1024 / 1024).toFixed(2))} MiB (${bytes} bytes)`;
}

export function assertMediaSize(bytes: number): void {
  const limits = bookSizeLimits();
  if (bytes > limits.maxMediaBytes) {
    throw new HostError(
      `The total media size exceeds the limit of ${mib(limits.maxMediaBytes)} ` +
        `(96% of the maximum book size of ${mib(limits.maxBookBytes)}). ` +
        'Remove media or choose smaller files and retry.',
      413,
      { code: 'book-media-too-large' }
    );
  }
}

/**
 * Inspect the final staged book, including whole exam/outdated imports. This
 * runs under the mutation's exclusive lock before publication, so clients
 * cannot bypass it or race the check by skipping the upload preflight.
 * Shared libraries and compressed export bytes are not part of the book.
 */
export async function assertStoredBookSize(
  directory: string,
  totalBytes: number
): Promise<void> {
  const maximum = maxBookBytes();
  const jsonSizes = await Promise.all(
    ['content.json', 'h5p.json'].map(async (name) => {
      try {
        return (await fs.stat(path.join(directory, name))).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    })
  );
  assertMediaSize(totalBytes - jsonSizes[0] - jsonSizes[1]);
  if (totalBytes > maximum) {
    throw new HostError(
      `The book exceeds the maximum size of ${mib(maximum)}. ` +
        'Remove content or choose smaller media files and retry.',
      413,
      { code: 'book-too-large' }
    );
  }
}
