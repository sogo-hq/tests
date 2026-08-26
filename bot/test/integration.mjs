/**
 * End-to-end check of the service layer against the live chain.
 * Not part of `npm test` -- it needs network. Run: node test/integration.mjs
 */
import assert from 'node:assert/strict';
import { performScan } from '../dist/service.js';
import { scanCache } from '../dist/cache.js';
import { userQuota, scanSemaphore } from '../dist/quota.js';
import { db } from '../dist/db.js';

const TOKEN = '0xd384722f6adfe7d79E8e6623896DF199afD31B76';
const ok = (m) => console.log(`  PASS  ${m}`);

const scansBefore = db.prepare('SELECT COUNT(*) n FROM scans').get().n;

// --- 1. cold scan is a miss and does real work -----------------------------
const t0 = Date.now();
const first = await performScan({ token: TOKEN, source: 'dm', userId: 1001, chatId: 42, botUsername: 'vitalscheck_bot' });
const firstMs = Date.now() - t0;
assert.equal(first.kind, 'ok', `expected ok, got ${first.kind}`);
assert.equal(first.cacheHit, false);
ok(`cold scan: ${firstMs}ms, cacheHit=false`);

// --- 2. warm scan is a hit, skips RPC, and is near-instant ------------------
const t1 = Date.now();
const second = await performScan({ token: TOKEN, source: 'group', userId: 1002, chatId: 43, botUsername: 'vitalscheck_bot' });
const secondMs = Date.now() - t1;
assert.equal(second.kind, 'ok');
assert.equal(second.cacheHit, true, 'second scan must be served from cache');
assert.ok(secondMs < 50, `cache hit took ${secondMs}ms, expected <50ms`);
assert.equal(second.card, first.card, 'cached card is identical');
assert.equal(second.compact, first.compact, 'cached compact card is identical');
ok(`warm scan: ${secondMs}ms, cacheHit=true, identical payload`);

// --- 3. a cache hit must NOT write a duplicate scans row --------------------
const scansAfter = db.prepare('SELECT COUNT(*) n FROM scans').get().n;
assert.equal(scansAfter - scansBefore, 1, `expected exactly 1 new scans row, got ${scansAfter - scansBefore}`);
ok('cache hit wrote no duplicate scans row');

// --- 4. every request logged with source, cache_hit and duration ------------
const events = db.prepare('SELECT source, chat_id, user_id, token, cache_hit, duration_ms, outcome FROM scan_events ORDER BY id DESC LIMIT 2').all();
const [warm, cold] = events;
assert.equal(cold.source, 'dm');       assert.equal(cold.cache_hit, 0);
assert.equal(cold.user_id, 1001);      assert.equal(cold.chat_id, 42);
assert.equal(warm.source, 'group');    assert.equal(warm.cache_hit, 1);
assert.equal(warm.user_id, 1002);      assert.equal(warm.chat_id, 43);
assert.equal(cold.token, TOKEN.toLowerCase(), 'token stored lowercased');
assert.ok(cold.duration_ms >= 0 && warm.duration_ms >= 0);
ok(`events logged: dm/miss ${cold.duration_ms}ms, group/hit ${warm.duration_ms}ms`);

// --- 5. cache hits do not consume quota ------------------------------------
const q = userQuota.check(1002);
assert.equal(q.allowed, true, 'a user served from cache should not have burned quota');
ok('cache hit consumed no quota');

// --- 6. quota denies the 11th real scan and never silently drops ------------
const USER = 7777;
let denied = null;
for (let i = 0; i < 12; i++) {
  // distinct uncached tokens would cost real RPC, so exercise the limiter directly
  const d = userQuota.consume(USER);
  if (!d.allowed) { denied = d; break; }
}
assert.ok(denied, 'quota must eventually deny');
assert.equal(denied.window, 'minute');
const rl = await performScan({ token: '0x' + '11'.repeat(20), source: 'inline', userId: USER });
assert.equal(rl.kind, 'rate_limited', `expected rate_limited, got ${rl.kind}`);
assert.match(rl.message, /^rate limited, try again in \d+s$/, `message was: ${rl.message}`);
ok(`rate limited with an explicit message: "${rl.message}"`);

const rlEvent = db.prepare("SELECT outcome, source FROM scan_events ORDER BY id DESC LIMIT 1").get();
assert.equal(rlEvent.outcome, 'rate_limited_minute');
assert.equal(rlEvent.source, 'inline');
ok('rate-limited request still logged (never silently dropped)');

// --- 7. concurrency stays capped under a burst -----------------------------
scanCache.set('0x' + 'ab'.repeat(20), { card: 'c', compact: 'c', meta: { symbol: 'X', traction: 'none', flagsRaised: 0, flagsTotal: 7, flagsUnknown: 0, topFlag: null, notFound: false } });
const burst = await Promise.all(Array.from({ length: 25 }, () =>
  performScan({ token: '0x' + 'ab'.repeat(20), source: 'inline', userId: 9000 })));
assert.ok(burst.every((r) => r.kind === 'ok' && r.cacheHit), 'burst on one token is fully cache-served');
assert.ok(scanSemaphore.stats().active === 0, 'no leaked slots');
assert.ok(scanSemaphore.stats().limit === 5, 'concurrency limit is 5');
ok(`25-request burst served from cache, ${scanSemaphore.stats().limit} slot limit intact, 0 leaked`);

// --- 8. unknown token: not_found, cached, and still disclaimed -------------
const nf = await performScan({ token: '0x' + '22'.repeat(20), source: 'dm', userId: 1003, botUsername: 'vitalscheck_bot' });
assert.equal(nf.kind, 'not_found');
assert.ok(nf.compact.includes('not a pons v2 launch'));
assert.ok(nf.compact.includes('not financial advice'), 'not-found card still carries the disclaimer');
const nf2 = await performScan({ token: '0x' + '22'.repeat(20), source: 'inline', userId: 1004 });
assert.equal(nf2.cacheHit, true, 'not-found results are cached too');
ok('not-found handled, disclaimed and cached');

// --- 9. single-flight: concurrent misses on one token do ONE scan ----------
{
  const HERD = '0x5a05ff9c0d10e89701bae5b35d64adf99903073b';
  scanCache.sweep();
  const before = db.prepare('SELECT COUNT(*) n FROM scans').get().n;
  const t = Date.now();
  const herd = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    performScan({ token: HERD, source: 'inline', userId: 20000 + i, botUsername: 'vitalscheck_bot' })));
  const ms = Date.now() - t;
  const after = db.prepare('SELECT COUNT(*) n FROM scans').get().n;
  const kinds = new Set(herd.map((h) => h.kind));
  assert.equal(kinds.size, 1, `all 8 should agree, got ${[...kinds].join(',')}`);
  assert.ok(['ok', 'not_found'].includes([...kinds][0]));
  assert.equal(after - before, 1, `8 concurrent scans of one token must produce 1 scans row, got ${after - before}`);
  const payloads = new Set(herd.map((h) => h.compact));
  assert.equal(payloads.size, 1, 'all callers get the identical card');
  console.log(`  PASS  8 concurrent misses on one token -> 1 scan, ${ms}ms, all identical`);
  assert.equal((await import('../dist/service.js')).inFlightCount(), 0, 'in-flight map drained');
  console.log('  PASS  in-flight map drained after completion');
}

console.log(`\n  cache: ${scanCache.toString()}`);
console.log('\nAll integration checks passed.');
process.exit(0);
