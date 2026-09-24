/**
 * The room's share, split the way the signed declaration says it is.
 *
 * DECLARED #001 says the room is "owed 10% of the fee wallet's cumulative
 * gross income, paid daily in ETH for 30 days, split equally between the seats
 * held that day", and that "when a seat is added the split is recomputed from
 * that day's payout forward and printed with it".
 *
 * Two things are tested here and the second matters more than the first. The
 * first is that the ledger pays equally. The second is that it cannot pay any
 * other way while that text is what is signed: a run whose table would divide
 * the pool by a different rule is refused, before anybody is looking at a list
 * of wallets and amounts. A ledger that merely happens to agree with a
 * declaration agrees with it until somebody changes a tier.
 *
 * Nothing here touches a network. Balances are figures, not wallets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('roomsplit');
process.env.VITALS_TOKEN_ADDRESS = '0x' + '11'.repeat(20);

const R = await import('../dist/roster.js');
const L = await import('../dist/ledger.js');
const S = await import('../dist/roomsplit.js');
const { db } = await import('../dist/db.js');

const W = (n) => '0x' + String(n).padStart(40, '0');
const ETH = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const DEPLOYER = '0x' + '44'.repeat(20);
const DAY = 86_400;

/** The room block as DECLARED #001 signs it, in the part this code reads. */
const EQUAL_ROOM =
  "the room: BLOCK ZERO is 3 seats today, the deployer and two others. the room is owed 10% of "
  + "the fee wallet's cumulative gross income, paid daily in ETH for 30 days, split equally "
  + 'between the seats held that day, every payout printed before it leaves and recorded with '
  + "its hash. when a seat is added the split is recomputed from that day's payout forward and "
  + 'printed with it.';

/** What the declaration used to say, and what the ledger used to do. */
const TIERED_ROOM =
  "the room: 50 seats. the room is owed 10% of the fee wallet's cumulative gross income, paid "
  + 'daily in ETH for 30 days by shares (T1 5, T2 2, T3 1), every payout printed before it '
  + 'leaves and recorded with its hash.';

