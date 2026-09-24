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

test('a mixed roster is paid equally, whatever its tiers are worth on the roster', () => {
  seed(4, 6, 10);
  // The roster still adds tier shares, because the roster still records a
  // tier. Nothing in the payout path below reads either of them.
  assert.equal(R.totalShares(), 42);
  assert.deepEqual(R.TIER_SHARES, { T1: 5, T2: 2, T3: 1 });

  const run = L.computeRun({ balanceWei: ETH(10.01), paidToDateWei: 0n });
  assert.equal(run.totalShares, 20, 'the payout weight is one per seat, not the tier total');
  assert.equal(L.eth(run.poolWei), '1.0010');
  assert.equal(L.eth(run.perShareWei), '0.0500');
  // One amount, on every row, whatever tier the row carries.
  assert.equal(new Set(run.rows.map((r) => String(r.amountWei))).size, 1);
  for (const t of ['T1', 'T2', 'T3']) {
    assert.equal(L.eth(run.rows.find((r) => r.tier === t).amountWei), '0.0500', t);
  }
  assert.deepEqual([...new Set(run.rows.map((r) => r.shares))], [1]);
  assert.equal(L.eth(run.distributedWei), '1.0000');
  assert.equal(L.eth(run.dustWei, 6), '0.001000');
  // Nothing is lost between the table and the total.
  assert.equal(run.rows.reduce((a, r) => a + r.amountWei, 0n), run.distributedWei);
  assert.equal(run.distributedWei + run.dustWei, run.poolWei);
});

