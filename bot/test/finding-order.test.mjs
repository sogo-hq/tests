/**
 * Which finding leads the card.
 *
 * The hero used to be whichever check happened to fire with the largest
 * hand-written severity, and those numbers were picked one at a time over
 * months: a ticker collision (70) outranked an above-median creator tax (40+),
 * and a custom pair asset (35) outranked an unreadable launch transaction on
 * any launch where the tax also fired.
 *
 * The order is now a policy: what a buyer cannot get anywhere else first, then
 * the size of the claim on supply. Nothing about the protocol exposes the
 * pre-exempted wallets, and they are the only wallets that can take supply
 * before anyone else can bid for it, so they lead. The pair asset is last,
 * because every page that shows the token at all already shows it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('findingorder');
const { db } = await import('../dist/db.js');
const { computeFlags } = await import('../dist/metrics/flags.js');
const { recordIndexAdvance } = await import('../dist/indexer/health.js');

const NOW = 1_757_000_000;
const TOKEN = '0x' + '11'.repeat(20);
const DEP = '0x' + 'd'.repeat(40);
const PAIR = '0x' + 'e'.repeat(40);

const insert = db.prepare(
  `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
     graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key,
     symbol_key, snipe_exemption_count, exemption_source, creator_tax_bps,
     exempt_open_pct, creator_open_pct)
   VALUES (?,?,?,?,1,'4200000000000000000',?,?,?,?,?,?,?,?,?,?,?,?)`,
);

// A populated index: 100 bps is the creator-tax median and 0.5% the median
// opening buy, over well above the 30 observations either needs.
for (let i = 0; i < 1500; i++) {
  const a = '0x' + i.toString(16).padStart(40, '0');
  insert.run(a, '0x' + 'c'.repeat(40), i < 8 ? DEP : a, PAIR,
    1000 + i, '0x' + i.toString(16).padStart(64, '0'), NOW - 3600,
    'n' + i, i < 60 ? 'DUPE' : 's' + i, 'n' + i, i < 60 ? 'dupe' : 's' + i,
    1, 'logs', 100, 0.5, 0.5);
}

// Outcomes for the deployer's priors, and a distribution to judge this token's
// holders against. Without them three checks land undetermined and the end-to-
// end order would only ever cover half the ladder.
const peak = db.prepare('INSERT OR REPLACE INTO token_peaks (token, peak_mcap, peak_at) VALUES (?,?,?)');
const snap = db.prepare(
  'INSERT OR REPLACE INTO holder_snapshots (token, top5_share, holders, excess, measured_at) VALUES (?,?,?,?,?)',
);
const scan = db.prepare(
  `INSERT INTO scans (token, curve, deployer, scanned_at, scanned_block)
   VALUES (?, ?, ?, ?, 1)`,
);
// One recheck row per prior, each hung off its own scan: rechecks are unique on
// (scan_id, offset_hours).
const recheck = db.prepare(
  `INSERT INTO rechecks (scan_id, token, offset_hours, due_at, completed_at, still_trading)
   VALUES (?, ?, 24, ?, ?, ?)`,
);
for (let i = 0; i < 1500; i++) {
  const a = '0x' + i.toString(16).padStart(40, '0');
  // The deployer's own eight priors peaked an order of magnitude below the rest
  // and none of them was still trading a day later.
  peak.run(a, i < 8 ? '1' : '100', NOW - 3600);
  if (i < 8) {
    const id = scan.run(a, '0x' + 'c'.repeat(40), DEP, NOW).lastInsertRowid;
    recheck.run(id, a, NOW, NOW, 0);
  }
  // A distribution the scanned token sits at the top of.
  snap.run(a, 40, 50, 0.1, NOW - 3600);
}

recordIndexAdvance(1n);

/**
 * One launch that trips nearly everything at once.
 *
 * Five wallets tax-free holding 22.3% of supply, a creator tax four times the
 * index median, a deployer with eight launches this week, a ticker sixty other
 * launches share, and a non-ETH pair. Before the order was a policy this card
 * led with the ticker collision.
 */
