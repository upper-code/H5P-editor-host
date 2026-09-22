#!/usr/bin/env node
/*
 * Scans the provisioned H5P runtime libraries and emits a third-party license
 * inventory (THIRD-PARTY-LIBRARIES.md). Run with `npm run licenses`.
 *
 * The libraries themselves are untracked runtime data (see
 * scripts/provision-libraries.mjs); this inventory is a reviewable record of
 * what a given deployment ships. Each H5P library ships a `library.json` whose
 * optional `license` field names its license (e.g. "MIT", "MPL-2.0", "GPL-3").
 * Many Hub libraries omit it or bundle sub-components under other licenses, so
 * no library here is assumed to be cleanly redistributable — each package's
 * distribution terms have to be established before it is shipped.
 *
 * The top-level `license` field is NOT trusted on its own: a library may declare
 * "MIT" while bundling copyleft sub-components (vendored fonts, minified vendor
 * JS, npm dependencies pinned in a lockfile). Every library tree is therefore
 * scanned for bundled GPL/AGPL/LGPL evidence and any such finding is surfaced
 * alongside the declared license — see `scanBundledCopyleft`. This scan is
 * evidence-gathering, not a license determination (a pinned lockfile entry
 * does not prove the dependency's code ships in the runtime artifact), and it
 * is not exhaustive — it covers shipped code/markup (js/css/svg/html/ts/tsx/jsx)
 * and license/readme/manifest files, not every format a library could carry.
 *
 * A library whose `library.json` declares nothing is looked up in the curated
 * evidence file (scripts/library-license-evidence.json, override with
 * LICENSE_EVIDENCE_FILE): an upstream license text read and recorded by hand,
 * with its URL, copyright holder and the date it was checked. Such a library is
 * reported as "<license> (upstream evidence)" rather than "(none)", so the
 * inventory carries the paper trail a reviewer needs instead of a blank. The
 * evidence never overrides a declared license and never silences the
 * bundled-copyleft scan. For a library that does declare its license, an entry
 * only adds where the Source Code Form lives — the pointer MPL and GPL require
 * a recipient to be given.
 *
 * MPL ("MPL"/"MPL2" in the H5P enum) is file-level copyleft: the covered files
 * may ship inside a larger work under any terms (MPL-2.0 §3.3), but they keep
 * their notices (§3.4) and the recipient must be told where their Source Code
 * Form is (§3.2). Such libraries are marked "file-level copyleft" and listed in
 * their own section with that pointer, so the obligation is visible without
 * reading the license.
 *
 * The evidence file is tracked and deployment-independent (it is keyed by
 * machineName and records facts about upstream projects); the library set is
 * untracked and specific to one deployment. The two are maintained apart, so
 * the run says out loud on stderr where they fail to meet:
 *   - a coverage gap: a provisioned library whose terms nothing authoritative
 *     states — no `license` in its library.json and no evidence entry, leaving
 *     only whatever a root README happened to say, or nothing at all;
 *   - stale evidence: an entry this run used whose `checked` date is older
 *     than LICENSE_EVIDENCE_MAX_AGE_DAYS (default 365; 0 turns the check off).
 * Both are warnings and the inventory is written either way — evidence does
 * not expire and an unknown library is a prompt to go read its license, not a
 * defect in this script. `--strict` (or LICENSE_INVENTORY_STRICT=1) turns a
 * coverage gap into a non-zero exit, for a build that must not assemble a set
 * containing a library on unrecorded terms.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataRoot = path.resolve(
  process.env.H5P_HOST_DATA_DIR || path.join(repoRoot, '.host-data')
);
const librariesDir = path.resolve(
  process.env.H5P_LIBRARIES_DIR || path.join(dataRoot, 'libraries')
);
const outputFile = path.resolve(
  process.env.LICENSE_INVENTORY_OUT ||
    path.join(repoRoot, 'THIRD-PARTY-LIBRARIES.md')
);
const evidenceFile = path.resolve(
  process.env.LICENSE_EVIDENCE_FILE ||
    path.join(repoRoot, 'scripts', 'library-license-evidence.json')
);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How old a recorded upstream check may get before the run mentions it. An
 * unparseable value is an error rather than a silent fallback: a threshold
 * that quietly reverts to the default would hide exactly what it was set to
 * surface. 0 disables the check.
 */
