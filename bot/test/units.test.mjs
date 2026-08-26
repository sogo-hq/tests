import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScanCache } from '../dist/cache.js';
import { UserQuota, Semaphore, SlotTimeout, formatRetry } from '../dist/quota.js';
import { renderCompactCard, renderCompactText, topRaisedFlags, compactMeta, inlineDescription, COMPACT_DISCLAIMER } from '../dist/card.js';
import { makeScan, flag } from './fixtures.mjs';

const entry = (n) => ({ card: `card${n}`, compact: `compact${n}`, meta: { symbol: `S${n}`, traction: 'none', flagsRaised: 0, flagsTotal: 7, flagsUnknown: 0, topFlag: null, notFound: false } });

// ---------------------------------------------------------------- cache
test('cache: hit within TTL, miss after it', () => {
  const c = new ScanCache(50, 10);
  c.set('0xAA', entry(1));
  assert.equal(c.get('0xaa')?.card, 'card1', 'lookup is case-insensitive');
  const before = c.stats();
  assert.equal(before.hits, 1);
});

test('cache: entry expires after TTL and is dropped', async () => {
  const c = new ScanCache(30, 10);
  c.set('0xAA', entry(1));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.get('0xAA'), null, 'expired entry must not be served');
  assert.equal(c.stats().size, 0, 'expired entry is evicted on read');
  assert.equal(c.stats().expired, 1);
});

test('cache: caps at maxEntries and evicts oldest first', () => {
  const c = new ScanCache(60_000, 3);
  for (const k of ['a', 'b', 'c', 'd']) c.set(k, entry(k));
  const s = c.stats();
  assert.equal(s.size, 3, 'never exceeds the cap');
  assert.equal(s.evictions, 1);
  assert.equal(c.get('a'), null, 'oldest was evicted');
  assert.ok(c.get('d'), 'newest survives');
});

test('cache: re-setting a key refreshes its position, protecting hot entries', () => {
  const c = new ScanCache(60_000, 3);
  c.set('a', entry('a'));
  c.set('b', entry('b'));
  c.set('c', entry('c'));
  c.set('a', entry('a2'));   // a is hot: refreshed
  c.set('d', entry('d'));    // should evict b, not a
  assert.ok(c.get('a'), 'refreshed hot key survives');
  assert.equal(c.get('b'), null, 'coldest key evicted');
});

test('cache: hit rate accounting, and peek does not distort it', () => {
  const c = new ScanCache(60_000, 10);
  c.set('a', entry('a'));
  c.get('a'); c.get('a'); c.get('zzz');
  const s = c.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.ok(Math.abs(s.hitRate - 2 / 3) < 1e-9);
  c.peek('a'); c.peek('nope');
  const after = c.stats();
  assert.equal(after.hits, 2, 'peek must not count as a hit');
  assert.equal(after.misses, 1, 'peek must not count as a miss');
});

test('cache: sweep drops only expired entries', async () => {
  const c = new ScanCache(40, 10);
  c.set('old', entry(1));
  await new Promise((r) => setTimeout(r, 60));
  c.set('new', entry(2));
  assert.equal(c.sweep(), 1);
  assert.equal(c.stats().size, 1);
});

// ---------------------------------------------------------------- quota
test('quota: allows exactly perMinute scans then denies', () => {
  const q = new UserQuota(10, 100);
  for (let i = 0; i < 10; i++) assert.equal(q.consume(1).allowed, true, `scan ${i + 1} allowed`);
  const denied = q.consume(1);
  assert.equal(denied.allowed, false, '11th is denied');
  assert.equal(denied.window, 'minute');
  assert.ok(denied.retryAfterSec >= 1 && denied.retryAfterSec <= 60, 'retryAfter within the window');
});

test('quota: denial does not consume, so it cannot push the window out', () => {
  const q = new UserQuota(2, 100);
  const t = Date.now();
  q.consume(1, t); q.consume(1, t);
  q.consume(1, t + 1000);
  q.consume(1, t + 2000);
  // original two timestamps expire 60s after t, regardless of denied attempts
  assert.equal(q.consume(1, t + 60_001).allowed, true, 'window slides on real usage only');
});

