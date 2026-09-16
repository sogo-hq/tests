/**
 * The documentation site, against the markdown it is built from.
 *
 * It replaces docs.checkvitals.xyz, so a page that silently drops a table or
 * leaks raw markdown is a published page nobody proof-read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { render, inline, PAGES, build } from '../scripts/build-docs-site.mjs';

const read = (slug) => readFileSync(`site/docs/${slug === 'index' ? 'index' : slug}.html`, 'utf8');
const md = (f) => readFileSync(`docs/${f}`, 'utf8');
const EM = String.fromCharCode(0x2014);

// ------------------------------------------------------------- the renderer

test('headings, paragraphs, bold and inline code', () => {
  const r = render('## A heading\n\nsome **bold** and `code` here.\n');
  assert.match(r.html, /<h2 id="a-heading">A heading<\/h2>/);
  assert.match(r.html, /<p>some <strong>bold<\/strong> and <code>code<\/code> here\.<\/p>/);
  assert.deepEqual(r.headings, [{ id: 'a-heading', text: 'A heading' }]);
});

test('tables become tables, with a header row', () => {
  const r = render('| id | what |\n| --- | --- |\n| a | one |\n| b | two |\n');
  assert.match(r.html, /<thead><tr><th>id<\/th><th>what<\/th><\/tr><\/thead>/);
  assert.match(r.html, /<tr><td>a<\/td><td>one<\/td><\/tr>/);
  assert.equal((r.html.match(/<tr>/g) ?? []).length, 3);
});

test('fenced code is never treated as markdown', () => {
  const r = render('```\n| not | a table |\n**not** bold\n```\n');
  assert.match(r.html, /<pre><code>/);
  assert.doesNotMatch(r.html, /<table>/);
  assert.doesNotMatch(r.html, /<strong>/);
});

test('markup in a document is escaped, never emitted', () => {
  const r = render('a <script>alert(1)</script> b\n');
  assert.doesNotMatch(r.html, /<script/);
  assert.match(r.html, /&lt;script&gt;/);
  assert.match(inline('<b>x</b>'), /&lt;b&gt;/);
});

test('a link inside a code span stays literal', () => {
  assert.equal(inline('`[a](b)`'), '<code>[a](b)</code>');
});

test('only links we could have written are rendered as links', () => {
  assert.match(inline('[x](https://checkvitals.xyz)'), /href="https:\/\/checkvitals\.xyz"/);
  assert.match(inline('[x](./api)'), /href="\.\/api"/);
  assert.match(inline('[x](#top)'), /href="#top"/);
  // Anything else loses its target rather than becoming one.
  assert.match(inline('[x](javascript:alert(1))'), /href="#"/);
  assert.match(inline('[x](data:text/html,y)'), /href="#"/);
});

test('lists render, and a wrapped line stays in its item', () => {
  const r = render('- one\n  continued\n- two\n');
  assert.match(r.html, /<li>one continued<\/li>/);
  assert.match(r.html, /<li>two<\/li>/);
  const o = render('1. first\n2. second\n');
  assert.match(o.html, /<ol>/);
});

// ----------------------------------------------------------------- the pages

test('every page the sidebar names exists on disk', () => {
  for (const p of PAGES) {
    const file = `site/docs/${p.slug === 'index' ? 'index' : p.slug}.html`;
    assert.ok(existsSync(file), file);
  }
  assert.deepEqual(PAGES.map((p) => p.slug), ['index', 'api', 'groups', 'vitals']);
});

test('every page carries the sidebar, with the current page marked', () => {
  for (const p of PAGES) {
    const html = read(p.slug);
    assert.match(html, /<nav>/, p.slug);
    for (const other of PAGES) assert.ok(html.includes(`>${other.title}</a>`), `${p.slug} is missing ${other.title}`);
    assert.equal((html.match(/class="on"/g) ?? []).length, 1, `${p.slug} marks the wrong number of pages`);
  }
});

test('nothing is fetched to render a page', () => {
  for (const p of PAGES) {
    const html = read(p.slug);
    assert.doesNotMatch(html, /<script/i, p.slug);
    assert.doesNotMatch(html, /@import/i, p.slug);
    assert.doesNotMatch(html, /\ssrc=/i, p.slug);
    assert.doesNotMatch(html, /<link\b/i, p.slug);
    // Only links a reader clicks, all absolute-https or relative.
    for (const h of [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) {
      assert.match(h, /^(https:\/\/|\.\/|#|\.\.\/)/, `${p.slug}: ${h}`);
    }
  }
});

test('no page leaks raw markdown', () => {
  for (const p of PAGES) {
    const html = read(p.slug);
    // A fence or a pipe table that survived is a block that did not render.
    assert.ok(!html.includes('```'), `${p.slug} has an unrendered code fence`);
    for (const line of html.split('\n')) {
      if (line.includes('<') || !line.trim()) continue;
      assert.doesNotMatch(line, /^\s*\|/, `${p.slug} has an unrendered table row: ${line.slice(0, 60)}`);
      assert.doesNotMatch(line, /^\s*#{1,4}\s/, `${p.slug} has an unrendered heading: ${line.slice(0, 60)}`);
    }
  }
});

test('the api page carries the tables and code the markdown has', () => {
  const source = md('api.md');
  const html = read('api');
  const tables = (source.match(/^\|[\s:|-]+\|$/gm) ?? []).length;
  assert.ok(tables > 0);
  assert.equal((html.match(/<table>/g) ?? []).length, tables, 'a table went missing');
  const fences = (source.match(/^```/gm) ?? []).length / 2;
  assert.equal((html.match(/<pre>/g) ?? []).length, fences, 'a code block went missing');
});

test('every second level heading reaches the sidebar contents', () => {
  for (const p of PAGES.filter((x) => x.source)) {
    const source = md(p.source);
    const expected = (source.match(/^## .+$/gm) ?? []).length;
    const html = read(p.slug);
    const sub = /<div class="sub">([\s\S]*?)<\/div>/.exec(html);
    assert.ok(sub, `${p.slug} has no contents`);
    assert.equal((sub[1].match(/<a /g) ?? []).length, expected, `${p.slug} contents is short`);
  }
});

test('no em dash and nothing a card may not say', () => {
  const banned = /\bsafe to buy\b|\bgood entry\b|\bwill pump\b|price target/i;
  for (const p of PAGES) {
    const html = read(p.slug);
    assert.ok(!html.includes(EM), p.slug);
    for (const line of html.split('\n')) {
      if (!banned.test(line)) continue;
      // A line forbidding the phrase is the opposite of a line promising it.
      assert.match(line, /\bno\b|\bnever\b|\bnot\b/i, `${p.slug}: ${line.trim().slice(0, 70)}`);
    }
  }
});

test('the index links every other page once', () => {
  const html = read('index');
  for (const p of PAGES.filter((x) => x.slug !== 'index')) {
    assert.ok(html.includes(`class="card" href="./${p.slug}"`), p.slug);
  }
  assert.match(html, /No score, no grade, no traffic light, no verdict/);
});

test('the build is reproducible from the markdown', () => {
  const before = PAGES.map((p) => read(p.slug));
  build();
  const after = PAGES.map((p) => read(p.slug));
  assert.deepEqual(after, before, 'docs/ changed without site/docs/ being rebuilt');
});

// ------------------------------------------------------- the api root redirect

test('the api root points at the docs site', async () => {
  const { DOCS_URL } = await import('../dist/api/server.js');
  assert.equal(DOCS_URL, 'https://docs.checkvitals.xyz/api');
  // And that is a page this build actually produces.
  assert.ok(PAGES.some((p) => p.slug === 'api'));
});

test('the api root redirects, and only the root does', async () => {
  const { handle, DOCS_URL } = await import('../dist/api/server.js');
  // handle() is called directly rather than through a socket: the module keeps
  // timers alive, and a test that leaves a listening server behind hangs the
  // runner rather than failing it.
  const call = async (url, method = 'GET') => {
    const res = {
      statusCode: 0, headers: {}, body: '',
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h ?? {}); },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { this.body = b ?? ''; this.done = true; },
    };
    await handle({ url, method, headers: { host: 'api.checkvitals.xyz' }, on: () => {} }, res);
    return res;
  };

  for (const url of ['/', '/?ref=x']) {
    const r = await call(url);
    assert.equal(r.statusCode, 302, url);
    assert.equal(r.headers.location, DOCS_URL, url);
  }
  // HEAD too: a link checker uses it, and a 404 would read as a dead host.
  assert.equal((await call('/', 'HEAD')).statusCode, 302);
  // Nothing else moved.
  assert.equal((await call('/v1/openapi.json')).statusCode, 200);
  assert.equal((await call('/nope')).statusCode, 404);
  // A POST to the root is not a browser looking for the documentation.
  assert.notEqual((await call('/', 'POST')).statusCode, 302);
  // "GET //" is a legal request line that this URL parser rejects. It is a
  // path this service does not have, so it is a 404 and not a 500.
  assert.equal((await call('//')).statusCode, 404);
});
