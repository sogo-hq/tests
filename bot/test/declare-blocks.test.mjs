/**
 * The two optional blocks, the docs hash, and the page they point at.
 *
 * Every fetch here is injected. Nothing in this file touches a network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('declare-blocks');
const D = await import('../dist/declare.js');

const NOW = 1_789_000_000_000;
const DEPLOYER = '0x' + '9'.repeat(40);
const DOCS = 'https://checkvitals.xyz/declared/001';

const ROOM_LINE =
  "the room: 50 seats. the room is owed 10% of the fee wallet's cumulative gross income, "
  + 'paid daily in ETH for 30 days by shares (T1 5, T2 2, T3 1), every payout printed before '
  + 'it leaves and recorded with its hash. a seat is given by the deployer, its tier is fixed '
  + 'when taken and reviewed once after the 30 days. a seat given up is reused and both '
  + 'occupants stay in the history. 10% of gross income goes to ecosystem integrations, '
  + '80% to the build.';

const HOLDER_BLOCK =
  'holder fee share is off at launch. the token is access, not yield: 250k = watch, 1M = the holder feed, 10M = desk.\n'
  + 'nothing changes in the first 10 days. the room reviews it with holders on 5 oct. any change is announced 7 days ahead.';

const VESTING = 'held by the deployer, vesting contracts in october, nothing distributed at launch';

/** Walk the whole form. `room` and `holder` may be 'skip'. */
function walk(u, { room = 'skip', holder = 'skip', docs = DOCS } = {}) {
  D.clearDraft(u);
  D.startDraft(u, NOW, 'nonce123');
  const answers = [DEPLOYER, '5', 'dev wallet only', '400, half to the artist', VESTING, room, holder, docs];
  return answers.map((a) => D.answerDraft(u, a)).pop();
}

/** A fetch that serves one body, or refuses. */
const serve = (body, { ok = true, status = 200 } = {}) => async () => ({
  ok, status, bytes: new Uint8Array(Buffer.from(body, 'utf8')),
});
const refuse = (status = 503) => async () => ({ ok: false, status, bytes: new Uint8Array() });
const throws = () => async () => { throw new Error('getaddrinfo ENOTFOUND'); };

// ------------------------------------------------------------ the two blocks

test('the form is eight steps, with the two blocks before the docs link', () => {
  assert.deepEqual(D.STEPS.map((s) => s.key),
    ['deployer', 'devBuy', 'exemptions', 'tax', 'vesting', 'room', 'holderFeeShare', 'docs']);
});

test('skipping both leaves the canonical text exactly as it was before they existed', () => {
  const done = walk(500);
  assert.equal(done.state, 'complete');
  const lines = done.canonical.split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('the room:')), []);
  assert.deepEqual(lines.filter((l) => l.startsWith('holder fee share')), []);
  // Every other declarer's format is untouched: the fields they answered, in
  // the order they answered them, and nothing else.
  assert.deepEqual(lines.map((l) => l.split(':')[0]), [
    'vitals declaration', 'deployer', 'dev buy', 'tax-free at launch',
    'creator tax', 'tax split', 'docs', 'nonce',
  ]);
});

test('an empty answer is a skip, and so are the obvious ways of saying nothing', () => {
  for (const answer of ['skip', 'none', 'no', 'n/a', 'nothing', 'Skip.']) {
    const done = walk(501, { room: answer });
    assert.ok(!done.canonical.includes('the room:'), `"${answer}" put a room line in`);
  }
});

test('a filled room block lands in the signed text verbatim', () => {
  const done = walk(502, { room: ROOM_LINE });
  assert.ok(done.canonical.includes(ROOM_LINE));
  assert.equal(done.canonical.split('\n').filter((l) => l.startsWith('the room:')).length, 1);
});

