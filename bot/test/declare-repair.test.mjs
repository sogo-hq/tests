/**
 * The seven ways /declare could put something in a signed text that nobody typed.
 *
 * Every one of these was reproduced against the real code on two runs of the
 * form, so each test below names the behaviour that was observed rather than
 * the behaviour that was intended. The rule they all serve is the same one:
 *
 *   an answer that does not parse re-asks, it never fills itself in.
 *
 * A form that quietly substitutes, defaults, or shortens is worse than a form
 * that refuses, because what comes out the other end is a document somebody
 * signs with a deployer wallet and publishes as a promise.
 *
 * Nothing here touches a network. The docs fetch is injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('declare-repair');

const D = await import('../dist/declare.js');
const { db } = await import('../dist/db.js');
const { clampWords, splitVerbatim, TELEGRAM_MAX_MESSAGE } = await import('../dist/text.js');

const NOW = 1_789_000_000_000;
const EM_DASH = String.fromCharCode(0x2014);

// The wallet DECLARED #001 signs with, as the document writes it: checksummed.
const DEPLOYER_001 = '0x447c8dc55B88C09830E123f9fB3e7C484714ED93';
const OTHER = '0x' + '5'.repeat(40);

let uid = 800;
const fresh = () => ++uid;

/** Feed answers into a fresh form and hand back every result, in order. */
function drive(answers, { user = fresh(), nonce = 'nonce123' } = {}) {
  D.clearDraft(user);
  D.startDraft(user, NOW, nonce);
  return { user, results: answers.map((a) => D.answerDraft(user, a)) };
}

const last = (r) => r.results[r.results.length - 1];

// ---------------------------------------------------- 1. the tax step

test('a bare number is not an answer to a question that asks two things', () => {
  const r = drive([DEPLOYER_001, '5', 'dev wallet only', '400']);
  const tax = last(r);
  assert.equal(tax.state, 'rejected', 'a bare rate was accepted');
  assert.equal(tax.step, 3, 'a rejected answer advanced the form');
  // And the rejection says what is missing rather than what is wrong.
  assert.match(tax.error, /where it goes/);
});

test('the split typed after a bare rate lands in the split, not one slot along', () => {
  // The run as it happened: "400" was accepted, "not stated" was written into
  // the split, and the split typed next went into the following slot, which is
  // the dev buy line. The same two messages now, with the bare rate refused.
  const SPLIT = '10% the room, 10% ecosystem, 80% the build, treasury rules as declared';
  const r = drive([
    DEPLOYER_001, '5', 'dev wallet only',
    '400',
    SPLIT,
    `400, ${SPLIT}`,
    'held by the deployer wallet, vesting contracts in october',
    'skip', 'skip', 'https://checkvitals.xyz/declared/001',
  ]);
  assert.equal(r.results[3].state, 'rejected', 'a bare rate was accepted');
  // And the split sent on its own is not a rate either: read as basis points
  // it was 10 bps with the leading digits eaten off the text.
  assert.equal(r.results[4].state, 'rejected', 'a percentage was read as basis points');
  assert.match(r.results[4].error, /not a percentage/);

  const done = last(r);
  assert.equal(done.state, 'complete', 'the form did not finish');
  assert.ok(!done.canonical.includes('not stated'),
    'a phrase nobody typed is in the text they are asked to sign');

  const lines = done.canonical.split('\n');
  assert.equal(lines.find((l) => l.startsWith('creator tax:')), 'creator tax: 400 bps');
  assert.equal(lines.find((l) => l.startsWith('tax split:')), `tax split: ${SPLIT}`);
  assert.equal(lines.find((l) => l.startsWith('dev buy:')),
    'dev buy: 5% of supply, held by the deployer wallet, vesting contracts in october',
    'the tax split is on the dev buy line');
});

test('a rate written as a percentage is refused with the figure in basis points', () => {
  const r = drive([DEPLOYER_001, '5', 'dev wallet only', '4% to the treasury']);
  const rej = last(r);
  assert.equal(rej.state, 'rejected');
  assert.match(rej.error, /4% is 400 bps/);
  assert.equal(rej.step, 3);
});