test('quota: hourly cap applies independently of the minute cap', () => {
  const q = new UserQuota(1000, 5);
  const t = Date.now();
  for (let i = 0; i < 5; i++) assert.equal(q.consume(7, t + i).allowed, true);
  const d = q.consume(7, t + 6);
  assert.equal(d.allowed, false);
  assert.equal(d.window, 'hour');
  assert.ok(d.retryAfterSec > 60, 'hourly retry is longer than a minute');
});

test('quota: users are independent', () => {
  const q = new UserQuota(1, 10);
  assert.equal(q.consume(1).allowed, true);
  assert.equal(q.consume(1).allowed, false);
  assert.equal(q.consume(2).allowed, true, 'other users unaffected');
});

test('quota: window slides so the user recovers', () => {
  const q = new UserQuota(2, 100);
  const t = Date.now();
  q.consume(5, t); q.consume(5, t + 10);
  assert.equal(q.consume(5, t + 20).allowed, false);
  assert.equal(q.consume(5, t + 60_050).allowed, true, 'recovers once the oldest ages out');
});

test('quota: check() does not consume', () => {
  const q = new UserQuota(1, 10);
  assert.equal(q.check(9).allowed, true);
  assert.equal(q.check(9).allowed, true, 'check is side-effect free');
  assert.equal(q.consume(9).allowed, true);
  assert.equal(q.check(9).allowed, false);
});

test('quota: sweep drops idle users', () => {
  const q = new UserQuota(10, 100);
  q.consume(1, Date.now() - 7_200_000);
  assert.equal(q.stats().trackedUsers, 1);
  q.sweep();
  assert.equal(q.stats().trackedUsers, 0);
});

test('formatRetry renders seconds and minutes', () => {
  assert.equal(formatRetry(5), '5s');
  assert.equal(formatRetry(59), '59s');
  // the per-minute window tops out at 60s and must read as "Ns"
  assert.equal(formatRetry(60), '60s');
  assert.equal(formatRetry(89), '89s');
  assert.equal(formatRetry(130), '2m 10s');
  assert.equal(formatRetry(3400), '56m 40s');
});

// ---------------------------------------------------------------- semaphore
test('semaphore: never exceeds the concurrency limit', async () => {
  const s = new Semaphore(5);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 40 }, async () => {
    const release = await s.acquire();
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--; release();
  }));
  assert.equal(peak, 5, `peak concurrency was ${peak}, expected 5`);
  assert.equal(s.stats().active, 0, 'all slots released');
});

test('semaphore: excess work queues rather than being dropped', async () => {
  const s = new Semaphore(2);
  let completed = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    const release = await s.acquire();
    await new Promise((r) => setTimeout(r, 3));
    completed++; release();
  }));
  assert.equal(completed, 12, 'every queued task eventually ran');
});

test('semaphore: deadline rejects with SlotTimeout and leaves no leak', async () => {
  const s = new Semaphore(1);
  const held = await s.acquire();
  await assert.rejects(() => s.acquire(30), (e) => e instanceof SlotTimeout);
  assert.equal(s.stats().queued, 0, 'timed-out waiter removed from the queue');
  held();
  const next = await s.acquire(1000);
  next();
  assert.equal(s.stats().active, 0);
});

test('semaphore: a timed-out waiter does not steal a later slot', async () => {
  const s = new Semaphore(1);
  const held = await s.acquire();
  const timedOut = s.acquire(20).catch(() => 'timeout');
  assert.equal(await timedOut, 'timeout');
  held();
  // The slot must be free for a new caller.
  const r = await s.acquire(50);
  assert.equal(s.stats().active, 1);
  r();
});

