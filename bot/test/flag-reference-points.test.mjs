/**
 * A finding states a number. The number needs something to be measured against.
 *
 * Two defects this locks shut. First, the creator-tax plain was byte-identical
 * whether the check had RAISED or PASSED -- "creator takes 3% of every trade"
 * either way -- so the card said the same words about a tax above the median
 * and one below it, and the median that decided which was computed two lines
 * earlier and discarded.
 *
 * Second, nothing tested these strings at all. Every card test builds its own
 * `plain` in a fixture, so flags.ts could have emitted anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('flagref');
const { db } = await import('../dist/db.js');
const { computeFlags } = await import('../dist/metrics/flags.js');
const { recordIndexAdvance } = await import('../dist/indexer/health.js');

const NOW = 1_757_000_000;
const DEP = '0x' + 'd'.repeat(40);
const insert = db.prepare(
  `INSERT OR IGNORE INTO launches (token, curve, deployer, pair_token, launch_config_id,
     graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key,
     symbol_key, snipe_exemption_count, creator_tax_bps)
   VALUES (?,?,?,?,1,'4200000000000000000',?,?,?,?,?,?,?,0,?)`,
);
// A populated, current index: below MIN_INDEX_ROWS_FOR_NEGATIVE (1,000) every
// negative is withheld and none of these branches would run.
for (let i = 0; i < 1500; i++) {
  insert.run(
    '0x' + i.toString(16).padStart(40, '0'), '0x' + 'c'.repeat(40),
    i < 8 ? DEP : '0x' + i.toString(16).padStart(40, '0'), '0x' + 'e'.repeat(40),
    1000 + i, '0x' + i.toString(16).padStart(64, '0'), NOW - 3600,
    'n' + i, i < 60 ? 'DUPE' : 's' + i, 'n' + i, i < 60 ? 'dupe' : 's' + i, 100,
  );
}
// The scanned token's own row: the exemption count is read from the index, not
// from the argument, so without it that check is undetermined rather than raised.
insert.run('0x' + '11'.repeat(20), '0x' + 'c'.repeat(40), DEP, '0x' + 'e'.repeat(40),
  1, '0x' + 'f'.repeat(64), NOW, 'NEW', 'DUPE', 'new', 'dupe', 400);
db.prepare('UPDATE launches SET snipe_exemption_count = 3 WHERE token = ?').run('0x' + '11'.repeat(20));
recordIndexAdvance(1n);

const flagsFor = (over = {}) => computeFlags({
  token: '0x' + '11'.repeat(20), deployer: DEP, name: 'NEW', symbol: 'DUPE',
  creatorTaxBps: 400, buybackEnabled: false,
  snipeExemptions: ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40), '0x' + '3'.repeat(40)],
  pairToken: '0x' + 'e'.repeat(40), pairSymbol: 'RDDT',
  scannedAt: NOW, launchedAt: NOW, mcapInQuote: 0n, isEarly: false, ...over,
}).flags;

test('the creator tax carries its baseline, raised or not', () => {
  const above = flagsFor({ creatorTaxBps: 400 }).find((f) => f.key === 'creator_tax');
  const below = flagsFor({ creatorTaxBps: 0 }).find((f) => f.key === 'creator_tax');

  assert.equal(above.state, 'raised');
  assert.equal(below.state, 'clean');
  for (const f of [above, below]) {
    assert.match(f.plain, /index median [\d.]+%/, `no baseline in "${f.plain}"`);
    assert.match(f.plain, /\(n=[\d,]+\)/, `no sample size in "${f.plain}"`);
  }
  assert.match(above.plain, /^creator takes 4% per trade/);
  assert.match(below.plain, /^creator takes nothing per trade/);
  assert.notEqual(above.plain, below.plain,
    'the two states rendered the same words for two years; they must not again');
});

test('every raised finding carries something to measure its number against', () => {
  // A reference point is a baseline, a threshold, or a denominator. A finding
  // that states only a count leaves the reader unable to size it.
  const REFERENCE = /index median|flag above|flag at|of [\d,]+ |of 32 |\(n=[\d,]+\)/;
  for (const f of flagsFor().filter((x) => x.state === 'raised')) {
    // custom_pair is a categorical fact, not a measurement: there is no scale
    // for "priced in something other than ETH" to sit on.
    if (f.key === 'custom_pair') continue;
    assert.match(f.plain, REFERENCE, `${f.key} states a bare number: "${f.plain}"`);
  }
});

test('the reference points are the real ones, not restatements', () => {
  const byKey = Object.fromEntries(flagsFor().map((f) => [f.key, f]));
  // 2 is the threshold deployer_rate actually tests against.
  assert.match(byKey['deployer_rate'].plain, /8 tokens in 7d · flag above 2/);
  // 32 is the protocol's cap on pre-exempted wallets.
  assert.match(byKey['snipe_exemptions'].plain, /3 of 32 exempt slots used/);
  // The collision count against the index it was found in.
  assert.match(byKey['collision'].plain, /60 of 1,50\d indexed launches/);
});

test('no finding reads as a verdict about the deployer or the creator', () => {
  for (const f of flagsFor()) {
    for (const banned of [/\bscam\b/i, /\brug\b/i, /\bsafe\b/i, /\bclean\b/i, /\bserial\b/i, /\bavoid\b/i]) {
      assert.doesNotMatch(f.plain, banned, `${f.key} carries a verdict: "${f.plain}"`);
    }
  }
});
