#!/usr/bin/env node
/*
 * Runs `npm audit` and fails on any high/critical advisory *except* a short,
 * dated allowlist. This replaces a blanket `--audit-level=critical`, which
 * would silently pass every future high-severity advisory as well as the ones
 * we have already reviewed.
 *
 * The only allowed entries are the image-size denial-of-service advisories:
 * npm audit reports the published version as vulnerable and cannot see the
 * local parser fix (scripts/patch-image-size.mjs applies it in postinstall;
 * the test suite exercises the patched parser). npm reports the two h5p-server
 * dependents as vulnerable *through* image-size (their `via` names it), so they
 * carry no advisory of their own — only image-size's two advisories are weighed
 * here, and only they need allowlisting.
 *
 * Each entry carries an expiry: past it the check fails until someone
 * re-confirms the advisory is still unfixed (then bumps the date) or a fixed
 * image-size ships (then removes the allowlist, the patch script, its
 * postinstall hook and the startup check, and raises audit back to `high`).
 *
 *   node scripts/audit-allowlist.mjs
 */
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Allowlisted advisories, keyed by GHSA id. `expires` is the date by which the
 * entry must be re-reviewed (UTC, inclusive).
 */
export const ALLOW = {
  'GHSA-w3rx-r6r6-pgpr': {
    reason: 'image-size ICNS parser infinite loop; patched locally',
    expires: '2026-12-31'
  },
  'GHSA-5p2g-fcmc-qvqq': {
    reason: 'image-size JXL/HEIF parser infinite loops; patched locally',
    expires: '2026-12-31'
  }
};

/** Severities that fail the build when not allowlisted. */
export const SEVERE = new Set(['high', 'critical']);

/** The GHSA ids named by a vulnerability's advisory-object `via` entries. */
export function advisoryIds(via) {
  return (Array.isArray(via) ? via : [])
    .filter((entry) => entry && typeof entry === 'object' && entry.url)
    .map((entry) => (String(entry.url).match(/GHSA-[0-9a-z-]+/i) || [])[0])
    .filter(Boolean);
}

/** A usable audit report carries the vulnerability map and the metadata block. */
function isReport(report) {
  return (
    !!report &&
    typeof report.vulnerabilities === 'object' &&
    report.vulnerabilities !== null &&
    typeof report.metadata === 'object' &&
    report.metadata !== null
  );
}

function runAudit() {
  return new Promise((resolve, reject) => {
    // npm audit exits non-zero when it finds anything, but still writes the
    // JSON report to stdout; that report is what we judge, not the exit code.
    // The exit code therefore cannot tell a clean run from a broken one — a
    // registry or transport failure also exits non-zero, so the report itself
    // must be inspected (see below).
    execFile(
      'npm',
      ['audit', '--omit=dev', '--json'],
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        let report;
        if (stdout && stdout.trim()) {
          try {
            report = JSON.parse(stdout);
          } catch (parseError) {
            reject(
              new Error(
                `could not parse npm audit output (${parseError.message})`
              )
            );
            return;
          }
        }
        if (!report) {
          reject(error || new Error('npm audit produced no output'));
          return;
        }
        // A registry/transport failure is reported as valid JSON of the shape
        // `{ message, error: { summary, detail } }` with no vulnerability map.
        // Without this guard that parses cleanly and, having no
        // `vulnerabilities`, reads as a spotless tree — a false green. Treat any
        // such report as a failed audit, never as a clean one.
        if (report.error) {
          const detail =
            report.error.summary ||
            report.error.detail ||
            report.error.code ||
            report.message ||
            'unknown error';
          reject(new Error(`npm audit did not complete: ${detail}`));
          return;
        }
        if (!isReport(report)) {
          reject(
            new Error(
              'npm audit output is missing the expected report structure (vulnerabilities/metadata)'
            )
          );
          return;
        }
        resolve(report);
      }
    );
  });
}

/**
 * Judge an audit report against the allowlist. Pure: no I/O, no process exit —
 * so it can be exercised with synthetic reports.
 *
 * Severity is weighed **per advisory**, not per package. A package's overall
 * severity is the maximum across everything it carries, so an allowlisted high
 * advisory alone makes the package "high"; gating on the package severity would
 * then fail the build for any *additional* advisory of any level. We instead
 * look at each advisory object's own `severity`: a new low advisory on a
 * package that is otherwise only allowlisted-high does not fail the build.
 *
 * A `via` entry that is a string names another vulnerable package (a transitive
 * chain); that package appears on its own row, where its advisory objects are
 * judged, so string entries carry nothing to weigh here.
 */
export function classify(
  report,
  { allow = ALLOW, today = new Date().toISOString().slice(0, 10) } = {}
) {
  const vulns = (report && report.vulnerabilities) || {};
  const allowedIds = new Set(Object.keys(allow));

  const expired = Object.entries(allow).filter(
    ([, entry]) => today > entry.expires
  );

  const failures = [];
  for (const [name, vuln] of Object.entries(vulns)) {
    const via = Array.isArray(vuln.via) ? vuln.via : [];
    for (const entry of via) {
      if (!entry || typeof entry !== 'object') continue;
      if (!SEVERE.has(entry.severity)) continue;
      const id = (String(entry.url).match(/GHSA-[0-9a-z-]+/i) || [])[0];
      if (id && allowedIds.has(id)) continue;
      failures.push({
        name,
        severity: entry.severity,
        id: id || '(unknown advisory)'
      });
    }
  }

  // Surface an allowlisted advisory that no longer appears: it may be fixed, and
  // the local patch plus the allowlist can then be retired.
  const seen = new Set(
    Object.values(vulns).flatMap((vuln) => advisoryIds(vuln.via))
  );
  const gone = Object.keys(allow).filter((id) => !seen.has(id));

  const meta =
    (report && report.metadata && report.metadata.vulnerabilities) || {};
  return {
    expired,
    failures,
    gone,
    high: meta.high || 0,
    critical: meta.critical || 0
  };
}

async function main() {
  let report;
  try {
    report = await runAudit();
  } catch (error) {
    console.error(`audit-allowlist: ${error.message}`);
    process.exit(1);
  }

  const { expired, failures, gone, high, critical } = classify(report);

  // Expiry first, so a stale allowlist fails even when the registry has nothing
  // new to report.
  if (expired.length > 0) {
    console.error('Audit allowlist entries are past their review date:');
    for (const [id, entry] of expired) {
      console.error(`  ${id} (expired ${entry.expires}) — ${entry.reason}`);
    }
    console.error(
      'Re-confirm the advisory is still unfixed and bump the date, or retire the entry.'
    );
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error('npm audit: high/critical advisories outside the allowlist:');
    for (const { name, severity, id } of failures) {
      console.error(`  ${name} (${severity}) — ${id}`);
    }
    console.error(
      'Fix the dependency, or (only after review) add its advisory to the allowlist in scripts/audit-allowlist.mjs.'
    );
    process.exit(1);
  }

  if (gone.length > 0) {
    console.warn(
      `npm audit: allowlisted advisor${gone.length === 1 ? 'y is' : 'ies are'} no longer reported (${gone.join(
        ', '
      )}); check whether the local fix can be retired.`
    );
  }

  console.log(
    `npm audit: ${high} high, ${critical} critical; all within the allowlist (${Object.keys(
      ALLOW
    ).join(', ')}).`
  );
}

// Run only when invoked directly; importing the module (e.g. from a test) must
// not launch `npm audit`.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
