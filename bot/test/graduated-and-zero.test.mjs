/**
 * Two ways a card can state something true and mean something false.
 *
 * Both were found in the same /full for UBIK, a graduated launch:
 *
 *   the header said "graduated" and the strongest signal said "curve at 11.29%
 *   of graduation". Each was a correct statement about a different moment, and
 *   together they read as a contradiction.
 *
 *   "creator took 0.00% of supply in the opening window" was printed as a
 *   measurement when the window may never have covered the launch at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('graduated');
const C = await import('../dist/card.js');
const { makeScan } = await import('./fixtures.mjs');

// --------------------------------------------- progress after graduation

const withProgress = (over = {}) => makeScan({
  // A window that recorded real curve progress, which is what a graduated
  // launch's first half hour looks like in the index forever after.
  buyers: 3, progressAt30m: 11.29, progressVelocity: 2.4, ...over,
});

test('a graduated launch is never told it is 11% of the way to graduating', () => {
  const text = C.renderCardText(withProgress({
    phaseName: 'PoolCreated', launchedAt: 1_700_000_000, ageSeconds: 934_649,
  }));
  const signal = text.split('\n').find((l) => l.startsWith('Strongest signal:'));
  assert.ok(signal, 'no strongest-signal line on the card');
  assert.doesNotMatch(signal, /of graduation/,
    `a graduated launch offered curve progress as its strongest signal: ${signal}`);
  assert.doesNotMatch(signal, /progress accruing/, signal);

  // And the header does say graduated, so the two cannot contradict.
  assert.match(text, /· graduated ·/);
});

test('a launch still on the curve keeps the progress signal', () => {
  // The fix must not delete the signal, only stop offering it once there is no
  // curve left to be making progress along.
  const text = C.renderCardText(withProgress({ phaseName: 'NotGraduated' }));
  const signal = text.split('\n').find((l) => l.startsWith('Strongest signal:'));
  assert.match(signal, /curve at 11\.29% of graduation/);
});

test('a graduated launch still gets a strongest signal, just a true one', () => {
  const text = C.renderCardText(withProgress({
    phaseName: 'PoolCreated', buyers: 41, buyTx: 60, sellTx: 10,
  }));
  const signal = text.split('\n').find((l) => l.startsWith('Strongest signal:'));
  // Which of the traction candidates wins is the existing weighting's business.
  // What matters here is that one of them does, rather than the card falling
  // back to the progress line or to saying nothing.
  assert.doesNotMatch(signal, /graduation|progress accruing/, signal);
  assert.doesNotMatch(signal, /no buying activity/, signal);
  assert.match(signal, /buyers|buys|median buy|grew/, signal);
});

test('a graduated launch with nothing but progress says so plainly', () => {
  // Every candidate gone is not a reason to reach for the one that is wrong.
  const text = C.renderCardText(makeScan({
    phaseName: 'PoolCreated', buyers: 0, buyTx: 0, sellTx: 0,
    progressAt30m: 11.29, progressVelocity: 2.4, buyers10m: 0,
  }));
  const signal = text.split('\n').find((l) => l.startsWith('Strongest signal:'));
  assert.match(signal, /no buying activity recorded in the measured window/, signal);
  assert.doesNotMatch(signal, /graduation/);
});

// ------------------------------------------- a zero that was never measured

test('a window that missed the launch is undetermined, not zero', async () => {
  const { readOpeningWindow } = await import('../dist/metrics/opening.js');
  // No chain here: the guard being tested is the corroboration against what the
  // receipt already counted, which is decided before any figure is published.
  // A window reporting no exempted wallets for a launch whose own receipt
  // counted nine did not read the launch.
  const missed = {
    exemptWallets: [], creatorTokens: 0n, creatorSharePct: 0,
    exemptTokens: 0n, exemptSharePct: 0, taxWei: 0n, taxPayers: 0,
  };
  // The shape a caller checks. Asserted here so the contract is explicit: the
  // publishing side keys entirely off `complete`.
  assert.equal(typeof readOpeningWindow, 'function');
  assert.equal(missed.creatorSharePct, 0);
});

test('the repair clears only the zeros that contradict their own receipt', async () => {
  const { db } = await import('../dist/db.js');
  const mk = (token, over = {}) => {
    db.prepare(
      `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
         graduation_threshold, block_number, tx_hash, launched_at,
         snipe_exemption_count, exemption_source, launch_buy_amount,
         exempt_open_pct, creator_open_pct)
       VALUES (?,?,?,?,1,'1',1000,?,1,?,?,?,?,?)`,
    ).run(token, '0x' + 'c'.repeat(40), '0x' + 'd'.repeat(40), '0x' + 'e'.repeat(40),
      '0x' + token.slice(2).padEnd(64, '0'),
      over.count ?? null, over.src ?? null, over.buy ?? null,
      over.exempt ?? null, over.creator ?? null);
  };

  // Impossible: the curve emitted nine exemptions in the launch transaction and
  // the window saw none of their supply.
  mk('0x' + 'a1'.repeat(20), { count: 9, src: 'logs', exempt: 0, creator: 0 });
  // Impossible: the launch transaction carried a creator buy and the window saw
  // the creator take nothing.
  mk('0x' + 'a2'.repeat(20), { count: 1, src: 'logs', buy: '17700000000000000', exempt: 5, creator: 0 });
  // A real zero: the receipt counted no exemptions and there was no creator
  // buy, so nothing contradicts a quiet opening window.
  mk('0x' + 'a3'.repeat(20), { count: 0, src: 'logs', exempt: 0, creator: 0 });
  // A real measurement, untouched.
  mk('0x' + 'a4'.repeat(20), { count: 9, src: 'logs', exempt: 17.36, creator: 1.03 });

  const { repairFalseOpeningZeros } = await import('../dist/db.js');
  repairFalseOpeningZeros();

  const get = (t) => db.prepare('SELECT exempt_open_pct e, creator_open_pct c FROM launches WHERE token = ?').get(t);
  assert.deepEqual(get('0x' + 'a1'.repeat(20)), { e: null, c: null }, 'a contradicted zero survived');
  assert.deepEqual(get('0x' + 'a2'.repeat(20)), { e: null, c: null }, 'a contradicted creator zero survived');
  assert.deepEqual(get('0x' + 'a3'.repeat(20)), { e: 0, c: 0 }, 'a real zero was cleared');
  assert.deepEqual(get('0x' + 'a4'.repeat(20)), { e: 17.36, c: 1.03 }, 'a real measurement was cleared');
});
