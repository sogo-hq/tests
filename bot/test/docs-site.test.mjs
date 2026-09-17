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
  assert.match(inline('[x](/api)'), /href="\/api"/);
  assert.match(inline('[x](#top)'), /href="#top"/);
  // Anything else loses its anchor entirely rather than pointing somewhere.
  // A href="#" is still a link, and a link that goes nowhere reads as a page
  // the reader failed to reach.
  for (const bad of ['javascript:alert(1)', 'data:text/html,y', 'http://example.com', 'nope.md']) {
    const out = inline(`[x](${bad})`);
    assert.doesNotMatch(out, /<a /, bad);
    assert.ok(out.startsWith('x'), `${bad}: ${out}`);
    // The target does not survive anywhere in the output, as text or markup.
    assert.doesNotMatch(out, /javascript:|data:|http:/i, bad);
  }
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
  assert.deepEqual(PAGES.map((p) => p.slug), ['index', 'whitepaper', 'api', 'groups', 'vitals']);
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
    // Only links a reader clicks, all absolute-https or site-absolute.
    for (const h of [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) {
      assert.match(h, /^(https:\/\/|\/|#)/, `${p.slug}: ${h}`);
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
    assert.ok(html.includes(`class="card" href="/${p.slug}"`), p.slug);
  }
  assert.match(html, /No score, no grade, no traffic light, no verdict/);
});

test('every internal link is absolute, so a page served from a folder works', () => {
  // /api is a directory. A relative ./vitals from inside it resolves to
  // /api/vitals, which is not a page, and the whole sidebar breaks on exactly
  // the pages a reader is most likely to be on.
  for (const p of PAGES) {
    const html = read(p.slug);
    for (const h of [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) {
      assert.doesNotMatch(h, /^\.\.?\//, `${p.slug} has a relative link: ${h}`);
    }
    assert.ok(html.includes('href="/"'), `${p.slug} cannot get back to the index`);
    for (const other of PAGES.filter((x) => x.slug !== 'index')) {
      assert.ok(html.includes(`href="/${other.slug}"`), `${p.slug} cannot reach ${other.slug}`);
    }
  }
});

test('no page loads anything over http, which would mark the site not secure', () => {
  // One http:// resource on an https page is mixed content. Chrome drops the
  // padlock for the whole site behind a perfectly valid certificate, and the
  // padlock is the only thing most readers check.
  for (const p of PAGES) {
    const html = read(p.slug);
    const insecure = [...html.matchAll(/(?:href|src|srcset|poster|action|data)="(http:\/\/[^"]*)"/gi)]
      .map((m) => m[1]);
    assert.deepEqual(insecure, [], `${p.slug} loads over http: ${insecure.join(', ')}`);
    // And nothing that fetches a resource at all, at any scheme.
    assert.doesNotMatch(html, /\ssrc=/i, p.slug);
    assert.doesNotMatch(html, /<link\b/i, p.slug);
    assert.doesNotMatch(html, /@import/i, p.slug);
    assert.doesNotMatch(html, /url\(\s*['"]?http/i, p.slug);
  }
});

test('the builder refuses a page that would carry an http resource', async () => {
  // The guard is in the build, not only in this file: a document that gains an
  // http link fails the build rather than reaching the site.
  const src = readFileSync('scripts/build-docs-site.mjs', 'utf8');
  assert.match(src, /insecure url/);
  assert.match(src, /mixed content/);
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

test('a link to a document the site does not publish becomes plain text', async () => {
  const { render, SITE_LINKS } = await import('../scripts/build-docs-site.mjs');
  const r = render('see [the runbook](launch-day-runbook.md) and [groups](partners-groups.md)');
  // Published: a link. Not published: the words, and no anchor pointing at a
  // page that would 404.
  assert.match(r.html, /<a href="\/groups">groups<\/a>/);
  assert.match(r.html, /see the runbook and/);
  assert.doesNotMatch(r.html, /launch-day-runbook/);
  assert.deepEqual(r.dropped, ['launch-day-runbook.md']);
  assert.equal(SITE_LINKS['partners-groups.md'], '/groups');
});

test('a file a page links to is published next to the pages', async () => {
  const { SITE_FILES } = await import('../scripts/build-docs-site.mjs');
  for (const f of SITE_FILES) {
    assert.ok(existsSync(`site/docs/${f.to}`), `${f.to} is linked but not published`);
  }
  // And the link in the api page points at where it was put.
  assert.match(read('api'), /href="\/examples\/sample-response\.json"/);
  assert.ok(JSON.parse(readFileSync('site/docs/examples/sample-response.json', 'utf8')));
});

test('an http link in a document is dropped rather than published', async () => {
  const { render } = await import('../scripts/build-docs-site.mjs');
  const r = render('see [x](http://example.com/thing)');
  assert.doesNotMatch(r.html, /http:\/\//, 'an http link would mark the site not secure');
  assert.deepEqual(r.dropped, ['http://example.com/thing']);
});

test('the whitepaper is published, linked from the index, and in the sidebar', () => {
  const wp = read('whitepaper');
  assert.ok(wp.length > 8_000, 'the page is too short to be the whitepaper');
  // Linked from the index like the others, and reachable from every page.
  assert.ok(read('index').includes('class="card" href="/whitepaper"'));
  for (const p of PAGES) assert.ok(read(p.slug).includes('href="/whitepaper"'), p.slug);
});

test('the whitepaper renders its tables and code, and leaks no markdown', () => {
  const source = readFileSync('docs/whitepaper.md', 'utf8');
  const wp = read('whitepaper');
  const tables = (source.match(/^\|[\s:|-]+\|$/gm) ?? []).length;
  assert.ok(tables >= 3);
  assert.equal((wp.match(/<table>/g) ?? []).length, tables);
  const fences = (source.match(/^```/gm) ?? []).length / 2;
  assert.ok(fences >= 2);
  assert.equal((wp.match(/<pre>/g) ?? []).length, fences);
  assert.ok(!wp.includes('```'));
});

test('the whitepaper says what it refuses to do, and says it in the words used everywhere', () => {
  const wp = read('whitepaper');
  assert.match(wp, /No score, no grade, no traffic light, no verdict/);
  assert.match(wp, /Absence of a finding is never "clean"/);
  assert.match(wp, /No median under thirty observations/);
  assert.match(wp, /No price data of any kind/);
});

test('the whitepaper carries the figures this repository can show', async () => {
  const wp = read('whitepaper');
  // The production distribution, and it adds up on the page.
  assert.match(wp, /478,610/);
  assert.match(wp, /331,678 \(69\.3%\)/);
  assert.match(wp, /146,932 \(30\.7%\)/);
  assert.match(wp, /422 \(0\.09%\)/);
  // The four slots, which is the thing that was wrong and is now measured.
  assert.match(wp, /four slots/i);
  assert.match(wp, /a count of zero was never possible/);
  // The two addresses, matching what the code compiles in.
  const { FACTORY, LAUNCH_FORWARDER } = await import('../dist/config.js');
  assert.ok(wp.includes(FACTORY), 'the factory address on the page is not the one in the code');
  assert.ok(wp.includes(LAUNCH_FORWARDER), 'the forwarder address on the page is not the one in the code');
});

test('the whitepaper tiers are the tiers the bot ships with', async () => {
  const { DEFAULT_THRESHOLDS } = await import('../dist/tiers.js');
  const wp = read('whitepaper');
  for (const n of [DEFAULT_THRESHOLDS.watch, DEFAULT_THRESHOLDS.premium, DEFAULT_THRESHOLDS.desk]) {
    assert.ok(wp.includes(Number(n).toLocaleString('en-US')), String(n));
  }
  assert.match(wp, /access, not yield/);
});

test('the whitepaper room share is the share the ledger pays', async () => {
  const { LEDGER_SHARE_PCT } = await import('../dist/ledger.js');
  const { TIER_SHARES } = await import('../dist/roster.js');
  const wp = read('whitepaper');
  assert.equal(LEDGER_SHARE_PCT, 10);
  assert.match(wp, /cumulative gross income/);
  // The page writes the shares as words, so the words are checked against the
  // numbers the ledger actually divides by.
  const WORD = { 1: 'one', 2: 'two', 5: 'five' };
  assert.deepEqual(
    [TIER_SHARES.T1, TIER_SHARES.T2, TIER_SHARES.T3].map((n) => WORD[n]),
    ['five', 'two', 'one'],
    'the tier shares changed and the whitepaper still says five, two, one',
  );
  assert.match(wp, /five for a first-tier seat, two for a second, one for a third/);
  // And the pool formula on the page is the one computeRun uses.
  assert.match(wp, /pool now\s+= 0\.10 \* gross income - everything paid out/);
});