test('a rate with nothing after it is refused however it is punctuated', () => {
  for (const bare of ['400', '400 bps', '400,', '400:', '400 bps ,  ']) {
    const r = drive([DEPLOYER_001, '5', 'dev wallet only', bare]);
    assert.equal(last(r).state, 'rejected', `"${bare}" was accepted as a whole answer`);
  }
});

// ------------------------------------------- 2. the cap, and loud rejection

test('the free text bound is the block bound, so the form accepts what it asks for', () => {
  assert.equal(D.MAX_FREE_TEXT, D.MAX_BLOCK_TEXT);
  // The vesting prompt asks who the buy is for, when it vests and what moves
  // at launch. The answer DECLARED #001 gives to that is 117 characters, and
  // the bound that rejected it was 120: near enough to look like it worked.
  const vesting =
    'held by the deployer wallet, 2% team and 3% partnerships, vesting contracts in october, '
    + 'nothing distributed at launch';
  assert.ok(vesting.length < D.MAX_FREE_TEXT);
  const r = drive([DEPLOYER_001, '5', 'dev wallet only', '400, to the treasury', vesting]);
  assert.equal(last(r).state, 'asked');
  assert.equal(last(r).step, 5, 'a three clause answer to a three clause question was refused');
});

test('a rejection says it was not recorded, by how much, and which question is open', () => {
  const over = 'x'.repeat(D.MAX_FREE_TEXT + 37);
  const r = drive([DEPLOYER_001, '5', 'dev wallet only', '400, to the treasury', over]);
  const rej = last(r);
  assert.equal(rej.state, 'rejected');
  assert.match(rej.error, new RegExp(`${over.length} characters`));
  assert.match(rej.error, /37 over/, 'the message leaves the subtraction to the reader');

  const text = D.rejectionText(rej);
  assert.match(text, /not recorded/, 'a silent re-ask is how the next answer lands in the wrong slot');
  assert.match(text, /nothing was saved for question 5/);
  assert.match(text, /5 of 8\./);
  assert.ok(text.includes(rej.prompt), 'the rejection does not re-ask the question');
  assert.ok(!text.includes(EM_DASH));
});

test('a block over the bound is refused rather than shortened, and says by how much', () => {
  // The observed run: a 736 character room block, a bound of 700, and the 62
  // character clause on the end gone from the signed text. Nothing in the bot
  // shortened it. The bound refused it, and the person cut it to fit.
  const tail = ": development, infrastructure, integrations and the dev's pay.";
  const room = `the room: ${'x'.repeat(736 - 10 - tail.length)}${tail}`;
  assert.equal(room.length, 736);

  const r = drive([
    DEPLOYER_001, '5', 'dev wallet only', '400, to the treasury',
    'held by the deployer wallet', room,
  ]);
  const rej = last(r);
  assert.equal(rej.state, 'rejected', 'a block over the bound was accepted, so something shortened it');
  assert.match(rej.error, /736 characters, 36 over/);
  assert.equal(rej.step, 5, 'the room question is still the open one');
});

test('a block inside the bound reaches the signed text with every character on it', () => {
  const tail = ": development, infrastructure, integrations and the dev's pay.";
  const room = `the room: ${'x'.repeat(D.MAX_BLOCK_TEXT - 10 - tail.length)}${tail}`;
  assert.equal(room.length, D.MAX_BLOCK_TEXT);
  const r = drive([
    DEPLOYER_001, '5', 'dev wallet only', '400, to the treasury',
    'held by the deployer wallet', room, 'skip', 'https://checkvitals.xyz/declared/001',
  ]);
  const done = last(r);
  assert.equal(done.state, 'complete');
  assert.ok(done.canonical.includes(room), 'the signed text is not the answer that was given');
  assert.ok(done.canonical.includes(tail), 'the last clause was dropped from a signed text');
});

// --------------------------------------------- 3. the deployer in its own list

