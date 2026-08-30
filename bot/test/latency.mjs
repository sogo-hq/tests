/**
 * A card that arrives after the decision is worth nothing.
 *
 * Holder concentration put a whole-life Transfer read on the critical path and
 * scans went from 1.1s to 56s on a busy token — 9,001 logs across four million
 * blocks. A tester read the delay as the bot being broken rather than slow, and
 * they were right to: nobody waits a minute on a launch.
 *
 * This asserts the ceiling against the largest token the index knows about, on
 * the live chain. Needs network. Run: node test/latency.mjs
 */
import assert from 'node:assert/strict';
import { performScan } from '../dist/service.js';
import { scanCache } from '../dist/cache.js';
import { db } from '../dist/db.js';
import { readStoredConcentration, refreshConcentration } from '../dist/metrics/concentration.js';
import { client } from '../dist/chain.js';
import { SCAN_BUDGET_MS } from '../dist/config.js';

const ok = (m) => console.log(`  PASS  ${m}`);
const MIN_HOLDERS = Number(process.env.LATENCY_MIN_HOLDERS || 300);

/**
 * The token this regression was found on: 206 holders and 9,001 Transfer logs
 * across four million blocks, which is what a whole-life read costs. Named
 * rather than discovered, so the suite works against a fresh database like
 * every other live suite here — discovering it from holder_snapshots meant the
 * test only ran when something else had already warmed the index, which is to
 * say it did not run.
 */
const SUBJECT = process.env.LATENCY_TOKEN || '0x2ca41249485eb6f71981872461d0fca32058fd78';

// ---- setup, not measured --------------------------------------------------
// One scan to index the launch, then the expensive first holder reading driven
// to completion. Both are what the background loop does on its own schedule in
// production; doing them here is what makes the measurements below the
// steady state rather than a cold start.
{
  const first = await performScan({ token: SUBJECT, source: 'dm', userId: 899_999 });
  assert.equal(first.kind, 'ok', `subject did not scan: ${first.kind}`);
  const row = db.prepare('SELECT block_number, curve FROM launches WHERE token = ?').get(SUBJECT.toLowerCase());
  assert.ok(row, 'subject has no launch row after a successful scan');
  const t0 = Date.now();
  const r = await refreshConcentration(SUBJECT, row.curve, BigInt(row.block_number), await client.getBlockNumber());
  console.log(`  setup: first holder reading took ${((Date.now() - t0) / 1000).toFixed(1)}s over ${r.blocksRead.toLocaleString()} blocks`);
}

const biggest = db
  .prepare('SELECT token, holders FROM holder_snapshots WHERE token = ?')
  .get(SUBJECT.toLowerCase());
assert.ok(biggest, 'the first reading recorded nothing — cannot measure what it costs to serve');

if (biggest.holders < MIN_HOLDERS) {
  // Stated, never skipped silently: a latency ceiling asserted against a
  // ten-holder token proves nothing, and pretending otherwise is how a
  // regression this size ships twice.
  console.log(
    `  WARN  subject has ${biggest.holders} holders, under the ${MIN_HOLDERS} this is meant to prove.\n` +
    `        Asserting against it anyway; set LATENCY_TOKEN to a heavier one.`,
  );
}
console.log(`  token ${biggest.token.slice(0, 12)}… — ${biggest.holders} holders`);

let uid = 900_000;
async function timed(label) {
  scanCache.drop(biggest.token);
  const t0 = Date.now();
  const r = await performScan({ token: biggest.token, source: 'dm', userId: ++uid });
  const ms = Date.now() - t0;
  assert.equal(r.kind, 'ok', `${label}: expected a card, got ${r.kind}`);
  return { ms, result: r };
}

// --- 1. warm: the reading is served from the index -------------------------
{
  const { ms } = await timed('warm');
  assert.ok(ms < SCAN_BUDGET_MS, `warm scan took ${ms}ms, over the ${SCAN_BUDGET_MS}ms ceiling`);
  ok(`warm scan of a ${biggest.holders}-holder token: ${ms}ms (ceiling ${SCAN_BUDGET_MS}ms)`);
}

// --- 2. cold: no stored reading, so the live read races the deadline --------
{
  const saved = readStoredConcentration(biggest.token);
  db.prepare('DELETE FROM holder_snapshots WHERE token = ?').run(biggest.token.toLowerCase());
  try {
    const { ms, result } = await timed('cold');
    assert.ok(
      ms < SCAN_BUDGET_MS,
      `cold scan took ${ms}ms, over the ${SCAN_BUDGET_MS}ms ceiling — phases: ${result.phases ?? 'n/a'}`,
    );
    ok(`cold scan (no stored reading, live read bounded): ${ms}ms`);
  } finally {
    // Put it back: this suite must not leave the index worse than it found it.
    if (saved) {
      db.prepare(
        `INSERT INTO holder_snapshots (token, top5_share, holders, excess, measured_at)
         VALUES (?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET
           top5_share = excluded.top5_share, holders = excluded.holders,
           excess = excluded.excess, measured_at = excluded.measured_at`,
      ).run(biggest.token.toLowerCase(), saved.top5Share, saved.holders, 0, saved.measuredAt);
    }
  }
}

// --- 3. repeated scans stay fast --------------------------------------------
// The first fix made the NEXT scan ten times slower, because refreshing on
// every scan left a heavy read running against the node while the following
// scan tried to use it. Four in a row is what caught that.
//
// Two assertions, because they fail for different reasons and only one of them
// is about this code. `readToken` is seventeen parallel eth_calls and the node
// serves them in anywhere from 0.9s to 5.8s depending on its own load; asserting
// a wall-clock ceiling on every scan therefore tests the node. What this code
// controls is everything else — whether a completed trade window is re-indexed,
// whether holder concentration blocks — and that is asserted exactly, per scan.
{
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push(await timed(`repeat ${i + 1}`));
  const times = runs.map((r) => r.ms);

  for (const { ms, result } of runs) {
    const phases = Object.fromEntries(
      (result.phases ?? '').split(' ').filter(Boolean).map((p) => p.split('=')).map(([k, v]) => [k, Number(v)]),
    );
    // Everything the scan does apart from waiting on the node's own reads.
    const ours = ms - (phases.reads ?? 0);
    assert.ok(ours < 1_500, `${ours}ms of scan overhead outside reads — phases: ${result.phases}`);
    assert.equal(phases.trades ?? 0, 0, `a completed window was re-indexed: ${result.phases}`);
    assert.ok(!/concentration=/.test(result.phases ?? ''), `concentration blocked the card: ${result.phases}`);
  }

  // And end to end, robust to one slow moment from the node but not to a
  // regression: a median over the ceiling means every scan is over it.
  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
  assert.ok(
    median < SCAN_BUDGET_MS,
    `median of four consecutive scans was ${median}ms: ${times.join(', ')}`,
  );
  ok(`four consecutive scans: ${times.join('ms, ')}ms — median ${median}ms, overhead outside reads under 1.5s each`);
}

// --- 4. the breakdown is in the log ----------------------------------------
{
  const { result } = await timed('breakdown');
  assert.ok(result.phases, 'a scan must report where its time went');
  for (const phase of ['reads', 'head', 'trades']) {
    assert.match(result.phases, new RegExp(`\\b${phase}=\\d+`), `no ${phase} timing in "${result.phases}"`);
  }
  ok(`per-phase breakdown is recorded: ${result.phases}`);
}

console.log('\nAll latency checks passed.');
process.exit(0);
