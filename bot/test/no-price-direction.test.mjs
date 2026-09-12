/**
 * No card states which way the price went.
 *
 * The rule, from the product owner: quantities of activity are evidence, price
 * direction is a trading signal, and the moment a card shows direction it stops
 * being the thing no other bot does and becomes a worse version of all of them.
 *
 * The hard part is that percentages are not the enemy. A card is FULL of them
 * and every one has to survive: share of supply, holder concentration, creator
 * tax, curve progress, an index median. So this does not ban "%", it bans the
 * two shapes a price direction actually takes:
 *
 *   a SIGNED percentage      +12.5%   -8.3%
 *   a percentage tied to a window   12.5% 5m   -8% over 1h   +3% 24h
 *
 * and the words and arrows that say the same thing without a number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('nopricedir');
const { db } = await import('../dist/db.js');
const C = await import('../dist/card.js');
const G = await import('../dist/groupcard.js');
const I = await import('../dist/image.js');
const F = await import('../dist/firstcall.js');
const { resetSponsor } = await import('../dist/sponsor.js');
const { makeScan } = await import('./fixtures.mjs');

const TOKEN = '0x147bbaa458ab7cd11e1e478b87f08fe5a42a9e67';
const CURVE = '0x0000000000000000000000000000000000000002';
const CHAT = -1001;
const NOW = 1_789_000_000_000;
const AT = new Date(Date.UTC(2026, 8, 12, 14, 32));

/**
 * A signed percentage. The sign is the tell: a share of supply is never "+22%",
 * it is "22%", and nothing on a card legitimately needs to say which way a
 * number moved.
 */
const SIGNED_PCT = /[+−-]\s?\d+(\.\d+)?\s?%/;

/**
 * A percentage sitting next to a time window, in either order. This is the
 * shape the removed line had: "+12.5% 5m", "-8% over 1h".
 */
const WINDOWED_PCT = /\d+(\.\d+)?\s?%\s*(over\s+)?\d*\s*(s|m|h|d|min|hour|hr|day)\b|\b\d+\s*(m|h|d|min|hour|hr|day)\s+[+−-]?\d+(\.\d+)?\s?%/i;

/** The words and glyphs that say a direction without a number. */
const DIRECTION_WORDS = [
  /\bpump(s|ing|ed)?\b/i, /\bdump(s|ing|ed)?\b/i, /\brall(y|ies|ying)\b/i,
  /\bmoon(s|ing|ed)?\b/i, /\bsurg(e|es|ing)\b/i, /\btank(s|ing|ed)\b/i,
  /\bup\s+\d/i, /\bdown\s+\d/i, /\bgain(s|ed|ing)?\b/i, /\bloss(es)?\b/i,
  /[↑↓▲▼↗↘]/,
];

function assertNoDirection(label, text) {
  const flat = String(text);
  const m = SIGNED_PCT.exec(flat);
  assert.equal(m, null, `${label} states a signed percentage: "${m && m[0]}"\n${flat}`);
  const w = WINDOWED_PCT.exec(flat);
  assert.equal(w, null, `${label} ties a percentage to a window: "${w && w[0]}"\n${flat}`);
  for (const re of DIRECTION_WORDS) {
    assert.doesNotMatch(flat, re, `${label} states a price direction in words: ${re}`);
  }
}

