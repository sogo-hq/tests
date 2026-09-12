/**
 * The group card.
 *
 * One structural rule, tested from several sides: the findings never move below
 * the market block. Every card of this shape in every other tool leads with
 * price and puts the risk underneath, and the ordering is the product.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('groupcard');
const G = await import('../dist/groupcard.js');
const M = await import('../dist/metrics/market.js');
const B = await import('../dist/buylinks.js');
const { recordFirstCall } = await import('../dist/firstcall.js');
const { db } = await import('../dist/db.js');
const { makeScan } = await import('./fixtures.mjs');

const TOKEN = '0x147bbaa458ab7cd11e1e478b87f08fe5a42a9e67';
const CURVE = '0x0000000000000000000000000000000000000002';
const CHAT = -1001;
const NOW = 1_789_000_000_000;

const f = (key, plain, severity, state = 'raised') =>
  ({ key, label: key, state, detail: `${key} technical`, compactDetail: key, plain, severity });

const FINDINGS = [
  f('snipe_exemptions', '5 wallets tax-free at launch, 1 of them the deployer, together 22.3% of supply', 922),
  f('creator_open_buy', 'creator opened with 4.9% of supply · index median 0.5%', 805),
  f('creator_tax', 'creator takes 8% per trade · index median 1%', 728),
  f('collision', '60 of 1,504 indexed launches use this ticker', 360),
  f('custom_pair', 'priced in RDDT, not ETH', 200),
  f('walk', 'holder transfers could not be read', 130, 'unknown'),
];

const MARKET = {
  mcapQuote: 1.68, athQuote: 5.4, athMinutes: 42, liquidityQuote: 0.9,
  vol5m: 0.12, vol1h: 3.4,
  trades: 180, complete: true,
};

const scan = (over = {}) => makeScan({
  buyers: 412, flags: FINDINGS, benchmarkMedian: 12, benchmarkN: 1837,
  mcapInQuote: 1.68, ...over,
});

const card = (over = {}, opts = {}) =>
  G.renderGroupCard(scan(over), { chatId: CHAT, botUsername: 'vitalscheck_bot', market: MARKET, now: NOW, ...opts });

// --------------------------------------------------------------- the order

test('the findings sit above the market block, always', () => {
  const lines = card().text.split('\n');
  const firstFinding = lines.findIndex((l) => l.includes('🚩'));
  const firstMarket = lines.findIndex((l) => l.startsWith('ath ') || l.startsWith('vol '));
  assert.ok(firstFinding > 0, 'no finding on the card');
  assert.ok(firstMarket > 0, 'no market block on the card');
  assert.ok(firstFinding < firstMarket,
    `the market block led the card: findings at ${firstFinding}, market at ${firstMarket}`);
});

test('and above it even when there are no findings to show', () => {
  const lines = card({ flags: [f('walk', 'holder transfers could not be read', 130, 'unknown')] }).text.split('\n');
  const undet = lines.findIndex((l) => l.includes('undetermined'));
  const firstMarket = lines.findIndex((l) => l.startsWith('ath ') || l.startsWith('vol '));
  assert.ok(undet > 0 && undet < firstMarket);
});

test('nothing raised is never reported as clean', () => {
  const text = card({ flags: [] }).text;
  assert.match(text, /no finding raised\. that is not the same as clean/);
  for (const banned of [/\bsafe\b/i, /\blooks good\b/i, /\ball clear\b/i]) {
    assert.doesNotMatch(text, banned);
  }
});

// ---------------------------------------------------------------- the shape

test('at most three findings, then a count', () => {
  const lines = card().text.split('\n');
  assert.equal(lines.filter((l) => l.includes('🚩')).length, 3);
  // Five raised in the fixture, three shown.
  assert.ok(lines.some((l) => l === '+2 more, /full'));
});

test('the card fits in eighteen lines, findings and all', () => {
  for (const [name, over] of [
    ['a launch with everything', {}],
    ['pre-graduation', { phaseName: 'NotGraduated', progressPct: 42.5 }],
    ['graduated', { phaseName: 'Swept', sweptAt: 1_700_000_000, launchedAt: 1_700_000_000, ageSeconds: 20_000 }],
    ['no findings', { flags: [] }],
    ['no traction window yet', { windowIndexed: false }],
  ]) {
    const lines = card(over).text.split('\n');
    assert.ok(lines.length <= G.MAX_GROUP_LINES,
      `${name}: ${lines.length} lines\n${lines.join('\n')}`);
    // And the findings survived the clamp.
    if (over.flags === undefined) {
      assert.ok(lines.some((l) => l.includes('🚩')), `${name}: the clamp ate the findings`);
    }
  }
});

test('the clamp cuts from the bottom and keeps the footer', () => {
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  many.push('no finding is not clean. /full. add to your group');
  const out = G.clampLines(many, 5);
  assert.equal(out.length, 5);
  assert.equal(out[0], 'line 0', 'the top of the card was cut');
  assert.match(out[out.length - 1], /^no finding is not clean/);
});

// --------------------------------------------------------- the market block

test('the state line carries the live graduation threshold', () => {
  const text = card({
    phaseName: 'NotGraduated', progressPct: 42.5,
    realQuoteReserve: 1_785_000_000_000_000_000n,
    graduationThreshold: 4_200_000_000_000_000_000n,
  }).text;
  assert.match(text, /on the curve 42\.5% \(1\.78 of 4\.2 ETH\)/);
});

test('a graduated launch says how long ago', () => {
  const text = card({
    phaseName: 'Swept', launchedAt: 1_700_000_000, sweptAt: 1_700_003_600, ageSeconds: 14_400,
  }).text;
  assert.match(text, /graduated 3h ago/);
});

test('the market block states both windows as quantities', () => {
  const text = card().text;
  assert.match(text, /ath 5\.4 ETH at \+42 min · liquidity 0\.9 ETH/);
  assert.match(text, /vol 5m 0\.12 · 1h 3\.4 ETH · 180 trades/);
});

test('a partial window says it is partial', () => {
  const text = card({}, { market: { ...MARKET, complete: false } }).text;
  assert.match(text, /\(partial\)/);
});

test('no market block at all still produces a card', () => {
  // This is the edit-in path: the findings go out first and the market block
  // arrives later. A card without it must still be a card.
  const c = card({}, { market: null });
  assert.equal(c.hasMarket, false);
  assert.ok(c.text.includes('🚩'));
  assert.ok(!c.text.includes('vol 5m'));
  assert.ok(c.text.split('\n').length <= G.MAX_GROUP_LINES);
});

// ----------------------------------------------------------------- the rows

test('the address is alone on its own line, in monospace', () => {
  const line = card().text.split('\n').find((l) => l.startsWith('<code>'));
  assert.equal(line, `<code>${TOKEN}</code>`);
});

test('a buy link is omitted unless its format has been supplied', () => {
  B.resetBuyLinkWarnings();
  for (const k of ['BUY_LINK_MAESTRO', 'BUY_LINK_BANANA', 'BUY_LINK_BASED', 'REF_MAESTRO']) delete process.env[k];
  let row = card().text.split('\n').find((l) => l.includes('explorer'));
  assert.ok(!/>MAE</.test(row), 'a link was guessed');
  assert.match(row, /explorer/, 'the explorer is the one host this bot resolves itself');

  // Supplied and complete: it renders, with the address and the referral code.
  process.env.BUY_LINK_MAESTRO = 'https://t.me/maestro?start={address}-{ref}';
  process.env.REF_MAESTRO = 'vitals';
  B.resetBuyLinkWarnings();
  row = card().text.split('\n').find((l) => l.includes('explorer'));
  assert.match(row, />MAE</);
  assert.ok(row.includes(TOKEN), 'the buy link does not carry the address');
  assert.ok(row.includes('vitals'), 'the buy link does not carry the referral code');

  // Supplied but missing its referral code: omitted rather than rendered with
  // the placeholder still in it, which would be a broken link to a real bot.
  delete process.env.REF_MAESTRO;
  B.resetBuyLinkWarnings();
  row = card().text.split('\n').find((l) => l.includes('explorer'));
  assert.ok(!/>MAE</.test(row));
  delete process.env.BUY_LINK_MAESTRO;
});

test('socials come from the token info, and only the ones that are set', () => {
  const text = card({ reads: { socials: { twitter: 'https://x.com/a', website: 'https://a.example' } } }).text;
  assert.match(text, /<a href="https:\/\/x\.com\/a">X<\/a>/);
  assert.match(text, /<a href="https:\/\/a\.example">web<\/a>/);
  assert.ok(!text.includes('>TG<'), 'a social nobody set was invented');
});

// ------------------------------------------------------------- first caller

test('the first-call line names who and at what, in the quote asset', () => {
  recordFirstCall({
    chatId: CHAT, token: TOKEN, userId: 11, username: 'alice',
    mcapQuote: 0.067, blockNumber: 500, now: NOW - 7_200_000,
  });
  const text = card().text;
  assert.match(text, /first called here by @alice 2h ago at 0\.067 ETH/);
  // Never a profit, and never in dollars.
  assert.ok(!/\$/.test(text.replace(/\$[A-Z]/g, '')), 'a dollar figure appeared');
});

test('there is no first-call line in a DM', () => {
  const text = G.renderGroupCard(scan(), { botUsername: 'vitalscheck_bot', market: MARKET, now: NOW }).text;
  assert.ok(!text.includes('first called here'));
});

// --------------------------------------------------------------- the footer

test('the footer carries the add-to-group link and the doctrine', () => {
  const text = card().text;
  assert.match(text, /no finding is not clean\. \/full\./);
  assert.match(text, /https:\/\/t\.me\/vitalscheck_bot\?startgroup=true/);
});

test('four buttons, refresh first', () => {
  const b = card().buttons[0];
  assert.deepEqual(b.map((x) => x.text), ['Refresh', 'Holders', 'Full', 'Image']);
  for (const x of b) assert.ok(x.callback_data.endsWith(TOKEN));
});

// ---------------------------------------------------- the market on a budget

test('the market block is what waits, never the findings', () => {
  // The edit-in path renders the same card twice: once without the block and
  // once with it. Both are cards, both carry the findings, and the second is
  // what the first is edited into.
  const without = card({}, { market: null });
  const with_ = card();

  for (const c of [without, with_]) {
    assert.ok(c.text.includes('🚩'), 'a card went out without its findings');
    assert.ok(c.text.split('\n').length <= G.MAX_GROUP_LINES);
  }
  assert.equal(without.hasMarket, false);
  assert.equal(with_.hasMarket, true);

  // The findings are identical between the two: the edit adds lines, it never
  // rewrites what was already read.
  const findings = (t) => t.split('\n').filter((l) => l.includes('🚩'));
  assert.deepEqual(findings(without.text), findings(with_.text));

  // And the block that arrives is additive.
  assert.ok(with_.text.split('\n').length > without.text.split('\n').length);
});

test('the budget is a clock, not a data check', () => {
  // Stated as a constant so it cannot quietly become "however long the read
  // takes": past this, the card goes out without the block.
  assert.equal(M.MARKET_BUDGET_MS, 1500);
  assert.equal(M.MARKET_CACHE_MS, 30_000);
});

test('holder math leaves out the protocol, the curve and the token', async () => {
  const { holderBreakdown } = await import('../dist/metrics/concentration.js');
  const { NON_HOLDER_ADDRESSES } = await import('../dist/config.js');
  const whale = '0x' + 'a'.repeat(40);
  const small = '0x' + 'b'.repeat(40);
  const balances = {
    // Every protocol address holding more than either real holder. Counted,
    // each of these would be the largest wallet on every graduated launch.
    ...Object.fromEntries(NON_HOLDER_ADDRESSES.map((a) => [a, '900000'])),
    [CURVE]: '900000',
    [TOKEN]: '900000',
    [whale]: '600',
    [small]: '400',
  };
  db.prepare(
    `INSERT OR REPLACE INTO holder_snapshots (token, top5_share, holders, excess, measured_at, balances, read_to_block)
     VALUES (?, 0, 0, 0, 1, ?, 100)`,
  ).run(TOKEN, JSON.stringify(balances));

  const hb = holderBreakdown(TOKEN, CURVE);
  assert.equal(hb.holders, 2, 'a protocol contract was counted as a holder');
  assert.deepEqual(hb.top, [60, 40]);
  assert.equal(hb.top5, 100);
  assert.equal(hb.top10, 100);
});