test('a tier is a label: changing one moves nobody money, then or now', () => {
  seed(1, 1, 0);
  const before = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  const id = L.saveRun(before);
  assert.equal(before.totalShares, 2, 'two seats, one share each');
  const [a, b] = before.rows;
  assert.equal(a.amountWei, b.amountWei);

  // A promotion changes what the roster prints, and nothing that is paid.
  const r = R.setTier('t2_1', 'T1', { at: 2000 });
  assert.equal(r.ok, true);
  assert.equal(R.totalShares(), 10, 'the roster still adds tier shares');
  const after = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(after.totalShares, 2);
  assert.deepEqual(after.rows.map((x) => String(x.amountWei)), before.rows.map((x) => String(x.amountWei)));

  const stored = L.loadRun(id);
  assert.equal(stored.totalShares, 2, 'a stored run changed when a tier did');
  assert.equal(stored.rows.find((x) => x.handle === 't2_1').shares, 1);
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

test('four runs: new income moves the pool, a sweep does not, and nothing is paid twice', () => {
  seed(4, 6, 10);
  const paid = (r) => r.rows.reduce((a, x) => a + x.amountWei, 0n);

  // Run 1. A wallet holding 10.01 ETH, nothing ever paid, nothing ever swept.
  // Not a round ten: twenty seats divide a tenth of ten exactly, and a pool
  // that divides exactly leaves no dust for the carry below to carry.
  const one = L.computeRun({ balanceWei: ETH(10.01), paidToDateWei: 0n, sweptToDateWei: 0n });
  assert.equal(L.eth(one.grossIncomeWei), '10.0100');
  assert.equal(L.eth(one.poolTargetWei), '1.0010');
  assert.equal(L.eth(one.poolWei), '1.0010');
  assert.equal(L.eth(one.perShareWei), '0.0500');
  assert.equal(L.eth(one.distributedWei), '1.0000');
  assert.equal(L.eth(one.dustWei, 6), '0.001000');

  // Paid, out of this same wallet. Gas is zero in this test so the figures
  // are the ones the model is specified with; gas is exercised on its own.
  const paidOne = paid(one);
  const balTwo = ETH(10.01) - paidOne;
  assert.equal(L.eth(balTwo), '9.0100');

  // Run 2. No new fees at all. Gross income has not moved, so the room is
  // owed nothing further except the dust run 1 could not divide.
  const two = L.computeRun({ balanceWei: balTwo, paidToDateWei: paidOne, sweptToDateWei: 0n });
  assert.equal(L.eth(two.grossIncomeWei), '10.0100', 'gross income moved without any income');
  assert.equal(L.eth(two.poolTargetWei), '1.0010');
  assert.equal(two.poolWei, one.dustWei, 'run 2 pays for income the room was already paid for');
  assert.equal(L.eth(two.poolWei, 6), '0.001000');
  // 0.0010 over twenty seats is under the 0.0001 ETH a payout is rounded to.
  assert.equal(two.perShareWei, 0n);
  assert.equal(two.distributedWei, 0n, 'something was sent below the printed precision');
  assert.equal(two.dustWei, two.poolWei, 'the dust stays whole and waits');
  assert.match(L.previewText(two), /under the 0\.0001 ETH a payout is rounded to\. nothing is sent/);

  // Run 3. Five ETH of new fees arrive; run 2 sent nothing.
  const balThree = balTwo + ETH(5);
  const three = L.computeRun({ balanceWei: balThree, paidToDateWei: paidOne, sweptToDateWei: 0n });
  assert.equal(L.eth(three.grossIncomeWei), '15.0100');
  assert.equal(L.eth(three.poolTargetWei), '1.5010');
  // A tenth of the new five, plus the dust the earlier runs could not divide.
  assert.equal(L.eth(three.poolWei, 6), '0.501000');
  assert.equal(three.poolWei, ETH(0.5) + one.dustWei, 'the carried dust is not in the pool');
  assert.equal(L.eth(three.perShareWei), '0.0250');
  assert.equal(L.eth(three.distributedWei), '0.5000');

  // Run 4. Eight ETH is swept out to the treasury. Run 3 was not paid.
  const swept = ETH(8);
  const balFour = balThree - swept;
  const four = L.computeRun({ balanceWei: balFour, paidToDateWei: paidOne, sweptToDateWei: swept });
  assert.equal(L.eth(four.balanceWei), '6.0100');
  assert.equal(L.eth(four.sweptToDateWei), '8.0000');
  assert.equal(L.eth(four.grossIncomeWei), '15.0100', 'a sweep changed gross income');
  assert.equal(four.poolWei, three.poolWei, 'the sweep moved the pool');
  assert.equal(four.refusal, null);
  assert.equal(L.eth(four.distributedWei), '0.5000');

  // And the arithmetic is visible, every term of it.
  const text = L.previewText(four);
  assert.match(text, /fee wallet balance\s+6\.0100 ETH/);
  assert.match(text, /paid out to date\s+\+ 1\.0000 ETH, payout values and their gas/);
  assert.match(text, /swept to date\s+\+ 8\.0000 ETH, moved out by hand and recorded/);
  assert.match(text, /gross income\s+= 15\.0100 ETH/);
  assert.match(text, /the room's 10%\s+1\.5010 ETH of it, in total, ever/);
  assert.match(text, /pool now\s+= 0\.5010 ETH/);
  assert.match(text, /equal split, 20 seats held today/);
});

test('a pool larger than the wallet is refused, and says what to do about it', () => {
  seed(4, 6, 10);
  // Ten ETH came in and nine and a half of it was swept out before the room
  // was paid its tenth. The room is owed 1 ETH and 0.5 is there.
  const run = L.computeRun({ balanceWei: ETH(0.5), paidToDateWei: 0n, sweptToDateWei: ETH(9.5) });
  assert.equal(L.eth(run.grossIncomeWei), '10.0000');
  assert.equal(L.eth(run.poolWei), '1.0000');
  assert.ok(run.refusal, 'a pool bigger than the wallet was not refused');
  assert.match(run.refusal, /the pool is 1\.0000 ETH and the fee wallet holds 0\.5000 ETH/);
  assert.match(run.refusal, /0\.5000 ETH more is owed than is there/);
  assert.match(run.refusal, /move it back/);
  // Nothing is payable, rather than a smaller table that looks payable.
  assert.equal(run.perShareWei, 0n);
  assert.equal(run.distributedWei, 0n);
  const text = L.previewText(run);
  assert.match(text, /REFUSED: the pool is 1\.0000 ETH/);
  assert.match(text, /nothing is payable until that is settled/);
  assert.doesNotMatch(text, /seat {2}handle/, 'a refused run printed a payout table');
});

test('gas counts on both sides: it left the wallet, and the room bears it', () => {
  seed(1, 0, 0);
  const gas = ETH(0.001);
  // A payout of 1 ETH that cost 0.001 to send: 1.001 left the wallet.
  const run = L.computeRun({ balanceWei: ETH(9), paidToDateWei: ETH(1) + gas, sweptToDateWei: 0n });
  assert.equal(L.eth(run.grossIncomeWei, 6), '10.001000', 'the gas is missing from gross income');
  assert.equal(L.eth(run.poolTargetWei, 6), '1.000100');
  // The room is owed a tenth of the gas too, and has already had it spent on
  // its behalf, so the pool is the target less the whole 1.001.
  assert.equal(run.poolWei, 0n, 'the room was paid twice for the gas of paying it');
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

test('an empty wallet pays nothing, and a room already paid its share is not owed a negative', () => {
  seed(1, 0, 0);
  const empty = L.computeRun({ balanceWei: 0n, paidToDateWei: 0n, sweptToDateWei: 0n });
  assert.equal(empty.grossIncomeWei, 0n);
  assert.equal(empty.poolWei, 0n);
  assert.equal(empty.rows[0].amountWei, 0n);
  assert.equal(empty.refusal, null, 'nothing owed and nothing there is not a shortfall');

  // Paid far more than a tenth of everything that ever came in. The pool is
  // nothing, not a debt to be collected back out of the room.
  const overpaid = L.computeRun({ balanceWei: ETH(1), paidToDateWei: ETH(5), sweptToDateWei: 0n });
  assert.equal(L.eth(overpaid.grossIncomeWei), '6.0000');
  assert.equal(L.eth(overpaid.poolTargetWei), '0.6000');
  assert.equal(overpaid.poolWei, 0n, 'a pool went negative');
  assert.equal(overpaid.refusal, null);
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

// ------------------------------------------------------- the burner rehearsal

test('the burner sends dust to three recipients derived from its own address', async () => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const burner = '0x357888ee9a318B33F5916eceF4b6558D9216a476';
  const keys = PP.burnerRecipientKeys(burner);
  assert.equal(keys.length, 3);
  const addrs = keys.map((k) => privateKeyToAccount(k).address);
  // Deterministic, so a resumed run targets the same three and the nonce
  // guard has something to be right about.
  assert.deepEqual(PP.burnerRecipientKeys(burner).map((k) => privateKeyToAccount(k).address), addrs);
  // And tied to the burner: a different key rehearses to different addresses.
  assert.notDeepEqual(PP.burnerRecipientKeys('0x' + '9'.repeat(40)).map((k) => privateKeyToAccount(k).address), addrs);
  assert.equal(new Set(addrs).size, 3, 'two recipients came out the same');

  // The CSV it writes is read back by the same parser a real run uses.
  const csv = PP.burnerCsv(addrs, PP.BURNER_DEFAULT_AMOUNT_WEI);
  const parsed = PP.parsePayCsv(csv);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '));
  assert.equal(PP.totalWei(parsed.rows), PP.BURNER_DEFAULT_AMOUNT_WEI * 3n);
});

test('a burner run that is not dust is refused', () => {
  assert.equal(PP.checkBurnerTotal(PP.BURNER_DEFAULT_AMOUNT_WEI * 3n).ok, true);
  assert.equal(PP.checkBurnerTotal(PP.BURNER_MAX_TOTAL_WEI).ok, true);
  const over = PP.checkBurnerTotal(PP.BURNER_MAX_TOTAL_WEI + 1n);
  assert.equal(over.ok, false);
  assert.match(over.reason, /over the 0\.001 ETH ceiling/);
  assert.match(PP.checkBurnerTotal(0n).reason, /proves nothing/);
});

test('killed after two and resumed: the third is sent, the first two are not', async () => {
  // The lifecycle a kill actually goes through, over a real file on disk:
  // the plan is written after every send, the process dies, and the next run
  // reads the file back rather than recomputing anything.
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'vitals-burner-'));
  const planPath = join(dir, 'pay-run-burner.json');
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const burner = '0x357888ee9a318B33F5916eceF4b6558D9216a476';
    const addrs = PP.burnerRecipientKeys(burner).map((k) => privateKeyToAccount(k).address);
    const rows = PP.parsePayCsv(PP.burnerCsv(addrs, PP.BURNER_DEFAULT_AMOUNT_WEI)).rows;

    // First run. The chain's pending nonce is 4.
    const first = PP.buildPlan({ runId: 'burner', from: burner, rows, baseNonce: 4 });
    assert.equal(first.resumed, false);
    const plan = first.plan;
    writeFileSync(planPath, PP.planToJson(plan));
    assert.deepEqual(plan.entries.map((e) => e.nonce), [4, 5, 6]);

    // Two go out, each followed by a write, and then it is killed.
    let killedAfter = 0;
    for (const e of plan.entries) {
      e.txHash = '0x' + String(e.index + 1).repeat(64).slice(0, 64);
      e.status = 'sent';
      writeFileSync(planPath, PP.planToJson(plan));
      if (++killedAfter === 2) break;
    }
    const onDisk = PP.planFromJson(readFileSync(planPath, 'utf8'));
    assert.equal(PP.sentEntries(onDisk).length, 2, 'the file does not record what went out');
    assert.equal(PP.unsent(onDisk).length, 1);

    // Resumed. The chain has moved on, so the pending nonce is now 6, and the
    // plan must ignore that for the rows it already has.
    const again = PP.buildPlan({ runId: 'burner', from: burner, rows, baseNonce: 6, stored: onDisk });
    assert.equal(again.ok, true);
    assert.equal(again.resumed, true);
    const todo = PP.unsent(again.plan);
    assert.equal(todo.length, 1, 'a row that already went out came back around');
    assert.equal(todo[0].wallet, addrs[2]);
    assert.equal(todo[0].nonce, 6, 'the third row kept the nonce it was given');
    assert.deepEqual(again.plan.entries.map((e) => e.nonce), [4, 5, 6],
      'the sent rows kept the nonces that paid them, which is what a second attempt collides with');
    assert.deepEqual(PP.sentEntries(again.plan).map((e) => e.wallet), [addrs[0], addrs[1]]);

    // Finish it. Nothing is left, and a third run sends nothing at all.
    todo[0].txHash = '0x' + '3'.repeat(64);
    todo[0].status = 'sent';
    writeFileSync(planPath, PP.planToJson(again.plan));
    const done = PP.buildPlan({ runId: 'burner', from: burner, rows, baseNonce: 7, stored: PP.planFromJson(readFileSync(planPath, 'utf8')) });
    assert.equal(PP.unsent(done.plan).length, 0, 'a finished run would send again');
    assert.equal(PP.totalWei(PP.sentEntries(done.plan)), PP.BURNER_DEFAULT_AMOUNT_WEI * 3n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- seat notes

test('a note is stored on the seat and shown in the admin table', () => {
  reset();
  R.addSeat('one', 'T1', W(1));
  R.addSeat('two', 'T2', W(2));
  const res = R.setSeatNote(1, '  the artist who did the   card  ');
  assert.deepEqual(res, { ok: true, seat: 1, note: 'the artist who did the card', cleared: false });
  assert.equal(R.liveSeats()[0].note, 'the artist who did the card');

  const table = R.seatTableForAdmin();
  assert.match(table, /the artist who did the card/);
  // On its own line under its seat, not squeezed into a column.
  const lines = table.split('\n');
  const at = lines.findIndex((l) => l.includes('the artist'));
  assert.match(lines[at - 1], /\bone\b/);
});

test('a note never reaches the roster the room sees', () => {
  reset();
  R.addSeat('one', 'T1', W(1));
  R.setSeatNote(1, 'owed a seat for the audit');
  const roster = R.publicRoster();
  assert.doesNotMatch(roster, /owed a seat/);
  assert.doesNotMatch(roster, /audit/);
  // And the public roster still carries no wallet either.
  assert.doesNotMatch(roster, /0x[0-9a-fA-F]{40}/);
});

test('an empty note clears it', () => {
  reset();
  R.addSeat('one', 'T1', W(1));
  R.setSeatNote(1, 'temporary');
  const res = R.setSeatNote(1, '   ');
  assert.equal(res.cleared, true);
  assert.equal(R.liveSeats()[0].note, null);
  assert.doesNotMatch(R.seatTableForAdmin(), /temporary/);
});

test('a note on a seat that is not live is refused', () => {
  reset();
  R.addSeat('one', 'T1', W(1));
  assert.deepEqual(R.setSeatNote(99, 'x'), { ok: false, reason: 'no-seat' });
  R.removeSeat('one');
  assert.deepEqual(R.setSeatNote(1, 'x'), { ok: false, reason: 'no-seat' });
});

test('a note longer than the bound is refused, and nothing is stored', () => {
  reset();
  R.addSeat('one', 'T1', W(1));
  R.setSeatNote(1, 'kept');
  assert.deepEqual(R.setSeatNote(1, 'x'.repeat(R.MAX_SEAT_NOTE + 1)), { ok: false, reason: 'too-long' });
  assert.equal(R.liveSeats()[0].note, 'kept', 'the refused note overwrote the old one');
});

test('a reused seat does not inherit the last occupant note', () => {
  reset();
  R.addSeat('one', 'T1', W(1));
  R.setSeatNote(1, 'the first occupant');
  R.removeSeat('one');
  R.addSeat('two', 'T2', W(2));
  const seat = R.liveSeats().find((s) => s.seat === 1);
  assert.ok(seat, 'the seat number was reused');
  assert.equal(seat.note, null, 'a note about somebody else came back with the seat');
  assert.doesNotMatch(R.seatTableForAdmin(), /the first occupant/);
});

// ------------------------------------ a hypothetical is not a run to be paid

test('the latest real run is the latest run computed from the wallet', () => {
  reset();
  seed(1, 1, 1);
  assert.equal(L.latestRealRun(), null, 'nothing is real before anything is computed');

  const real = L.saveRun(L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n, sweptToDateWei: 0n }));
  assert.equal(L.latestRun().id, real);
  assert.equal(L.latestRealRun().id, real);

  // Exploring a figure moves the latest run and must not move this one.
  const guess = L.saveRun(L.computeRun({
    balanceWei: ETH(99), paidToDateWei: 0n, sweptToDateWei: 0n, hypothetical: true,
  }));
  assert.equal(L.latestRun().id, guess);
  assert.equal(L.latestRun().hypothetical, true);
  assert.equal(L.latestRealRun().id, real, 'a typed balance became the run the payer would reach for');
  assert.equal(L.latestRealRun().hypothetical, false);
});

test('a csv from a hypothetical says so at the top, and a real one says nothing', () => {
  reset();
  seed(1, 0, 0);
  const real = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n, sweptToDateWei: 0n });
  real.id = L.saveRun(real);
  // The split line is on every csv, hypothetical or not. The header is the
  // last comment-free line before the rows.
  const realLines = L.csvText(real).split('\n');
  assert.match(realLines[0], /^# (split not checked|declaration \d+):/);
  assert.equal(realLines[1], 'wallet,amount');
  assert.ok(!L.csvText(real).includes(L.CSV_HYPOTHETICAL_MARK));

  const guess = L.computeRun({
    balanceWei: ETH(10), paidToDateWei: 0n, sweptToDateWei: 0n, hypothetical: true,
  });
  guess.id = L.saveRun(guess);
  const lines = L.csvText(guess).split('\n');
  assert.match(lines[0], new RegExp(`^${L.CSV_HYPOTHETICAL_MARK}: run ${guess.id} was computed against a balance typed`));
  assert.match(lines[1], /never owed/);
  assert.match(lines[2], /^# (split not checked|declaration \d+):/);
  assert.equal(lines[3], 'wallet,amount');
});

test('the note at the top of a hypothetical csv is read back as a note, not a row', () => {
  reset();
  seed(2, 0, 0);
  const guess = L.computeRun({
    balanceWei: ETH(10), paidToDateWei: 0n, sweptToDateWei: 0n, hypothetical: true,
  });
  guess.id = L.saveRun(guess);
  // Labelling the file must not make it unreadable: it is exported to be
  // looked at, and the parser is the one thing that reads it.
  const parsed = PP.parsePayCsv(L.csvText(guess));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '));
  assert.equal(parsed.rows.length, 2);
  assert.equal(PP.totalWei(parsed.rows), guess.distributedWei);
  // And a note is the only thing skipped: a malformed row still stops the run.
  const broken = PP.parsePayCsv(`# a note\nwallet,amount\n${W(1)},0.1\nnope,0.2\n`);
  assert.equal(broken.ok, false);
  assert.match(broken.errors[0], /nope is not a wallet address/);
});
