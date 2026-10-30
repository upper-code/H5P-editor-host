import fs from 'fs/promises';
import path from 'path';

/**
 * The open-source notices page.
 *
 * Every browser that loads the editor receives GPL-licensed JavaScript from
 * this service — the H5P core and editor runtime, the CKEditor 5 bundle and
 * the bridge itself — so the page that names those components, their exact
 * versions and where their corresponding source lives must be reachable from
 * the editor UI as an ordinary web page, not only as a Markdown download.
 * `THIRD-PARTY-NOTICES.md` stays the single source of truth; this module
 * renders it to HTML with a deliberately small converter (headings, lists,
 * paragraphs, links, inline code, emphasis) so no Markdown dependency is
 * needed for one static page.
 */

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function inline(text: string): string {
  let html = escapeHtml(text);
  // `code` first, so nothing inside it is treated as markup.
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Web URLs and explicit local ./ links — the URL was HTML-escaped above,
  // which keeps it a
  // valid attribute value.
  html = html.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|\.\/)[^)\s]+)\)/g,
    '<a href="$2" rel="noopener">$1</a>'
  );
  // Bare URLs become links; a trailing `.`/`,`/`)` belongs to the sentence.
  html = html.replace(
    /(^|[\s(])(https?:\/\/[^\s<]+?)([.,;:)]*)(?=\s|$)/g,
    (_match, lead, url, tail) =>
      `${lead}<a href="${url}" rel="noopener">${url}</a>${tail}`
  );
  return html;
}

function flush(kind: 'p' | 'li', lines: string[], out: string[]): void {
  if (lines.length === 0) {
    return;
  }
  out.push(`<${kind}>${inline(lines.join(' '))}</${kind}>`);
  lines.length = 0;
}

/** Renders the subset of Markdown that the notices file uses. */
export function renderNoticesHtml(markdown: string): string {
  const out: string[] = [];
  const pending: string[] = [];
  let inList = false;
  let title = 'Open-source licenses';

  const closeList = (): void => {
    if (inList) {
      flush('li', pending, out);
      out.push('</ul>');
      inList = false;
    }
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      flush('p', pending, out);
      const level = heading[1].length;
      if (level === 1) {
        title = heading[2];
      }
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!inList) {
        flush('p', pending, out);
        out.push('<ul>');
        inList = true;
      } else {
        flush('li', pending, out);
      }
      pending.push(item[1]);
      continue;
    }
    if (line === '') {
      closeList();
      flush('p', pending, out);
      continue;
    }
    // A continuation line: indented under a list item, or the next line of a
    // paragraph.
    pending.push(line.trim());
  }
  closeList();
  flush('p', pending, out);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0 auto; max-width: 48rem; padding: 2rem 1.25rem; font: 16px/1.55 system-ui, sans-serif; color: #182337; background: #fff; }
      h1 { font-size: 1.6rem; } h2 { font-size: 1.25rem; margin-top: 2rem; } h3 { font-size: 1.05rem; }
      code { font-size: 0.92em; background: #f1f4f8; padding: 0.05em 0.3em; border-radius: 3px; }
      a { color: #2468a7; }
      li { margin: 0.35rem 0; }
    </style>
  </head>
  <body>
${out.map((line) => `    ${line}`).join('\n')}
  </body>
</html>
`;
}

/**
 * Serves the notices as HTML, or as the Markdown source when the client asks
 * for it (`?format=md`, or an `Accept` that prefers `text/markdown`). The
 * file is read once; it is part of the tracked release, not runtime data.
 */
export function createLicensesHandler(appRoot: string) {
  const noticesPath = path.join(appRoot, 'THIRD-PARTY-NOTICES.md');
  let cached: Promise<{ markdown: string; html: string }> | undefined;
  const load = (): Promise<{ markdown: string; html: string }> => {
    if (!cached) {
      cached = fs.readFile(noticesPath, 'utf8').then((markdown) => ({
        markdown,
        html: renderNoticesHtml(markdown)
      }));
      cached.catch(() => {
        cached = undefined;
      });
    }
    return cached;
  };
  return async (
    req: {
      query: Record<string, unknown>;
      accepts: (types: string[]) => string | false;
    },
    res: {
      type: (t: string) => unknown;
      send: (body: string) => unknown;
    },
    next: (error: unknown) => void
  ): Promise<void> => {
    try {
      const notices = await load();
      const wantsMarkdown =
        req.query.format === 'md' ||
        req.accepts(['text/html', 'text/markdown']) === 'text/markdown';
      if (wantsMarkdown) {
        res.type('text/markdown');
        res.send(notices.markdown);
      } else {
        res.type('text/html');
        res.send(notices.html);
      }
    } catch (error) {
      next(error);
    }
  };
}
