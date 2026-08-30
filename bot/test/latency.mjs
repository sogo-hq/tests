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
import { readStoredConcentration } from '../dist/metrics/concentration.js';
import { SCAN_BUDGET_MS } from '../dist/config.js';

const ok = (m) => console.log(`  PASS  ${m}`);
const MIN_HOLDERS = Number(process.env.LATENCY_MIN_HOLDERS || 300);

// The heaviest token on record: holder count is what drives the Transfer read,
// which is the phase that caused this.
const biggest = db
  .prepare('SELECT token, holders FROM holder_snapshots ORDER BY holders DESC LIMIT 1')
  .get();

assert.ok(biggest, 'no holder readings on record — run the window indexer first');
if (biggest.holders < MIN_HOLDERS) {
  // Stated, never skipped silently: a latency ceiling asserted against a
  // ten-holder token proves nothing, and pretending otherwise is how a
  // regression this size ships twice.
  console.log(
    `  WARN  largest token on record has ${biggest.holders} holders, under the ${MIN_HOLDERS} this is meant to prove.\n` +
    `        Asserting against it anyway; set LATENCY_MIN_HOLDERS to change the bar.`,
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
{
  const times = [];
  for (let i = 0; i < 4; i++) times.push((await timed(`repeat ${i + 1}`)).ms);
  const worst = Math.max(...times);
  assert.ok(
    worst < SCAN_BUDGET_MS,
    `slowest of four consecutive scans was ${worst}ms: ${times.join(', ')}`,
  );
  ok(`four consecutive scans stay under the ceiling: ${times.join('ms, ')}ms`);
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
