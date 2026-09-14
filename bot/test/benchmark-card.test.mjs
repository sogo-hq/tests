/**
 * The buyer line on the ladder.
 *
 * The benchmark window is a rung and the token's own window is its exact age,
 * so the two can label differently. What is pinned: the line never claims "at
 * this age" over a window the head did not state, never prints n=0 as if the
 * index were empty, and says from when a comparison exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('benchmark-card');
const { buyerLine, windowLabel } = await import('../dist/card.js');
const { makeScan } = await import('./fixtures.mjs');

const withBench = (ageSeconds, bench, buyers = 13) => {
  const r = makeScan({ ageSeconds, buyers, benchmarkMedian: bench.median ?? null, benchmarkN: bench.n ?? 0 });
  r.benchmark.windowMinutes = bench.windowMinutes;
  r.benchmark.measuredAtAge = bench.measuredAtAge ?? false;
  return r;
};

test('below the first rung the line says from when a comparison exists', () => {
  const r = withBench(20, { windowMinutes: 0, median: null, n: 0 });
  const line = buyerLine(r);
  assert.match(line, /index median from 30s$/);
  assert.doesNotMatch(line, /n=0/, 'an n of zero reads as an empty index, and it is not');
});

test('same rung as the age: "at this age", window named once', () => {
  // 2m08s old: head says "first 2 min", the rung is 2 min, labels agree.
  const r = withBench(128, { windowMinutes: 2, median: 4, n: 2031, measuredAtAge: true });
  const line = buyerLine(r);
  assert.match(line, /13 buyers in first 2 min · index median 4 at this age \(n=2,031\)/);
});

test('a rung below the head label names its own window rather than claiming the age', () => {
  // 45s old: head says "first 45s", the rung is 30s. The median must say so.
  const r = withBench(45, { windowMinutes: 0.5, median: 2, n: 900, measuredAtAge: true });
  const line = buyerLine(r);
  assert.match(line, /13 buyers in first 45s · index median 2 over first 30s \(n=900\)/);
  assert.doesNotMatch(line, /at this age/);
});

test('past the cap it is a first-30-minutes measurement, never "at this age"', () => {
  const r = withBench(7200, { windowMinutes: 30, median: 9, n: 1500, measuredAtAge: false });
  const line = buyerLine(r);
  assert.match(line, /index median 9 \(n=1,500\)/);
  assert.doesNotMatch(line, /at this age/);
});

test('the shared label spells a fraction of a minute in seconds', () => {
  assert.equal(windowLabel(0.5), '30s');
  assert.equal(windowLabel(2), '2 min');
  assert.equal(windowLabel(2.13), '2 min');
});
