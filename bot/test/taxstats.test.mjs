/**
 * Creator tax across the index, and curve volume by tax band.
 *
 * What is pinned: the bands are by the rate rounded to a whole percent (250 bps
 * is 3-5, not 1-2), an undecoded tax is counted as undecoded and never as
 * zero, the median and p90 are withheld under the sample floor and published
 * by nearest rank above it, the ranking is curve volume over seven days on ETH
 * pairs only with the launches it left out counted beside it, and the message
 * ends on the line that says pool trades are not in it.
 *
 * DB_PATH is read once when db.js is imported, so it is set first and every
 * test in this file shares the one fresh database, in order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('taxstats');
const { db } = await import('../dist/db.js');
const { MIN_BENCHMARK_SAMPLES } = await import('../dist/metrics/benchmark.js');
const T = await import('../dist/taxstats.js');

const A = (n) => '0x' + String(n).padStart(40, '0');
const ETH = A(0);
const WETH = A(77);
const NOW = 2_000_000;
const DAY = 86_400;
const EM = String.fromCharCode(0x2014);

let tx = 0;
const launch = (n, { tax, phase = 0, pair = ETH, symbol = null, graduatedAt = null } = {}) => {
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
        graduation_threshold, block_number, tx_hash, launched_at, symbol,
        creator_tax_bps, phase, graduated_at)
      VALUES (?,?,?,?,0,'0',1000,?,?,?,?,?,?)`,
  ).run(A(n), A(99), A(98), pair, '0xtx' + n, NOW - 10 * DAY, symbol, tax, phase, graduatedAt);
};
/** A curve trade of `eth` whole ETH on the token, at a unix time. */
const trade = (n, side, eth, blockTime) => db.prepare(
  `INSERT INTO trades (tx_hash, log_index, token, curve, side, trader, recipient,
      quote_amount, token_amount, fee, creator_tax, block_number, block_time)
    VALUES (?,?,?,?,?,?,?,?,'0','0','0',?,?)`,
).run('0xt' + (++tx), 0, A(n), A(99), side, A(50), A(50), (BigInt(eth * 1000) * 10n ** 15n).toString(), 2000, blockTime);

const INSIDE = NOW - 1000;
const OUTSIDE = NOW - 7 * DAY - 1;
const AT_CUTOFF = NOW - 7 * DAY;

// The seed. Every launch is here for one assertion below.
launch(1, { tax: null });                                            // undecoded, on the curve
launch(2, { tax: 0 });                                               // 0%, on the curve
launch(3, { tax: 250, phase: 2, graduatedAt: 4000 });                // 2.5% rounds to 3: band 3-5
trade(3, 'buy', 1.5, INSIDE);
trade(3, 'sell', 0.5, INSIDE);
trade(3, 'buy', 100, OUTSIDE);                                       // outside the window: not volume
launch(4, { tax: 1000, phase: 2, symbol: 'four', graduatedAt: 5000 });
trade(4, 'buy', 3, INSIDE);
launch(5, { tax: 600, phase: 2, symbol: 'five', graduatedAt: 5000 });
trade(5, 'buy', 1, INSIDE);
trade(5, 'buy', 1, INSIDE);
trade(5, 'sell', 3, INSIDE);
launch(6, { tax: 700, phase: 2, pair: WETH, symbol: 'six', graduatedAt: 5000 });
trade(6, 'buy', 10, INSIDE);                                         // WETH pair: counted, never ranked
launch(7, { tax: 100, phase: 1, symbol: 'seven' });                  // swept, not graduated
trade(7, 'buy', 50, INSIDE);
launch(8, { tax: 150, phase: 2, symbol: 'eight', graduatedAt: 3000 });
trade(8, 'buy', 40, OUTSIDE);                                        // graduated, traded only before the window
launch(9, { tax: null, phase: 2, graduatedAt: 3000 });               // graduated and undecoded
launch(10, { tax: 0, phase: 2, symbol: 'ten', graduatedAt: 5000 });
trade(10, 'buy', 0.25, AT_CUTOFF);                                   // exactly seven days ago: inside
launch(11, { tax: 49 });                                             // rounds to 0
launch(12, { tax: 50 });                                             // rounds to 1
launch(13, { tax: 200, phase: 2, pair: WETH, symbol: 'thirteen', graduatedAt: 5000 });
trade(13, 'buy', 7, INSIDE);                                         // WETH pair in a band with nothing ranked

