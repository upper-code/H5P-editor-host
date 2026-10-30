const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { bookSizeLimits } = require('../build/src/book-size');
const {
  mutateContent,
  transactionalContentStorage
} = require('../build/src/content-transactions');
const { tmpDir, withEnv } = require('./helpers');

test('book limits default to 500 MiB with 480 MiB for media and round down whole bytes', (t) => {
  withEnv(t, { H5P_HOST_MAX_BOOK_BYTES: undefined });
  assert.deepEqual(bookSizeLimits(), {
    maxBookBytes: 524288000,
    maxMediaBytes: 503316480
  });
  process.env.H5P_HOST_MAX_BOOK_BYTES = '101';
  assert.equal(bookSizeLimits().maxMediaBytes, 96);
});

test('parameters and metadata count toward the absolute book limit before publication', async (t) => {
  withEnv(t, { H5P_HOST_MAX_BOOK_BYTES: '1000' });
  const root = path.join(tmpDir(t, 'book-size-'), 'content');
  await fs.mkdir(root);
  const storage = transactionalContentStorage(root);
  const save = (params) =>
    mutateContent({
      root,
      fingerprint: params,
      reason: 'editor-save',
      save: async () => ({
        contentId: await storage.addContent({ title: 'Book' }, params, {})
      })
    });
  const original = await save({ text: 'small' });
  await assert.rejects(save({ text: 'x'.repeat(1000) }), {
    statusCode: 413,
    code: 'book-too-large'
  });
  assert.deepEqual(await fs.readdir(root), [original.contentId]);
});
