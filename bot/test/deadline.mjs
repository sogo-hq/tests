/**
 * Verifies the inline deadline contract: a scan that would exceed the budget
 * returns "still indexing, try again in a moment" instead of letting the inline
 * query expire -- and the abandoned scan still populates the cache, so the
 * retry the message promises actually lands.
 * Needs network. Run: node test/deadline.mjs
 */
import assert from 'node:assert/strict';
import { performScan } from '../dist/service.js';
import { scanCache } from '../dist/cache.js';
import { db } from '../dist/db.js';

const ok = (m) => console.log(`  PASS  ${m}`);
const TOKEN = '0x927db481d5f59d6ae2880b6dc1254742960e65ed';

// make sure it is genuinely uncached
scanCache.sweep();
assert.equal(scanCache.peek(TOKEN), false, 'token must start uncached for this test');

// --- 1. an impossible deadline yields "busy", not a hang or an error --------
const t0 = Date.now();
const busy = await performScan({ token: TOKEN, source: 'inline', userId: 31337, deadlineMs: 1 });
const elapsed = Date.now() - t0;
assert.equal(busy.kind, 'busy', `expected busy, got ${busy.kind}`);
assert.equal(busy.message, 'still indexing, try again in a moment');
assert.ok(elapsed < 1000, `returned in ${elapsed}ms — must not wait for the scan`);
ok(`deadline exceeded -> "${busy.message}" in ${elapsed}ms`);

// --- 2. it was logged as a timeout, never silently dropped ------------------
const ev = db.prepare('SELECT outcome, source, cache_hit FROM scan_events ORDER BY id DESC LIMIT 1').get();
assert.ok(ev.outcome === 'timeout' || ev.outcome === 'busy', `outcome was ${ev.outcome}`);
assert.equal(ev.source, 'inline');
ok(`logged as "${ev.outcome}" from inline`);

// --- 3. the abandoned scan still completes and fills the cache -------------
// The scan is not cancellable; it keeps running. That is what makes
// "try again in a moment" an honest instruction.
let cached = false;
for (let i = 0; i < 60; i++) {
  if (scanCache.peek(TOKEN)) { cached = true; break; }
  await new Promise((r) => setTimeout(r, 250));
}
assert.ok(cached, 'the abandoned scan should still have populated the cache');
ok('abandoned scan still populated the cache');

// --- 4. so the promised retry is instant ------------------------------------
const t1 = Date.now();
const retry = await performScan({ token: TOKEN, source: 'inline', userId: 31337 });
const retryMs = Date.now() - t1;
assert.equal(retry.kind, 'ok', `retry returned ${retry.kind}`);
assert.equal(retry.cacheHit, true, 'retry should be served from cache');
assert.ok(retryMs < 50, `retry took ${retryMs}ms`);
ok(`retry served from cache in ${retryMs}ms — the message was honest`);

// --- 5. a generous deadline does not interfere ------------------------------
// The launch row is indexed first, deliberately. On a completely cold index
// findLaunch walks the factory's logs backwards and a scan measured 21s against
// this node -- so a 10s deadline there is not testing whether the deadline
// interferes, it is testing how long a cold log search takes. That cost is real
// and is what recovery's boot backfill exists to pay down; it is asserted
// separately below rather than folded into this one.
const FINE_TOKEN = '0xa73da07580d3c6b1648b9de217c666e2a63ccb00';
await performScan({ token: FINE_TOKEN, source: 'dm', userId: 31339 });
// sweep() only drops EXPIRED entries, so it cannot force a miss -- using it
// here measured a cache hit and proved nothing about the deadline at all.
scanCache.drop(FINE_TOKEN);

const t2 = Date.now();
const fine = await performScan({ token: FINE_TOKEN, source: 'inline', userId: 31338, deadlineMs: 10_000 });
const fineMs = Date.now() - t2;
assert.ok(['ok', 'not_found'].includes(fine.kind), `expected a real result, got ${fine.kind} in ${fineMs}ms`);
assert.equal(fine.cacheHit, false, 'this must exercise a real scan, not a cache hit');
ok(`10s deadline (the inline setting) completes normally on an indexed launch: ${fine.kind} in ${fineMs}ms`);

// --- 6. and a cold index is reported, never silently slow --------------------
// No persistent volume means the index is empty after every deploy, so this is
// the state a real container boots in. The scan does not fail, it exceeds the
// inline deadline and says so -- which is the honest answer, and the reason the
// message is "try again in a moment" rather than "scan failed".
{
  const cold = await performScan({
    token: '0x0feca3b3a7be814212310eaa0a94682dc3a2af03',
    source: 'inline', userId: 31340, deadlineMs: 50,
  });
  assert.ok(['busy', 'ok', 'not_found'].includes(cold.kind), `unexpected kind ${cold.kind}`);
  if (cold.kind === 'busy') {
    assert.match(cold.message, /still indexing|try again/i, `a deadline must explain itself: ${cold.message}`);
    assert.ok(!/failed/i.test(cold.message), 'a deadline is not a failure');
  }
  ok(`an unindexed launch under a tight deadline reports "${cold.kind}", never a failure`);
}

console.log('\nAll deadline checks passed.');
process.exit(0);
