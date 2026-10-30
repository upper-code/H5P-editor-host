const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_H5P_HOST_ROUTE_PREFIX,
  h5pHostRoutePrefix,
  hostRoute
} = require('../build/src/route-prefix');
const { withEnv } = require('./helpers');

test('the host defaults to the public core namespace', () => {
  assert.equal(DEFAULT_H5P_HOST_ROUTE_PREFIX, '/h5p-editor-core');
  assert.equal(h5pHostRoutePrefix(), DEFAULT_H5P_HOST_ROUTE_PREFIX);
  assert.equal(
    hostRoute('/h5p/core/js/h5p.js'),
    '/h5p-editor-core/h5p/core/js/h5p.js'
  );
});

test('the host prefix is configurable but cannot consume the site root', (t) => {
  withEnv(t, { H5P_HOST_ROUTE_PREFIX: '/custom-core/' });
  assert.equal(h5pHostRoutePrefix(), '/custom-core');
  process.env.H5P_HOST_ROUTE_PREFIX = '/';
  assert.throws(() => h5pHostRoutePrefix());
});