// ---------------------------------------------------------------- compact card
test('compact card: matches the specified shape', () => {
  const r = makeScan({
    symbol: 'GHATS', buyers: 2, roundTrippers: 2, flagsTotal: 7,
    flags: [
      flag('snipe', 'raised', '1 wallet pre-exempted from the opening tax', 101),
      flag('collision', 'raised', 'name collides with 2 tokens after homoglyph normalisation', 70),
      flag('peaks', 'unknown', 'no prior outcomes for this deployer yet', 5),
      flag('surv', 'unknown', 'no +24h history for this deployer yet', 5),
    ],
  });
  const lines = renderCompactText(r, 'vitalscheck_bot').split('\n');
  assert.equal(lines.length, 7, `expected 7 lines, got ${lines.length}:\n${lines.join('\n')}`);
  assert.equal(lines[0], 'VITALS  $GHATS');
  assert.equal(lines[1], 'traction none · 2 buyers/30m · progress 0.00%');
  assert.equal(lines[2], 'flags 2 of 7 · 2 undetermined');
  assert.equal(lines[3], '🚩 1 wallet pre-exempted from the opening tax');
  assert.equal(lines[4], '🚩 name collides with 2 tokens after homoglyph normalisation');
  assert.equal(lines[5], 'round-trippers 2 of 2 buyers also sold');
  assert.equal(lines[6], 'via @vitalscheck_bot · signals only, not financial advice');
});

test('compact card: never shows more than two flag lines', () => {
  const flags = Array.from({ length: 6 }, (_, i) => flag(`f${i}`, 'raised', `detail ${i}`, i * 10));
  const r = makeScan({ flags });
  const lines = renderCompactText(r, 'b').split('\n');
  assert.equal(lines.filter((l) => l.startsWith('🚩')).length, 2);
});

test('compact card: shows the two HIGHEST severity raised flags', () => {
  const r = makeScan({ flags: [
    flag('low', 'raised', 'low sev', 1),
    flag('high', 'raised', 'high sev', 100),
    flag('mid', 'raised', 'mid sev', 50),
  ]});
  const top = topRaisedFlags(r, 2).map((f) => f.compactDetail);
  assert.deepEqual(top, ['high sev', 'mid sev']);
});

test('compact card: undetermined flags never occupy a flag line', () => {
  const r = makeScan({ flags: [
    flag('u1', 'unknown', 'undetermined thing', 900),
    flag('r1', 'raised', 'a real finding', 10),
  ]});
  const text = renderCompactText(r, 'b');
  assert.ok(text.includes('🚩 a real finding'));
  assert.ok(!text.includes('undetermined thing'), 'unknown flag must not be shown as a finding');
  assert.ok(text.includes('1 undetermined'), 'but it is still counted');
});

test('compact card: always shows traction, round-trippers and footer', () => {
  for (const over of [{ buyers: 0, roundTrippers: 0 }, { buyers: 5, roundTrippers: 0 }, { buyers: 9, roundTrippers: 9 }]) {
    const text = renderCompactText(makeScan(over), 'b');
    assert.ok(/^VITALS/m.test(text), 'header');
    assert.ok(text.includes('traction '), 'traction always present');
    assert.ok(text.includes('round-trippers'), 'round-trippers always present');
    assert.ok(text.trim().endsWith(COMPACT_DISCLAIMER), 'footer is last');
  }
});

test('compact card: zero buyers reads sensibly rather than "0 of 0"', () => {
  const text = renderCompactText(makeScan({ buyers: 0, roundTrippers: 0 }), 'b');
  assert.ok(text.includes('round-trippers — no buyers in the window'));
  assert.ok(!text.includes('0 of 0'));
});

test('compact card: HTML is escaped so a hostile ticker cannot inject markup', () => {
  const r = makeScan({ symbol: '<b>x</b>' });
  const html = renderCompactCard(r, 'b');
  // ticker() upper-cases, so the injected tag arrives as <B>...</B>
  assert.ok(html.includes('&lt;B&gt;X&lt;/B&gt;'), `ticker markup escaped, got: ${html.split('\n')[0]}`);
  assert.ok(!/\$<B>/.test(html), 'no raw tag survives into the ticker');
});

