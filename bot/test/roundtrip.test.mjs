/**
 * Roster to ledger to payer and back, through the real commands.
 *
 * This is the join that runs at T+4h on launch day: /seat builds the roster,
 * /ledger preview computes the run, /ledger csv writes the file, pay.mjs
 * parses that exact file and builds the plan it will send, /ledger tx takes
 * the hashes back keyed by wallet, and /ledger post is what the room sees.
 *
 * Each piece is tested on its own elsewhere. What is tested here is that the
 * columns one writes are the columns the next one reads, that the amounts
 * survive the trip to four decimal places, that the dust carries, and that
 * nothing with a name or an address on it reaches the room.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('roundtrip');
process.env.ADMIN_IDS = '9001';
process.env.VITALS_TOKEN_ADDRESS = '0x' + '11'.repeat(20);
const { createBot } = await import('../dist/bot.js');
const L = await import('../dist/ledger.js');
const PP = await import('../dist/payplan.js');
const { liveSeats, totalShares } = await import('../dist/roster.js');
const dbModule = await import('../dist/db.js');

const bot = createBot('123456:FAKE');
bot.botInfo = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};
const calls = [];
let sentId = 8000;
bot.api.config.use(async (_p, method, payload) => {
  calls.push({ method, payload });
  if (method === 'sendMessage' || method === 'sendDocument') {
    return { ok: true, result: { message_id: ++sentId, chat: { id: payload.chat_id }, date: 0 } };
  }
  if (method === 'getChatMember') return { ok: true, result: { status: 'administrator', user: { id: payload.user_id, is_bot: false } } };
  return { ok: true, result: true };
});

let uid = 0;
const DM = { id: 9001, type: 'private', first_name: 'A' };
const GROUP = { id: -1001, type: 'supergroup', title: 'room' };
const send = async (text, { from = 9001, chat = DM } = {}) => {
  calls.length = 0;
  await bot.handleUpdate({
    update_id: ++uid,
    message: {
      message_id: 1000 + uid, date: 1_789_000_000, chat, from: { id: from, is_bot: false, first_name: 'U' },
      text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    },
  });
  return calls.filter((c) => c.method !== 'getChatMember');
};
const said = async (text, o) => (await send(text, o)).map((c) => c.payload.text ?? '').join('\n');

/** Twenty distinct wallets and twenty distinct handles. */
const W = (n) => '0x' + String(n).padStart(40, '0');
const HANDLES = [];

/**
 * The signed declaration this ledger pays under.
 *
 * The T+4h journey on launch day starts from one, so this journey does too.
 * Without it every run below reads as "the split was not checked against a
 * declaration", which is true and is not what launch day looks like.
 */
const DEPLOYER = '0x' + '44'.repeat(20);
const ROOM_DECLARED =
  "the room: BLOCK ZERO is 3 seats today. the room is owed 10% of the fee wallet's cumulative "
  + 'gross income, paid daily in ETH for 30 days, split equally between the seats held that day, '
  + 'every payout printed before it leaves and recorded with its hash.';

