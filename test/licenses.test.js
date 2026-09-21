const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { renderNoticesHtml } = require('../build/src/licenses');
const { CORE, appRoot, auth, rawGet: get, withHost } = require('./host');

test('the notices renderer covers headings, lists, links, code and escapes markup', () => {
  const html = renderNoticesHtml(
    '# Title <x>\n\nA paragraph with `code` and **bold** and https://example.org/a.\n' +
      'continued.\n\n## Section\n\n- item [one](https://example.org/one)\n  continued item\n- item two\n'
  );
  assert.match(html, /<title>Title &lt;x&gt;<\/title>/);
  assert.match(html, /<h1>Title &lt;x&gt;<\/h1>/);
  assert.match(
    html,
    /<p>A paragraph with <code>code<\/code> and <strong>bold<\/strong> and <a href="https:\/\/example.org\/a" rel="noopener">https:\/\/example.org\/a<\/a>\. continued\.<\/p>/
  );
  assert.match(
    html,
    /<h2>Section<\/h2>\s*<ul>\s*<li>item <a href="https:\/\/example.org\/one" rel="noopener">one<\/a> continued item<\/li>\s*<li>item two<\/li>\s*<\/ul>/
  );
});

test('the tracked notices name the browser-conveyed components with versions and source', () => {
  const notices = fs.readFileSync(
    path.join(appRoot, 'THIRD-PARTY-NOTICES.md'),
    'utf8'
  );
  const ckeditor = fs.readFileSync(
    path.join(appRoot, 'assets/h5p/editor/ckeditor/ckeditor.js'),
    'utf8'
  );
  const bundled =
    /CKEDITOR_VERSION[^"]*"(\d+\.\d+\.\d+)"/.exec(ckeditor) ||
    /S="(\d+\.\d+\.\d+)"/.exec(ckeditor);
  assert.ok(bundled, 'the CKEditor bundle states its version');
  assert.ok(
    notices.includes(`CKEditor 5, version ${bundled[1]}`),
    `notices must name CKEditor ${bundled[1]}`
  );
  assert.ok(
    notices.includes(
      `https://github.com/ckeditor/ckeditor5/tree/v${bundled[1]}`
    )
  );
  const h5pServer = require('@lumieducation/h5p-server/package.json').version;
  assert.ok(
    notices.replace(/\s+/g, ' ').includes(`version **${h5pServer}**`),
    `notices must name h5p-server ${h5pServer}`
  );
  const config = fs.readFileSync(
    path.join(appRoot, 'src/h5p/config.ts'),
    'utf8'
  );
  // `h5pVersion` carries a cache-busting package-version suffix
  // (`1.27-0.3.1`); only the leading core version feeds the source link.
  const core = /h5pVersion: `(\d+\.\d+)/.exec(config)[1];
  assert.ok(
    notices.includes(`h5p-php-library/tree/${core}.0`),
    'core source link matches the pinned version'
  );
});

test('the pinned CKEditor build inputs and runtime match their recorded source snapshot', () => {
  const result = require('node:child_process').execFileSync(
    process.execPath,
    [path.join(appRoot, 'scripts/verify-ckeditor-source.mjs')],
    { encoding: 'utf8' }
  );
  assert.match(
    result,
    /pinned source and runtime verified at 2db790c4df5398883492f49be5820522e22e1866/
  );
});

test('GET /licenses serves HTML by default and the Markdown source on request', async () => {
  await withHost(async (port) => {
    const html = await get(port, `${CORE}/licenses`, auth);
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /text\/html/);
    assert.match(html.body, /<h1>Open-source licenses<\/h1>/);
    assert.match(
      html.body,
      /href="https:\/\/github.com\/ckeditor\/ckeditor5\/tree\/v43\.3\.0"/
    );
    assert.match(html.body, /href="\.\/COPYING"/);
    assert.match(html.body, /href="\.\/docs\/CKEDITOR_SOURCE\.md"/);
    assert.match(
      html.body,
      /href="\.\/sources\/ckeditor5\/webpack\.config\.js"/
    );
    const markdown = await get(port, `${CORE}/licenses?format=md`, auth);
    assert.match(markdown.headers['content-type'], /text\/markdown/);
    assert.match(markdown.body, /^# Open-source licenses/);
    const negotiated = await get(port, `${CORE}/licenses`, {
      ...auth,
      accept: 'text/markdown'
    });
    assert.match(negotiated.headers['content-type'], /text\/markdown/);
  });
});

test('the browser can obtain the GPL text, build instructions and every pinned local source file', async () => {
  await withHost(async (port) => {
    const manifest = require('../sources/ckeditor5-source.json');
    const files = [
      'COPYING',
      'docs/CKEDITOR_SOURCE.md',
      'sources/ckeditor5-source.json',
      ...Object.keys(manifest.sourceFiles).map(
        (name) => `sources/ckeditor5/${name}`
      )
    ];
    for (const name of files) {
      const response = await get(port, `${CORE}/${name}`, auth);
      assert.equal(response.status, 200, name);
      assert.match(response.headers['content-type'], /text\/plain/);
      assert.equal(
        response.body,
        fs.readFileSync(path.join(appRoot, name), 'utf8'),
        name
      );
    }
    assert.equal(
      (
        await get(
          port,
          `${CORE}/sources/ckeditor5/node_modules/example.js`,
          auth
        )
      ).status,
      404
    );
    // Only the pinned set is served: a path under a served prefix that the
    // manifest does not name is refused by the allowlist before any disk
    // access, so nothing outside the pinned set can be published.
    assert.equal(
      (await get(port, `${CORE}/docs/not-a-pinned-source.md`, auth)).status,
      404
    );
  });
});
