import type { IUser } from '@lumieducation/h5p-server';

/**
 * The single user identity used by one tenant of the editor.
 *
 * H5P's per-user permission checks run through IPermissionSystem, so the legacy
 * `can*` capability flags carried by older IUser shapes are not part of the 9.x
 * interface and are not modelled here. Library installation/updating is denied
 * by RestrictivePermissionSystem (see permission-system.ts), reinforced by an
 * offline content-type cache plus `fetchingDisabled: 1` in the config.
 *
 * There is one such user per distributor and each tenant has its own content
 * storage root, so tenancy — not per-content authorization — is the isolation
 * boundary; that is why the permission system allows every content action.
 */
export default class WebUser implements IUser {
  public id: string;

  public name: string;

  public type: string;

  public email: string;

  // An empty name, not a placeholder: this host has no real author name to
  // offer (`/editors` reports only a distributor id and quotas), and a
  // stand-in string would otherwise default the metadata dialog's Author
  // field and get written into every book's h5p.json as if it were real.
  constructor(id = 'web-user', name = '') {
    // Assign every field in the constructor body. With `target: es2022` and
    // `useDefineForClassFields`, field initializers run before the constructor
    // parameters are in scope, so deriving one field from another via an
    // initializer would observe `undefined`.
    this.id = id;
    this.name = name;
    this.type = 'local';
    this.email = 'user@interactive-book-editor.local';
  }
}