test('the deployer named among the exempt wallets is not counted twice', () => {
  // The observed line: "tax-free at launch: the deployer and 1 other", with the
  // deployer's own address listed underneath as the other.
  const r = drive([
    DEPLOYER_001, '5', DEPLOYER_001, '400, to the treasury',
    'held by the deployer wallet', 'skip', 'skip', 'https://checkvitals.xyz/declared/001',
  ]);
  const done = last(r);
  assert.equal(done.state, 'complete');
  assert.deepEqual(done.answers.exemptList, []);
  assert.match(done.canonical, /^tax-free at launch: the deployer only$/m);
  assert.ok(!done.canonical.includes(DEPLOYER_001.toLowerCase()),
    'the deployer is listed as one of the wallets beyond the deployer');
  assert.equal(D.declaredExemptCount(done.answers), 1);
});

test('the deployer is taken out of a longer list, and the rest are kept in order', () => {
  const r = drive([
    DEPLOYER_001, '5', `${OTHER} ${DEPLOYER_001} ${OTHER}`, '400, to the treasury',
    'held by the deployer wallet', 'skip', 'skip', 'https://checkvitals.xyz/declared/001',
  ]);
  const done = last(r);
  assert.deepEqual(done.answers.exemptList, [OTHER.toLowerCase()]);
  assert.match(done.canonical, /^tax-free at launch: the deployer and 1 other$/m);
  assert.equal(D.declaredExemptCount(done.answers), 2);
});

test('case is not a second wallet: the checksummed and lowercase forms are one address', () => {
  const r = drive([
    DEPLOYER_001.toLowerCase(), '5', DEPLOYER_001, '400, to the treasury',
    'held by the deployer wallet', 'skip', 'skip', 'https://checkvitals.xyz/declared/001',
  ]);
  assert.deepEqual(last(r).answers.exemptList, []);
});

test('a stored list that still carries the deployer is counted as if it did not', () => {
  // Drafts written before the form took it out are still drafts somebody can
  // finish, and a count wrong by one is a declaration disagreeing with chain.
  const a = {
    deployer: DEPLOYER_001.toLowerCase(),
    exemptList: [DEPLOYER_001.toLowerCase(), OTHER.toLowerCase()],
    devBuyPct: 5, creatorTaxBps: 400, taxSplit: 'to the treasury',
    vesting: 'held by the deployer wallet', room: '', holderFeeShare: '',
    docsUrl: 'https://checkvitals.xyz/declared/001', docsSha256: '',
  };
  assert.equal(D.declaredExemptCount(a), 2);
  const text = D.canonicalText(a, 'n');
  assert.match(text, /^tax-free at launch: the deployer and 1 other$/m);
  assert.equal(text.split('\n').filter((l) => l.startsWith('  0x')).length, 1);
  assert.deepEqual(D.othersThanDeployer(a.deployer, a.exemptList), [OTHER.toLowerCase()]);
});

test('an empty answer is not "no exemptions"', () => {
  const r = drive([DEPLOYER_001, '5', '   ']);
  assert.equal(last(r).state, 'rejected', 'a blank message declared something about the launch');
});

test('a blank or odd dev buy is not zero percent', () => {
  for (const bad of ['', '  ', '0x10', '1e3', 'none', '-1', '101']) {
    const r = drive([DEPLOYER_001, bad]);
    assert.equal(last(r).state, 'rejected', `"${bad}" became a declared dev buy`);
  }
  // And the ordinary forms still work.
  for (const [typed, want] of [['5', 5], ['5%', 5], ['2.5', 2.5], ['0', 0]]) {
    const r = drive([DEPLOYER_001, typed]);
    assert.equal(last(r).state, 'asked', typed);
    assert.equal(D.STEPS[1].parse(typed).value, want);
  }
});

// -------------------------------------------- 4. the declared line on a card

test('a declared line is cut at a word, not mid sentence, and is marked as cut', () => {
  const line = 'declared: the room: 50 seats, 10% of creator fees, 80% to the build: development';
  const cut = clampWords(line, D.MAX_DECLARED_LINE);
  assert.ok(cut.length <= D.MAX_DECLARED_LINE, `${cut.length} characters`);
  assert.match(cut, / …$/, 'the cut is not marked');
  assert.ok(!/[,;:.]\s*…$/.test(cut), `the punctuation the cut landed on was kept: ${cut}`);
  // The last thing kept is a whole word from the original.
  const kept = cut.slice(0, -2).trim();
  assert.ok(line.startsWith(kept), kept);
  assert.ok(/\S$/.test(kept));
});

