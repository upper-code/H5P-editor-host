const assert = require('node:assert/strict');
const test = require('node:test');

const WebUser = require('../build/src/h5p/user').default;

test('a tenant user has no author-placeholder name by default', () => {
  // H5PIntegration.user.name defaults the metadata dialog's Author field
  // (h5peditor-metadata.js) and gets written into a saved book's h5p.json —
  // a stand-in name like "H5P Editor Host User" would look like a real
  // credit. `/editors` gives this host no real name to offer (only a
  // distributor id and quotas), so tenant-manager.ts constructs every
  // tenant's user with an empty name; this is what that construction relies
  // on the default to be.
  const user = new WebUser('dev1');
  assert.equal(user.name, '');
  assert.equal(user.id, 'dev1');
});

test('tenant-manager.ts constructs the tenant user with an explicit empty name', () => {
  const user = new WebUser('dev1', '');
  assert.equal(user.name, '');
});