function readMaxAgeDays(raw) {
  if (raw === undefined || raw.trim() === '') {
    return 365;
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(
      'LICENSE_EVIDENCE_MAX_AGE_DAYS: expected a non-negative whole number ' +
        `of days, got "${raw}"`
    );
  }
  return days;
}

const evidenceMaxAgeDays = readMaxAgeDays(
  process.env.LICENSE_EVIDENCE_MAX_AGE_DAYS
);

const strict =
  process.argv.includes('--strict') ||
  /^(?:1|true)$/i.test(process.env.LICENSE_INVENTORY_STRICT || '');

// Directories that never carry the library's own license (dependency trees /
// VCS metadata); their manifests are inspected structurally instead of scanned.
const SKIP_DIRS = new Set(['.git', 'node_modules']);

// Copyleft as it reads in a license header / notice comment or a plain-text
// LICENSE file. Two accepted forms: the spelled-out name, or the acronym bound
// to a version. A bare version-less "GPL" is deliberately NOT enough — it is
// too weak to assert copyleft and matches noise like "gplus" (Google Plus) or a
// stray token in minified vendor code. Real bundled-GPL notices in this tree
// always carry the spelled-out name or a versioned id.
const COPYLEFT_TEXT =
  /GNU (?:Affero |Lesser )?General Public License|\b(?:AGPL|LGPL|GPL)[-\s]?v?[0-9]/i;

// The H5P `license` enum spells the Mozilla Public License "MPL" (1.1) and
// "MPL2"; SPDX ids are accepted too in case a library.json carries one.
const FILE_LEVEL_COPYLEFT = /^MPL(?:2|-?1\.1|-?2\.0)?$/i;

// Copyleft as it reads in an SPDX `license` field of a package manifest.
const COPYLEFT_SPDX =
  /\b(?:AGPL|LGPL|GPL)-[0-9][0-9.]*(?:-only|-or-later)?\b|GNU General Public/i;

/**
 * Extracts a readable copyleft label from the first match, or null.
 */
function copyleftLabel(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[0].replace(/\s+/g, ' ').trim() : null;
}

// A file is worth reading as a license-header carrier if it is shipped code or a
// license/notice text. JSON is deliberately excluded from text scanning: H5P
// `semantics.json` and `language/*.json` list "General Public License" and the
// like as *content* license dropdown labels an author can pick — those describe
// the author's content, not the library, and would be false positives.
function isTextEvidenceFile(name) {
  return (
    /\.(?:js|css|svg|html?|ts|tsx|jsx)$/i.test(name) ||
    /^(?:license|copying|notice|readme)/i.test(name)
  );
}

function isManifestFile(name) {
  return name === 'package.json' || name === 'package-lock.json';
}

/**
 * Walks a package manifest and collects copyleft SPDX ids declared for the
 * package itself or any pinned dependency. Returns [] on parse failure (a
 * lockfile we cannot read is reported separately by the caller if needed).
 */
function copyleftFromManifest(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const found = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    const raw = node.license ?? node.licenses;
    const asText = Array.isArray(raw)
      ? raw.map((l) => (typeof l === 'string' ? l : l?.type || '')).join(' ')
      : typeof raw === 'object' && raw
        ? raw.type || ''
        : typeof raw === 'string'
          ? raw
          : '';
    const label = asText && copyleftLabel(asText, COPYLEFT_SPDX);
    if (label) {
      found.add(label);
    }
    for (const key of ['packages', 'dependencies', 'devDependencies']) {
      const child = node[key];
      if (child && typeof child === 'object') {
        Object.values(child).forEach(visit);
      }
    }
  };
  visit(json);
  return [...found];
}

/**
 * Recursively yields file paths under `dir`, skipping dependency/VCS trees.
 */
function* walkFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walkFiles(full);
      }
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Scans a library tree for bundled copyleft evidence the top-level
 * `library.json` does not (or cannot) declare: vendored fonts/JS carrying a GPL
 * header, or npm dependencies pinned to a GPL license in a lockfile.
 *
 * Returns findings as `{ license, file }` (file relative to the library root),
 * deduped and sorted, most likely one per evidence file.
 */