const reset = () => {
  for (const t of ['seats', 'seat_events', 'ledger_runs', 'ledger_payments', 'ledger_sweeps',
                   'launch_declarations', 'launches']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
};

/** A signed declaration covering the configured token's launch. */
function declare(room, { pct } = {}) {
  db.prepare('DELETE FROM launch_declarations').run();
  db.prepare('DELETE FROM launches').run();
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(process.env.VITALS_TOKEN_ADDRESS.toLowerCase(), W(2), DEPLOYER.toLowerCase(), W(3), 1,
        '0', 500, '0x' + 'e'.repeat(64), 1_789_000_000);
  const info = db.prepare(
    `INSERT INTO launch_declarations (deployer, declared_by, declared_at, block_number,
       dev_buy_pct, exempt_list, exempt_count, creator_tax_bps, tax_split, vesting, room,
       docs_url, canonical, signature, free_slot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(DEPLOYER.toLowerCase(), 9001, 1_789_000_000, 400, 5, '[]', 1, 400,
        `${pct ?? 10}% the room`, 'held by the deployer', room,
        'https://checkvitals.xyz/declared/001', 'signed text', '0xsig', 1);
  return Number(info.lastInsertRowid);
}

const seat = (handle, tier, n, at) => {
  const r = R.addSeat(handle, tier, W(n), { at });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  return r.value;
};

// ------------------------------------------------------- 1. three seats equal

test('three seats are paid the same amount, to the wei', () => {
  reset();
  declare(EQUAL_ROOM);
  seat('deployer', 'T1', 1, 1000);
  seat('crew_one', 'T2', 2, 1000);
  seat('crew_two', 'T3', 3, 1000);

  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n, sweptToDateWei: 0n });
  assert.equal(run.refusal, null, run.refusal ?? '');
  assert.equal(L.eth(run.poolWei), '1.0000');
  // 1 ETH over three seats, floored to the printed precision.
  assert.equal(L.eth(run.perShareWei), '0.3333');
  assert.equal(run.rows.length, 3);
  assert.equal(new Set(run.rows.map((r) => String(r.amountWei))).size, 1,
    'three seats on three tiers were paid three different amounts');
  assert.deepEqual([...new Set(run.rows.map((r) => r.shares))], [1]);
  assert.equal(L.eth(run.distributedWei), '0.9999');
  assert.equal(L.eth(run.dustWei, 6), '0.000100');
  assert.equal(run.distributedWei + run.dustWei, run.poolWei);

  // And the preview says which rule it used and how many seats it divided by.
  const text = L.previewText(run);
  assert.match(text, /equal split, 3 seats held today/);
  assert.match(text, /per seat\s+0\.3333 ETH/);
  assert.doesNotMatch(text, /total shares/);
});

test('the tier a seat carries changes nothing about what it is paid', () => {
  reset();
  declare(EQUAL_ROOM);
  seat('seat_a', 'T3', 1, 1000);
  seat('seat_b', 'T3', 2, 1000);
  seat('seat_c', 'T3', 3, 1000);
  const flat = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });

  assert.equal(R.setTier('seat_a', 'T1').ok, true);
  const promoted = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.deepEqual(
    promoted.rows.map((r) => String(r.amountWei)),
    flat.rows.map((r) => String(r.amountWei)),
    'a promotion moved money',
  );
  // The roster still adds tier shares, and nothing reads them to pay anybody.
  assert.equal(R.totalShares(), 5 + 1 + 1);
  assert.equal(promoted.totalShares, 3);
});

// --------------------------------- 2. a seat added on day 9, and not before

test('a seat added on day 9 recomputes from day 9 forward and not before', () => {
  reset();
  declare(EQUAL_ROOM);
  for (const [i, h] of ['deployer', 'crew_one', 'crew_two'].entries()) seat(h, 'T1', i + 1, 1000);

  // Eight daily runs, each paid in full so the next one starts from what is
  // left. A tenth of gross, less what the room has had.
  let balance = ETH(0);
  let paid = 0n;
  const stored = [];
  for (let d = 1; d <= 8; d++) {
    balance += ETH(3); // the day's fees
    const run = L.computeRun({ balanceWei: balance, paidToDateWei: paid, sweptToDateWei: 0n, now: 1000 + d * DAY });
    assert.equal(run.rows.length, 3, `day ${d} divided between the wrong number of seats`);
    const id = L.saveRun(run);
    stored.push({ id, day: d, each: run.rows[0].amountWei, seats: run.rows.length });
    // Paid, with hashes, which is what makes it paid to date.
    L.recordTxs(id, run.rows.map((r) => ({ seat: r.seat, txHash: '0x' + `${d}${r.seat}`.padStart(64, 'a') })));
    balance -= run.distributedWei;
    paid += run.distributedWei;
  }
  assert.equal(stored.length, 8);
  const beforeAdd = stored.map((r) => String(r.each));

  // Day 9: a fourth seat, given for what somebody actually did.
  seat('crew_three', 'T2', 4, 1000 + 9 * DAY);
  balance += ETH(3);
  const nine = L.computeRun({ balanceWei: balance, paidToDateWei: paid, sweptToDateWei: 0n, now: 1000 + 9 * DAY });
  assert.equal(nine.refusal, null, nine.refusal ?? '');
  assert.equal(nine.rows.length, 4, 'the new seat is not in the day it was given');
  assert.equal(new Set(nine.rows.map((r) => String(r.amountWei))).size, 1);
  const nineId = L.saveRun(nine);

  // Days 1 to 8 are exactly as they were paid. Not recomputed, not adjusted,
  // and the newcomer is in none of them.
  for (const [i, r] of stored.entries()) {
    const back = L.loadRun(r.id);
    assert.equal(back.rows.length, 3, `run ${r.id} grew a seat`);
    assert.equal(String(back.rows[0].amountWei), beforeAdd[i], `run ${r.id} was rewritten`);
    assert.ok(!back.rows.some((x) => x.handle === 'crew_three'),
      `the seat given on day 9 was paid for day ${r.day}`);
  }

  // And the change is printed with the payout rather than left to be noticed.
  const note = L.seatChangeNote(L.loadRun(nineId));
  assert.ok(note, 'the split changed size and nothing said so');
  assert.match(note, /seats held changed since run \d+: 3 then, 4 now/);
  assert.match(note, /recomputed from this run forward/);
  assert.match(note, new RegExp(`run ${stored[7].id} and everything before it stay exactly as they were paid`));
  assert.ok(!note.includes(String.fromCharCode(0x2014)));
  assert.match(L.previewText(L.loadRun(nineId)), /seats held changed since run/);
  assert.match(L.postText(L.loadRun(nineId)), /seats held changed since run/);

  // A run with no change before it says nothing at all.
  assert.equal(L.seatChangeNote(L.loadRun(stored[4].id)), null);
});

// ------------------------------- 3. a seat given up leaves both in history

test('a seat given up is reused and both occupants stay in the history', () => {
  reset();
  declare(EQUAL_ROOM);
  seat('deployer', 'T1', 1, 1000);
  seat('crew_one', 'T1', 2, 1000);
  seat('crew_two', 'T1', 3, 1000);

  const before = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  const beforeId = L.saveRun(before);
  assert.equal(before.rows.length, 3);

  assert.equal(R.removeSeat('crew_two', { at: 2000 }).ok, true);
  assert.deepEqual(R.liveSeats().map((s) => s.handle), ['deployer', 'crew_one']);

  // The number comes round again rather than the roster growing a gap.
  const back = seat('crew_three', 'T3', 4, 3000);
  assert.equal(back.seat, 3, 'the freed number was not reused');

  // Both occupants of seat 3 are in its history, in order, with what happened.
  const ev = R.seatHistory(3);
  assert.deepEqual(ev.map((e) => [e.handle, e.event]),
    [['crew_two', 'add'], ['crew_two', 'remove'], ['crew_three', 'add']]);

  // The run that paid the first occupant still names the first occupant. A
  // seat is a number and the history is what disambiguates it.
  const paidRun = L.loadRun(beforeId);
  assert.equal(paidRun.rows.find((r) => r.seat === 3).handle, 'crew_two');

  // And the next run pays three seats again, equally, with the newcomer in it.
  const after = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(after.rows.length, 3);
  assert.equal(after.rows.find((r) => r.seat === 3).handle, 'crew_three');
  assert.equal(new Set(after.rows.map((r) => String(r.amountWei))).size, 1);
});

// --------------------------- 4. the refusal when the two do not agree

test('a run whose split is not the one signed is refused, and says both sides', () => {
  reset();
  // The declaration still carries the old tiered rule, and the ledger pays
  // equally. This is exactly the state this branch was in before the ledger
  // moved: signed one way, paying another.
  const id = declare(TIERED_ROOM);
  seat('deployer', 'T1', 1, 1000);
  seat('crew_one', 'T2', 2, 1000);

  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(run.split.state, 'differs');
  assert.ok(run.refusal, 'a run that contradicts the signed declaration was payable');
  assert.match(run.refusal, new RegExp(`declaration ${id}`));
  assert.match(run.refusal, /T1 5, T2 2, T3 1/);
  assert.match(run.refusal, /a payout that contradicts a signed declaration does not go out/);
  // Either side may be the one that is wrong, and this code never says which.
  assert.match(run.refusal, /the roster moves to what was signed, or a new declaration is signed/);

  // Nothing is payable: no amount on any row, and nothing to hand a payer.
  assert.equal(run.perShareWei, 0n);
  assert.equal(run.distributedWei, 0n);
  assert.deepEqual([...new Set(run.rows.map((r) => String(r.amountWei)))], ['0']);
  assert.match(L.previewText(run), /REFUSED: /);
  assert.match(L.previewText(run), /nothing is payable until that is settled/);
});

test('a declared share of gross that is not the one being paid is refused', () => {
  reset();
  const id = declare(EQUAL_ROOM.replace('owed 10% of', 'owed 15% of'), { pct: 15 });
  seat('deployer', 'T1', 1, 1000);
  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(run.split.state, 'differs');
  assert.match(run.refusal, new RegExp(`declaration ${id} says the room is owed 15% of gross and this run pays 10%`));
});

test('a refused run is not payable through any of the three ways a table leaves', () => {
  reset();
  declare(TIERED_ROOM);
  seat('deployer', 'T1', 1, 1000);
  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  // A refused run is not saved by the preview handler, but one stored before
  // the declaration moved still has to refuse when it is loaded again.
  const id = L.saveRun({ ...run, refusal: null, rows: run.rows, perShareWei: 0n });
  const loaded = L.loadRun(id);
  assert.ok(loaded.refusal, 'a stored run stopped refusing when it was loaded');
  assert.equal(loaded.split.state, 'differs');
});

test('the check passes when the roster and the signed text agree, and says so by name', () => {
  reset();
  const id = declare(EQUAL_ROOM);
  seat('deployer', 'T1', 1, 1000);
  seat('crew_one', 'T2', 2, 1000);
  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(run.refusal, null);
  assert.equal(run.split.state, 'match');
  assert.equal(run.split.declarationId, id);
  assert.match(L.previewText(run), new RegExp(`declaration ${id}: equal split, 2 seats held today`));
});

// ------------------------------------------- undetermined is not agreement

test('no declaration is undetermined, which is neither a match nor a contradiction', () => {
  reset();
  seat('deployer', 'T1', 1, 1000);
  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(run.split.state, 'undetermined');
  assert.equal(run.refusal, null, 'an absent lookup blocked a payout');
  const text = L.previewText(run);
  assert.match(text, /split not checked: no launch is indexed for 0x1{40}, so there is nothing a declaration could cover yet/);
  // It must never print as agreement.
  assert.doesNotMatch(text, /declaration \d+: equal split/);
});

test('a room block that does not state a rule is undetermined, and says which one it read', () => {
  reset();
  const id = declare('the room: some people get paid sometimes.');
  seat('deployer', 'T1', 1, 1000);
  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(run.split.state, 'undetermined');
  assert.match(L.previewText(run), new RegExp(`split not checked: declaration ${id} was found and the room block does not state how the share is divided`));
});

test('a room block stating two rules at once is read as neither', () => {
  const both = `${EQUAL_ROOM} by shares (T1 5, T2 2, T3 1)`;
  assert.equal(S.declaredSplit(both).kind, 'unreadable');
  assert.match(S.declaredSplit(both).why, /an equal split and a tiered one/);
});

test('the reader recognises the two rules this project has signed, and nothing else', () => {
  assert.deepEqual(S.declaredSplit(EQUAL_ROOM), { kind: 'equal' });
  assert.deepEqual(S.declaredSplit(TIERED_ROOM), { kind: 'tiered', shares: { T1: 5, T2: 2, T3: 1 } });
  assert.equal(S.declaredPoolPct(EQUAL_ROOM), 10);
  assert.equal(S.declaredPoolPct(TIERED_ROOM), 10);
  assert.equal(S.declaredPoolPct('the room: nothing about a percentage'), null);
  assert.equal(S.declaredSplit('').kind, 'unreadable');
});

test('no seats is not a contradiction of anything', () => {
  reset();
  declare(EQUAL_ROOM);
  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(run.rows.length, 0);
  assert.equal(run.refusal, null);
  assert.equal(run.split.state, 'match');
  assert.match(L.previewText(run), /no seats, so nothing to divide/);
});

// ----------------------------------------------------- the signed text itself

test('the room block DECLARED #001 signs reads as an equal split of a tenth', async () => {
  // Read off the document rather than copied here, so this cannot pass against
  // a room block nobody is signing.
  const { readFileSync } = await import('node:fs');
  const template = readFileSync('docs/template-declaration.md', 'utf8');
  const block = (template.split('\n```\n')[1] ?? '').replace(/^```\w*\n?/, '').trim();
  const room = block.split('\n').find((l) => l.startsWith('the room:'));
  assert.ok(room, 'the template has no room line');

  assert.deepEqual(S.declaredSplit(room), { kind: 'equal' },
    'the ledger pays equally and the signed text does not say that is what it does');
  assert.equal(S.declaredPoolPct(room), L.LEDGER_SHARE_PCT,
    'the share of gross the ledger pays is not the share that was signed');
});

// ------------------------------- undetermined is public, and says which one

/**
 * The same sentence on every surface.
 *
 * "Undetermined" is what this project prints in public when the data cannot
 * support a claim, and a payout of our own money is not the one place that
 * word gets to stay on an admin screen. So whatever the preview says about the
 * check, the room's post says it and the file handed to the machine holding
 * the key says it.
 */
const splitLineOf = (text) => text.split('\n')
  .map((l) => l.replace(/^# /, ''))
  .find((l) => l.startsWith('split not checked:') || /^declaration \d+: /.test(l));

test('the preview, the public post and the csv carry the same split line', () => {
  for (const room of [EQUAL_ROOM, null]) {
    reset();
    if (room) declare(room);
    seat('deployer', 'T1', 1, 1000);
    seat('crew_one', 'T1', 2, 1000);
    const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
    run.id = L.saveRun(run);

    const line = splitLineOf(L.previewText(run));
    assert.ok(line, 'the preview has no split line');
    assert.equal(splitLineOf(L.postText(run)), line, 'the room is told something else');
    assert.equal(splitLineOf(L.csvText(run)), line, 'the payer is told something else');
    assert.equal(run.split.state, room ? 'match' : 'undetermined');
  }
});

test('the csv carries it as a comment, so the payer reads it and the parser does not', async () => {
  const PP = await import('../dist/payplan.js');
  reset();
  seat('deployer', 'T1', 1, 1000);
  seat('crew_one', 'T1', 2, 1000);
  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  run.id = L.saveRun(run);

  const csv = L.csvText(run);
  assert.match(csv, /^# split not checked: /m);
  const parsed = PP.parsePayCsv(csv);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '));
  assert.equal(parsed.rows.length, 2, 'the note was parsed as a row, or ate one');
  assert.equal(PP.totalWei(parsed.rows), run.distributedWei);
});

test('an undetermined post is not silently a clean one', () => {
  reset();
  seat('deployer', 'T1', 1, 1000);
  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  const post = L.postText(run);
  assert.match(post, /split not checked: /);
  assert.doesNotMatch(post, /\bclean\b|\bsafe\b|\blooks good\b/i);
  assert.doesNotMatch(post, /declaration \d+: /, 'an unresolved check printed as agreement');
  assert.ok(!post.includes(String.fromCharCode(0x2014)));
});

// -------------------------- each reason is its own sentence, so they differ

test('before the token exists on chain, the reason names that and nothing else', () => {
  // The Sunday rehearsal: signed, nothing launched, the ledger run on a typed
  // balance. This is the only answer the check can give, and it has to be
  // distinguishable on Monday from a run where the launch IS indexed.
  reset();
  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(run.split.state, 'undetermined');
  assert.equal(
    run.split.detail,
    `no launch is indexed for ${process.env.VITALS_TOKEN_ADDRESS}, so there is nothing a declaration could cover yet`,
  );
});

test('a launch with no declaration before it reads differently from no launch at all', () => {
  reset();
  // A launch, indexed, and nothing signed before its block.
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(process.env.VITALS_TOKEN_ADDRESS.toLowerCase(), W(2), DEPLOYER.toLowerCase(), W(3), 1,
        '0', 64_623_813, '0x' + 'e'.repeat(64), 1_789_000_000);
  seat('deployer', 'T1', 1, 1000);

  const run = L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n });
  assert.equal(run.split.state, 'undetermined');
  assert.equal(
    run.split.detail,
    `the launch of ${process.env.VITALS_TOKEN_ADDRESS} is indexed at block 64623813 `
    + 'and no declaration signed before that block covers it',
  );
});

test('every reason the check cannot resolve is a different sentence', () => {
  const seen = new Set();

  // 1. No token configured at all.
  reset();
  const token = process.env.VITALS_TOKEN_ADDRESS;
  delete process.env.VITALS_TOKEN_ADDRESS;
  seen.add(S.ledgerDeclaration().reason);
  process.env.VITALS_TOKEN_ADDRESS = token;

  // 2. Configured, nothing on chain.
  seen.add(S.ledgerDeclaration().reason);

  // 3. On chain, nothing signed before it.
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(token.toLowerCase(), W(2), DEPLOYER.toLowerCase(), W(3), 1, '0', 900,
        '0x' + 'e'.repeat(64), 1_789_000_000);
  seen.add(S.ledgerDeclaration().reason);

  // 4. Signed, and the room block states no rule.
  declare('the room: some people get paid sometimes.');
  seat('deployer', 'T1', 1, 1000);
  seen.add(L.computeRun({ balanceWei: ETH(10), paidToDateWei: 0n }).split.detail);

  assert.equal(seen.size, 4, `two reasons print the same sentence: ${[...seen].join(' | ')}`);
  for (const r of seen) assert.ok(r && r.length > 20, String(r));
  // And the one that resolves is not one of them.
  reset();
  declare(EQUAL_ROOM);
  assert.equal(S.ledgerDeclaration().reason, null);
});
