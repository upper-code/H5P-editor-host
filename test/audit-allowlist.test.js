const assert = require('node:assert/strict');
const test = require('node:test');

// The audit gate is an ESM script; load its pure classifier without launching
// `npm audit` (the module runs the audit only when invoked as the main script).
let classify;
test.before(async () => {
  ({ classify } = await import('../scripts/audit-allowlist.mjs'));
});

const ALLOW = {
  'GHSA-w3rx-r6r6-pgpr': { reason: 'image-size ICNS', expires: '2999-12-31' },
  'GHSA-5p2g-fcmc-qvqq': {
    reason: 'image-size JXL/HEIF',
    expires: '2999-12-31'
  }
};

const advisory = (severity, ghsa) => ({
  severity,
  url: `https://github.com/advisories/${ghsa}`
});

// The current, real dependency shape: image-size carries the two allowlisted
// advisory objects; its two dependents reach it through a string `via`.
const cleanReport = {
  vulnerabilities: {
    '@lumieducation/h5p-express': {
      severity: 'high',
      via: ['@lumieducation/h5p-server']
    },
    '@lumieducation/h5p-server': { severity: 'high', via: ['image-size'] },
    'image-size': {
      severity: 'high',
      via: [
        advisory('high', 'GHSA-w3rx-r6r6-pgpr'),
        advisory('high', 'GHSA-5p2g-fcmc-qvqq')
      ]
    }
  },
  metadata: { vulnerabilities: { high: 3, critical: 0 } }
};

test('allowlisted advisories across a transitive chain do not fail', () => {
  const { failures, expired } = classify(cleanReport, { allow: ALLOW });
  assert.deepEqual(failures, []);
  assert.deepEqual(expired, []);
});

test('an allowlisted high plus a new low advisory still passes', () => {
  // Regression: the package severity is "high" because of the allowlisted
  // advisory, but the only *new* advisory is low — it must not fail the build.
  const report = structuredClone(cleanReport);
  report.vulnerabilities['@lumieducation/h5p-server'].via.push(
    advisory('low', 'GHSA-newl-owww-0000')
  );
  const { failures } = classify(report, { allow: ALLOW });
  assert.deepEqual(failures, []);
});

test('a new non-allowlisted high advisory fails', () => {
  const report = structuredClone(cleanReport);
  report.vulnerabilities['@lumieducation/h5p-server'].via.push(
    advisory('high', 'GHSA-newh-ighh-9999')
  );
  const { failures } = classify(report, { allow: ALLOW });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, '@lumieducation/h5p-server');
  assert.equal(failures[0].severity, 'high');
  assert.equal(failures[0].id, 'GHSA-newh-ighh-9999');
});

test('a new non-allowlisted critical advisory fails', () => {
  const report = structuredClone(cleanReport);
  report.vulnerabilities['image-size'].via.push(
    advisory('critical', 'GHSA-crit-icaa-1111')
  );
  const { failures } = classify(report, { allow: ALLOW });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].severity, 'critical');
});

test('an expired allowlist entry is reported', () => {
  const stale = {
    'GHSA-w3rx-r6r6-pgpr': { reason: 'x', expires: '2020-01-01' },
    'GHSA-5p2g-fcmc-qvqq': { reason: 'y', expires: '2999-12-31' }
  };
  const { expired } = classify(cleanReport, {
    allow: stale,
    today: '2026-09-09'
  });
  assert.deepEqual(
    expired.map(([id]) => id),
    ['GHSA-w3rx-r6r6-pgpr']
  );
});

test('an allowlisted advisory that no longer appears is surfaced as gone', () => {
  const onlyOne = {
    vulnerabilities: {
      'image-size': {
        severity: 'high',
        via: [advisory('high', 'GHSA-w3rx-r6r6-pgpr')]
      }
    },
    metadata: { vulnerabilities: { high: 1, critical: 0 } }
  };
  const { gone } = classify(onlyOne, { allow: ALLOW });
  assert.deepEqual(gone, ['GHSA-5p2g-fcmc-qvqq']);
});

test('an empty (clean) report yields no failures', () => {
  const { failures, high, critical } = classify(
    {
      vulnerabilities: {},
      metadata: { vulnerabilities: { high: 0, critical: 0 } }
    },
    { allow: ALLOW }
  );
  assert.deepEqual(failures, []);
  assert.equal(high, 0);
  assert.equal(critical, 0);
});
