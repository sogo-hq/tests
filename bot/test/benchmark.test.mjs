import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * "5 buyers" tells a reader nothing. The comparison is what makes it a fact, so
 * what is pinned here is the comparison: measured over the same window on both
 * sides, withheld below the sample floor, and never worded as a judgement.
 *
 * Runs in child processes because DB_PATH is read once when db.js is imported.
 */
const CWD = process.cwd();

function inTempDb(body, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-bench-'));
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { db } = await import('${CWD}/dist/db.js');
      const { buyerBenchmark, bucketFor, AGE_BUCKETS, MIN_BENCHMARK_SAMPLES } =
        await import('${CWD}/dist/metrics/benchmark.js');
      const A = (n) => '0x' + String(n).padStart(40, '0');
      const NOW = 1_000_000;
      let tx = 0;
      // BLOCKS_PER_MINUTE is 600 on this chain.
      //
      // A launch is only in the population because somebody scanned it -- that
      // is what put its trades in the index -- so the seed records the scan
      // too. \`indexedMinutes\` is how much of the window that scan reached:
      // a token last scanned at five minutes old has five minutes of history
      // however old it is now.
      const launch = (token, ageSeconds, indexedMinutes = 30) => {
        db.prepare(
          \`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
              graduation_threshold, block_number, tx_hash, launched_at)
            VALUES (?,?,?,?,0,'0',1000,?,?)\`
        ).run(token, A(99), A(98), A(0), '0xtx' + token, NOW - ageSeconds);
        // a scan cannot reach further into a launch's life than the launch has lived\n        const reach = Math.min(indexedMinutes * 60, ageSeconds);\n        const scannedAt = NOW - ageSeconds + Math.round(reach);
        db.prepare(
          \`INSERT INTO scans (token, curve, deployer, scanned_at, scanned_block)
            VALUES (?,?,?,?,1)\`
        ).run(token, A(99), A(98), scannedAt);
      };
      /** A buy by \`wallet\` \`minutes\` after that token's launch block. */
      const buy = (token, wallet, minutes) => db.prepare(
        \`INSERT INTO trades (tx_hash, log_index, token, curve, side, trader, recipient,
            quote_amount, token_amount, fee, creator_tax, block_number, block_time)
          VALUES (?,?,?,?,'buy',?,?,'0','0','0','0',?,0)\`
      ).run('0xt' + (++tx), 0, token, A(99), wallet, wallet, 1000 + Math.round(minutes * 600));
      const sell = (token, wallet, minutes) => db.prepare(
        \`INSERT INTO trades (tx_hash, log_index, token, curve, side, trader, recipient,
            quote_amount, token_amount, fee, creator_tax, block_number, block_time)
          VALUES (?,?,?,?,'sell',?,?,'0','0','0','0',?,0)\`
      ).run('0xt' + (++tx), 0, token, A(99), wallet, wallet, 1000 + Math.round(minutes * 600));
      ${body}
    `], { cwd: CWD, env: { ...process.env, DB_PATH: join(dir, 'b.db'), ...env }, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('buckets split at 5m, 30m, 2h and 12h', () => {
  const out = inTempDb(`
    const edges = [0, 299, 300, 1799, 1800, 7199, 7200, 43199, 43200, 999999];
    console.log(edges.map((e) => bucketFor(e).key).join(','));
    console.log(AGE_BUCKETS.map((b) => b.label).join('|'));
  `).trim().split('\n');
  assert.equal(out[0], 'under5m,under5m,to30m,to30m,to2h,to2h,to12h,to12h,over12h,over12h');
  assert.equal(out[1], 'under 5m|5-30m|30m-2h|2-12h|12h+');
});

test('below the floor the median is withheld and n is still reported', () => {
  const out = inTempDb(`
    for (let i = 0; i < 10; i++) { launch(A(i), 86400); buy(A(i), A(500 + i), 1); }
    const b = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(999), now: NOW });
    console.log(JSON.stringify({ median: b.median, n: b.n, floor: MIN_BENCHMARK_SAMPLES }));
  `);
  const b = JSON.parse(out);
  assert.equal(b.median, null, 'a median of ten launches must not be published');
  assert.equal(b.n, 10, 'the sample size is reported even when the median is not');
  assert.equal(b.floor, 30);
});

test('at the floor it publishes the median of unique buyers', () => {
  // 31 launches: buyer counts 1..31, median of that run is 16.
  const out = inTempDb(`
    for (let i = 1; i <= 31; i++) {
      launch(A(i), 86400);
      for (let w = 0; w < i; w++) buy(A(i), A(1000 + i * 100 + w), 1);
    }
    const b = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(999), now: NOW });
    console.log(JSON.stringify({ median: b.median, n: b.n, bucket: b.bucket.key }));
  `);
  const b = JSON.parse(out);
  assert.equal(b.n, 31);
  assert.equal(b.median, 16);
  assert.equal(b.bucket, 'over12h');
});

test('the window is the same on both sides: a later buy is outside a short window', () => {
  const out = inTempDb(`
    // every launch gets one buyer at +1 min and one at +20 min
    for (let i = 1; i <= 31; i++) {
      launch(A(i), 86400);
      buy(A(i), A(2000 + i), 1);
      buy(A(i), A(3000 + i), 20);
    }
    const short = buyerBenchmark({ ageSeconds: 120, windowMinutes: 2, excludeToken: A(999), now: NOW });
    const long = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(999), now: NOW });
    console.log(JSON.stringify({ short: short.median, long: long.median }));
  `);
  const b = JSON.parse(out);
  assert.equal(b.short, 1, 'a 2-minute window must not count a buyer who arrived at 20 minutes');
  assert.equal(b.long, 2);
});

test('a launch younger than the window is not eligible', () => {
  const out = inTempDb(`
    // 31 old launches, plus 5 that are only a minute old
    for (let i = 1; i <= 31; i++) { launch(A(i), 86400); buy(A(i), A(2000 + i), 1); }
    for (let i = 40; i < 45; i++) { launch(A(i), 60); buy(A(i), A(2000 + i), 0.5); }
    const b = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(999), now: NOW });
    console.log(JSON.stringify({ n: b.n }));
  `);
  assert.equal(JSON.parse(out).n, 31, 'launches that never lived a full window would drag the median down');
});

test('a launch with trades but no buys in the window counts as a real zero', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 30; i++) { launch(A(i), 86400); buy(A(i), A(2000 + i), 1); }
    // one launch whose only trade in range is a sell -- zero buyers, not absent
    launch(A(90), 86400); sell(A(90), A(9000), 1);
    const b = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(999), now: NOW });
    console.log(JSON.stringify({ n: b.n, median: b.median }));
  `);
  const b = JSON.parse(out);
  assert.equal(b.n, 31, 'a zero-buyer launch is part of the population');
  assert.equal(b.median, 1);
});

test('the scanned token is never in the population it is compared against', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 31; i++) { launch(A(i), 86400); buy(A(i), A(2000 + i), 1); }
    const withSelf = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(999), now: NOW });
    const excluded = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(5), now: NOW });
    console.log(JSON.stringify({ withSelf: withSelf.n, excluded: excluded.n }));
  `);
  const b = JSON.parse(out);
  assert.equal(b.withSelf, 31);
  assert.equal(b.excluded, 30, 'a launch must not be part of its own reference point');
});

