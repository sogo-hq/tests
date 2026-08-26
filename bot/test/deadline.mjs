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
scanCache.sweep();
const fine = await performScan({ token: '0xa73da07580d3c6b1648b9de217c666e2a63ccb00', source: 'inline', userId: 31338, deadlineMs: 10_000 });
assert.ok(['ok', 'not_found'].includes(fine.kind), `expected a real result, got ${fine.kind}`);
ok(`10s deadline (the inline setting) completes normally: ${fine.kind}`);

console.log('\nAll deadline checks passed.');
process.exit(0);
