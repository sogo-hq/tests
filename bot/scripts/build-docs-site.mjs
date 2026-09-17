#!/usr/bin/env node
/**
 * Build site/docs/ from the markdown in docs/.
 *
 * One page per document plus an index, a sidebar on every page, and no
 * external resource of any kind: no font CDN, no script, no stylesheet, no
 * image. A documentation site that fetches a font from somewhere else renders
 * differently when that somewhere else is having a bad day, and this one
 * describes a tool whose whole argument is that it reports what it actually
 * read.
 *
 * The markdown renderer is written out here rather than pulled in, for the
 * same reason. It handles what these documents use, and the build fails on a
 * page that comes out carrying markup it did not mean to emit.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'docs');

/** The pages, in sidebar order. */
export const PAGES = [
  { slug: 'index', title: 'Overview', source: null,
    blurb: 'what this is and what it refuses to do' },
  { slug: 'api', title: 'API', source: 'api.md',
    blurb: 'the read-only HTTP API, its guarantees and its shapes' },
  { slug: 'groups', title: 'Groups', source: 'partners-groups.md',
    blurb: 'putting the bot in a group, and what it does there' },
  { slug: 'vitals', title: 'VITALS', source: 'vitals.md',
    blurb: 'the project, the socials, and DECLARED #001' },
];

// ------------------------------------------------------------------ markdown

const esc = (s) => s
  .split('&').join('&amp;')
  .split('<').join('&lt;')
  .split('>').join('&gt;');

/**
 * Where a link between documents goes on the site.
 *
 * The markdown links documents by filename, which is right in the repository
 * and wrong on a site that publishes three of them under different paths.
 * Anything not in here is not published, so the link is dropped to plain text
 * rather than shipped pointing at a 404.
 */
export const SITE_LINKS = {
  'api.md': '/api',
  'partners-groups.md': '/groups',
  'vitals.md': '/vitals',
  '../examples/sample-response.json': '/examples/sample-response.json',
};

/** The files copied next to the pages, because a page links to them. */
export const SITE_FILES = [
  { from: 'examples/sample-response.json', to: 'examples/sample-response.json' },
];

/**
 * Inline: code, bold, links.
 *
 * Escaped first, so nothing in a document can inject markup. Code spans are
 * parked behind a sentinel before links and bold run, because a backtick span
 * is literal by definition and must not be reinterpreted.
 *
 * `dropped` collects links to documents this site does not publish. They come
 * out as plain text: a dead link on a documentation site is worse than no
 * link, because it reads as something a reader failed to find.
 */
export function inline(text, dropped = []) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `@@CODE${codes.length - 1}@@`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    if (/^https:\/\//.test(href) || href.startsWith('#') || href.startsWith('/')) {
      return `<a href="${href}">${label}</a>`;
    }
    const mapped = SITE_LINKS[href] ?? SITE_LINKS[href.replace(/^\.\//, '')];
    if (mapped) return `<a href="${mapped}">${label}</a>`;
    // http, or a document the site does not publish.
    dropped.push(href);
    return label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/@@CODE(\d+)@@/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

/** A markdown table row into cells, tolerating the leading and trailing pipe. */
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function render(md) {
  const lines = md.split('\n');
  const out = [];
  const headings = [];
  const dropped = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. Never rendered as markdown, never linkified.
    if (/^```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Headings, which also build the contents in the sidebar.
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (level === 2) headings.push({ id, text });
      out.push(`<h${level} id="${id}">${inline(text, dropped)}</h${level}>`);
      i++;
      continue;
    }

    // Tables: a header row, a separator, then body rows.
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push('<div class="scroll"><table>');
      out.push(`<thead><tr>${head.map((c) => `<th>${inline(c, dropped)}</th>`).join('')}</tr></thead>`);
      out.push('<tbody>');
      for (const r of body) out.push(`<tr>${r.map((c) => `<td>${inline(c, dropped)}</td>`).join('')}</tr>`);
      out.push('</tbody></table></div>');
      continue;
    }

    // Lists, bulleted or numbered, with wrapped lines folded into their item.
    const bullet = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m) { items.push(m[2]); i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ` ${lines[i].trim()}`; i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t, dropped)}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (!line.trim()) { i++; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim()
      && !/^```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])
      && !/^\s*\|/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])
      && !/^\s*---+\s*$/.test(lines[i])) {
      para.push(lines[i++]);
    }
    if (para.length) out.push(`<p>${inline(para.join(' ').trim(), dropped)}</p>`);
    else i++;
  }

  return { html: out.join('\n'), headings, dropped };
}

