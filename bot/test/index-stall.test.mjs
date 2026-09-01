/**
 * A component that cannot do its job must not look like one that is retrying.
 *
 * The index failed 32,000 consecutive times with the same error for over a day.
 * The loop logged every twentieth attempt, so the line at attempt 32,000 read
 * exactly like the line at attempt 1 with a bigger number -- nothing escalated,
 * nothing stopped, and nothing anywhere said the index was not advancing. Every
 * scan for that day was answered from a day-stale index, with the same
 * confidence as one answered from a current one.
 *
 * Two obligations, asserted separately because they are separate: say it once
 * to the operator, and withhold from the user the negatives that depend on the
 * index being current.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CWD = process.cwd();
function withDb(dbPath, script, env = {}) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: CWD,
    env: { ...process.env, DB_PATH: dbPath, ...env },
    encoding: 'utf8',
  });
}

// ------------------------------------------------------- the failure counter
test('the same error twenty times is announced once, then stops counting', async () => {
  const { recordIndexFailure, resetIndexHealth, indexHealth, FATAL_AFTER } =
    await import('../dist/indexer/health.js');
  resetIndexHealth();

  let crossings = 0;
  for (let i = 0; i < 32_000; i++) {
    if (recordIndexFailure('JSON is not a valid request object.').justCrossed) crossings++;
  }
  assert.equal(crossings, 1, 'the fatal line must be emitted exactly once, not 1,600 times');

  const h = indexHealth();
  assert.equal(h.fatal, true);
  assert.equal(
    h.consecutiveFailures, FATAL_AFTER,
    `the counter kept climbing to ${h.consecutiveFailures}; "32,000 in a row" and "20 in a row" ` +
      'describe the same broken component and only one of them tempts a reader into thinking the number means something',
  );
  resetIndexHealth();
});

test('a different error is new information and starts its own run', async () => {
  const { recordIndexFailure, resetIndexHealth } = await import('../dist/indexer/health.js');
  resetIndexHealth();
  for (let i = 0; i < 25; i++) recordIndexFailure('first kind of broken');
  const r = recordIndexFailure('a completely different failure');
  assert.equal(r.consecutive, 1, 'a changed error must not be collapsed into the old run');
  assert.equal(r.fatal, false);
  resetIndexHealth();
});

test('a success ends the run, so recovery is visible', async () => {
  const { recordIndexFailure, recordIndexAdvance, resetIndexHealth, indexHealth } =
    await import('../dist/indexer/health.js');
  resetIndexHealth();
  for (let i = 0; i < 30; i++) recordIndexFailure('same');
  assert.equal(indexHealth().fatal, true);
  recordIndexAdvance();
  assert.equal(indexHealth().fatal, false);
  assert.equal(indexHealth().consecutiveFailures, 0);
  resetIndexHealth();
});

// ----------------------------------------------- the user-visible obligation
/**
 * The required test: with the RPC erroring on every call, /stats reports the
 * stall and index-derived negatives are withheld.
 *
 * The RPC is pointed at a closed port, so every call genuinely fails -- this
 * does not stub the failure, it causes one.
 */
