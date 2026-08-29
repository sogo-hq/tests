import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What the background window indexer chooses to read, and what it declines to.
 *
 * The selection is the whole design: reading everything would be eighteen
 * thousand launches for a median of forty, and reading nothing is where this
 * started. Only selection is exercised here -- the reading itself is
 * indexOneCurve, which is covered live.
 */
const CWD = process.cwd();

function inTempDb(body, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-win-'));
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { db } = await import('${CWD}/dist/db.js');
      const W = await import('${CWD}/dist/indexer/windows.js');
      const B = await import('${CWD}/dist/metrics/benchmark.js');
      const A = (n) => '0x' + String(n).padStart(40, '0');
      const NOW = 1_000_000;
      /** A launch, optionally already covered to \`coveredMinutes\`. */
      const launch = (n, opts = {}) => {
        const token = A(n);
        db.prepare(
          \`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
              graduation_threshold, block_number, tx_hash, launched_at,
              snipe_exemption_count, trades_indexed_to, holders_read_at)
            VALUES (?,?,?,?,0,'0',?,?,?,?,?,?)\`
        ).run(
          token, A(900000 + n), A(98), A(0),
          1000 + (opts.blockOffset ?? n * 100), '0xtx' + n,
          NOW - (opts.ageSeconds ?? 86400),
          opts.exempt ?? 0,
          opts.coveredMinutes === undefined
            ? null
            : 1000 + (opts.blockOffset ?? n * 100) + Math.round(opts.coveredMinutes * 600),
          // Default: the holder read has already happened, so a test about
          // TRADE selection is not also picking up the holder path.
          opts.holdersRead === false ? null : 1,
        );
        return token;
      };
      /** \`n\` distinct buyers for a token, as the trade indexer would have left them. */
      let tx = 0;
      const buys = (token, n) => {
        for (let i = 0; i < n; i++) {
          db.prepare(
            \`INSERT INTO trades (tx_hash, log_index, token, curve, side, trader, recipient,
                quote_amount, token_amount, fee, creator_tax, block_number, block_time)
              VALUES (?,0,?,?,'buy',?,?,'0','0','0','0',1001,0)\`
          ).run('0xt' + (++tx), token, A(99), A(50000 + i), A(50000 + i));
        }
      };
      ${body}
    `], { cwd: CWD, env: { ...process.env, DB_PATH: join(dir, 'w.db'), ...env }, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('exempted-wallet launches are read first', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 50; i++) launch(i);                 // plain launches
    for (let i = 100; i < 110; i++) launch(i, { exempt: 3 }); // carrying exemptions
    const picked = W.selectTargets(10);
    console.log(JSON.stringify(picked.map((p) => p.reason)));
  `);
  assert.deepEqual(JSON.parse(out), Array(10).fill('exempt'),
    'the median that is actually published depends on this population, so it goes first');
});

test('the whole exempt population is eventually taken, not a sample of it', () => {
  const out = inTempDb(`
    for (let i = 100; i < 300; i++) launch(i, { exempt: 1 });
    // drain by marking each pick covered, as a real pass would
    let taken = 0;
    for (let pass = 0; pass < 40; pass++) {
      const picked = W.selectTargets(25).filter((p) => p.reason === 'exempt');
      if (!picked.length) break;
      for (const p of picked) {
        db.prepare('UPDATE launches SET trades_indexed_to = block_number + 18000 WHERE token = ?').run(p.token);
        taken++;
      }
    }
    console.log(JSON.stringify({ taken, left: W.windowBacklog().exempt }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.taken, 200, 'every launch carrying exemptions is read');
  assert.equal(r.left, 0);
});

test('a launch already covered to the full window is never picked again for trades', () => {
  const out = inTempDb(`
    for (let i = 100; i < 110; i++) launch(i, { exempt: 1, coveredMinutes: 30 });
    launch(200, { exempt: 1, coveredMinutes: 29 });  // just short
    const picked = W.selectTargets(25);
    console.log(JSON.stringify(picked.map((p) => p.token)));
  `);
  const picked = JSON.parse(out);
  assert.equal(picked.length, 1, `only the short one should be picked, got ${picked.length}`);
  assert.equal(picked[0], '0x' + '200'.padStart(40, '0'));
});

test('a launch is picked for its holder distribution even when its trades are read', () => {
  // Check 09's population is filled from Transfer logs, not trades. Tying it to
  // trade coverage left the loop idle with two observations and thirty needed.
  const out = inTempDb(`
    for (let i = 1; i <= 60; i++) launch(i, { coveredMinutes: 30 });      // trades done, holders done
    for (let i = 200; i < 210; i++) { launch(i, { coveredMinutes: 30, holdersRead: false }); buys(A(i), 8); }
    const picked = W.selectTargets(25);
    console.log(JSON.stringify(picked.map((p) => p.reason)));
  `);
  const picked = JSON.parse(out);
  assert.equal(picked.length, 10, `every unread holder distribution should be picked, got ${picked.length}`);
  assert.deepEqual([...new Set(picked)], ['holders']);
});

test('holder reads stop once the threshold has enough behind it', () => {
  const out = inTempDb(`
    // 40 recorded distributions is at target
    for (let i = 1; i <= 40; i++) {
      db.prepare('INSERT INTO holder_snapshots (token, top5_share, holders, excess, measured_at) VALUES (?,?,?,?,1)')
        .run(A(90000 + i), 50, 20, 0.4);
    }
    for (let i = 200; i < 260; i++) launch(i, { coveredMinutes: 30, holdersRead: false });
    console.log(JSON.stringify({ picked: W.selectTargets(25).length }));
  `);
  assert.equal(JSON.parse(out).picked, 0, 'sixty unread launches remain and none is worth reading');
});

test('a launch whose holder read found too few holders is not read again', () => {
  // Most launches on this chain have fewer than six holders, where the top-five
  // share is forced and records nothing. Without an attempt marker the loop
  // would pick the same launches every pass and never reach one that counts.
  const out = inTempDb(`
    for (let i = 200; i < 205; i++) { launch(i, { coveredMinutes: 30, holdersRead: false }); buys(A(i), 9); }
    const first = W.selectTargets(25).map((p) => p.token);
    // the pass marks them read whatever came back
    for (const t of first) db.prepare('UPDATE launches SET holders_read_at = 1 WHERE token = ?').run(t);
    console.log(JSON.stringify({ first: first.length, second: W.selectTargets(25).length }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.first, 5);
  assert.equal(r.second, 0, 'a launch that recorded nothing must not be retried forever');
});

test('the sample stops once every bucket clears its target and nothing else is short', () => {
  const out = inTempDb(`
    // 45 launches already covered to the full window -- above the target of 40
    for (let i = 1; i <= 45; i++) launch(i, { coveredMinutes: 30 });
    // and a thousand that are not
    for (let i = 500; i < 1500; i++) launch(i);
    // check 09 is satisfied too, so nothing is pulling the sample onward
    for (let i = 1; i <= 40; i++) {
      db.prepare('INSERT INTO holder_snapshots (token, top5_share, holders, excess, measured_at) VALUES (?,?,?,?,1)')
        .run(A(90000 + i), 50, 20, 0.4);
    }
    const picked = W.selectTargets(25);
    console.log(JSON.stringify({
      picked: picked.length,
      coverage: B.benchmarkCoverage().map((c) => [c.bucket.key, c.n]),
      backlog: W.windowBacklog().total,
    }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.picked, 0, `a thousand unread launches remain, and none is worth reading: picked ${r.picked}`);
  assert.ok(r.backlog >= 1000, 'the backlog is real, the loop just has no reason to touch it');
  for (const [key, n] of r.coverage) assert.ok(n >= 40, `${key} should be at target, is ${n}`);
});

test('the sample tops up only while a bucket is short, and takes the newest first', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 10; i++) launch(i, { coveredMinutes: 30 });  // 10 of 40
    // newest launch has the largest index here, since age is fixed per call
    for (let i = 500; i < 600; i++) launch(i, { ageSeconds: 86400 - i });
    const picked = W.selectTargets(5);
    console.log(JSON.stringify({
      reasons: picked.map((p) => p.reason),
      newestFirst: picked.map((p) => parseInt(p.token.slice(2), 10)),
    }));
  `);
  const r = JSON.parse(out);
  assert.deepEqual(r.reasons, Array(5).fill('sample'));
  const sorted = [...r.newestFirst].sort((a, b) => b - a);
  assert.deepEqual(r.newestFirst, sorted, 'a rolling sample means the most recent launches');
});

test('coverage is reported per bucket, and the floor is unchanged', () => {
  const out = inTempDb(`
    // covered to 5 minutes only: answers the under-5m bucket, nothing wider
    for (let i = 1; i <= 35; i++) launch(i, { coveredMinutes: 5 });
    console.log(JSON.stringify({
      coverage: B.benchmarkCoverage().map((c) => [c.bucket.key, c.n, c.windowMinutes]),
      line: B.benchmarkCoverageLine(),
      floor: B.MIN_BENCHMARK_SAMPLES,
    }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.floor, 30, 'the floor is untouched by any of this');
  const byKey = Object.fromEntries(r.coverage.map(([k, n]) => [k, n]));
  assert.equal(byKey.under5m, 35, 'five minutes of history answers the five-minute bucket');
  assert.equal(byKey.to30m, 0, 'and nothing wider');
  assert.equal(byKey.over12h, 0);
  assert.match(r.line, /^buyer benchmark: not enough data yet \(n=0\)$/,
    'the line reports the WORST bucket, not the best');
});

test('the /stats line goes live only when every bucket clears the floor', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 41; i++) launch(i, { coveredMinutes: 30 });
    console.log(B.benchmarkCoverageLine());
  `);
  assert.equal(out.trim(), 'buyer benchmark: live (n=41 per bucket)');
});

test('one launch short of the floor is still reported as not enough', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 29; i++) launch(i, { coveredMinutes: 30 });
    console.log(B.benchmarkCoverageLine());
  `);
  assert.equal(out.trim(), 'buyer benchmark: not enough data yet (n=29)');
});