// --------------------------------------------------------------------- shell

const CSS = `
  :root { --bg: #080B09; --ink: #E8F0DE; --dim: #6E7A66; --ref: #C6F73A; --rule: #1B241A; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 400 16px/1.7 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { display: flex; align-items: flex-start; max-width: 1180px; margin: 0 auto; gap: 48px; padding: 0 24px; }
  nav { position: sticky; top: 0; flex: 0 0 210px; padding: 48px 0 64px; max-height: 100vh; overflow-y: auto; }
  nav .brand {
    font: 400 13px/1 "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--ref);
    display: block; margin-bottom: 26px; text-decoration: none; border: 0;
  }
  nav a { display: block; color: var(--dim); text-decoration: none; border: 0; padding: 6px 0; font-size: 15px; }
  nav a:hover { color: var(--ink); }
  nav a.on { color: var(--ink); border-left: 2px solid var(--ref); padding-left: 12px; margin-left: -14px; }
  nav .sub { margin: 4px 0 18px 0; padding-left: 12px; border-left: 1px solid var(--rule); }
  nav .sub a { font-size: 14px; padding: 4px 0; }
  main { flex: 1 1 auto; min-width: 0; padding: 48px 0 120px; }
  h1 { font-size: 34px; line-height: 1.2; margin: 0 0 28px; font-weight: 700; letter-spacing: -0.01em; }
  h2 {
    font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim);
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-weight: 400; margin: 52px 0 14px; padding-top: 14px; border-top: 1px solid var(--rule);
  }
  h3 { font-size: 19px; margin: 34px 0 12px; font-weight: 600; }
  h4 { font-size: 16px; margin: 26px 0 10px; font-weight: 600; color: var(--dim); }
  p { margin: 0 0 16px; }
  ul, ol { margin: 0 0 16px; padding-left: 22px; }
  li { margin: 0 0 8px; }
  a { color: var(--ref); text-decoration: none; border-bottom: 1px solid var(--rule); }
  a:hover { border-bottom-color: var(--ref); }
  code {
    font: 400 0.88em/1.5 "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0C100B; border: 1px solid var(--rule); border-radius: 3px; padding: 1px 5px;
  }
  pre {
    background: #0C100B; border: 1px solid var(--rule); border-left: 2px solid var(--ref);
    border-radius: 3px; padding: 16px 18px; margin: 0 0 18px; overflow-x: auto;
  }
  pre code { background: none; border: 0; padding: 0; font-size: 13.5px; line-height: 1.7; }
  .scroll { overflow-x: auto; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
  th, td { text-align: left; padding: 9px 14px 9px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th {
    font: 400 12px/1.4 "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); white-space: nowrap;
  }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 36px 0; }
  strong { font-weight: 600; }
  footer { margin-top: 64px; padding-top: 24px; border-top: 1px solid var(--rule); color: var(--dim); font-size: 14px; }
  .cards { display: grid; gap: 14px; margin: 0 0 28px; }
  .card { display: block; border: 1px solid var(--rule); border-radius: 4px; padding: 18px 20px; text-decoration: none; color: var(--ink); }
  .card:hover { border-color: var(--ref); }
  .card b { display: block; font-weight: 600; margin-bottom: 4px; }
  .card span { color: var(--dim); font-size: 14.5px; }
  @media (max-width: 860px) {
    .wrap { display: block; padding: 0 20px; }
    nav { position: static; max-height: none; padding: 32px 0 0; border-bottom: 1px solid var(--rule); }
    nav .sub { display: none; }
    main { padding: 32px 0 80px; }
    h1 { font-size: 27px; }
  }
`;

/**
 * Absolute, not relative.
 *
 * The pages are served from folders, so /api is a directory and a relative
 * ./vitals from inside it resolves to /api/vitals, which does not exist. An
 * absolute path is the same link wherever the page is served from.
 */
export const hrefFor = (slug) => (slug === 'index' ? '/' : `/${slug}`);

function sidebar(slug, headings) {
  const links = PAGES.map((p) => {
    const href = hrefFor(p.slug);
    const on = p.slug === slug ? ' class="on"' : '';
    const sub = p.slug === slug && headings.length
      ? `<div class="sub">${headings.map((h) => `<a href="#${h.id}">${esc(h.text)}</a>`).join('')}</div>`
      : '';
    return `<a href="${href}"${on}>${esc(p.title)}</a>${sub}`;
  }).join('\n      ');
  return `<nav>\n      <a class="brand" href="/">VITALS docs</a>\n      ${links}\n    </nav>`;
}

