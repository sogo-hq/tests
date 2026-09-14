/**
 * The curve-life pass for graduated launches.
 *
 * What is pinned is the property the re-review caught: the pass records its
 * read in its own column, and the buyer benchmark's population, keyed on
 * trades_indexed_to, does not change by one launch because a graduated launch
 * was read. Outcome-selected launches enrolled in the reference figure would
 * move every card's "index median" up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('graduated-curves');
const { db } = await import('../dist/db.js');
const W = await import('../dist/indexer/windows.js');
const { buyerBenchmark } = await import('../dist/metrics/benchmark.js');

const A = (n) => '0x' + String(n).padStart(40, '0');
const NOW = 1_000_000;
const launch = (n, { phase = 2, block = 1000, sweptAt = null, graduatedAt = null, tradesTo = null, curveTo = null } = {}) => {
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id, graduation_threshold,
       block_number, tx_hash, launched_at, phase, swept_at, graduated_at, trades_indexed_to, curve_indexed_to)
     VALUES (?,?,?,?,0,'0',?,?,?,?,?,?,?,?)`,
  ).run(A(n), A(99), A(98), A(0), block, '0xtx' + n, NOW - 86_400, phase, sweptAt, graduatedAt, tradesTo, curveTo);
};

test('selection: graduated, with a sweep or graduation block, not yet read to it; newest first', () => {
  launch(1, { sweptAt: 5000, graduatedAt: 5002 });             // unread
  launch(2, { sweptAt: 9000, curveTo: 8999 });                 // read one short of the sweep
  launch(3, { sweptAt: 7000, curveTo: 7000 });                 // read in full
  launch(4, { graduatedAt: 6000 });                            // no sweep block: the graduation block bounds it
  launch(5, { phase: 1, sweptAt: 8000 });                      // swept, not graduated
  launch(6, { phase: 2 });                                     // graduated per the chain, no block yet
  launch(7, { sweptAt: 4000, tradesTo: 4000 });                // the sample reached the sweep, still counted here
  assert.deepEqual(W.unreadGraduated(10).map((t) => t.token), [A(2), A(4), A(1), A(7)]);
  assert.equal(W.graduatedUnreadCount(), 4);
});

test('the read range resumes past either read and stops at head', () => {
  const t = { token: A(1), curve: A(99), block_number: 1000, trades_indexed_to: null, curve_indexed_to: null, curve_end: 5000 };
  assert.deepEqual(W.graduatedReadRange(t, 9000), { from: 1000, to: 5000 });
  assert.deepEqual(W.graduatedReadRange({ ...t, trades_indexed_to: 1600 }, 9000), { from: 1601, to: 5000 });
  assert.deepEqual(W.graduatedReadRange({ ...t, trades_indexed_to: 1600, curve_indexed_to: 3000 }, 9000), { from: 3001, to: 5000 });
  assert.deepEqual(W.graduatedReadRange(t, 4000), { from: 1000, to: 4000 }, 'a sweep past head is read to head, and again next time');
  assert.equal(W.graduatedReadRange({ ...t, curve_indexed_to: 5000 }, 9000), null);
  assert.equal(W.graduatedReadRange(t, 999), null, 'nothing to read before the launch block');
});

test('marking a curve life read does not enrol the launch in the buyer benchmark', () => {
  // A sampled population of 40 launches with a full 30-minute window.
  for (let i = 100; i < 140; i++) launch(i, { phase: 0, tradesTo: 1000 + 18_000 });
  const before = buyerBenchmark({ ageSeconds: 86_400, windowMinutes: 30, excludeToken: A(999) });
  assert.equal(before.n, 40);
  W.markCurveIndexed(A(1), 5000);
  W.markCurveIndexed(A(2), 9000);
  const after = buyerBenchmark({ ageSeconds: 86_400, windowMinutes: 30, excludeToken: A(999) });
  assert.equal(after.n, before.n, 'a graduated launch joined the reference population because it was read');
  const row = db.prepare('SELECT trades_indexed_to, curve_indexed_to FROM launches WHERE token = ?').get(A(1));
  assert.equal(row.trades_indexed_to, null, 'the population key was written');
  assert.equal(row.curve_indexed_to, 5000);
  // Read in full now, so the pass leaves it alone.
  assert.ok(!W.unreadGraduated(10).some((t) => t.token === A(1)));
  assert.ok(!W.unreadGraduated(10).some((t) => t.token === A(2)));
});
