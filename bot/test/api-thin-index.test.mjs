/**
 * The v1 contract on a thin index.
 *
 * The populated-index tests cover the case where every reference point exists.
 * This file covers the one the partner will actually hit first, and the one the
 * committed shape is easiest to break on: an index too small to have a median,
 * a threshold, or a collision corpus.
 *
 * The distinction it exists to hold:
 *
 *   a window that was NOT READ is undetermined, and states nothing
 *   a window that WAS READ with no reference yet is a measurement, and states it
 *
 * Collapsing the second into the first is what made a measured 1.03% opening
 * buy print as "undetermined" with the number still in the sentence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('api-thin');

const { toApiLaunch } = await import('../dist/api/map.js');
const { db } = await import('../dist/db.js');
const { computeFlags } = await import('../dist/metrics/flags.js');
const { recordIndexAdvance } = await import('../dist/indexer/health.js');
const { makeScan } = await import('./fixtures.mjs');
const { MIN_BENCHMARK_SAMPLES } = await import('../dist/metrics/benchmark.js');

const TOKEN = '0x147bbaa458ab7cd11e1e478b87f08fe5a42a9e67';
const CURVE = '0x0000000000000000000000000000000000000002';
const DEP = '0x0000000000000000000000000000000000000003';
const PAIR = '0x' + 'e'.repeat(40);
const NOW = 1_789_000_000_000;

const insert = db.prepare(
  `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
     graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key,
     symbol_key, snipe_exemption_count, exemption_source, creator_tax_bps,
     exempt_open_pct, creator_open_pct)
   VALUES (?,?,?,?,1,'4200000000000000000',?,?,?,?,?,?,?,?,'logs',?,?,?)`,
);

// Eleven launches. Under every minimum the engine has, which is the point.
for (let i = 0; i < 11; i++) {
  const a = '0x' + i.toString(16).padStart(40, '0');
  insert.run(a, CURVE, a, PAIR, 1000 + i, '0x' + i.toString(16).padStart(64, '0'),
    1_780_000_000, 'n' + i, 's' + i, 'n' + i, 's' + i, 1, 100, 0.5, 0.5);
}
insert.run(TOKEN, CURVE, DEP, PAIR, 900_000, '0x' + 'f'.repeat(64), 1_780_000_000,
  'Chipper', 'CHIPPER', 'chipper', 'chipper', 9, 0, 17.4, 1.03);
recordIndexAdvance(1n);

const launch = () => {
  const r = makeScan({ buyers: 412, mcapInQuote: 1.68 });
  r.flags = computeFlags({
    token: TOKEN, deployer: DEP, name: 'Chipper', symbol: 'CHIPPER',
    creatorTaxBps: 0, buybackEnabled: false, pairToken: PAIR, pairSymbol: 'NVDA',
    scannedAt: 1_780_003_600,
    concentration: { top5Share: 61, top1Share: 34, holders: 412, circulating: 1000n },
  });
  r.reads.token = TOKEN;
  r.reads.curve = CURVE;
  r.reads.deployer = DEP;
  r.reads.pairToken = PAIR;
  r.reads.symbol = 'CHIPPER';
  r.launchBlock = 900_000;
  return toApiLaunch(r, new Date(NOW));
};

test('the index really is too thin for a median', () => {
  const n = db.prepare('SELECT count(*) c FROM launches').get().c;
  assert.ok(n < MIN_BENCHMARK_SAMPLES, `${n} launches is not a thin index`);
});

test('a measured share with no index median is a measurement, not undetermined', () => {
  const c = launch().checks.find((x) => x.id === 'creator_opening_buy');
  assert.notEqual(c.state, 'undetermined',
    'a window that WAS read came back undetermined because no median existed yet');
  assert.equal(c.state, 'none');
  assert.ok(Math.abs(c.value.supply_share - 0.0103) < 1e-9, JSON.stringify(c.value));
  assert.equal(c.reference, null, 'there is no median, so there is no reference');
  assert.match(c.headline, /no index median yet, n=\d+, needs 30/);
  assert.equal(c.severity, 0, 'a measurement without a reference is not a concern');
});

test('a measured top-5 share with no threshold is a measurement, not undetermined', () => {
  const c = launch().checks.find((x) => x.id === 'holder_concentration');
  assert.equal(c.state, 'none');
  assert.ok(Math.abs(c.value.top5_share - 0.61) < 1e-9);
  assert.ok(Math.abs(c.value.largest_share - 0.34) < 1e-9);
  assert.equal(c.reference, null);
  assert.match(c.headline, /no reference yet/);
});

test('and it is still never called clean', () => {
  const { checks } = launch();
  for (const c of checks) {
    assert.doesNotMatch(c.headline, /\bclean\b|\bsafe\b|looks good/i, c.id);
    assert.equal(c.label, undefined, 'a label would be a second place to say "clean"');
  }
});

test('no undetermined check states a number anywhere in its headline', () => {
  const seen = [];
  for (const c of launch().checks.filter((x) => x.state === 'undetermined')) {
    seen.push(c.id);
    assert.doesNotMatch(c.headline, /\d/,
      `${c.id} is undetermined and its headline states a number: "${c.headline}"`);
    assert.equal(c.value, null, `${c.id} is undetermined and carries a value`);
    assert.equal(c.reference, null);
  }
  assert.ok(seen.length > 0, 'nothing came back undetermined, so nothing was tested');
});

test('every value and reference is an object or null, never a scalar', () => {
  for (const c of launch().checks) {
    for (const field of ['value', 'reference']) {
      const v = c[field];
      if (v === null) continue;
      assert.equal(typeof v, 'object',
        `${c.id}.${field} is a ${typeof v} (${JSON.stringify(v)})`);
      assert.ok(!Array.isArray(v), `${c.id}.${field} is an array`);
    }
  }
});

test('a corpus too small to prove a ticker unique says so, and states nothing', () => {
  // The mirror of the collision fix. Excluding the token itself leaves zero
  // matches here too, but zero out of twelve indexed launches is not evidence
  // that the ticker is unique, and "none" would read as if it were.
  const c = launch().checks.find((x) => x.id === 'ticker_collision');
  assert.equal(c.state, 'undetermined');
  assert.equal(c.value, null);
  assert.doesNotMatch(c.headline, /shared with|\d/);
});

test('an unread largest-holder share is null, never zero', () => {
  // The render path defaults it to 0 so a row written before the column existed
  // does not crash a card. Published, that zero says the largest wallet holds
  // nothing while the top five hold 61%, and a consumer cannot tell it from a
  // measured value.
  const r = makeScan({ buyers: 412, mcapInQuote: 1.68 });
  r.flags = computeFlags({
    token: TOKEN, deployer: DEP, name: 'Chipper', symbol: 'CHIPPER',
    creatorTaxBps: 0, buybackEnabled: false, pairToken: PAIR, pairSymbol: 'NVDA',
    scannedAt: 1_780_003_600,
    concentration: { top5Share: 61, holders: 412, circulating: 1000n },
  });
  r.reads.token = TOKEN;
  const c = toApiLaunch(r, new Date(NOW)).checks.find((x) => x.id === 'holder_concentration');
  assert.equal(c.value.largest_share, null, 'an unread share was published as zero');
  assert.ok(Math.abs(c.value.top5_share - 0.61) < 1e-9, 'and the share that WAS read survives');
  assert.doesNotMatch(c.headline, /largest/, 'the card does not claim it either');
});
