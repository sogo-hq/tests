/**
 * Declared launches.
 *
 * A creator states, before launching, what the launch will do, and signs it
 * with the wallet that will deploy. Everything here tests the same rule from a
 * different side: a declaration can only ever add a line to a card. It cannot
 * remove one, soften one, or stand in for one, and where the launch differs
 * from what was signed the difference is a finding of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('declare');
// Two free slots, so the founding window and the gate after it are both
// reachable inside one file.
process.env.DECLARE_FREE_UNTIL = '2';

const { privateKeyToAccount } = await import('viem/accounts');
const D = await import('../dist/declare.js');
const { db } = await import('../dist/db.js');
const { computeFlags } = await import('../dist/metrics/flags.js');
const { grant, revokeGrant } = await import('../dist/tiers.js');
const { recordIndexAdvance } = await import('../dist/indexer/health.js');

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(KEY);
const DEPLOYER = account.address.toLowerCase();
const OTHER = '0x' + '7'.repeat(40);
const NOW = 1_789_000_000_000;

const answers = (over = {}) => ({
  deployer: DEPLOYER, devBuyPct: 2.5, exemptList: [], creatorTaxBps: 400,
  taxSplit: 'half to the artist', vesting: 'held by the deployer, vesting contracts in october, nothing distributed at launch',
  room: '', holderFeeShare: '', docsUrl: 'https://docs.checkvitals.xyz', docsSha256: '', ...over,
});

/** Walk the six questions with the answers a real creator would type. */
function fillForm(userId, typed) {
  D.startDraft(userId, NOW, 'nonce123');
  const results = typed.map((t) => D.answerDraft(userId, t));
  return results[results.length - 1];
}

const GOOD = [
  DEPLOYER,
  '2.5',
  'dev wallet only',
  '400, half to the artist',
  'held by the deployer, vesting contracts in october, nothing distributed at launch',
  'skip',
  'skip',
  'https://docs.checkvitals.xyz',
];

// --------------------------------------------------------------- the form

test('the form asks six questions and refuses a bad answer without losing the place', () => {
  const u = 101;
  D.startDraft(u, NOW, 'nonce123');
  const bad = D.answerDraft(u, 'my wallet');
  assert.equal(bad.state, 'rejected');
  assert.equal(bad.step, 0, 'a rejected answer must not advance the form');

  const ok = D.answerDraft(u, DEPLOYER);
  assert.equal(ok.state, 'asked');
  assert.equal(ok.step, 1);

  const done = ['2.5', 'dev wallet only', '400, half to the artist',
    'held by the deployer, vesting contracts in october, nothing distributed at launch',
    'skip', 'skip', 'https://docs.checkvitals.xyz'].map((t) => D.answerDraft(u, t)).pop();
  assert.equal(done.state, 'complete');
  assert.equal(D.STEPS.length, 8);
  D.clearDraft(u);
});

test('"dev wallet only" is one exempt wallet, not zero', () => {
  // The curve exempts the deployer automatically, so a declaration that names
  // nobody is still a declaration of one. Counted as zero it would contradict
  // every launch that behaved exactly as declared.
  assert.equal(D.declaredExemptCount(answers({ exemptList: [] })), 1);
  assert.equal(D.declaredExemptCount(answers({ exemptList: [OTHER] })), 2);
});

test('free text is bounded and carries no em dash', () => {
  const u = 102;
  D.startDraft(u, NOW, 'n');
  D.answerDraft(u, DEPLOYER);
  D.answerDraft(u, '2.5');
  D.answerDraft(u, 'dev wallet only');
  const long = D.answerDraft(u, `400, ${'x'.repeat(200)}`);
  assert.equal(long.state, 'rejected');
  D.answerDraft(u, '400, half to the artist');
  const dash = D.answerDraft(u, `held by the deployer ${String.fromCharCode(0x2014)} vesting in october`);
  assert.equal(dash.state, 'asked');
  D.answerDraft(u, 'skip');
  D.answerDraft(u, 'skip');
  const complete = D.answerDraft(u, 'https://docs.checkvitals.xyz');
  assert.ok(!complete.canonical.includes(String.fromCharCode(0x2014)));
  D.clearDraft(u);
});

// ---------------------------------------------------------- the signature

