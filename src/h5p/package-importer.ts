import fs from 'fs/promises';
import path from 'path';
import { ContentFileScanner } from '@lumieducation/h5p-server';
import type {
  H5PEditor,
  IContentMetadata,
  IPermissionSystem,
  IUser
} from '@lumieducation/h5p-server';
import ContentStorer from '@lumieducation/h5p-server/build/src/ContentStorer';
import PackageImporter from '@lumieducation/h5p-server/build/src/PackageImporter';

import HostError from '../errors';
import { isInsideDirectory } from '../content-id';
import { isExamContent, stageExamPackage } from './exam-package';
import {
  deferInstallationCheck,
  stageOutdatedPackage
} from './outdated-package';
import { packageImport } from './whole-package';

/**
 * h5p-server 9.3.3 silently clears references to files missing from a package
 * in copyFromDirectoryToTemporary. The save's media check cannot catch that:
 * uploadPackage has already erased the expected path by then. Validate the
 * extracted package before that step, using the same semantic file scanner.
 * PackageImporter still owns extraction, schema validation and cleanup.
 *
 * Inside the import route's `packageImport`, a package whose parameters carry
 * an encrypted exam is not copied to temporary storage at all: its `content/`
 * is checked and moved aside whole for the save (exam-package.ts). So is a
 * package on library versions that are not installed, when the caller asked
 * to keep it (outdated-package.ts) — before the media check, which needs
 * the semantics of those versions.
 */
class CompletePackageStorer extends ContentStorer {
  private readonly packageFiles: ContentFileScanner;

  private readonly editor: H5PEditor;

  constructor(editor: H5PEditor) {
    super(
      editor.contentManager,
      editor.libraryManager,
      editor.temporaryFileManager
    );
    this.packageFiles = new ContentFileScanner(editor.libraryManager);
    this.editor = editor;
  }

  public override async copyFromDirectoryToTemporary(
    metadata: IContentMetadata,
    packageDirectory: string,
    user: IUser
  ) {
    const contentDirectory = path.join(packageDirectory, 'content');
    const parameters = JSON.parse(
      await fs.readFile(path.join(contentDirectory, 'content.json'), 'utf8')
    );
    const library = metadata.preloadedDependencies.find(
      (dependency) => dependency.machineName === metadata.mainLibrary
    );
    // Upstream passes the miss on to the scanner, which fails with a
    // TypeError; the package itself is what is wrong.
    if (!library) {
      throw new HostError(
        'The uploaded package does not declare a resolvable main library.',
        400
      );
    }
    const state = packageImport.getStore();
    if (
      state?.keepOutdated &&
      (await stageOutdatedPackage(
        this.editor,
        state,
        metadata,
        parameters,
        contentDirectory
      ))
    ) {
      return { metadata, parameters };
    }
    const references = await this.packageFiles.scanForFiles(
      parameters,
      library
    );
    for (const file of references) {
      // The scanner already excludes HTTP(S) URLs. ContentStorer also keeps
      // these legacy external video references even without an archive entry.
      if (
        file.mimeType?.toLowerCase() === 'video/youtube' ||
        /^[^./]+?\.[^./]+\/.+$/.test(file.filePath)
      ) {
        continue;
      }
      const candidate = path.resolve(contentDirectory, file.filePath);
      const exists =
        isInsideDirectory(contentDirectory, file.filePath) &&
        (await fs.stat(candidate).then(
          (stat) => stat.isFile(),
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
              return false;
            throw error;
          }
        ));
      if (!exists) {
        throw new HostError(
          `The package is missing the media file ${path.posix.basename(file.filePath)}. ` +
            'Export a complete package and retry. No changes were saved.',
          422,
          { code: 'media-missing' }
        );
      }
    }
    if (state && isExamContent(parameters)) {
      // Here, not after the import returns: PackageImporter deletes the
      // extraction directory as soon as this method does.
      await stageExamPackage(contentDirectory, parameters, references, state);
      return { metadata, parameters };
    }
    return super.copyFromDirectoryToTemporary(metadata, packageDirectory, user);
  }
}

export default function createPackageImporter(
  editor: H5PEditor,
  permissionSystem: IPermissionSystem
): PackageImporter {
  const importer = new PackageImporter(
    editor.libraryManager,
    editor.config,
    permissionSystem,
    editor.contentManager,
    new CompletePackageStorer(editor)
  );
  // Patched once here; it changes nothing outside an import route's
  // `packageImport.run` that asked to keep outdated packages.
  deferInstallationCheck(importer);
  return importer;
}