test('a line that fits is untouched, and a single long word is still cut', () => {
  assert.equal(clampWords('declared: 400 bps', D.MAX_DECLARED_LINE), 'declared: 400 bps');
  const solid = 'x'.repeat(200);
  const cut = clampWords(solid, 20);
  assert.ok(cut.length <= 20 && cut.endsWith(' …'));
  assert.ok(cut.startsWith('xxxx'));
});

// ---------------------------------------------------------- 6. the nonce

test('the nonce is from the system generator, not from Math.random', () => {
  const seen = new Set();
  const original = Math.random;
  // If the nonce came from Math.random this would produce the same one every
  // time, which is the whole point: it is the replay guard.
  Math.random = () => 0.5;
  try {
    for (let i = 0; i < 200; i++) {
      D.startDraft(9000 + i, NOW);
      const row = db.prepare('SELECT nonce FROM declare_drafts WHERE user_id = ?').get(9000 + i);
      seen.add(row.nonce);
      assert.match(row.nonce, /^[0-9a-f]{16}$/, row.nonce);
    }
  } finally {
    Math.random = original;
  }
  assert.equal(seen.size, 200, 'two drafts share a nonce');
});

// ------------------------------------------------- 7. the pre-sign review

test('the review is one message when it fits, and that message is unchanged', () => {
  const canonical = 'vitals declaration\ndeployer: x\nnonce: n';
  const parts = D.signPrompt(canonical, 'abc');
  assert.equal(parts.length, 1);
  assert.ok(parts[0].startsWith('sign this exact text with the deployer wallet:'));
  assert.ok(parts[0].includes(canonical));
  assert.match(parts[0], /then send: \/declare sign <signature>$/);
});

test('a review over the limit goes out in parts, with every character of the text in them', () => {
  const canonical = Array.from({ length: 400 }, (_, i) => `line ${i} ${'y'.repeat(30)}`).join('\n');
  assert.ok(canonical.length > TELEGRAM_MAX_MESSAGE);
  const parts = D.signPrompt(canonical, null);
  assert.ok(parts.length > 3, 'the text was not split');
  for (const p of parts) assert.ok(p.length <= TELEGRAM_MAX_MESSAGE, `${p.length} characters`);

  // The middle parts are the text itself, and joining them gives it back. Not
  // "most of it": a declaration one ellipsis short of what the wallet signs is
  // worse than one that took two messages.
  const body = parts.slice(1, -1).join('\n');
  assert.equal(body, canonical);
  assert.ok(!parts.join('\n').includes('…'), 'something was clamped');
  assert.match(parts[0], /follows in \d+ parts/);
  assert.match(parts[parts.length - 1], /then send: \/declare sign <signature>$/);
});

test('splitting verbatim never drops a line and never drops a character', () => {
  const text = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n');
  assert.deepEqual(splitVerbatim(text, 10_000), [text]);
  const parts = splitVerbatim(text, 40);
  assert.equal(parts.join('\n'), text);
  for (const p of parts) assert.ok(p.length <= 40);
  // A single line with nowhere to break is cut into pieces, not truncated.
  const solid = 'z'.repeat(250);
  assert.equal(splitVerbatim(solid, 100).join(''), solid);
});

// ------------------------------- the form and the page are the same text

/**
 * The one test that proves the two paths converge.
 *
 * docs/template-declaration.md is the document that gets built into
 * site/declared/001.html, whose sha256 is signed. The form is the other way to
 * the same text. If they can drift, one of them is wrong at the moment of
 * signing and nothing else in this file would catch it.
 */