test('a launch scanned before the window closed is not counted as a full measurement', () => {
  const out = inTempDb(`
    // 31 launches fully indexed, plus 5 last scanned at 5 minutes old
    for (let i = 1; i <= 31; i++) { launch(A(i), 86400); buy(A(i), A(2000 + i), 1); }
    for (let i = 50; i < 55; i++) { launch(A(i), 86400, 5); buy(A(i), A(2000 + i), 1); }
    const b = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(999), now: NOW });
    const short = buyerBenchmark({ ageSeconds: 300, windowMinutes: 5, excludeToken: A(999), now: NOW });
    console.log(JSON.stringify({ full: b.n, short: short.n }));
  `);
  const b = JSON.parse(out);
  assert.equal(b.full, 31, 'five minutes of history is not a thirty-minute measurement');
  assert.equal(b.short, 36, 'but it is a complete five-minute one');
});

test('a scanned launch with no trades at all is a real zero, not an absence', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 15; i++) { launch(A(i), 86400); buy(A(i), A(2000 + i), 1); }
    // sixteen launches somebody scanned that never traded -- selecting on the
    // trades table would drop these and push the median from 0 up to 1
    for (let i = 60; i < 76; i++) launch(A(i), 86400);
    const b = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(999), now: NOW });
    console.log(JSON.stringify({ n: b.n, median: b.median }));
  `);
  const b = JSON.parse(out);
  assert.equal(b.n, 31);
  assert.equal(b.median, 0, 'a population of 16 zeros and 15 ones has a median of 0');
});

test('a launch nobody scanned is not in the population at all', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 31; i++) { launch(A(i), 86400); buy(A(i), A(2000 + i), 1); }
    // backfilled but never scanned: its window was never looked at, so it is
    // neither a zero nor a measurement
    db.prepare(\`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
        graduation_threshold, block_number, tx_hash, launched_at) VALUES (?,?,?,?,0,'0',1000,?,?)\`)
      .run(A(500), A(99), A(98), A(0), '0xtxunscanned', NOW - 86400);
    const b = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(999), now: NOW });
    console.log(JSON.stringify({ n: b.n }));
  `);
  assert.equal(JSON.parse(out).n, 31);
});

test('measuredAtAge is true only while the window is the token\'s whole life', () => {
  const out = inTempDb(`
    const young = buyerBenchmark({ ageSeconds: 120, windowMinutes: 2, excludeToken: A(9), now: NOW });
    const atCap = buyerBenchmark({ ageSeconds: 1800, windowMinutes: 30, excludeToken: A(9), now: NOW });
    const old = buyerBenchmark({ ageSeconds: 86400, windowMinutes: 30, excludeToken: A(9), now: NOW });
    console.log(JSON.stringify({ young: young.measuredAtAge, atCap: atCap.measuredAtAge, old: old.measuredAtAge }));
  `);
  const b = JSON.parse(out);
  assert.equal(b.young, true, 'a two-minute-old token really was measured at its age');
  assert.equal(b.atCap, true, 'so was one exactly at the cap');
  assert.equal(b.old, false, 'a day-old token was measured over its first 30 min, not at its age');
});

test('a malformed sample floor falls back rather than switching the floor off', () => {
  const out = inTempDb(`console.log(String(MIN_BENCHMARK_SAMPLES));`, { MIN_BENCHMARK_SAMPLES: 'not-a-number' });
  assert.equal(out.trim(), '30', 'Number("not-a-number") is NaN and n < NaN is false — the floor would vanish');
});

test('a zero-length window publishes nothing', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 31; i++) { launch(A(i), 86400); buy(A(i), A(2000 + i), 1); }
    const b = buyerBenchmark({ ageSeconds: 0, windowMinutes: 0, excludeToken: A(999), now: NOW });
    console.log(JSON.stringify({ median: b.median, n: b.n }));
  `);
  const b = JSON.parse(out);
  assert.equal(b.median, null);
  assert.equal(b.n, 0);
});