const declare = (room = ROOM_DECLARED) => {
  const { db } = dbModule;
  db.prepare('DELETE FROM launch_declarations').run();
  db.prepare(
    `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(process.env.VITALS_TOKEN_ADDRESS.toLowerCase(), W(2), DEPLOYER.toLowerCase(), W(3), 1,
        '0', 500, '0x' + 'e'.repeat(64), 1_789_000_000);
  db.prepare(
    `INSERT INTO launch_declarations (deployer, declared_by, declared_at, block_number,
       dev_buy_pct, exempt_list, exempt_count, creator_tax_bps, tax_split, vesting, room,
       docs_url, canonical, signature, free_slot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(DEPLOYER.toLowerCase(), 9001, 1_789_000_000, 400, 5, '[]', 1, 400,
        '10% the room', 'held by the deployer', room,
        'https://checkvitals.xyz/declared/001', 'signed text', '0xsig', 1);
};

// Shared across the file: this is one journey, in order.
let csv = null;
let runId = null;
let plan = null;

test('1. the roster: 20 seats, carrying three tiers that no longer decide money', async () => {
  declare();
  let n = 0;
  for (const [tier, count] of [['T1', 4], ['T2', 6], ['T3', 10]]) {
    for (let i = 0; i < count; i++) {
      n++;
      const handle = `${tier.toLowerCase()}_member_${i + 1}`;
      HANDLES.push(handle);
      await said(`/seat add ${handle} ${tier} ${W(n)}`);
    }
  }
  const seats = liveSeats();
  assert.equal(seats.length, 20);
  // The roster still adds tier shares, because the roster still records a
  // tier. The payout path below does not read either of them.
  assert.equal(totalShares(), 42, '4*5 + 6*2 + 10*1, on the roster');
});

test('2. the preview, on a typed balance of 10.01 ETH', async () => {
  // A balance that does not divide cleanly by twenty, on purpose: the carry is
  // the thing this journey exists to check, and a pool that divides exactly
  // would leave no dust to carry.
  const out = await said('/ledger preview 10.01');
  assert.match(out, /gross income\s+= 10\.0100 ETH/);
  assert.match(out, /pool now\s+= 1\.0010 ETH/);
  // Equal, and said to be equal. Twenty seats, not forty-two shares.
  assert.match(out, /equal split, 20 seats held today/);
  assert.doesNotMatch(out, /total shares/);
  // And the signed text agrees with it, by name.
  assert.match(out, /declaration \d+: equal split, 20 seats held today/);
  // 1.0010 / 20 rounded down to 4dp is 0.0500, so each seat is paid 0.0500 and
  // the run distributes 1.0000 with 0.0010 left over.
  assert.match(out, /per seat\s+0\.0500 ETH/);
  runId = Number(/run (\d+)/.exec(out)?.[1] ?? /\brun\b\D*(\d+)/.exec(out)?.[1]);
  if (!Number.isFinite(runId)) runId = L.latestRun()?.id;
  assert.ok(runId, 'the preview stored a run');
});

test('3. the csv the ledger writes, named by id because the balance was typed', async () => {
  // Bare /ledger csv does not reach a hypothetical at all: the whole journey
  // below runs on a figure rather than a wallet, so the run is asked for.
  const refused = await (async () => {
    const out = (await send('/ledger csv')).map((c) => c.payload.text ?? '').join('\n');
    return out;
  })();
  assert.match(refused, /was a hypothetical/, refused);

  const doc = (await send(`/ledger csv ${runId}`)).find((c) => c.method === 'sendDocument');
  csv = Buffer.from(doc.payload.document.fileData ?? doc.payload.document.file ?? '').toString('utf8');
  const lines = csv.trim().split('\n');
  // The file says on its face what it was built from, so the machine that
  // holds the key is not asked to remember.
  assert.match(lines[0], /^# HYPOTHETICAL: run \d+ was computed against a balance typed into \/ledger preview$/);
  assert.match(lines[1], /^# not read from the fee wallet\. these amounts were never owed\.$/);
  assert.match(lines[2], /^# declaration \d+: equal split, 20 seats held today$/,
    'the payer is not told what the split was checked against');
  assert.equal(lines[3], 'wallet,amount');
  assert.equal(lines.length, 24, 'three notes, a header and twenty seats');
});

test('4. the columns the ledger writes are the columns the payer parses', () => {
  const parsed = PP.parsePayCsv(csv);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '));
  assert.equal(parsed.rows.length, 20);
  // Not "it parsed": every wallet in the run is in the parse, and nothing else.
  const run = L.loadRun(runId);
  assert.deepEqual(
    parsed.rows.map((r) => r.wallet.toLowerCase()).sort(),
    run.rows.map((r) => r.wallet.toLowerCase()).sort(),
  );
});

test('5. the amounts survive the trip to four decimal places', () => {
  const run = L.loadRun(runId);
  const parsed = PP.parsePayCsv(csv);
  const byWallet = new Map(parsed.rows.map((r) => [r.wallet.toLowerCase(), r.amountWei]));
  for (const row of run.rows) {
    const fromCsv = byWallet.get(row.wallet.toLowerCase());
    assert.equal(fromCsv, row.amountWei, `seat ${row.seat} changed in the csv`);
  }
  // And in the aggregate, which is what the confirmation prompt compares.
  assert.equal(PP.totalWei(parsed.rows), run.distributedWei);
  assert.equal(L.eth(PP.totalWei(parsed.rows)), '1.0000');
});

test('6. the dust carries rather than being paid or lost', () => {
  const run = L.loadRun(runId);
  assert.equal(run.poolWei - run.distributedWei, run.dustWei);
  assert.equal(L.eth(run.dustWei), '0.0010');
  // Every seat was paid the same, which is the rule that was signed.
  assert.equal(new Set(run.rows.map((r) => String(r.amountWei))).size, 1);
  // Nothing below the 4dp floor is sent, so no row is short of a whole unit.
  for (const r of run.rows) assert.equal(r.amountWei % L.PAYOUT_PRECISION_WEI, 0n);
});

test('7. the plan the payer builds from that exact csv', () => {
  const run = L.loadRun(runId);
  const parsed = PP.parsePayCsv(csv);
  const built = PP.buildPlan({
    runId: String(runId), from: W(999), rows: parsed.rows, baseNonce: 7, stored: null,
  });
  assert.equal(built.ok, true);
  plan = built.plan;
  assert.equal(plan.entries.length, 20);
  // Nonces are consecutive from the wallet's pending count, so a resume cannot
  // pay a row twice.
  assert.deepEqual(plan.entries.map((e) => e.nonce), Array.from({ length: 20 }, (_, i) => 7 + i));
  assert.equal(PP.totalWei(plan.entries), run.distributedWei);
});

test('8. the hashes go back keyed by wallet, which is all the payer ever saw', async () => {
  const run = L.loadRun(runId);
  // What pay.mjs prints for the operator to paste.
  for (const [i, e] of plan.entries.entries()) {
    e.status = 'sent';
    e.txHash = '0x' + String(i + 1).padStart(64, 'a');
  }
  const command = PP.recordCommand(plan);
  assert.match(command, /^\/ledger tx \d+ /);
  assert.doesNotMatch(command, /t[123]_member/, 'the payer never sees a handle');

  // And the command resolves every wallet back to a seat.
  const { txs, unmatched } = L.parseTxArgs(run, command.split(/\s+/).slice(3));
  assert.deepEqual(unmatched, []);
  assert.equal(txs.length, 20);
  const seats = new Set(run.rows.map((r) => r.seat));
  for (const t of txs) assert.ok(seats.has(t.seat), `hash landed on seat ${t.seat}, which is not in this run`);

  const out = await said(command);
  assert.match(out, /20 hashes recorded/);
});

test('9. a wallet the run does not hold is reported, not dropped', () => {
  const run = L.loadRun(runId);
  const stranger = '0x' + 'f'.repeat(40);
  const { txs, unmatched } = L.parseTxArgs(run, [`${stranger}:0x${'b'.repeat(64)}`]);
  assert.deepEqual(txs, []);
  assert.deepEqual(unmatched, [stranger]);
});

test('10. a second paste does not record a second hash against a seat', async () => {
  const out = await said(PP.recordCommand(plan));
  assert.match(out, /0 hashes recorded/);
  assert.match(out, /20 seats already had one, left as they were/);
});

test('11. the public post: the hashes, and nothing that names anyone', async () => {
  // Named, because this whole journey ran on a typed balance and /ledger post
  // will not reach a hypothetical on its own.
  const post = await said(`/ledger post ${runId}`, { chat: GROUP });

  // The arithmetic the room checks.
  assert.match(post, /gross income\s+10\.0100 ETH/);
  assert.match(post, /the room's 10%\s+1\.0010 ETH/);
  assert.match(post, /this run\s+1\.0010 ETH/);
  assert.match(post, /equal split, 20 seats held today/);
  assert.match(post, /paid out\s+1\.0000 ETH/);
  assert.match(post, /undistributed\s+0\.001 ETH/);
  assert.match(post, /20 transfers:/);

  // The twenty hashes are there.
  assert.equal((post.match(/0x[0-9a-f]{64}/g) ?? []).length, 20);

  // And nothing else is. Every wallet and every handle, checked by name.
  for (const seat of liveSeats()) {
    assert.ok(!post.toLowerCase().includes(seat.wallet.toLowerCase()), `the post carried seat ${seat.seat}'s wallet`);
    assert.ok(!post.includes(seat.handle), `the post carried seat ${seat.seat}'s handle`);
  }
  assert.doesNotMatch(post, /0x[0-9a-fA-F]{40}\b(?![0-9a-fA-F])/, 'the post carried an address');
  assert.doesNotMatch(post, /t[123]_member/);
});

test('11b. bare /ledger post does not reach the typed-balance run', async () => {
  const out = await said('/ledger post', { chat: GROUP });
  assert.match(out, /was a hypothetical/, out);
  assert.doesNotMatch(out, /gross income/, 'a hypothetical reached the room');
});

test('12. the room sees one amount, and never a person', async () => {
  const post = await said(`/ledger post ${runId}`, { chat: GROUP });
  assert.match(post, /equal split, 20 seats held today/);
  assert.match(post, /0\.0500 ETH each/);
  // The post used to group by tier, which is how it showed that different
  // seats were paid different amounts. No seat is any more, and a post still
  // grouped by tier would suggest the tier decided it.
  assert.doesNotMatch(post, /^T[123]\s+\d+ seats/m);
  assert.equal(0.0500 * 20, 1.0000);
  assert.doesNotMatch(post, /!/);
  assert.ok(!post.includes(String.fromCharCode(0x2014)));
});

test('13. the next run starts from the dust, not from zero', async () => {
  // The same wallet balance, less what went out: the room has been paid
  // 1.0000 of its 1.0010, so the next run owes the 0.0010 and nothing more.
  const out = await said('/ledger preview 9.01');
  assert.match(out, /gross income\s+= 10\.0100 ETH/);
  assert.match(out, /the room's 10%\s+1\.0010 ETH/);
  assert.match(out, /paid out to date\s+\+ 1\.0000 ETH/);
  assert.match(out, /pool now\s+= 0\.0010 ETH/);
  // Below the floor over twenty seats, so it pays nothing and carries again.
  assert.match(out, /per seat\s+0\.0000 ETH/);
});

// ---------------------------------------- the guard that nearly broke the post

test('14. a transaction hash is not a wallet, anywhere the guard runs', async () => {
  const { containsAddress, addressesIn } = await import('../dist/text.js');
  const hash = '0x' + 'a'.repeat(64);
  const addr = '0x' + 'b'.repeat(40);

  // The bug this caught: the first forty characters of a hash are a perfectly
  // good address as far as a regular expression is concerned, so the guard on
  // the public post refused every post that carried hashes. That is the T+4h
  // post, and it would have failed the first time it mattered.
  assert.equal(containsAddress(hash), false);
  assert.equal(containsAddress(`three transfers:\n  ${hash}\n  ${hash}`), false);
  assert.equal(containsAddress(addr), true);
  assert.equal(containsAddress(`seat 4 ${addr} paid`), true);
  assert.deepEqual(addressesIn(`${hash} ${addr} ${hash}`), [addr]);
});

test('15. the fake CA guard in the room does not fire on a hash', async () => {
  const { ADDRESS_ANYWHERE } = await import('../dist/launchday.js');
  const hash = '0x' + 'c'.repeat(64);
  assert.deepEqual(hash.match(ADDRESS_ANYWHERE), null,
    'a member pasting a hash would have been warned and then muted for a day');
  const addr = '0x' + 'd'.repeat(40);
  assert.deepEqual(`look at ${addr}`.match(ADDRESS_ANYWHERE), [addr]);
});
