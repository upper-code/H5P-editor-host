import {
  ContentPermission,
  GeneralPermission,
  TemporaryFilePermission,
  UserDataPermission
} from '@lumieducation/h5p-server';
import type { IPermissionSystem, IUser } from '@lumieducation/h5p-server';

/**
 * The editor's authorization policy.
 *
 * The package default is `LaissezFairePermissionSystem`, which grants every
 * permission to every user — including the general permission to install and
 * update libraries. This host must NEVER install or update libraries at
 * runtime: content types and editor widgets are provisioned as a reviewed,
 * versioned set into the runtime directory, and the
 * editor runs fully offline. Granting library installation would let a crafted
 * package request (or a future Hub reconnection) mutate that set.
 *
 * `fetchingDisabled` plus an empty, pre-seeded content-type cache already make
 * installation structurally impossible; this permission system is the explicit,
 * checked-in statement of the same policy at the authorization layer — defence
 * in depth rather than an accident of configuration.
 *
 * Everything else the editor and player legitimately do — creating, editing,
 * viewing, listing, downloading and embedding content, reading/writing the
 * (unused) per-viewer user data, and staging temporary files while editing — is
 * permitted, because a single trusted tenant user performs all of it.
 */
export default class RestrictivePermissionSystem implements IPermissionSystem {
  // Every general permission is a library-installation or restricted-content
  // capability (CreateRestricted, InstallRecommended, UpdateAndInstallLibraries);
  // none of them are needed by an offline, pre-provisioned editor, so all are
  // denied. This is what closes the "install/update libraries" hole.

  public async checkForGeneralAction(
    _actingUser: IUser,
    _permission: GeneralPermission
  ): Promise<boolean> {
    return false;
  }

  public async checkForContent(
    _actingUser: IUser,
    _permission: ContentPermission,
    _contentId: string | undefined
  ): Promise<boolean> {
    return true;
  }

  public async checkForUserData(
    _actingUser: IUser,
    _permission: UserDataPermission,
    _contentId: string,
    _affectedUserId?: string
  ): Promise<boolean> {
    return true;
  }

  public async checkForTemporaryFile(
    _actingUser: IUser,
    _permission: TemporaryFilePermission,
    _filename: string | undefined
  ): Promise<boolean> {
    return true;
  }
}