const TEMPLATE = readFileSync('docs/template-declaration.md', 'utf8');
const fenced = (n) => (TEMPLATE.split('\n```\n')[n * 2 - 1] ?? '').replace(/^```\w*\n?/, '').trim();

const ROOM_001 =
  "the room: 50 seats. the room is owed 10% of the fee wallet's cumulative gross income, "
  + 'paid daily in ETH for 30 days by shares (T1 5, T2 2, T3 1), every payout printed before '
  + 'it leaves and recorded with its hash. a seat is given by the deployer, its tier is fixed '
  + 'when taken and reviewed once after the 30 days. a seat given up is reused and both '
  + 'occupants stay in the history. 10% of gross income goes to ecosystem integrations, '
  + '80% to the build.';

const HOLDER_001 =
  'holder fee share is off at launch. the token is access, not yield: 250k = watch, 1M = the holder feed, 10M = desk.\n'
  + 'nothing changes in the first 10 days. the room reviews it with holders on 5 oct. any change is announced 7 days ahead.';

const ANSWERS_001 = [
  DEPLOYER_001,
  '5',
  'dev wallet only',
  '400, 10% the room, 10% ecosystem, 80% the build, treasury rules as declared',
  'held by the deployer wallet, 2% team and 3% partnerships, vesting contracts in october, '
    + 'nothing distributed at launch',
  ROOM_001,
  HOLDER_001,
  'https://checkvitals.xyz/declared/001',
];

/** Only these two lines may differ: one is issued per draft, one is a hash. */
const ISSUED = (l) => l.startsWith('nonce:') || l.startsWith('docs sha256:');

test('the eight answers for DECLARED #001 produce the template, line for line', () => {
  const r = drive(ANSWERS_001);
  const done = last(r);
  assert.equal(done.state, 'complete', JSON.stringify(done).slice(0, 300));

  const wanted = fenced(1).split('\n').filter((l) => !ISSUED(l));
  const got = done.canonical.split('\n').filter((l) => !ISSUED(l));

  // Line by line first, so a failure names the line rather than the page.
  for (let i = 0; i < Math.max(wanted.length, got.length); i++) {
    assert.equal(got[i], wanted[i], `line ${i + 1} of the signed text differs from the template`);
  }
  assert.equal(got.join('\n'), wanted.join('\n'));
});

test('the nonce line is the only issued line, and it is present', () => {
  const done = last(drive(ANSWERS_001, { nonce: 'aabbccddeeff0011' }));
  const lines = done.canonical.split('\n');
  assert.equal(lines[lines.length - 1], 'nonce: aabbccddeeff0011');
  assert.equal(lines.filter(ISSUED).length, 1, 'the unpinned form has a docs sha256 line');
  // And the template's own placeholder is on the line this one replaces.
  const tmpl = fenced(1).split('\n');
  assert.match(tmpl[tmpl.length - 1], /^nonce: /);
});

test('the docs sha256 is the second and last line allowed to differ', async () => {
  const { user } = drive(ANSWERS_001);
  const body = '<!doctype html><title>001</title>';
  const pinned = await D.pinDocsHash(user, async () => ({
    ok: true, status: 200, bytes: new Uint8Array(Buffer.from(body, 'utf8')),
  }));
  const got = pinned.canonical.split('\n').filter((l) => !ISSUED(l));
  assert.equal(got.join('\n'), fenced(1).split('\n').filter((l) => !ISSUED(l)).join('\n'));
  assert.ok(pinned.canonical.includes(`docs sha256: ${D.sha256Hex(body)}`));
});

test('the deployer is signed the way the page prints it, checksummed', () => {
  // The page is byte frozen and its hash is signed. An address written one way
  // there and another way in the text the wallet signs is exactly the drift
  // this pair of tests exists to refuse.
  const done = last(drive(ANSWERS_001));
  assert.match(done.canonical, new RegExp(`^deployer: ${DEPLOYER_001}$`, 'm'));
  // Typed in lowercase, signed checksummed: one address, one rendering.
  const lower = last(drive([DEPLOYER_001.toLowerCase(), ...ANSWERS_001.slice(1)]));
  assert.equal(lower.canonical, done.canonical);
});

test('the review of DECLARED #001 is one message, so nothing about it is split', () => {
  const done = last(drive(ANSWERS_001));
  assert.equal(D.signPrompt(done.canonical, 'a'.repeat(64)).length, 1);
});

test('nothing in the produced text is a phrase the form supplied', () => {
  const done = last(drive(ANSWERS_001));
  assert.ok(!done.canonical.includes('not stated'));
  assert.ok(!done.canonical.includes(EM_DASH));
  assert.ok(!done.canonical.includes('['), done.canonical);
});