const SCRIPT = `
const { db } = await import('${CWD}/dist/db.js');
const now = Math.floor(Date.now() / 1000);

// Comfortably OVER MIN_ROWS_FOR_NEGATIVE (1,000), so the row floor is satisfied
// and the stall is the ONLY reason a negative could be withheld. At 600 rows
// this test passed for the wrong reason: the floor withheld them anyway, and
// coverageReason happens to check the stall first, so the message still said
// "stalled" while the gate under test was doing nothing.
const insert = db.prepare(
  \`INSERT OR IGNORE INTO launches (token, curve, deployer, pair_token, launch_config_id,
      graduation_threshold, block_number, tx_hash, launched_at, name, symbol,
      name_key, symbol_key, snipe_exemption_count, creator_tax_bps, phase)
    VALUES (?,?,?,?,1,'4200000000000000000',?,?,?,?,?,?,?,0,100,0)\`);
for (let i = 0; i < 1500; i++) {
  const t = '0x' + i.toString(16).padStart(40, '0');
  insert.run(t, '0x' + 'c'.repeat(40), '0x' + 'd'.repeat(40), '0x' + 'e'.repeat(40),
    1_000_000 + i, '0x' + i.toString(16).padStart(64, '0'), now - 3600, 'n' + i, 's' + i,
    'n' + i, 's' + i);
}
db.prepare("INSERT INTO cursors (name, block_number, updated_at) VALUES ('launches', 1, ?) " +
           "ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at")
  .run(now - 26 * 3600);

// Drive the real poll loop against a dead endpoint so the failures are real.
const { startIndexLoop } = await import('${CWD}/dist/indexer/launches.js');
const errs = [];
const realError = console.error;
console.error = (...a) => errs.push(a.join(' '));
const timer = startIndexLoop(50);
// Long enough for the loop to cross the threshold: viem retries each call
// three times, so a failing pass is about a second.
await new Promise((r) => setTimeout(r, 9000));
clearInterval(timer);
console.error = realError;

const { statsText } = await import('${CWD}/dist/bot.js');
const { computeFlags } = await import('${CWD}/dist/metrics/flags.js');
const flags = computeFlags({
  token: '0x' + '11'.repeat(20), deployer: '0x' + '22'.repeat(20),
  name: 'ZZUNIQUEZZ', symbol: 'ZZUNIQUEZZ', creatorTaxBps: 100, buybackEnabled: false,
  snipeExemptions: [], pairToken: '0x' + 'e'.repeat(40), pairSymbol: 'ETH',
  scannedAt: now, launchedAt: now, mcapInQuote: 0n, isEarly: false,
}).flags;

console.log('RESULT' + JSON.stringify({
  stats: statsText(),
  fatalLines: errs.filter((l) => /FATAL/.test(l)),
  pollLines: errs.filter((l) => /poll failed/.test(l)).length,
  flags: flags.map((f) => ({ key: f.key, state: f.state, detail: f.detail })),
}));
`;

test('with the RPC failing, /stats reports the stall and negatives are withheld', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-stall-'));
  try {
    const out = withDb(join(dir, 'stall.db'), SCRIPT, {
      // A closed port: every RPC call fails for real.
      RPC_URL: 'http://127.0.0.1:9',
      INDEX_FATAL_AFTER: '3',
    });
    const line = out.split('\n').find((l) => l.startsWith('RESULT'));
    assert.ok(line, `no result from the child:\n${out.slice(-800)}`);
    const r = JSON.parse(line.slice('RESULT'.length));

    // 1. /stats says it, in words, with the age.
    assert.match(
      r.stats, /index stalled 26h ago/,
      `/stats did not report the stall:\n${r.stats}`,
    );

    // 2. The operator gets one distinct fatal line, not a rising count.
    assert.equal(r.fatalLines.length, 1, `expected exactly one FATAL line, got ${r.fatalLines.length}`);
    assert.match(r.fatalLines[0], /consecutive failures with the same error/);
    assert.match(r.fatalLines[0], /withheld/);

    // 3. Index-derived negatives are withheld -- the whole point.
    const byKey = Object.fromEntries(r.flags.map((f) => [f.key, f]));
    for (const key of ['collision', 'deployer_rate', 'creator_tax']) {
      assert.equal(
        byKey[key].state, 'unknown',
        `${key} asserted "${byKey[key].detail}" from an index that stopped advancing 26 hours ago`,
      );
      assert.match(byKey[key].detail, /stalled/, `${key} did not say why: "${byKey[key].detail}"`);
    }

    // 4. Checks that never touch the index still answer: a stalled index is not
    //    a reason to stop reporting what was read from the chain directly.
    assert.equal(byKey['pair_ticker'].state, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
