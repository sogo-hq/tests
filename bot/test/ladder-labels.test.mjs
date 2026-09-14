/**
 * The buyer count and its median on every surface, under the ladder.
 *
 * The count is over the token's own window; the median is over a rung, which
 * can be a shorter window. What is pinned on the picture and the group card
 * is what the text card already pins: the count is labelled with its own
 * window, never the rung's, and when the two label differently the median
 * names its own rather than claiming the age.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('ladder-labels');
const { heroOf, measuresOf } = await import('../dist/image.js');
const { renderGroupCard } = await import('../dist/groupcard.js');
const { makeScan } = await import('./fixtures.mjs');

const scan = (ageSeconds, bench, buyers = 13) => {
  const r = makeScan({ ageSeconds, buyers, benchmarkMedian: bench.median ?? null, benchmarkN: bench.n ?? 0 });
  r.benchmark.windowMinutes = bench.windowMinutes;
  r.benchmark.measuredAtAge = bench.measuredAtAge ?? false;
  return r;
};

test('hero: the count carries the token window; a shorter rung is named on the median', () => {
  // 19.9 minutes old, the rung is 15: before this the headline said
  // "13 buyers in the first 15 min" for buyers counted over 19.9.
  const h = heroOf(scan(1194, { windowMinutes: 15, median: 9, n: 2031, measuredAtAge: false }));
  assert.equal(h.headline, '13 buyers in the first 20 min');
  assert.equal(h.reference, 'index median 9 over the first 15 min, 2,031 launches');
});

test('hero: same label, at this age', () => {
  const h = heroOf(scan(128, { windowMinutes: 2, median: 4, n: 2031, measuredAtAge: true }));
  assert.equal(h.headline, '13 buyers in the first 2 min');
  assert.equal(h.reference, 'index median 4 at this age over 2,031 launches');
});

test('hero: under the first rung, no "0 min" and the median says from when', () => {
  const h = heroOf(scan(20, { windowMinutes: 0, median: null, n: 0 }));
  assert.equal(h.headline, '13 buyers in the first 20s');
  assert.equal(h.reference, 'index median from 30s');
  assert.doesNotMatch(h.headline, /0 min/);
});

test('measures: the median names a shorter rung', () => {
  const m = measuresOf(scan(1194, { windowMinutes: 15, median: 9, n: 2031 })).find((x) => x.label === 'buyers');
  assert.equal(m.reference, 'index median 9 over first 15 min (n=2,031)');
  const same = measuresOf(scan(128, { windowMinutes: 2, median: 4, n: 2031 })).find((x) => x.label === 'buyers');
  assert.equal(same.reference, 'index median 4 (n=2,031)');
});

test('group card: the count names its window and the median names a shorter rung', () => {
  const g = renderGroupCard(scan(45, { windowMinutes: 0.5, median: 2, n: 900, measuredAtAge: true }));
  const line = g.text.split('\n').find((l) => /buyers in first/.test(l));
  assert.ok(line, 'no buyer line');
  assert.match(line, /^13 buyers in first 45s · index median 2 over first 30s \(n=900\)$/);
  const g2 = renderGroupCard(scan(128, { windowMinutes: 2, median: 4, n: 2031, measuredAtAge: true }));
  assert.match(g2.text.split('\n').find((l) => /buyers in first/.test(l)), /^13 buyers in first 2 min · index median 4 \(n=2,031\)$/);
});
