#!/usr/bin/env node
/*
 * Applies the local image-size denial-of-service fix to the copy
 * @lumieducation/h5p-server resolves — its ICNS and JXL/HEIF parsers can be
 * driven into an infinite loop by a crafted upload and have no fixed release.
 * Runs from `postinstall`.
 *
 * Every edit is an exact text replacement written for one released version.
 * The script is idempotent and fails loudly when the installed version or the
 * text to edit differs, so a partially fixed install cannot pass unnoticed.
 * The host additionally refuses to start on an unpatched copy
 * (src/image-size-patch.ts) — an install with `--ignore-scripts` never runs
 * this file at all.
 *
 *   node scripts/patch-image-size.mjs           apply (or confirm) the fix
 *   node scripts/patch-image-size.mjs --check   report without writing
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** The image-size release these edits were written against. */
export const PATCHED_VERSION = '1.2.1';

/**
 * The fix, as exact `from` → `to` replacements per file. Both parsers loop
 * over length-prefixed records; each edit rejects a record shorter than its
 * own header, so the loop offset always advances.
 */
export const EDITS = [
  {
    file: 'dist/types/utils.js',
    replacements: [
      {
        // An ISO BMFF box header is eight bytes: refuse a box that cannot
        // hold one, so findBox() (shared by the JXL and HEIF parsers) always
        // advances by at least the header length.
        from: [
          'function readBox(input, offset) {',
          '    if (input.length - offset < 4)',
          '        return;',
          '    const boxSize = (0, exports.readUInt32BE)(input, offset);',
          ''
        ].join('\n'),
        to: [
          'function readBox(input, offset) {',
          '    if (input.length - offset < 8)',
          '        return;',
          '    const boxSize = (0, exports.readUInt32BE)(input, offset);',
          '    if (boxSize < 8) {',
          "        throw new TypeError('Invalid box size');",
          '    }',
          ''
        ].join('\n')
      },
      {
        // The upstream workaround only handled a size of exactly zero.
        from: [
          '        // Fix the infinite loop by ensuring offset always increases',
          '        // If box.size is 0, advance by at least 8 bytes (the size of the box header)',
          '        offset += box.size > 0 ? box.size : 8;'
        ].join('\n'),
        to: '        offset += box.size;'
      }
    ]
  },
  {
    file: 'dist/types/icns.js',
    replacements: [
      {
        // An ICNS entry header is eight bytes (type + length). Never read a
        // truncated header, and refuse an entry that cannot hold its own.
        from: [
          'function readImageHeader(input, imageOffset) {',
          '    const imageLengthOffset = imageOffset + ENTRY_LENGTH_OFFSET;',
          '    return [',
          '        (0, utils_1.toUTF8String)(input, imageOffset, imageLengthOffset),',
          '        (0, utils_1.readUInt32BE)(input, imageLengthOffset),',
          '    ];',
          '}'
        ].join('\n'),
        to: [
          'function readImageHeader(input, imageOffset) {',
          '    if (input.length - imageOffset < 8) {',
          "        throw new TypeError('Invalid ICNS entry header');",
          '    }',
          '    const imageLengthOffset = imageOffset + ENTRY_LENGTH_OFFSET;',
          '    const imageLength = (0, utils_1.readUInt32BE)(input, imageLengthOffset);',
          '    if (imageLength < 8) {',
          "        throw new TypeError('Invalid ICNS entry size');",
          '    }',
          '    return [',
          '        (0, utils_1.toUTF8String)(input, imageOffset, imageLengthOffset),',
          '        imageLength,',
          '    ];',
          '}'
        ].join('\n')
      }
    ]
  }
];

/** The image-size package directory h5p-server loads, hoisted or nested. */
export function resolveImageSizeDirectory() {
  const requireHere = createRequire(import.meta.url);
  const h5pServer = requireHere.resolve(
    '@lumieducation/h5p-server/package.json'
  );
  const requireFromH5p = createRequire(h5pServer);
  return path.dirname(requireFromH5p.resolve('image-size/package.json'));
}

/**
 * Applies every edit to the package at `directory`. Resolves with the files
 * written; a file already carrying every edit is left untouched. Rejects
 * without writing anything when the version or the text differs, and with
 * `{ check: true }` reports the files that would change instead of writing.
 */
export async function applyImageSizePatch(directory, { check = false } = {}) {
  const { version } = JSON.parse(
    await fs.readFile(path.join(directory, 'package.json'), 'utf8')
  );
  if (version !== PATCHED_VERSION) {
    throw new Error(
      `image-size ${version} is installed at ${directory}, but the local ` +
        `fix is written for ${PATCHED_VERSION}. Update the override in ` +
        'package.json and scripts/patch-image-size.mjs together.'
    );
  }
  const pending = [];
  for (const { file, replacements } of EDITS) {
    const filePath = path.join(directory, file);
    const original = await fs.readFile(filePath, 'utf8');
    let text = original;
    for (const { from, to } of replacements) {
      if (text.includes(to)) {
        continue;
      }
      if (!text.includes(from)) {
        throw new Error(
          `${filePath} does not contain the text the local image-size fix ` +
            `edits; the installed copy differs from a clean ${PATCHED_VERSION}.`
        );
      }
      text = text.replace(from, () => to);
    }
    if (text !== original) {
      pending.push({ filePath, file, text });
    }
  }
  if (!check) {
    for (const { filePath, text } of pending) {
      await fs.writeFile(filePath, text);
    }
  }
  return pending.map(({ file }) => file);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const check = process.argv.includes('--check');
  applyImageSizePatch(resolveImageSizeDirectory(), { check })
    .then((files) => {
      if (files.length === 0) {
        console.log(`image-size ${PATCHED_VERSION}: local fix already applied`);
      } else if (check) {
        console.error(
          `image-size ${PATCHED_VERSION}: local fix missing from ${files.join(', ')}`
        );
        process.exitCode = 1;
      } else {
        console.log(
          `image-size ${PATCHED_VERSION}: local fix applied to ${files.join(', ')}`
        );
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