/** Every string drawn into an SVG, so a picture is checked like a message. */
const svgText = (svg) => [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join('\n');

// ------------------------------------------------------------- the fixtures

// detail carries the same figures as plain, as every real flag's does: /full is
// the technical wording of the same finding, not a different finding.
const f = (key, plain, severity, state = 'raised') =>
  ({ key, label: key, state, detail: plain, compactDetail: plain, plain, severity });

// Deliberately stuffed with the percentages that MUST survive: a share of
// supply, a holder concentration, a creator tax, an index median, a share of
// an index. If the guard is too broad it fails here rather than in production.
const FINDINGS = [
  f('snipe_exemptions', '5 wallets tax-free at launch, 1 of them the deployer, together 22.3% of supply', 922),
  f('creator_open_buy', 'creator opened with 4.9% of supply · index median 0.5% (n=1,837)', 805),
  f('creator_tax', 'creator takes 8% per trade · index median 1% (n=1,837)', 728),
  f('holder_concentration', 'top 5 hold 61% of supply, largest 34% · 412 holders', 661),
  f('collision', '60 of 1,504 indexed launches use this ticker', 360),
  f('walk', 'holder transfers could not be read', 130, 'unknown'),
];

const MARKET = {
  mcapQuote: 1.68, athQuote: 5.4, athMinutes: 42, liquidityQuote: 0.9,
  vol5m: 0.12, vol1h: 3.4, trades: 180, complete: true,
};

const scan = (over = {}) => makeScan({
  buyers: 412, buyTx: 980, sellTx: 410, flags: FINDINGS,
  benchmarkMedian: 12, benchmarkN: 1837, mcapInQuote: 1.68,
  progressPct: 42.5, concentration: { top5Share: 61, top1Share: 34, holders: 412, excess: 0.4 },
  ...over,
});

// ------------------------------------------------------------------ the text

test('no text card states a price direction', () => {
  resetSponsor();
  const variants = {
    'the quick card': C.renderDefaultCard(scan(), 'vitalscheck_bot'),
    'the full card': C.renderCardText(scan()),
    'the early card': C.renderCardText(scan({ ageSeconds: 40 })),
    'the not-found card': C.renderDefaultNotFound(TOKEN, 'vitalscheck_bot'),
    'a graduated launch': C.renderCardText(scan({
      phaseName: 'Swept', launchedAt: 1_700_000_000, sweptAt: 1_700_003_600, ageSeconds: 14_400,
    })),
    'a launch with no window yet': C.renderCardText(scan({ windowIndexed: false })),
  };
  for (const [label, text] of Object.entries(variants)) assertNoDirection(label, text);
});

test('no group card states a price direction', () => {
  resetSponsor();
  const opts = { chatId: CHAT, botUsername: 'vitalscheck_bot', now: NOW };
  assertNoDirection('the group card', G.renderGroupCard(scan(), { ...opts, market: MARKET }).text);
  assertNoDirection('the group card before the market lands',
    G.renderGroupCard(scan(), { ...opts, market: null }).text);
  assertNoDirection('the group card with a partial window',
    G.renderGroupCard(scan(), { ...opts, market: { ...MARKET, complete: false } }).text);
  assertNoDirection('a pre-graduation group card',
    G.renderGroupCard(scan({
      phaseName: 'NotGraduated', progressPct: 42.5,
      realQuoteReserve: 1_785_000_000_000_000_000n,
      graduationThreshold: 4_200_000_000_000_000_000n,
    }), { ...opts, market: MARKET }).text);
});

test('no picture states a price direction', () => {
  resetSponsor();
  for (const size of ['portrait', 'wide']) {
    assertNoDirection(`the ${size} card`, svgText(I.cardSvg(scan(), AT, size)));
  }
  assertNoDirection('the declaration card', svgText(I.declarationCardSvg({
    id: 12, deployer: '0x' + '9'.repeat(40), declaredBy: 7, declaredAtSeconds: 1_789_000_000,
    blockNumber: 8000, devBuyPct: 2.5, exemptList: [], exemptCount: 1, creatorTaxBps: 400,
    taxSplit: 'half to the artist', vesting: 'team holds 5%, vesting over 12 months',
    docsUrl: 'https://docs.checkvitals.xyz', canonical: 'c', signature: '0xsig', freeSlot: 12,
  }, AT)));
  assertNoDirection('the call card', svgText(I.callCardSvg({
    symbol: 'MIKA', token: TOKEN, username: 'alice', calledAt: 1_789_000_000,
    mcapQuote: 0.067, athQuote: 1.68, multiple: 25.1, quote: 'ETH',
    botUsername: 'vitalscheck_bot',
  }, AT)));
});

test('no leaderboard states a price direction', () => {
  db.prepare(
    `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at, symbol)
     VALUES (?,?,?,?,1,'1',1000,?,?, 'MIKA')`,
  ).run(TOKEN, CURVE, '0x' + 'd'.repeat(40), '0x' + 'e'.repeat(40),
    '0x' + 'f'.repeat(64), Math.floor(NOW / 1000) - 86_400);
  db.prepare(
    `INSERT OR REPLACE INTO trades (tx_hash, log_index, token, curve, side, trader, recipient,
       quote_amount, token_amount, fee, creator_tax, block_number, block_time)
     VALUES (?,1,?,?,'buy',?,?,?,?,'0','0',1100,?)`,
  ).run('0x' + '1'.repeat(64), TOKEN, CURVE, '0x' + '9'.repeat(40), '0x' + '9'.repeat(40),
    '1000000000000000000', '1000000000000000000', Math.floor(NOW / 1000) - 1800);
  F.recordFirstCall({
    chatId: CHAT, token: TOKEN, userId: 11, username: 'alice',
    mcapQuote: 0.067, blockNumber: 500, now: NOW - 7_200_000,
  });
  assertNoDirection('the leaderboard', F.renderLeaderboard(CHAT, 7, 'ETH', NOW));
  assertNoDirection('an empty leaderboard', F.renderLeaderboard(-4242, 30, 'ETH', NOW));
});

// ------------------------------------------------------- the guard is honest

test('the closest legitimate neighbour survives the guard', () => {
  // "progress accruing at 2.41% per 10 min" is a percentage tied to a time
  // window, which is the exact shape the guard bans. It is allowed: it is net
  // quote into the CURVE as a share of the graduation threshold, per ten
  // minutes, which is a quantity of activity and the same family as "vol 1h".
  //
  // This is the one line that would tell us the guard had been written too
  // wide, so it is rendered deliberately rather than left at the fixture's
  // zero, where it never appears and the guard is never tested against it.
  resetSponsor();
  const withVelocity = scan({ progressVelocity: 2.413 });
  const full = C.renderCardText(withVelocity);
  assert.match(full, /progress velocity: 2\.413% per 10 min/,
    'the fixture no longer renders the line this test exists for');
  assertNoDirection('the full card with progress velocity', full);
  assertNoDirection('the quick card with progress velocity',
    C.renderDefaultCard(withVelocity, 'vitalscheck_bot'));
  assertNoDirection('the picture with progress velocity',
    svgText(I.cardSvg(withVelocity, AT)));
});

test('the launch-room surfaces state no price direction either', async () => {
  // Not a card, but the same rule and the same readers: the pinned countdown
  // post and /ready carry a signed delta over a window. It is a count of
  // registered wallets and the ETH they hold before the token exists, so it is
  // allowed, and it is guarded here so a price delta cannot be added beside it.
  const { totalsBlock } = await import('../dist/tge.js');
  // yesterday's figure comes from the snapshot table, so the delta needs one.
  const today = Math.floor(NOW / 86_400_000);
  db.prepare('INSERT OR REPLACE INTO ready_snapshots (day, wallets, wei) VALUES (?,?,?)')
    .run(today - 1, 39, '112500000000000000000');
  const block = totalsBlock(
    { members: 120, now: NOW, botUsername: 'vitalscheck_bot', updatedMinutesAgo: 3 },
    { wallets: 42, wei: 125_000_000_000_000_000_000n, external: 0 },
  );
  assert.match(block, /\+3 wallets/, 'the fixture no longer renders the delta this test exists for');
  // The delta is not a percentage and carries no unit of price, so the signed
  // form is fine; what must never appear is a price moving.
  for (const re of DIRECTION_WORDS) {
    assert.doesNotMatch(block, re, `the totals block states a price direction: ${re}`);
  }
  assert.equal(WINDOWED_PCT.exec(block), null);
});

test('the percentages that are not price all still render', () => {
  // A guard that passed by banning every "%" would be worthless: it would have
  // deleted the exemption share, the holder spread, the creator tax and the
  // index median, which are the whole card. Asserted positively so the guard
  // above can never be widened into one that does.
  resetSponsor();
  // Checked across the surfaces together: the quick card clips a long finding
  // at seventy characters, so the share of supply lives in full on /full and on
  // the group card, and each of these is somewhere.
  const surfaces = [
    C.renderDefaultCard(scan(), 'vitalscheck_bot'),
    C.renderCardText(scan()),
    G.renderGroupCard(scan(), { chatId: CHAT, botUsername: 'vitalscheck_bot', market: MARKET, now: NOW }).text,
  ].join('\n');
  for (const expected of [
    /22\.3% of supply/,
    /4\.9% of supply/,
    /index median 0\.5%/,
    /creator takes 8% per trade/,
    /top 5 hold 61% of supply/,
    /42\.5%/,
  ]) {
    assert.match(surfaces, expected, `the guard would have banned a legitimate percentage: ${expected}`);
  }
});

test('the market snapshot has no direction to render in the first place', async () => {
  // Belt and braces: the renderers are checked above, but a computed-and-unused
  // direction is how the feature comes back. There is no field for one.
  const M = await import('../dist/metrics/market.js');
  const snap = M.marketSnapshot({
    token: TOKEN, mcapQuote: 1.68, liquidityQuote: 0.9, pairDecimals: 18,
    currentBlock: 1100, now: NOW,
  });
  for (const banned of ['change5m', 'change1h', 'priceChange', 'delta', 'pctChange']) {
    assert.ok(!(banned in snap), `the snapshot carries ${banned}`);
  }
  // And the quantities it does carry are all still there.
  for (const kept of ['mcapQuote', 'athQuote', 'athMinutes', 'liquidityQuote', 'vol5m', 'vol1h', 'trades']) {
    assert.ok(kept in snap, `${kept} was removed along with the direction`);
  }
});