test('bands are by the rate rounded to the nearest whole percent', () => {
  const key = (bps) => T.bracketOf(bps)?.key ?? null;
  assert.equal(key(0), '0');
  assert.equal(key(49), '0');
  assert.equal(key(50), '1-2');
  assert.equal(key(249), '1-2');
  assert.equal(key(250), '3-5', '2.5% rounds up to 3');
  assert.equal(key(549), '3-5');
  assert.equal(key(550), '6-10');
  assert.equal(key(1000), '6-10');
  assert.equal(key(-1), null);
  assert.equal(key(1001), null, 'above the factory maximum: no band');
  assert.equal(key(NaN), null);
  assert.deepEqual(T.TAX_BRACKETS.map((b) => b.label), ['0%', '1-2%', '3-5%', '6-10%']);
});

test('all launches: undecoded is counted as undecoded, shares are of the decoded', () => {
  const d = T.taxDistribution('all');
  assert.equal(d.population, 'all');
  assert.equal(d.n, 11);
  assert.equal(d.unknown, 2);
  assert.deepEqual(d.brackets.map((b) => [b.key, b.n]), [['0', 3], ['1-2', 4], ['3-5', 1], ['6-10', 3]]);
  for (const b of d.brackets) assert.ok(Math.abs(b.share - b.n / 11) < 1e-12);
  assert.ok(Math.abs(d.brackets.reduce((s, b) => s + b.share, 0) - 1) < 1e-12);
});

test('graduated launches: phase 2 only, swept is not graduated', () => {
  const d = T.taxDistribution('graduated');
  assert.equal(d.population, 'graduated');
  assert.equal(d.n, 7);
  assert.equal(d.unknown, 1);
  assert.deepEqual(d.brackets.map((b) => [b.key, b.n]), [['0', 1], ['1-2', 2], ['3-5', 1], ['6-10', 3]]);
});

test('median and p90 are withheld under the sample floor, and n is still reported', () => {
  assert.equal(MIN_BENCHMARK_SAMPLES, 30);
  for (const p of ['all', 'graduated']) {
    const d = T.taxDistribution(p);
    assert.ok(d.n < MIN_BENCHMARK_SAMPLES);
    assert.equal(d.medianBps, null);
    assert.equal(d.p90Bps, null);
  }
});

test('ranking: curve volume over seven days, both sides, ETH pairs, volume then trades', () => {
  const zero = T.topGraduatedByCurveVolume('0', NOW);
  assert.deepEqual(zero.rows.map((r) => [r.token, r.vol7dQuote, r.trades]), [[A(10), 0.25, 1]]);
  assert.equal(zero.excludedNonEth, 0);

  const low = T.topGraduatedByCurveVolume('1-2', NOW);
  assert.deepEqual(low.rows, [], 'a swept launch and a launch that traded only before the window are not rows');
  assert.equal(low.excludedNonEth, 1, 'the WETH-paired launch in the band is counted even with nothing ranked');

  const mid = T.topGraduatedByCurveVolume('3-5', NOW);
  assert.equal(mid.rows.length, 1);
  assert.equal(mid.rows[0].token, A(3));
  assert.equal(mid.rows[0].symbol, null);
  assert.equal(mid.rows[0].taxBps, 250);
  assert.ok(Math.abs(mid.rows[0].vol7dQuote - 2) < 1e-9, 'buy 1.5 plus sell 0.5, the 100 outside the window ignored');
  assert.equal(mid.rows[0].trades, 2);
  assert.equal(mid.rows[0].graduatedAt, 4000);

  const high = T.topGraduatedByCurveVolume('6-10', NOW);
  assert.deepEqual(high.rows.map((r) => [r.symbol, r.vol7dQuote, r.trades]), [['five', 5, 3], ['four', 3, 1]]);
  assert.equal(high.excludedNonEth, 1, 'the WETH pair is not summed with ETH');

  assert.deepEqual(T.topGraduatedByCurveVolume('6-10', NOW, 1).rows.map((r) => r.symbol), ['five']);
});

test('the window is seven days from now, inclusive at the edge', () => {
  // One second later the trade exactly seven days old falls out.
  assert.equal(T.topGraduatedByCurveVolume('0', NOW + 1).rows.length, 0);
  // Move now past the window and the 3-5 band has nothing inside it either.
  assert.equal(T.topGraduatedByCurveVolume('3-5', NOW + 7 * DAY + 1001).rows.length, 0);
  // Stepping back does not revive the trade a second beyond the edge until now reaches it.
  assert.equal(T.topGraduatedByCurveVolume('1-2', NOW - 1).rows.map((r) => r.symbol).join(), 'eight');
});

