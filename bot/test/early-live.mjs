/**
 * Early mode against a genuinely fresh launch, including what it writes to the
 * database. Column alignment in a 37-column INSERT is not something a renderer
 * test can catch. Needs network. Run: node test/early-live.mjs
 */
import assert from 'node:assert/strict';
import { client, logsClient } from '../dist/chain.js';
import { FACTORY, EARLY_WINDOW_SECONDS } from '../dist/config.js';
import { TokenLaunched } from '../dist/abi.js';
import { scanToken } from '../dist/scan.js';
import { renderCardText, renderCompactText, compactMeta, inlineDescription } from '../dist/card.js';
import { db } from '../dist/db.js';

const ok = (m) => console.log(`  PASS  ${m}`);

const head = await client.getBlockNumber();
const logs = await logsClient.getLogs({
  address: FACTORY, event: TokenLaunched,
  fromBlock: head - BigInt(EARLY_WINDOW_SECONDS * 10), toBlock: head,
});
if (!logs.length) {
  console.log('  SKIP  no launch inside the early window right now');
  process.exit(0);
}

// newest first, so we get the youngest token available
let result = null;
for (const l of [...logs].reverse()) {
  const r = await scanToken(l.args.token);
  if (r && r.isEarly) { result = r; break; }
}
if (!result) {
  console.log('  SKIP  no scannable launch still inside the early window');
  process.exit(0);
}

const r = result;
console.log(`  token ${r.reads.token} age ${r.ageSeconds}s`);
assert.ok(r.ageSeconds < EARLY_WINDOW_SECONDS, 'fixture must actually be early');
assert.equal(r.isEarly, true);
ok(`live launch at ${r.ageSeconds}s is in early mode`);

// ---- the rendered output ---------------------------------------------------
const full = renderCardText(r);
const compact = renderCompactText(r, 'vitalscheck_bot');
for (const [name, text] of [['full', full], ['compact', compact]]) {
  assert.doesNotMatch(text, /TRACTION\s+none/i, `${name} printed TRACTION none`);
  assert.doesNotMatch(text, /round-trippers/i, `${name} printed round-trippers`);
  assert.doesNotMatch(text, /buyer growth/i, `${name} printed buyer growth`);
  assert.doesNotMatch(text, /progress velocity/i, `${name} printed progress velocity`);
}
assert.match(full, new RegExp(`launched ${r.ageSeconds}s ago — too early for traction`));
assert.match(full, /traction unavailable — the snipe tax window is still open\. re-scan in 2 minutes\./);
assert.match(compact, new RegExp(`^launched ${r.ageSeconds}s ago · too early for traction$`, 'm'));
assert.match(compact, /^re-scan in 2 min$/m);
ok('both cards render early mode with none of the undefined metrics');

// ---- inline ----------------------------------------------------------------
const m = compactMeta(r);
assert.equal(m.early, true);
assert.equal(m.traction, 'early');
assert.match(inlineDescription(m), /too early for traction/);
assert.doesNotMatch(inlineDescription(m), /traction none/);
ok('inline description reports early, not a traction verdict');

// ---- what it stored --------------------------------------------------------
const row = db.prepare('SELECT * FROM scans WHERE id = ?').get(r.scanId);
assert.ok(row, 'scan row written');
assert.equal(row.traction, 'early', `traction column was ${JSON.stringify(row.traction)} — check INSERT column alignment`);
for (const col of [
  'unique_buyers_30m', 'unique_buyers_10m', 'buyer_growth_ratio', 'buy_tx_count',
  'sell_tx_count', 'buy_sell_ratio', 'median_buy_size', 'progress_pct',
  'progress_velocity_per_10m', 'unique_buyers_at_scan',
]) {
  assert.equal(row[col], null, `${col} must be NULL for an early scan, was ${JSON.stringify(row[col])}`);
}
ok('every traction column stored NULL, label stored "early" — not a measured-looking zero');

// columns that ARE known at this age must still be populated, which also proves
// the INSERT did not shift
assert.equal(row.token, r.reads.token.toLowerCase(), 'token column intact (no column shift)');
assert.equal(row.deployer, r.reads.deployer.toLowerCase(), 'deployer column intact');
assert.equal(row.flags_total, r.flags.total, 'flags_total intact');
assert.equal(row.flags_raised, r.flags.raised, 'flags_raised intact');
assert.equal(row.creator_tax_bps, r.reads.creatorTaxBps, 'creator_tax_bps intact');
assert.ok(row.scanned_at > 0 && row.launched_at > 0, 'timestamps intact');
assert.equal(row.age_seconds, r.ageSeconds, 'age_seconds intact');
ok('all creation- and index-derived columns intact — no column shift in the 37-column INSERT');

// ---- rechecks were still scheduled ----------------------------------------
const rechecks = db.prepare('SELECT COUNT(*) n FROM rechecks WHERE scan_id = ?').get(r.scanId).n;
assert.equal(rechecks, 4, `expected 4 rechecks queued, got ${rechecks}`);
ok('an early scan still queues its +1h/+6h/+24h/+7d rechecks');

console.log('\nAll early-mode live checks passed.');
process.exit(0);