const flagsFor = (over = {}) => {
  const row = {
    count: 5, source: 'logs', taxBps: 400, exemptPct: 22.3, creatorPct: 4.9,
    symbol: 'DUPE', pairSymbol: 'RDDT', pairToken: PAIR, ...over,
  };
  insert.run(TOKEN, '0x' + 'c'.repeat(40), DEP, row.pairToken,
    1, '0x' + 'f'.repeat(64), NOW, 'NEW', row.symbol, 'new',
    row.symbol.toLowerCase(), row.count, row.source, row.taxBps,
    row.exemptPct, row.creatorPct);
  return computeFlags({
    token: TOKEN, deployer: DEP, name: 'NEW', symbol: row.symbol,
    creatorTaxBps: row.taxBps, buybackEnabled: false,
    pairToken: row.pairToken, pairSymbol: row.pairSymbol,
    scannedAt: NOW, launchedAt: NOW,
    concentration: row.concentration === undefined
      ? { top5Share: 92, top1Share: 61, holders: 50, circulating: 1000n }
      : row.concentration,
  });
};

const rank = (r) => r.flags
  .filter((f) => f.state !== 'clean')
  .sort((a, b) => b.severity - a.severity)
  .map((f) => f.key);

test('an exemption set outranks an above-median tax', () => {
  const r = flagsFor();
  assert.equal(r.worst.key, 'snipe_exemptions',
    `led with ${r.worst.key}: "${r.worst.plain}"`);
  const order = rank(r);
  assert.ok(order.indexOf('snipe_exemptions') < order.indexOf('creator_tax'));
  assert.ok(order.indexOf('creator_tax') < order.indexOf('collision'));
  assert.ok(order.indexOf('collision') < order.indexOf('custom_pair'));
});

test('the stated order holds end to end', () => {
  const order = rank(flagsFor());
  const stated = [
    'snipe_exemptions', 'creator_open_buy', 'creator_tax',
    'holder_concentration', 'deployer_survival', 'deployer_peaks',
    'deployer_rate', 'pair_ticker', 'collision', 'custom_pair',
  ];
  const seen = order.filter((k) => stated.includes(k));
  const expected = stated.filter((k) => seen.includes(k));
  assert.deepEqual(seen, expected, `order was ${seen.join(' > ')}`);
});

test('two exemption sets are ordered by the supply they took', () => {
  const small = flagsFor({ exemptPct: 0.4 }).flags.find((f) => f.key === 'snipe_exemptions');
  const large = flagsFor({ exemptPct: 40 }).flags.find((f) => f.key === 'snipe_exemptions');
  assert.ok(large.severity > small.severity,
    'a set holding 40% must rank above one holding 0.4%');
  // And a set whose window was never measured cannot overtake a measured one.
  const unmeasured = flagsFor({ exemptPct: null, count: 32 }).flags
    .find((f) => f.key === 'snipe_exemptions');
  assert.ok(unmeasured.severity < large.severity,
    'an unmeasured count of 32 must not outrank a measured 40% of supply');
});

test('the exemption line says how much of the token the set took', () => {
  const f = flagsFor().flags.find((f) => f.key === 'snipe_exemptions');
  assert.equal(f.plain, '5 wallets tax-free at launch, 1 of them the deployer, together 22.3% of supply');
  assert.ok(f.plain.length <= 79, `${f.plain.length} chars`);
});

test('with no measured window the line falls back to the count alone', () => {
  const f = flagsFor({ exemptPct: null }).flags.find((f) => f.key === 'snipe_exemptions');
  assert.equal(f.plain, '5 wallets tax-free at launch, 1 of them the deployer');
});

test('the creator opening buy is its own finding, under the exemption set', () => {
  const f = flagsFor().flags.find((f) => f.key === 'creator_open_buy');
  assert.equal(f.state, 'raised');
  assert.match(f.plain, /^creator opened with 4\.9% of supply · index median 0\.5% \(n=1,50\d\)$/);
});

