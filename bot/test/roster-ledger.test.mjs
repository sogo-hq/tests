/**
 * The share maths, the dust, and the two ways money gets paid twice.
 *
 * The one that matters most is the carry: rounding down leaves a remainder in
 * the wallet every run, and a remainder that is not picked up by the next run
 * is money quietly accumulating in an account nobody is watching.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('roster-ledger');
const R = await import('../dist/roster.js');
const L = await import('../dist/ledger.js');
const PP = await import('../dist/payplan.js');
const { db } = await import('../dist/db.js');

const W = (n) => '0x' + String(n).padStart(40, '0');
const ETH = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const reset = () => {
  for (const t of ['seats', 'seat_events', 'ledger_runs', 'ledger_payments']) db.prepare(`DELETE FROM ${t}`).run();
};
const seed = (t1, t2, t3) => {
  reset();
  let n = 0;
  for (const [tier, count] of [['T1', t1], ['T2', t2], ['T3', t3]]) {
    for (let i = 0; i < count; i++) { n++; R.addSeat(`${tier.toLowerCase()}_${i + 1}`, tier, W(n), { at: 1000 }); }
  }
  return n;
};

// ------------------------------------------------------------ share maths

test('a mixed roster adds its shares the way the tiers say', () => {
  seed(4, 6, 10);
  assert.equal(R.totalShares(), 42);
  assert.deepEqual(R.TIER_SHARES, { T1: 5, T2: 2, T3: 1 });
  const run = L.computeRun({ balanceWei: ETH(10), paidBeforeWei: 0n });
  assert.equal(run.totalShares, 42);
  assert.equal(L.eth(run.poolWei), '1.0000');
  assert.equal(L.eth(run.perShareWei), '0.0238');
  const byTier = (t) => run.rows.filter((r) => r.tier === t);
  assert.equal(L.eth(byTier('T1')[0].amountWei), '0.1190');
  assert.equal(L.eth(byTier('T2')[0].amountWei), '0.0476');
  assert.equal(L.eth(byTier('T3')[0].amountWei), '0.0238');
  assert.equal(L.eth(run.distributedWei), '0.9996');
  assert.equal(L.eth(run.dustWei, 6), '0.000400');
  // Every payout is the per-share amount times the shares, with nothing lost
  // between the table and the total.
  assert.equal(run.rows.reduce((a, r) => a + r.amountWei, 0n), run.distributedWei);
  assert.equal(run.distributedWei + run.dustWei, run.poolWei);
});

test('shares are stored, so changing what a tier is worth does not rewrite a past run', () => {
  seed(1, 1, 0);
  const before = L.computeRun({ balanceWei: ETH(10), paidBeforeWei: 0n });
  const id = L.saveRun(before);
  assert.equal(before.totalShares, 7);
  // A promotion changes the next run, not the one already computed.
  const r = R.setTier('t2_1', 'T1', { at: 2000 });
  assert.equal(r.ok, true);
  assert.equal(R.totalShares(), 10);
  const after = L.computeRun({ balanceWei: ETH(10), paidBeforeWei: 0n });
  assert.equal(after.totalShares, 10);
  const stored = L.loadRun(id);
  assert.equal(stored.totalShares, 7, 'a stored run changed when a tier did');
  assert.equal(stored.rows.find((x) => x.handle === 't2_1').shares, 2);
  // And the change is in the history, with what it was before.
  const ev = R.seatHistory().filter((e) => e.event === 'tier');
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].fromTier, ev[0].toTier], ['T2', 'T1']);
});

test('a freed seat keeps its history and its number comes round again', () => {
  seed(0, 0, 3);
  assert.deepEqual(R.liveSeats().map((s) => s.seat), [1, 2, 3]);
  assert.equal(R.removeSeat('t3_2', { at: 3000 }).ok, true);
  assert.deepEqual(R.liveSeats().map((s) => s.seat), [1, 3]);
  assert.equal(R.totalShares(), 2, 'a freed seat is not paid');
  const added = R.addSeat('newcomer', 'T1', W(90), { at: 4000 });
  assert.equal(added.ok, true);
  assert.equal(added.value.seat, 2, 'the freed number was not reused');
  // Both occupants are in the history of seat 2.
  const ev = R.seatHistory(2);
  assert.deepEqual(ev.map((e) => [e.handle, e.event]), [['t3_2', 'add'], ['t3_2', 'remove'], ['newcomer', 'add']]);
});

test('a handle or a wallet cannot hold two seats at once', () => {
  seed(0, 0, 1);
  assert.match(R.addSeat('t3_1', 'T2', W(77)).reason, /already holds seat 1/);
  assert.match(R.addSeat('someone', 'T2', W(1)).reason, /wallet already holds seat 1/);
  // After leaving, the handle may come back.
  R.removeSeat('t3_1', { at: 5000 });
  assert.equal(R.addSeat('t3_1', 'T1', W(1)).ok, true);
});

test('a bad tier, handle or wallet is refused by name', () => {
  reset();
  assert.match(R.addSeat('ok', 'T4', W(1)).reason, /not a tier/);
  assert.match(R.addSeat('a', 'T1', W(1)).reason, /not a handle/);
  assert.match(R.addSeat('ok', 'T1', 'nope').reason, /not a wallet/);
  assert.match(R.setTier('ghost', 'T1').reason, /does not hold a seat/);
  assert.match(R.removeSeat('ghost').reason, /does not hold a seat/);
});

// --------------------------------------------------------------- the dust

test('the dust stays in the wallet and goes out with the next run', () => {
  seed(4, 6, 10);
  const one = L.computeRun({ balanceWei: ETH(10), paidBeforeWei: 0n });
  const id = L.saveRun(one);
  assert.equal(L.eth(one.dustWei, 6), '0.000400');

  // Paid: the hashes come back, so this is now money that has left.
  L.recordTxs(id, one.rows.map((r) => ({ seat: r.seat, txHash: '0x' + String(r.seat).padStart(64, '0') })));
  assert.equal(L.paidOutWei(), one.distributedWei);

  // The wallet took nothing further in, so its balance is what it was less
  // what went out. The dust is still sitting in it.
  const balanceNow = ETH(10) - one.distributedWei;
  const two = L.computeRun({ balanceWei: balanceNow, paidBeforeWei: 0n });
  assert.equal(two.remainderWei, balanceNow);

  // As the ledger actually runs it: the live balance, less what has been paid.
  // Only a tenth went out, so most of the remainder is simply the nine tenths
  // that were never up for distribution. What matters is that the dust is
  // inside it and not stranded, which is the difference between the new
  // remainder and the nine tenths.
  const carried = L.computeRun({ balanceWei: ETH(10), paidBeforeWei: L.paidOutWei() });
  const ninetenths = ETH(10) - one.poolWei;
  assert.equal(carried.remainderWei - ninetenths, one.dustWei, 'the dust was not carried into the next run');
  assert.equal(carried.remainderWei + one.distributedWei, ETH(10), 'the wallet is fully accounted for');

  // And it goes out: the second pool is a tenth of a remainder that includes it.
  assert.equal(carried.poolWei, carried.remainderWei / 10n);
  assert.ok(carried.poolWei > ninetenths / 10n, 'the second pool does not include the first run\'s dust');
});

test('what has been paid is what has a hash, not what was once computed', () => {
  seed(1, 0, 0);
  const run = L.computeRun({ balanceWei: ETH(10) });
  const id = L.saveRun(run);
  assert.equal(L.paidOutWei(), 0n, 'a computed run is not money that left');
  assert.equal(L.unrecordedRuns().length, 1);
  L.recordTxs(id, [{ seat: run.rows[0].seat, txHash: '0x' + 'a'.repeat(64) }]);
  assert.equal(L.paidOutWei(), run.distributedWei);
  assert.equal(L.unrecordedRuns().length, 0, 'a fully recorded run is not outstanding');
});

test('a hash is never overwritten, and an unknown seat is reported', () => {
  seed(1, 0, 0);
  const run = L.computeRun({ balanceWei: ETH(10) });
  const id = L.saveRun(run);
  const seat = run.rows[0].seat;
  const first = L.recordTxs(id, [{ seat, txHash: '0x' + 'a'.repeat(64) }]);
  assert.equal(first.recorded, 1);
  const second = L.recordTxs(id, [{ seat, txHash: '0x' + 'b'.repeat(64) }, { seat: 99, txHash: '0x' + 'c'.repeat(64) }]);
  assert.equal(second.recorded, 0, 'a second hash overwrote the first');
  assert.deepEqual(second.already.map((a) => a.txHash), ['0x' + 'a'.repeat(64)]);
  assert.deepEqual(second.unknown, [99]);
  assert.equal(L.paidOutWei(), run.distributedWei, 'the amount was counted twice');
});

test('a balance below what was paid distributes nothing rather than a negative', () => {
  seed(1, 0, 0);
  const run = L.computeRun({ balanceWei: ETH(1), paidBeforeWei: ETH(5) });
  assert.equal(run.remainderWei, 0n);
  assert.equal(run.poolWei, 0n);
  assert.equal(run.perShareWei, 0n);
  assert.equal(run.rows[0].amountWei, 0n);
});

test('no seats means no division by zero', () => {
  reset();
  const run = L.computeRun({ balanceWei: ETH(10) });
  assert.equal(run.totalShares, 0);
  assert.equal(run.perShareWei, 0n);
  assert.deepEqual(run.rows, []);
  assert.equal(run.dustWei, run.poolWei);
});

// -------------------------------------------------------- double payment

test('a row that already went out is never sent again, and keeps its nonce', () => {
  const rows = [
    { wallet: W(1), amountEth: '0.1190', amountWei: ETH(0.119) },
    { wallet: W(2), amountEth: '0.0476', amountWei: ETH(0.0476) },
    { wallet: W(3), amountEth: '0.0238', amountWei: ETH(0.0238) },
  ];
  const first = PP.buildPlan({ runId: '7', from: W(50), rows, baseNonce: 12 });
  assert.equal(first.ok, true);
  assert.deepEqual(first.plan.entries.map((e) => e.nonce), [12, 13, 14]);

  // The first two land, then the run dies.
  first.plan.entries[0].status = 'sent'; first.plan.entries[0].txHash = '0x' + '1'.repeat(64);
  first.plan.entries[1].status = 'sent'; first.plan.entries[1].txHash = '0x' + '2'.repeat(64);
  const stored = PP.planFromJson(PP.planToJson(first.plan));

  // Resumed later, when the chain's pending nonce has moved on.
  const again = PP.buildPlan({ runId: '7', from: W(50), rows, baseNonce: 14, stored });
  assert.equal(again.ok, true);
  assert.equal(again.resumed, true);
  const todo = PP.unsent(again.plan);
  assert.deepEqual(todo.map((e) => e.wallet), [W(3)], 'a row that was already sent came back around');
  assert.equal(todo[0].nonce, 14, 'the nonce was recomputed instead of reused');
  assert.deepEqual(again.plan.entries.map((e) => e.nonce), [12, 13, 14],
    'the sent rows kept the nonces that paid them, which is what stops a second payment');
  assert.equal(PP.totalWei(PP.unsent(again.plan)), ETH(0.0238));
});

test('a stored plan that does not match the file is refused, never merged', () => {
  const rows = [{ wallet: W(1), amountEth: '0.1', amountWei: ETH(0.1) }];
  const stored = PP.buildPlan({ runId: '7', from: W(50), rows, baseNonce: 1 }).plan;
  const changed = [{ wallet: W(1), amountEth: '0.2', amountWei: ETH(0.2) }];
  assert.match(PP.buildPlan({ runId: '7', from: W(50), rows: changed, baseNonce: 1, stored }).reason, /does not match/);
  const extra = [...rows, { wallet: W(2), amountEth: '0.1', amountWei: ETH(0.1) }];
  assert.match(PP.buildPlan({ runId: '7', from: W(50), rows: extra, baseNonce: 1, stored }).reason, /1 rows and the file has 2/);
  assert.match(PP.buildPlan({ runId: '7', from: W(51), rows, baseNonce: 1, stored }).reason, /made for/);
});

test('the csv is parsed strictly: a bad row stops the run rather than being skipped', () => {
  const good = PP.parsePayCsv('wallet,amount\n' + `${W(1)},0.1190\n${W(2)},0.0476\n`);
  assert.equal(good.ok, true);
  assert.equal(good.rows.length, 2);
  assert.equal(PP.totalWei(good.rows), ETH(0.1666));

  const dup = PP.parsePayCsv(`wallet,amount\n${W(1)},0.1\n${W(1)},0.2\n`);
  assert.equal(dup.ok, false);
  assert.match(dup.errors[0], /already on line 2/);

  const bad = PP.parsePayCsv(`wallet,amount\nnope,0.1\n${W(2)},abc\n${W(3)},0\n`);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 3, bad.errors.join('; '));
  assert.equal(PP.parsePayCsv('').ok, false);
});

test('the line pasted back into the bot names wallets, which the bot resolves to seats', () => {
  const rows = [{ wallet: W(1), amountEth: '0.1', amountWei: ETH(0.1) }];
  const plan = PP.buildPlan({ runId: '3', from: W(50), rows, baseNonce: 0 }).plan;
  assert.match(PP.recordCommand(plan), /nothing was sent/);
  plan.entries[0].status = 'sent';
  plan.entries[0].txHash = '0x' + 'f'.repeat(64);
  assert.equal(PP.recordCommand(plan), `/ledger tx 3 ${W(1)}:0x${'f'.repeat(64)}`);
});
