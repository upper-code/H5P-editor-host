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

function readLibraries() {
  const entries = fs
    .readdirSync(librariesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return entries.map((dir) => {
    const libPath = path.join(librariesDir, dir);
    let title = dir;
    let license = '(none)';
    let source = 'library.json';
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(libPath, 'library.json'), 'utf8')
      );
      title = meta.title || dir;
      if (typeof meta.license === 'string' && meta.license.trim() !== '') {
        license = meta.license.trim();
      } else {
        ({ license, source } = findRootEvidence(libPath));
      }
    } catch {
      source = 'invalid or absent library.json';
    }

    const bundled = scanBundledCopyleft(libPath);
    return { dir, title, license, source, bundled };
  });
}

// The bucket a library counts under in the summary: bundled copyleft dominates
// a permissive declaration, because that is the redistribution-relevant fact.
function summaryBucket(library) {
  return library.bundled.length > 0
    ? 'bundled copyleft (see notes)'
    : library.license;
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
  for (const library of libraries) {
    const bucket = summaryBucket(library);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
    if (library.bundled.length > 0) {
      contaminated.push(library);
    }
  }
  return { counts, contaminated };
}

function buildReport(libraries, { counts, contaminated }) {
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

  const rows = libraries
    .map((library) => {
      const declared = library.license;
      const display = library.bundled.length
        ? `${declared} · bundled copyleft`
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

## Libraries

| Directory | Title | License/evidence | Source |
|---|---|---|---|
${rows}
`;
}

const libraries = readLibraries();
const summary = summarize(libraries);
fs.writeFileSync(outputFile, buildReport(libraries, summary), 'utf8');

console.log(
  `Wrote ${outputFile} (${libraries.length} libraries, ` +
    `${summary.contaminated.length} with bundled copyleft):`,
  Object.fromEntries(summary.counts)
);