function scanBundledCopyleft(libDir) {
  const findings = [];
  const seen = new Set();
  const add = (license, file) => {
    const key = `${license}::${file}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ license, file });
    }
  };

  for (const file of walkFiles(libDir)) {
    const name = path.basename(file);
    const rel = path.relative(libDir, file);
    if (isManifestFile(name)) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const license of copyleftFromManifest(text)) {
        add(license, rel);
      }
      continue;
    }
    if (!isTextEvidenceFile(name)) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const label = copyleftLabel(text, COPYLEFT_TEXT);
    if (label) {
      add(label, rel);
    }
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Best-effort license evidence from a library's root text files, used only when
 * `library.json` declares nothing. Bundled-copyleft evidence is handled
 * separately by `scanBundledCopyleft` and reported for every library.
 */
function findRootEvidence(directory) {
  const candidateNames = fs
    .readdirSync(directory)
    .filter((name) => /^(?:readme|license|copying)/i.test(name));
  for (const name of candidateNames) {
    const candidate = path.join(directory, name);
    if (!fs.statSync(candidate).isFile()) {
      continue;
    }
    const text = fs.readFileSync(candidate, 'utf8');
    if (COPYLEFT_TEXT.test(text)) {
      return { license: 'GPL (evidence)', source: name };
    }
    if (
      /MIT License/i.test(text) ||
      /licensed under (?:the )?MIT(?: license)?/i.test(text)
    ) {
      return { license: 'MIT (metadata missing)', source: name };
    }
  }
  return { license: '(none)', source: 'not found' };
}

/**
 * The curated evidence, keyed by machineName. A missing file is an empty map
 * (a fresh checkout of the script still runs); a malformed one is an error,
 * because silently ignoring it would turn recorded evidence back into "(none)".
 */
function readEvidence() {
  let text;
  try {
    text = fs.readFileSync(evidenceFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
  const parsed = JSON.parse(text);
  const libraries = parsed.libraries;
  if (!libraries || typeof libraries !== 'object' || Array.isArray(libraries)) {
    throw new Error(`${evidenceFile}: expected a "libraries" object`);
  }
  const map = new Map();
  for (const [machineName, entry] of Object.entries(libraries)) {
    for (const field of [
      'license',
      'holder',
      'upstream',
      'evidence',
      'checked'
    ]) {
      if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') {
        throw new Error(
          `${evidenceFile}: ${machineName} lacks a non-empty "${field}"`
        );
      }
    }
    map.set(machineName, entry);
  }
  return map;
}

function readLibraries(evidence) {
  const entries = fs
    .readdirSync(librariesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return entries.map((dir) => {
    const libPath = path.join(librariesDir, dir);
    let title = dir;
    let machineName;
    let license = '(none)';
    let source = 'library.json';
    let curated;
    // True once the library's terms come from something that states them:
    // its own `library.json`, or a curated evidence entry. A root-file guess
    // or an unreadable manifest leaves it false — that is a coverage gap.
    let resolved = false;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(libPath, 'library.json'), 'utf8')
      );
      title = meta.title || dir;
      machineName = meta.machineName;
      curated = evidence.get(meta.machineName);
      if (typeof meta.license === 'string' && meta.license.trim() !== '') {
        license = meta.license.trim();
        resolved = true;
        if (curated) {
          source =
            `library.json · upstream ${curated.license}: ` +
            `${curated.evidence} (checked ${curated.checked})`;
        }
      } else if (curated) {
        license = `${curated.license} (upstream evidence)`;
        resolved = true;
        source =
          `${curated.evidence} — © ${curated.holder}, ` +
          `checked ${curated.checked}`;
      } else {
        ({ license, source } = findRootEvidence(libPath));
      }
    } catch {
      source = 'invalid or absent library.json';
    }

    const bundled = scanBundledCopyleft(libPath);
    const fileLevelCopyleft = FILE_LEVEL_COPYLEFT.test(license);
    return {
      dir,
      title,
      machineName,
      license,
      source,
      bundled,
      fileLevelCopyleft,
      curated,
      resolved
    };
  });
}

// The bucket a library counts under in the summary: bundled copyleft dominates
// a permissive declaration, because that is the redistribution-relevant fact.
function summaryBucket(library) {
  if (library.bundled.length > 0) {
    return 'bundled copyleft (see notes)';
  }
  if (library.fileLevelCopyleft) {
    return `${library.license} (file-level copyleft)`;
  }
  return library.license;
}

/**
 * One pass over the inventory for everything derived from it: how many
 * libraries fall into each summary bucket, and which ones carry bundled
 * copyleft. The report and the closing log line both read this, so what is
 * written to the file and what is printed to the operator cannot disagree.
 */
function summarize(libraries) {
  const counts = new Map();
  const contaminated = [];
  const fileLevel = [];
  for (const library of libraries) {
    const bucket = summaryBucket(library);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
    if (library.bundled.length > 0) {
      contaminated.push(library);
    }
    if (library.fileLevelCopyleft) {
      fileLevel.push(library);
    }
  }
  return { counts, contaminated, fileLevel };
}

/**
 * Provisioned libraries whose distribution terms nothing authoritative states.
 * This is the seam between a tracked evidence file and an untracked library
 * set: the file can only ever be complete for the sets it has been filled
 * against, so a set that brings an unrecorded library has to announce itself
 * rather than settle quietly into the `(none)` row of a long table.
 */
function findCoverageGaps(libraries) {
  return libraries.filter((library) => !library.resolved);
}

/**
 * Evidence entries this run actually used whose recorded check is older than
 * `maxAgeDays`. Deduped by machineName: one entry covers every provisioned
 * version of a library, and it is the entry that ages, not the copies. Only
 * entries in use are reported — an entry for a library this deployment does
 * not ship is not wrong, just unused.
 */
function findStaleEvidence(libraries, maxAgeDays, now) {
  if (maxAgeDays === 0) {
    return [];
  }
  const byName = new Map();
  for (const library of libraries) {
    if (!library.curated || !library.machineName) {
      continue;
    }
    const checked = Date.parse(`${library.curated.checked}T00:00:00Z`);
    if (Number.isNaN(checked)) {
      continue;
    }
    const ageDays = Math.floor((now - checked) / DAY_MS);
    if (ageDays <= maxAgeDays) {
      continue;
    }
    const seen = byName.get(library.machineName);
    if (seen) {
      seen.dirs.push(library.dir);
    } else {
      byName.set(library.machineName, {
        machineName: library.machineName,
        checked: library.curated.checked,
        ageDays,
        dirs: [library.dir]
      });
    }
  }
  return [...byName.values()].sort(
    (a, b) =>
      b.ageDays - a.ageDays || a.machineName.localeCompare(b.machineName)
  );
}

function buildReport(libraries, { counts, contaminated, fileLevel }) {
  const summary = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([license, count]) => `| ${license} | ${count} |`)
    .join('\n');

  const bundledSection = contaminated.length
    ? contaminated
        .map((library) => {
          const evidence = library.bundled
            .map((f) => `\`${f.file}\` → ${f.license}`)
            .join('; ');
          return `| \`${library.dir}\` | ${library.license} | ${evidence} |`;
        })
        .join('\n')
    : '| _none detected_ | | |';

  const fileLevelSection = fileLevel.length
    ? fileLevel
        .map((library) => {
          const { curated } = library;
          const sourceForm = curated
            ? `${curated.upstream} (${curated.license}, © ${curated.holder})`
            : '**not recorded** — add the upstream repository to the evidence file';
          const note = curated?.note ?? '';
          return `| \`${library.dir}\` | ${library.license} | ${sourceForm} | ${note} |`;
        })
        .join('\n')
    : '| _none_ | | | |';

  const rows = libraries
    .map((library) => {
      const declared = library.license;
      const display = library.bundled.length
        ? `${declared} · bundled copyleft`
        : library.fileLevelCopyleft
          ? `${declared} · file-level copyleft`
          : declared;
      const source = library.bundled.length
        ? library.bundled.map((f) => f.file).join(', ')
        : library.source;
      return `| \`${library.dir}\` | ${library.title} | ${display} | ${source} |`;
    })
    .join('\n');

  return `# Third-party license inventory — H5P runtime libraries

Generated by \`npm run licenses\` from the provisioned runtime directory
(\`${path.relative(repoRoot, librariesDir) || librariesDir}\`). These libraries
are untracked runtime data owned by the H5P Group / Joubel and their respective
authors, redistributed under their individual licenses. This project holds no
rights over them and no library here is assumed to be cleanly redistributable.

The declared \`library.json\` license is not trusted on its own: each tree is
also scanned for bundled GPL/AGPL/LGPL sub-components (vendored fonts, minified
vendor JS, pinned npm dependencies). Content-license dropdown labels in
\`semantics.json\` / \`language/*.json\` are deliberately ignored — they describe
an author's content, not the library.

Total libraries: **${libraries.length}**

## Summary

| License | Count |
|---|---|
${summary}

## Review notes

- **\`bundled copyleft\`**: the declared license is permissive but the tree
  contains copyleft evidence (see the section below for the exact file) — a
  license header in shipped code, or a copyleft SPDX id pinned in a package
  manifest. This is evidence, not a determination: a \`package-lock.json\`
  entry proves the dependency is *pinned*, not that its code ships in the
  runtime artifact, and a header in one file says nothing about the rest of
  the tree. Treat this as "requires composition and distribution-terms
  review before redistribution," not as a verdict that the whole library is
  copyleft-encumbered.
- **\`<license> (upstream evidence)\`**: \`library.json\` declares no license;
  the license was read from the upstream repository and recorded in
  \`scripts/library-license-evidence.json\` (the Source column links the text
  that was read, names the copyright holder and dates the check). Redistribute
  under that license and preserve the holder's notice.
- **\`MPL\` / \`MPL2\` (file-level copyleft)**: the Mozilla Public License covers
  the files it is attached to, not the deployment around them — they may be
  combined with code under any other terms (MPL-2.0 §3.3, "Larger Work"). What
  conveying them requires: keep their license notices (§3.4) and tell the
  recipient where the Source Code Form is (§3.2); for unmodified files that is
  the upstream repository named in the section below. Any modification to one
  of those files stays under the MPL.
- **\`MIT (metadata missing)\`**: a README/LICENSE contains an MIT statement but
  \`library.json\` does not declare a license. Review the exact grant before
  redistribution.
- **\`GPL (evidence)\`** / any GPL declaration: this library (or a bundled
  sub-component) is copyleft. Preserve its notices and keep its corresponding
  source obtainable wherever this deployment is distributed.
- **\`(none)\`**: neither a \`license\` field nor MIT/GPL evidence was found.
  No distribution right should be inferred; requires source-level review.

## Bundled copyleft components

Libraries whose tree carries GPL/AGPL/LGPL evidence beyond (or contradicting)
the declared license.

| Directory | Declared | Bundled copyleft evidence |
|---|---|---|
${bundledSection}

## File-level copyleft (MPL) components

Libraries whose declared license is the Mozilla Public License. They ship
unmodified; the Source Code Form column is what a recipient must be pointed to.

| Directory | Declared | Source Code Form | Note |
|---|---|---|---|
${fileLevelSection}

## Libraries

| Directory | Title | License/evidence | Source |
|---|---|---|---|
${rows}
`;
}

