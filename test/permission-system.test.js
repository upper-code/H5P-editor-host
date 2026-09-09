const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ContentPermission,
  GeneralPermission,
  TemporaryFilePermission,
  UserDataPermission
} = require('@lumieducation/h5p-server');

const RestrictivePermissionSystem =
  require('../build/src/h5p/permission-system').default;

const user = { id: 'tenant-1', name: 'Tenant', type: 'local', email: 'a@b.c' };

test('every general action is denied, blocking library install/update', async () => {
  const ps = new RestrictivePermissionSystem();
  // The three general permissions are exactly the install/restricted-content
  // capabilities; all must be denied so a package can never mutate the
  // provisioned, offline library set.
  for (const permission of [
    GeneralPermission.CreateRestricted,
    GeneralPermission.InstallRecommended,
    GeneralPermission.UpdateAndInstallLibraries
  ]) {
    assert.equal(await ps.checkForGeneralAction(user, permission), false);
  }
});

test('content, user-data and temporary-file actions remain allowed', async () => {
  const ps = new RestrictivePermissionSystem();

  for (const permission of Object.values(ContentPermission).filter(
    (value) => typeof value === 'number'
  )) {
    assert.equal(await ps.checkForContent(user, permission, '5'), true);
  }
  assert.equal(
    await ps.checkForContent(user, ContentPermission.Create, undefined),
    true
  );

  for (const permission of Object.values(UserDataPermission).filter(
    (value) => typeof value === 'number'
  )) {
    assert.equal(await ps.checkForUserData(user, permission, '5'), true);
  }

  for (const permission of Object.values(TemporaryFilePermission).filter(
    (value) => typeof value === 'number'
  )) {
    assert.equal(
      await ps.checkForTemporaryFile(user, permission, 'file.png'),
      true
    );
  }
});