test('compact card: falls back to a short address when there is no symbol', () => {
  const r = makeScan({ symbol: null });
  const text = renderCompactText(r, 'b');
  assert.ok(text.startsWith('VITALS  0x147B…9E67'), text.split('\n')[0]);
});

test('compact card: stays within a group-friendly length', () => {
  const flags = Array.from({ length: 7 }, (_, i) => flag(`f${i}`, 'raised', `a fairly long flag description number ${i}`, i));
  const text = renderCompactText(makeScan({ flags }), 'vitalscheck_bot');
  assert.ok(text.split('\n').length <= 8, 'at most 8 lines');
});

// ---------------------------------------------------------------- inline description
test('inline description: summarises traction, flags and top flag', () => {
  const r = makeScan({ flags: [flag('snipe', 'raised', '1 wallet pre-exempted', 100)] });
  assert.equal(inlineDescription(compactMeta(r)), 'traction none · 1 flag · 1 wallet pre-exempted');
});

test('inline description: falls back to undetermined count with no raised flags', () => {
  const r = makeScan({ flags: [flag('u', 'unknown', 'unknown thing', 5)] });
  assert.equal(inlineDescription(compactMeta(r)), 'traction none · 0 flags · 1 undetermined');
});

test('inline description: not-found case', () => {
  assert.equal(inlineDescription({ notFound: true }), 'not a pons v2 launch on this chain');
});

test('inline description: truncated to a sane width', () => {
  const r = makeScan({ flags: [flag('x', 'raised', 'y'.repeat(300), 100)] });
  assert.ok(inlineDescription(compactMeta(r)).length <= 120);
});

// ---------------------------------------------------------------- output rules
test('output rules: compact card contains no prediction or trade language', () => {
  const banned = /price target|will pump|safe to buy|good entry|buy now|sell now|moon|to the moon|recommend/i;
  for (const over of [
    { traction: 'strong', buyers: 90, roundTrippers: 0, progressPct: 88 },
    { traction: 'none', buyers: 0, roundTrippers: 0 },
    { traction: 'building', buyers: 20, roundTrippers: 3, flags: [flag('a', 'raised', 'b', 1)] },
  ]) {
    const text = renderCompactText(makeScan(over), 'b');
    assert.ok(!banned.test(text), `banned language in: ${text}`);
  }
});

// ------------------------------------------------- regressions from review
test('regression: malformed cache config falls back instead of disabling limits', () => {
  const c = new ScanCache(NaN, NaN);
  for (const k of ['a', 'b', 'c']) c.set(k, entry(k));
  assert.equal(c.stats().ttlMs, 60_000, 'NaN TTL must not disable expiry');
  assert.equal(c.stats().maxEntries, 500, 'NaN cap must not disable eviction');
  const c2 = new ScanCache(-5, 0);
  assert.ok(c2.stats().ttlMs > 0 && c2.stats().maxEntries > 0, 'non-positive values rejected too');
});

test('regression: mutating a returned cache entry cannot poison the cache', () => {
  const c = new ScanCache(60_000, 10);
  c.set('a', entry(1));
  const first = c.get('a');
  first.card = 'TAMPERED';
  first.meta.traction = 'strong';
  const second = c.get('a');
  assert.equal(second.card, 'card1', 'card unchanged for the next reader');
  assert.equal(second.meta.traction, 'none', 'meta unchanged for the next reader');
});

test('regression: withDeadline(<=0) does not leave an unhandled rejection', async () => {
  const { withDeadline, DeadlineExceeded } = await import('../dist/service.js');
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  const doomed = new Promise((_, rej) => setTimeout(() => rej(new Error('late failure')), 10));
  await assert.rejects(() => withDeadline(doomed, 0), (e) => e instanceof DeadlineExceeded);
  await new Promise((r) => setTimeout(r, 60));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null, `abandoned promise produced an unhandled rejection: ${unhandled}`);
});