const libraries = readLibraries(readEvidence());
const summary = summarize(libraries);
fs.writeFileSync(outputFile, buildReport(libraries, summary), 'utf8');

console.log(
  `Wrote ${outputFile} (${libraries.length} libraries, ` +
    `${summary.contaminated.length} with bundled copyleft, ` +
    `${summary.fileLevel.length} file-level copyleft):`,
  Object.fromEntries(summary.counts)
);

// The warnings go to stderr so that piping the summary somewhere never
// swallows them, and the report stays on disk either way: an inventory you
// can read is what tells you which library the gap is about.
const evidencePath = path.relative(repoRoot, evidenceFile) || evidenceFile;
const gaps = findCoverageGaps(libraries);
const stale = findStaleEvidence(libraries, evidenceMaxAgeDays, Date.now());

if (gaps.length > 0) {
  console.warn(
    `\nUnrecorded terms — ${gaps.length} provisioned ` +
      `${gaps.length === 1 ? 'library' : 'libraries'} with no license in ` +
      `library.json and no entry in ${evidencePath}:`
  );
  for (const library of gaps) {
    console.warn(`  ${library.dir} — ${library.license} (${library.source})`);
  }
  console.warn(
    'Read each one\u2019s upstream license text and record it there, or drop ' +
      'the library from the set. Until then no distribution right is ' +
      'established for it.'
  );
}

if (stale.length > 0) {
  console.warn(
    `\n${stale.length} evidence ${stale.length === 1 ? 'entry' : 'entries'} ` +
      `used here ${stale.length === 1 ? 'was' : 'were'} last checked over ` +
      `${evidenceMaxAgeDays} days ago:`
  );
  for (const entry of stale) {
    console.warn(
      `  ${entry.machineName} — checked ${entry.checked} ` +
        `(${entry.ageDays} days ago), covers ${entry.dirs.join(', ')}`
    );
  }
  console.warn(
    'Re-read the upstream text and update `checked`, or remove the entry if ' +
      'upstream relicensed.'
  );
}

if (strict && gaps.length > 0) {
  process.exitCode = 1;
  console.warn(
    `\n--strict: exiting non-zero, ${gaps.length} ` +
      `${gaps.length === 1 ? 'library has' : 'libraries have'} unrecorded terms.`
  );
}