test('only the wallet that will deploy can sign the declaration', async () => {
  const u = 110;
  const done = fillForm(u, GOOD);
  assert.equal(done.state, 'complete');

  const wrong = privateKeyToAccount('0x' + '4'.repeat(63) + '1');
  const wrongSig = await wrong.signMessage({ message: done.canonical });
  const refused = await D.signDraft(u, wrongSig, { now: NOW, blockNumber: async () => 5000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'wrong-wallet');

  const nonsense = await D.signDraft(u, '0xnotasignature', { now: NOW, blockNumber: async () => 5000 });
  assert.equal(nonsense.reason, 'bad-signature');

  const sig = await account.signMessage({ message: done.canonical });
  const ok = await D.signDraft(u, sig, { now: NOW, blockNumber: async () => 5000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.declaration.deployer, DEPLOYER);
  assert.equal(ok.declaration.blockNumber, 5000);
  assert.equal(ok.declaration.exemptCount, 1);
  assert.equal(ok.declaration.canonical, done.canonical,
    'the bytes that were signed are kept, so the signature stays checkable');
  assert.ok(!D.draftOpen(u), 'a signed form is finished');
});

test('a signature for one declaration cannot be replayed for another', async () => {
  const u = 111;
  const first = fillForm(u, GOOD);
  const sig = await account.signMessage({ message: first.canonical });
  // Same answers, different nonce: the canonical text differs, so the old
  // signature recovers a different address and is refused.
  D.startDraft(u, NOW, 'a-different-nonce');
  GOOD.forEach((t) => D.answerDraft(u, t));
  const replayed = await D.signDraft(u, sig, { now: NOW, blockNumber: async () => 5001 });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.reason, 'wrong-wallet');
  D.clearDraft(u);
});

// --------------------------------------------------------- who may declare

test('the founding window is free, and says which number it was', async () => {
  assert.equal(D.DECLARE_FREE_UNTIL, 2);
  db.prepare('DELETE FROM launch_declarations').run();
  const before = D.declarationCount();
  const e = await D.entitlement(999, DEPLOYER, { now: NOW, balanceOf: async () => 0n });
  assert.equal(e.allowed, true);
  assert.equal(e.reason, 'free-window');
  assert.equal(e.freeSlot, before + 1);
});

test('after the window it takes premium, on the account or in the deployer wallet', async () => {
  // Fill the free window.
  while (D.declarationCount() < D.DECLARE_FREE_UNTIL) {
    const u = 200 + D.declarationCount();
    const done = fillForm(u, GOOD);
    const sig = await account.signMessage({ message: done.canonical });
    await D.signDraft(u, sig, { now: NOW, blockNumber: async () => 5000 });
  }

  const none = await D.entitlement(301, DEPLOYER, { now: NOW, balanceOf: async () => 0n });
  assert.equal(none.allowed, false);
  assert.equal(none.freeSlot, null, 'a paid declaration is not a founding one');

  // Paid: a grant on the Telegram account.
  grant(301, 'premium', 30, 'payment', NOW);
  const paid = await D.entitlement(301, DEPLOYER, { now: NOW, balanceOf: async () => 0n });
  assert.equal(paid.allowed, true);
  assert.equal(paid.reason, 'user-premium');
  revokeGrant(301);

  // Held: the deployer wallet itself holds enough.
  const held = await D.entitlement(301, DEPLOYER, { now: NOW, balanceOf: async () => 1_000_000n });
  assert.equal(held.allowed, true);
  assert.equal(held.reason, 'wallet-holds');

  // An unreadable balance is not zero, but it is not proof either.
  const unknown = await D.entitlement(301, DEPLOYER, { now: NOW, balanceOf: async () => null });
  assert.equal(unknown.allowed, false);
});

test('an unentitled signature stores nothing', async () => {
  const u = 310;
  const done = fillForm(u, GOOD);
  const sig = await account.signMessage({ message: done.canonical });
  const before = D.declarationCount();
  const res = await D.signDraft(u, sig, {
    now: NOW, blockNumber: async () => 5000, balanceOf: async () => 0n,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-entitled');
  assert.equal(D.declarationCount(), before);
  D.clearDraft(u);
});

// ------------------------------------------------------- against the chain

const TOKEN = '0x' + '11'.repeat(20);
const PAIR = '0x' + 'e'.repeat(40);
const LAUNCH_BLOCK = 900_000;

const insertLaunch = db.prepare(
  `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
     graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key,
     symbol_key, snipe_exemption_count, exemption_source, creator_tax_bps,
     exempt_open_pct, creator_open_pct)
   VALUES (?,?,?,?,1,'1',?,?,?,?,?,?,?,?,'logs',?,?,?)`,
);

// A populated index: 100 bps median tax, 0.5% median opening buy.
for (let i = 0; i < 1500; i++) {
  const a = '0x' + i.toString(16).padStart(40, '0');
  insertLaunch.run(a, '0x' + 'c'.repeat(40), a, PAIR, 1000 + i,
    '0x' + i.toString(16).padStart(64, '0'), 1_780_000_000, 'n' + i, 's' + i, 'n' + i, 's' + i,
    1, 100, 0.5, 0.5);
}
recordIndexAdvance(1n);

const declare = db.prepare(
  `INSERT INTO launch_declarations (deployer, declared_by, declared_at, block_number,
     dev_buy_pct, exempt_list, exempt_count, creator_tax_bps, tax_split, vesting,
     docs_url, canonical, signature, free_slot)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);

/**
 * One launch, one declaration, and the flags that come out of the pair.
 *
 * `launch` is what the chain shows, `declared` is what was signed, and `at` is
 * the block the declaration arrived at.
 */
function flagsWith(launch = {}, declared = {}, at = LAUNCH_BLOCK - 1) {
  const L = { exemptCount: 1, taxBps: 100, openPct: 0.5, ...launch };
  const C = { devBuyPct: 0.5, exemptCount: 1, taxBps: 100, vesting: 'held by the deployer, vesting contracts in october, nothing distributed at launch', room: '', holderFeeShare: '', docsSha256: '', ...declared };
  db.prepare('DELETE FROM launch_declarations').run();
  insertLaunch.run(TOKEN, '0x' + 'c'.repeat(40), DEPLOYER, PAIR, LAUNCH_BLOCK,
    '0x' + 'f'.repeat(64), 1_780_000_000, 'NEW', 'UNIQ', 'new', 'uniq',
    L.exemptCount, L.taxBps, 5, L.openPct);
  declare.run(DEPLOYER, 7, 1_789_000_000, at, C.devBuyPct, '[]', C.exemptCount, C.taxBps,
    'half to the artist', C.vesting, 'https://docs.checkvitals.xyz', 'canonical', '0xsig', 1);
  return computeFlags({
    token: TOKEN, deployer: DEPLOYER, name: 'NEW', symbol: 'UNIQ',
    creatorTaxBps: L.taxBps, buybackEnabled: false,
    pairToken: PAIR, pairSymbol: 'ETH', scannedAt: 1_780_003_600,
  });
}

const byKey = (r, k) => r.flags.find((f) => f.key === k);

test('a declaration made before the launch block attaches, one made after does not', () => {
  const before = flagsWith({}, {}, LAUNCH_BLOCK - 1);
  assert.ok(before.declaration, 'a statement made before the launch is a declaration');
  assert.ok(byKey(before, 'snipe_exemptions').declared);

  const after = flagsWith({}, {}, LAUNCH_BLOCK + 1);
  assert.equal(after.declaration, null,
    'a statement made after the launch is a description, and earns nothing');
  assert.ok(!byKey(after, 'snipe_exemptions').declared);
  assert.ok(!byKey(after, 'declaration_mismatch'));
});

test('a launch that matches its declaration raises nothing for it', () => {
  const r = flagsWith();
  const m = byKey(r, 'declaration_mismatch');
  assert.equal(m.state, 'clean');
  assert.equal(m.severity, 0);
});

test('each contradiction is its own finding, and names both numbers', () => {
  const exempt = byKey(flagsWith({ exemptCount: 3 }, { exemptCount: 1 }), 'declaration_mismatch');
  assert.equal(exempt.state, 'raised');
  assert.equal(exempt.plain, 'launch differs from declaration: 3 exempt wallets, declared 1');

  const buy = byKey(flagsWith({ openPct: 8 }, { devBuyPct: 1 }), 'declaration_mismatch');
  assert.equal(buy.state, 'raised');
  assert.match(buy.plain, /dev buy 8\.0%, declared 1%/);

  const tax = byKey(flagsWith({ taxBps: 900 }, { taxBps: 400 }), 'declaration_mismatch');
  assert.equal(tax.state, 'raised');
  assert.match(tax.plain, /creator tax 900 bps, declared 400/);

  // All three at once: one finding, every difference in the technical detail.
  const all = byKey(flagsWith({ exemptCount: 4, openPct: 9, taxBps: 900 },
    { exemptCount: 1, devBuyPct: 1, taxBps: 400 }), 'declaration_mismatch');
  assert.match(all.detail, /4 exempt wallets, declared 1/);
  assert.match(all.detail, /dev buy 9\.0%, declared 1%/);
  assert.match(all.detail, /creator tax 900 bps, declared 400/);
});

test('a dev buy a shade under what was declared is not a contradiction', () => {
  // A plan against a measurement. Half a percentage point, and only upward:
  // taking less than you announced is not what anyone is worried about.
  assert.equal(byKey(flagsWith({ openPct: 1.3 }, { devBuyPct: 1 }), 'declaration_mismatch').state, 'clean');
  assert.equal(byKey(flagsWith({ openPct: 0.1 }, { devBuyPct: 5 }), 'declaration_mismatch').state, 'clean');
  assert.equal(byKey(flagsWith({ openPct: 1.6 }, { devBuyPct: 1 }), 'declaration_mismatch').state, 'raised');
});

test('a contradiction leads the card, and never replaces what it contradicts', () => {
  const r = flagsWith({ exemptCount: 6, openPct: 0.5 }, { exemptCount: 1 });
  assert.equal(r.worst.key, 'declaration_mismatch');
  const ex = byKey(r, 'snipe_exemptions');
  assert.equal(ex.state, 'raised', 'the exemption finding still stands');
  assert.match(ex.plain, /^6 wallets tax-free at launch/);
});

test('the declared lines fit the card', () => {
  const r = flagsWith({ exemptCount: 3, taxBps: 900, openPct: 4 },
    { exemptCount: 2, taxBps: 400, devBuyPct: 1,
      vesting: 'the team holds five percent of supply and it vests over twelve whole months' });
  const lines = [
    byKey(r, 'snipe_exemptions').declared,
    byKey(r, 'creator_open_buy').declared,
    byKey(r, 'creator_tax').declared,
    r.buyback.declared,
  ];
  for (const line of lines) {
    assert.ok(line, 'every declared check gets its line');
    assert.ok(line.startsWith('declared:'), `"${line}"`);
    assert.ok(line.length <= D.MAX_DECLARED_LINE, `${line.length} chars: "${line}"`);
  }
});

test('$VITALS declaring its own 4% tax does not remove the 4% tax flag', () => {
  // The whole feature in one assertion. The bot's own token declares a creator
  // tax four times the index median, exactly as it charges it, and the card
  // still carries the finding. A declaration that could quiet a check would be
  // worth buying, and this one is worth nothing except to a creator who
  // intends to keep to it.
  const r = flagsWith({ taxBps: 400, exemptCount: 1, openPct: 0.5 },
    { taxBps: 400, exemptCount: 1, devBuyPct: 0.5 });
  const tax = byKey(r, 'creator_tax');
  assert.equal(tax.state, 'raised', 'declaring a tax does not unflag it');
  assert.match(tax.plain, /creator takes 4% per trade/);
  assert.match(tax.plain, /index median 1%/);
  assert.equal(tax.declared, 'declared: 400 bps, half to the artist');
  // And declaring it honestly raises nothing extra.
  assert.equal(byKey(r, 'declaration_mismatch').state, 'clean');
});

// ------------------------------------------------------------- the listing

test('/declared lists them newest first, with what the launch did', () => {
  db.prepare('DELETE FROM launch_declarations').run();
  db.prepare('DELETE FROM launches WHERE deployer = ?').run(DEPLOYER);
  declare.run(DEPLOYER, 7, 1_789_000_000, 100, 1, '[]', 1, 100, 'x', 'y',
    'https://docs.checkvitals.xyz', 'c', '0xsig', 1);
  declare.run(OTHER, 8, 1_789_000_100, 200, 2, '[]', 1, 100, 'x', 'y',
    'https://docs.checkvitals.xyz', 'c', '0xsig', 2);

  const list = D.recentDeclarations(10);
  assert.equal(list.length, 2);
  assert.equal(list[0].deployer, OTHER, 'newest first');

  // Nothing launched yet, and that is said as the absence it is.
  assert.match(D.declarationOutcome(list[0]), /no launch from this wallet yet/);

  // A launch after the declaration, rechecked at +24h.
  insertLaunch.run(TOKEN, '0x' + 'c'.repeat(40), DEPLOYER, PAIR, 150,
    '0x' + 'f'.repeat(64), 1_780_000_000, 'NEW', 'UNIQ', 'new', 'uniq', 1, 100, 0.5, 0.5);
  const own = list.find((d) => d.deployer === DEPLOYER);
  assert.match(D.declarationOutcome(own), /not yet rechecked at \+24h/);

  const scanId = db.prepare(
    `INSERT INTO scans (token, curve, deployer, scanned_at, scanned_block) VALUES (?,?,?,?,1)`,
  ).run(TOKEN, '0x' + 'c'.repeat(40), DEPLOYER, 1_780_000_000).lastInsertRowid;
  db.prepare(
    `INSERT INTO rechecks (scan_id, token, offset_hours, due_at, completed_at, still_trading)
     VALUES (?,?,24,?,?,1)`,
  ).run(scanId, TOKEN, 1_780_086_400, 1_780_086_400);
  assert.match(D.declarationOutcome(own), /still trading at \+24h/);
});

test('the permalink is a deep link until the site route exists', () => {
  delete process.env.SITE_DECLARATION_BASE;
  assert.equal(D.declarationLink(12, 'vitalscheck_bot'), 'https://t.me/vitalscheck_bot?start=d12');
  process.env.SITE_DECLARATION_BASE = 'https://checkvitals.xyz/d';
  assert.equal(D.declarationLink(12, 'vitalscheck_bot'), 'https://checkvitals.xyz/d/12');
  delete process.env.SITE_DECLARATION_BASE;
});

// ------------------------------------------- the dev buy IS the allocation

/** Walk to the vesting question and answer it. */
const vestingAnswer = (u, devBuy, answer) => {
  D.clearDraft(u);
  D.startDraft(u, NOW, 'n');
  D.answerDraft(u, DEPLOYER);
  D.answerDraft(u, devBuy);
  D.answerDraft(u, 'dev wallet only');
  D.answerDraft(u, '400, half to the artist');
  const r = D.answerDraft(u, answer);
  D.clearDraft(u);
  return r;
};

test('"none" is refused beside a dev buy, and the refusal says why', () => {
  const r = vestingAnswer(401, '5', 'no team allocation');
  assert.equal(r.state, 'rejected');
  assert.match(r.error, /you declared a dev buy of 5% of supply, and that is the team allocation/);
  assert.match(r.error, /say where those tokens sit/);
});

test('every obvious way of saying none is refused', () => {
  for (const answer of ['none', 'None.', 'nothing', 'no team tokens', 'n/a', 'zero', '0', 'nil', 'no allocation']) {
    assert.equal(vestingAnswer(402, '2.5', answer).state, 'rejected', answer);
  }
});

test('a declarer who bought nothing may still say there is nothing', () => {
  // The line is only false when there IS a dev buy. A creator who took none
  // is telling the truth and the form must not argue with them.
  const r = vestingAnswer(403, '0', 'no team allocation');
  assert.equal(r.state, 'asked');
});

test('an honest answer passes and lands on the dev buy line', () => {
  const u = 404;
  const done = fillForm(u, GOOD);
  assert.equal(done.state, 'complete');
  assert.match(done.canonical,
    /^dev buy: 2\.5% of supply, held by the deployer, vesting contracts in october, nothing distributed at launch$/m);
  D.clearDraft(u);
});

test('there is no team tokens line left to sign', () => {
  const text = D.canonicalText(answers(), 'n');
  assert.doesNotMatch(text, /^team tokens:/m);
  // And exactly one dev buy line, not two.
  assert.equal((text.match(/^dev buy: /gm) ?? []).length, 1);
});

test('the prompt says a dev buy is a team allocation', () => {
  const step = D.STEPS.find((s) => s.key === 'vesting');
  assert.match(step.prompt, /a dev buy is a team allocation/);
  assert.doesNotMatch(step.prompt, /if there are none, say/);
});

test('the canonical text still carries every other field once', () => {
  const text = D.canonicalText(answers(), 'nonce123');
  for (const re of [/^deployer: /m, /^tax-free at launch: /m, /^creator tax: /m, /^tax split: /m, /^docs: /m, /^nonce: /m]) {
    assert.equal((text.match(new RegExp(re.source, 'gm')) ?? []).length, 1, String(re));
  }
  assert.ok(!text.includes(String.fromCharCode(0x2014)));
});