test('a two line holder block keeps both of its lines', () => {
  const done = walk(503, { holder: HOLDER_BLOCK });
  assert.ok(done.canonical.includes(HOLDER_BLOCK),
    'the newline was collapsed, so the text signed is not the text shown');
  const lines = done.canonical.split('\n');
  assert.ok(lines.includes('nothing changes in the first 10 days. the room reviews it with holders on 5 oct. any change is announced 7 days ahead.'));
});

test('both blocks sit between the tax split and the docs line', () => {
  const done = walk(504, { room: ROOM_LINE, holder: HOLDER_BLOCK });
  const lines = done.canonical.split('\n');
  const at = (pred) => lines.findIndex(pred);
  const tax = at((l) => l.startsWith('tax split:'));
  const room = at((l) => l.startsWith('the room:'));
  const holder = at((l) => l.startsWith('holder fee share'));
  const docs = at((l) => l.startsWith('docs:'));
  assert.ok(tax < room && room < holder && holder < docs, done.canonical);
});

test('a block longer than the bound is refused, and the form keeps its place', () => {
  D.clearDraft(505);
  D.startDraft(505, NOW, 'n');
  for (const a of [DEPLOYER, '5', 'dev wallet only', '400, half to the artist', VESTING]) D.answerDraft(505, a);
  const long = D.answerDraft(505, 'x'.repeat(D.MAX_BLOCK_TEXT + 1));
  assert.equal(long.state, 'rejected');
  assert.match(long.error, new RegExp(`keep it under ${D.MAX_BLOCK_TEXT}`));
  assert.equal(long.step, 5, 'a rejected answer must not advance the form');
  D.clearDraft(505);
});

test('the bound fits the two blocks this launch signs', () => {
  assert.ok(ROOM_LINE.length < D.MAX_BLOCK_TEXT, `${ROOM_LINE.length} characters`);
  assert.ok(HOLDER_BLOCK.length < D.MAX_BLOCK_TEXT, `${HOLDER_BLOCK.length} characters`);
});

test('a block carrying an em dash is rewritten, like every other field', () => {
  const done = walk(506, { room: `the room: 50 seats ${String.fromCharCode(0x2014)} no more` });
  assert.ok(!done.canonical.includes(String.fromCharCode(0x2014)));
  assert.ok(done.canonical.includes('the room: 50 seats, no more'));
});

// -------------------------------------------------------------- the docs hash

test('the hash is of the page body, and goes in as its own line', async () => {
  walk(510, { room: ROOM_LINE, holder: HOLDER_BLOCK });
  const body = '<!doctype html><title>001</title>';
  const pinned = await D.pinDocsHash(510, serve(body));
  const expected = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
  assert.equal(pinned.hash, expected);
  assert.ok(pinned.canonical.includes(`docs sha256: ${expected}`));
  // Directly under the line it pins, and above the nonce.
  const lines = pinned.canonical.split('\n');
  assert.equal(lines[lines.indexOf(`docs: ${DOCS}`) + 1], `docs sha256: ${expected}`);
  assert.ok(lines[lines.length - 1].startsWith('nonce:'));
});

test('a page that cannot be read means no hash line, not an error', async () => {
  for (const get of [refuse(503), refuse(404), throws()]) {
    walk(511);
    const pinned = await D.pinDocsHash(511, get);
    assert.equal(pinned.hash, null);
    assert.ok(!pinned.canonical.includes('docs sha256:'),
      'an unreachable page must not put a line in saying anything about it');
    // And the rest of the declaration is untouched and signable.
    assert.ok(pinned.canonical.includes(`docs: ${DOCS}`));
    assert.ok(pinned.canonical.startsWith('vitals declaration\n'));
  }
});