test('a launch too small to have six holders is never read for one', () => {
  // Read blind the yield was 6%: thirty-two Transfer logs for two usable
  // observations, because below six holders the top-five share is forced by
  // arithmetic and records nothing. Distinct buy recipients is a lower bound on
  // holders, and it is already indexed.
  const out = inTempDb(`
    for (let i = 200; i < 240; i++) { launch(i, { coveredMinutes: 30, holdersRead: false }); buys(A(i), 2); }
    const tooSmall = W.selectTargets(25).length;
    // one launch with enough buyers to be worth the read
    launch(300, { coveredMinutes: 30, holdersRead: false }); buys(A(300), 7);
    const picked = W.selectTargets(25);
    console.log(JSON.stringify({ tooSmall, picked: picked.map((p) => p.token) }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.tooSmall, 0, 'forty two-buyer launches are not worth a Transfer log each');
  assert.deepEqual(r.picked, ['0x' + '300'.padStart(40, '0')]);
});

test('a launch whose trades were never indexed is not read for holders either', () => {
  // Nothing is known about it, so there is no basis for spending the read.
  const out = inTempDb(`
    for (let i = 200; i < 240; i++) launch(i, { holdersRead: false });  // no trades_indexed_to
    const picked = W.selectTargets(25);
    console.log(JSON.stringify({ reasons: [...new Set(picked.map((p) => p.reason))] }));
  `);
  assert.deepEqual(JSON.parse(out).reasons, ['sample'],
    'they are worth indexing trades for; the holder read waits until they are');
});

test('a starved check 09 keeps the trade sample running', () => {
  // Check 09 can only be read for launches whose trades are indexed, so when it
  // is short AND has nothing left to read, the thing actually starved is the
  // trade sample. Stopping it at the benchmark's target stranded check 09
  // twelve observations short with eighteen thousand launches untouched.
  const out = inTempDb(`
    // every bucket at target, and every indexed launch already read for holders
    for (let i = 1; i <= 45; i++) launch(i, { coveredMinutes: 30 });
    for (let i = 500; i < 700; i++) launch(i);   // unindexed, so not holder candidates
    const before = W.selectTargets(25);
    // now satisfy check 09 as well
    for (let i = 1; i <= 40; i++) {
      db.prepare('INSERT INTO holder_snapshots (token, top5_share, holders, excess, measured_at) VALUES (?,?,?,?,1)')
        .run(A(90000 + i), 50, 20, 0.4);
    }
    const after = W.selectTargets(25);
    console.log(JSON.stringify({ before: before.length, beforeReasons: [...new Set(before.map((p) => p.reason))], after: after.length }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.before, 25, 'a starved check 09 must keep trades flowing so it gets candidates');
  assert.deepEqual(r.beforeReasons, ['sample']);
  assert.equal(r.after, 0, 'and it must stop the moment nothing is short');
});