function page({ slug, title, body, headings }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} . VITALS docs</title>
<meta name="description" content="VITALS documentation. ${esc(title)}.">
<style>${CSS}</style>
</head>
<body>
  <div class="wrap">
    ${sidebar(slug, headings)}
    <main>
${body}
      <footer>
        <p><a href="https://checkvitals.xyz">checkvitals.xyz</a>
        . <a href="https://t.me/vitalscheck_bot">@vitalscheck_bot</a>
        . <a href="https://x.com/vitalsxyz">x.com/vitalsxyz</a>
        . <a href="https://t.me/vitalsofficial">t.me/vitalsofficial</a></p>
        <p>No score, no grade, no verdict. A check that found nothing is not a
        check that found the launch to be fine.</p>
      </footer>
    </main>
  </div>
</body>
</html>
`;
}

const INDEX_BODY = `      <h1>VITALS documentation</h1>
      <p>VITALS reads pons v2 launches on Robinhood Chain and prints what the
      chain shows. Facts and their reference points. No score, no grade, no
      verdict.</p>
      <div class="cards">
${PAGES.filter((p) => p.slug !== 'index').map((p) =>
  `        <a class="card" href="${hrefFor(p.slug)}"><b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></a>`).join('\n')}
      </div>
      <h2>What it never says</h2>
      <ul>
        <li>No score, no grade, no traffic light, no verdict.</li>
        <li>Absence of a finding is never "clean". Undetermined when the data
        cannot support a negative.</li>
        <li>No price targets, no direction, no entry, no exit.</li>
        <li>Nothing that did not finish reads as a fact about the chain.</li>
      </ul>`;

// ----------------------------------------------------------------------- run

export function build() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const written = [];
  const allDropped = [];
  const EM = String.fromCharCode(0x2014);

  // The files a page links to, next to the pages.
  for (const f of SITE_FILES) {
    mkdirSync(join(OUT, dirname(f.to)), { recursive: true });
    copyFileSync(join(ROOT, f.from), join(OUT, f.to));
  }

  for (const p of PAGES) {
    let body;
    let headings = [];
    if (p.source) {
      const md = readFileSync(join(ROOT, 'docs', p.source), 'utf8');
      const r = render(md);
      body = r.html.split('\n').map((l) => `      ${l}`).join('\n');
      headings = r.headings;
      for (const d of r.dropped) allDropped.push(`${p.source} -> ${d}`);
    } else {
      body = INDEX_BODY;
    }
    const html = page({ slug: p.slug, title: p.title, body, headings });
    if (html.includes(EM)) throw new Error(`${p.slug}: the page carries an em dash`);
    if (/<script|@import|\ssrc=/i.test(html)) throw new Error(`${p.slug}: the page fetches something`);
    // One http:// resource on an https page is mixed content: Chrome marks the
    // whole site not secure behind a valid certificate, and the padlock is the
    // only thing most readers check.
    const insecure = [...html.matchAll(/(?:href|src)="(http:\/\/[^"]*)"/gi)].map((m) => m[1]);
    if (insecure.length) throw new Error(`${p.slug}: insecure url ${insecure[0]}`);
    // A relative link is a link that breaks as soon as a page is served from a
    // folder, which is how all of these are served.
    const relative = [...html.matchAll(/href="(\.[^"]*)"/g)].map((m) => m[1]);
    if (relative.length) throw new Error(`${p.slug}: relative link ${relative[0]}`);
    const file = join(OUT, p.slug === 'index' ? 'index.html' : `${p.slug}.html`);
    writeFileSync(file, html);
    written.push({
      path: `site/docs/${p.slug === 'index' ? 'index.html' : `${p.slug}.html`}`,
      bytes: Buffer.byteLength(html, 'utf8'),
      sha256: createHash('sha256').update(html).digest('hex'),
    });
  }
  // Said, not swallowed: a link that came out as plain text is a document
  // somebody expected to be able to reach.
  if (allDropped.length) {
    console.log(`  ${allDropped.length} link${allDropped.length === 1 ? '' : 's'} to unpublished documents, rendered as plain text:`);
    for (const d of [...new Set(allDropped)]) console.log(`    ${d}`);
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const w of build()) {
    console.log(`  ${w.path.padEnd(24)} ${String(w.bytes).padStart(6)} bytes  ${w.sha256.slice(0, 16)}`);
  }
}