test('the same bytes always give the same hash, whatever they contain', () => {
  assert.equal(D.sha256Hex(''), createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  assert.equal(D.sha256Hex('a'), D.sha256Hex(new Uint8Array([97])));
  assert.notEqual(D.sha256Hex('a'), D.sha256Hex('b'));
  assert.match(D.sha256Hex('a'), /^[0-9a-f]{64}$/);
});

test('a page read later that matches is a match, and one byte different is not', async () => {
  const body = '<!doctype html><title>001</title>';
  const signed = D.sha256Hex(body);
  assert.equal(await D.checkDocsPage({ docsUrl: DOCS, docsSha256: signed }, serve(body)), 'match');
  assert.equal(await D.checkDocsPage({ docsUrl: DOCS, docsSha256: signed }, serve(body + ' ')), 'differs');
});

test('a page that will not answer is undetermined, never a match and never a change', async () => {
  const signed = D.sha256Hex('x');
  for (const get of [refuse(503), throws()]) {
    assert.equal(await D.checkDocsPage({ docsUrl: DOCS, docsSha256: signed }, get), 'undetermined');
  }
});

test('a declaration signed without a hash says so rather than claiming a match', async () => {
  assert.equal(await D.checkDocsPage({ docsUrl: DOCS, docsSha256: '' }, serve('anything')), 'unpinned');
  assert.equal(D.docsHashState('', 'abc'), 'unpinned');
});

test('every state has a line, and none of them is a verdict about the launch', () => {
  for (const state of ['match', 'differs', 'undetermined', 'unpinned']) {
    const line = D.docsHashLine(state);
    assert.ok(line.startsWith('docs page:'), state);
    assert.doesNotMatch(line, /\bclean\b|\bsafe\b|\bfine\b|\bgood\b|!/i, state);
    assert.ok(!line.includes(String.fromCharCode(0x2014)), state);
  }
  assert.match(D.docsHashLine('differs'), /changed since it was signed/);
  assert.match(D.docsHashLine('undetermined'), /undetermined/);
});

test('an http docs link is never hashed', async () => {
  // The hash is only meaningful over bytes nobody could have replaced in
  // flight. A plain http page is not that.
  assert.equal(await D.fetchDocsHash('http://example.com/x', serve('body')), null);
  assert.equal(await D.fetchDocsHash('', serve('body')), null);
});

// --------------------------------------------------------------- the page

const PAGE = readFileSync('site/declared/001.html', 'utf8');
const TEMPLATE = readFileSync('docs/template-declaration.md', 'utf8');
const fenced = (n) => (TEMPLATE.split('\n```\n')[n * 2 - 1] ?? '').replace(/^```\w*\n?/, '').trim();

test('the page carries the signed text, the treasury, the holder block and the room', () => {
  for (const [what, text] of [['canonical', fenced(1)], ['treasury', fenced(2)], ['holder', fenced(3)]]) {
    assert.ok(text.length > 40, `the template has no ${what} block`);
    const escaped = text.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
    assert.ok(PAGE.includes(escaped), `the page does not carry the ${what} block`);
  }
  assert.ok(PAGE.includes(ROOM_LINE), 'the page does not carry the room line');
});

test('the page is self-contained: nothing is fetched to render it', () => {
  assert.doesNotMatch(PAGE, /<script/i);
  assert.doesNotMatch(PAGE, /@import/i);
  assert.doesNotMatch(PAGE, /url\(/i);
  assert.doesNotMatch(PAGE, /<link\b/i);
  // Only outbound links a reader can click, no resources.
  const hrefs = [...PAGE.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0);
  for (const h of hrefs) assert.match(h, /^https:\/\//, h);
  assert.doesNotMatch(PAGE, /src="/i);
});

test('the page says nothing a card is not allowed to say', () => {
  assert.ok(!PAGE.includes(String.fromCharCode(0x2014)));
  assert.doesNotMatch(PAGE, /\bsafe to buy\b|\bgood entry\b|\bwill pump\b|price target|\bguaranteed\b/i);
  assert.doesNotMatch(PAGE, /backed by|partnered with|official partner/i);
  // And it says the thing every surface has to say.
  assert.match(PAGE, /is not a check that found the launch to be fine/);
  assert.match(PAGE, /no score, no grade and no verdict/);
});

test('the page carries no placeholder and no signature', () => {
  assert.doesNotMatch(PAGE, /\[TREASURY RULES\]|\[HOLDER FEE SHARING\]/);
  assert.doesNotMatch(PAGE, /CHANGE.?ME/i);
  assert.doesNotMatch(PAGE, /0x[0-9a-fA-F]{130}/, 'a signature is on the page');
});

test('the page is small enough to be read before it is trusted', () => {
  assert.ok(PAGE.length < 40_000, `${PAGE.length} bytes`);
});

test('the page hashes to something stable, which is what gets signed', () => {
  const hash = createHash('sha256').update(Buffer.from(PAGE, 'utf8')).digest('hex');
  assert.match(hash, /^[0-9a-f]{64}$/);
  // Byte for byte, twice.
  assert.equal(hash, createHash('sha256').update(Buffer.from(readFileSync('site/declared/001.html', 'utf8'), 'utf8')).digest('hex'));
});

test('the builder reproduces the page that is checked in', async () => {
  // If this fails, the template moved and the page was not rebuilt, which is
  // the drift the page is generated to prevent.
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['scripts/build-declared-001.mjs'], { encoding: 'utf8' });
  assert.equal(readFileSync('site/declared/001.html', 'utf8'), PAGE,
    'docs/template-declaration.md changed without site/declared/001.html being rebuilt');
});

// ------------------------------------------- DECLARED #001 through the form

/** The answers DECLARED #001 gives, taken from the document itself. */
const VESTING_001 =
  'held by the deployer wallet, 2% team and 3% partnerships, vesting contracts in october, '
  + 'nothing distributed at launch';
const TAX_001 = '400, 10% the room, 10% ecosystem, 80% the build, treasury rules as declared';

function walk001(u) {
  D.clearDraft(u);
  D.startDraft(u, NOW, 'nonce123');
  return [DEPLOYER, '5', 'dev wallet only', TAX_001, VESTING_001, ROOM_LINE, HOLDER_BLOCK, DOCS]
    .map((a) => D.answerDraft(u, a)).pop();
}

test('the form produces exactly the text the template says gets signed', () => {
  // The whole point of the two optional fields: #001 signs through the same
  // flow as anyone, so the document and the bot cannot disagree about what
  // was signed.
  const done = walk001(520);
  assert.equal(done.state, 'complete');

  const fromDocs = fenced(1).split('\n');
  const produced = done.canonical.split('\n');

  // Every line of the document's block, in order, allowing for the fields this
  // walk answers differently: the deployer, and the nonce the bot issues.
  const skip = (l) => l.startsWith('deployer:') || l.startsWith('nonce:') || l.startsWith('docs:');
  const wanted = fromDocs.filter((l) => !skip(l));
  let at = 0;
  for (const line of wanted) {
    const found = produced.indexOf(line, at);
    assert.notEqual(found, -1, `the form cannot produce this line:\n  ${line}`);
    at = found;
  }
});

test('the template explains the one line it cannot print', () => {
  assert.match(TEMPLATE, /One line is missing from the block below/);
  assert.match(TEMPLATE, /the hash of a page cannot be part of the page/);
  // And the block itself still carries no marker of any kind.
  assert.ok(!fenced(1).includes('['), fenced(1));
});

test('the page says the same thing, so nobody compares and finds a mismatch', () => {
  assert.match(PAGE, /one line added\s*\n?at the moment of signing/);
  assert.match(PAGE, /the hash of a page cannot be part\nof the page/);
});

test('the docs sha256 line is the only line the page does not carry', () => {
  const done = walk001(521);
  const escaped = (s) => s.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
  for (const line of done.canonical.split('\n')) {
    if (line.startsWith('nonce:') || line.startsWith('deployer:') || line.startsWith('docs:')) continue;
    assert.ok(PAGE.includes(escaped(line)), `the page is missing:\n  ${line}`);
  }
});