test('an unread launch transaction still leads over a pair asset', () => {
  // The absence of the highest-ranked finding is more useful than the presence
  // of the lowest. A card that led with "priced in RDDT, not ETH" while the
  // exemption set went unmentioned is the false all-clear this tool exists for.
  const r = flagsFor({
    count: null, source: null, taxBps: 0, exemptPct: null, creatorPct: null,
    symbol: 'UNIQ', concentration: null,
  });
  assert.equal(r.worst.key, 'snipe_exemptions');
  assert.equal(r.worst.state, 'unknown');
});

test('but a measured claim on supply leads over an unread one', () => {
  // The one place an undetermined check is outranked by a finding, and it is
  // the right way round: 92% of supply in five wallets is a number, and "we
  // could not read the launch" is the absence of one.
  const r = flagsFor({ count: null, source: null, taxBps: 0, exemptPct: null, creatorPct: null, symbol: 'UNIQ' });
  assert.equal(r.worst.key, 'holder_concentration');
  // And the placement does not depend on how large that share happens to be.
  const low = flagsFor({
    count: null, source: null, taxBps: 0, exemptPct: null, creatorPct: null, symbol: 'UNIQ',
    concentration: { top5Share: 60, top1Share: 20, holders: 50, circulating: 1000n },
  });
  assert.equal(low.worst.key, 'holder_concentration');
});

test('every other undetermined check sits below every finding', () => {
  const r = flagsFor();
  const worstUnknown = Math.max(...r.flags
    .filter((f) => f.state === 'unknown' && f.key !== 'snipe_exemptions')
    .map((f) => f.severity), 0);
  const leastRaised = Math.min(...r.flags
    .filter((f) => f.state === 'raised').map((f) => f.severity));
  assert.ok(worstUnknown < leastRaised,
    `an undetermined check at ${worstUnknown} outranked a finding at ${leastRaised}`);
});

test('a tax is ranked by its multiple of the median, not its distance from it', () => {
  // 50 bps over a 100 bps median is half again as much; 50 bps over a 500 bps
  // median is a rounding difference. The old ranking scored them identically.
  const near = flagsFor({ taxBps: 150 }).flags.find((f) => f.key === 'creator_tax');
  const far = flagsFor({ taxBps: 800 }).flags.find((f) => f.key === 'creator_tax');
  assert.ok(far.severity > near.severity);
});

test('"0 of 32" can never be produced', () => {
  for (const count of [null, 0, 1, 2, 5, 32]) {
    for (const source of ['logs', null]) {
      for (const f of flagsFor({ count, source }).flags) {
        for (const text of [f.plain, f.detail, f.compactDetail]) {
          assert.doesNotMatch(text, /\b0 of \d+\b/, `"${text}"`);
          assert.doesNotMatch(text, /exempt slots?/, `"${text}"`);
        }
      }
    }
  }
});

test('/full says where the supply share was read from', () => {
  // The obvious place to look is the launch receipt, and it is the wrong one:
  // measured on four launches it reported 1.0% where the opening window
  // reported 17.4%. A reader checking the figure needs to know which blocks.
  const f = flagsFor().flags.find((f) => f.key === 'snipe_exemptions');
  assert.ok(f.note, 'a measured share with no account of where it came from');
  assert.match(f.note, /do not buy in the launch transaction/);
  assert.match(f.note, /tax-free seconds after it/);
  assert.match(f.note, /opening window \(40 blocks from the launch block\)/);

  // Only where there is a share to explain, and never on the quick card or the
  // picture: both have a line budget, and neither is the place for it.
  assert.equal(flagsFor({ exemptPct: null }).flags
    .find((f) => f.key === 'snipe_exemptions').note, null);
  for (const fl of flagsFor().flags) {
    if (fl.note) assert.ok(!fl.plain.includes(fl.note) && !fl.compactDetail.includes(fl.note));
  }
});