test('the text: distribution, rankings with their filters named, and the pool disclaimer', () => {
  const text = T.taxStatsText(NOW);
  const lines = text.split('\n');
  assert.deepEqual(lines, [
    'creator tax, all launches (n=11, 2 undecoded)',
    '  0% 3 (27.3%) · 1-2% 4 (36.4%) · 3-5% 1 (9.1%) · 6-10% 3 (27.3%)',
    '  median and p90 not published under 30 observations (n=11)',
    'creator tax, graduated launches (n=7, 1 undecoded)',
    '  0% 1 (14.3%) · 1-2% 2 (28.6%) · 3-5% 1 (14.3%) · 6-10% 3 (42.9%)',
    '  median and p90 not published under 30 observations (n=7)',
    'top by curve volume, last 7d, ETH pairs, 0% tax:',
    '  $TEN · 0.25 ETH · 1 trade',
    'top by curve volume, 1-2% tax: none traded on the curve in 7d',
    '  1 graduated launch on other pairs not ranked',
    'top by curve volume, last 7d, ETH pairs, 3-5% tax:',
    '  0x0000…0003 · 2 ETH · 2 trades',
    'top by curve volume, last 7d, ETH pairs, 6-10% tax:',
    '  $FIVE · 5 ETH · 3 trades',
    '  $FOUR · 3 ETH · 1 trade',
    '  1 graduated launch on other pairs not ranked',
    'pool trades after graduation are not indexed, so volume is what traded on the curve',
  ]);
  assert.equal(lines.at(-1), T.POOL_TRADES_NOTE);
  assert.ok(!text.includes(EM), 'no em dash');
  assert.ok(!text.includes('\\u2014'), 'no em dash escape either');
  assert.ok(!/\b(clean|safe|looks good|pump|buy|sell)\b/i.test(text), 'facts, not verdicts');
  assert.ok(!text.includes('!'));
});

test('at the floor the median and nearest-rank p90 are published, and the text carries them', () => {
  // Thirty more graduated launches, 0 to 900 bps three times over, none with a
  // trade so the rankings above are untouched.
  for (let i = 0; i < 30; i++) launch(100 + i, { tax: 100 * (i % 10), phase: 2, graduatedAt: 6000 });

  // Graduated, decoded: the seven above plus these thirty, n=37, sorted
  //   0 x4 | 100 x3 | 150 | 200 x4 | 250 | 300 x3 | 400 x3 | 500 x3 | 600 x4 | 700 x4 | 800 x3 | 900 x3 | 1000
  // median is the 19th value, 400. Nearest rank for p90 is ceil(0.9 * 37) = 34,
  // and the 34th value is 900: the 33rd is 800, and an interpolation would have
  // landed between them on a rate no launch has.
  const g = T.taxDistribution('graduated');
  assert.equal(g.n, 37);
  assert.equal(g.unknown, 1);
  assert.equal(g.medianBps, 400);
  assert.equal(g.p90Bps, 900);

  // All decoded: the eleven above plus thirty, n=41, sorted
  //   0 x5 | 49 | 50 | 100 x4 | 150 | 200 x4 | 250 | 300 x3 | 400 x3 | 500 x3 | 600 x4 | 700 x4 | 800 x3 | 900 x3 | 1000
  // median is the 21st value, 400; ceil(0.9 * 41) = 37 and the 37th value is 800.
  const a = T.taxDistribution('all');
  assert.equal(a.n, 41);
  assert.equal(a.unknown, 2);
  assert.equal(a.medianBps, 400);
  assert.equal(a.p90Bps, 800);

  const lines = T.taxStatsText(NOW).split('\n');
  assert.equal(lines[0], 'creator tax, all launches (n=41, 2 undecoded)');
  assert.equal(lines[2], '  median 4% · p90 8%');
  assert.equal(lines[3], 'creator tax, graduated launches (n=37, 1 undecoded)');
  assert.equal(lines[5], '  median 4% · p90 9%');
  assert.ok(!lines.some((l) => l.includes('not published')));
  assert.equal(lines.at(-1), T.POOL_TRADES_NOTE);
});

test('an even sample averages the two middle rates, and a half-percent prints as one decimal', () => {
  // One more graduated launch at 500 makes n=38: the 19th and 20th values are
  // 400 and 500, so the median is 450 bps and prints as 4.5%.
  launch(200, { tax: 500, phase: 2, graduatedAt: 6000 });
  const g = T.taxDistribution('graduated');
  assert.equal(g.n, 38);
  assert.equal(g.medianBps, 450);
  assert.equal(g.p90Bps, 900, 'ceil(0.9 * 38) = 35, still a 900');
  assert.equal(T.taxStatsText(NOW).split('\n')[5], '  median 4.5% · p90 9%');
});
