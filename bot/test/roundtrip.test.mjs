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
const { createBot } = await import('../dist/bot.js');
const L = await import('../dist/ledger.js');
const PP = await import('../dist/payplan.js');
const { liveSeats, totalShares } = await import('../dist/roster.js');

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

// Shared across the file: this is one journey, in order.
let csv = null;
let runId = null;
let plan = null;

test('1. the roster: 4 T1, 6 T2, 10 T3', async () => {
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
  assert.equal(totalShares(), 42, '4*5 + 6*2 + 10*1');
});

test('2. the preview, on a typed balance of 10 ETH', async () => {
  const out = await said('/ledger preview 10');
  assert.match(out, /gross income\s+= 10\.0000 ETH/);
  assert.match(out, /pool now\s+= 1\.0000 ETH/);
  assert.match(out, /total shares\s+42/);
  // 1.0000 / 42 rounded down to 4dp is 0.0238, so a share pays 0.0238 and the
  // run distributes 0.9996 with 0.0004 left over.
  assert.match(out, /per share\s+0\.0238 ETH/);
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
  assert.equal(lines[2], 'wallet,amount');
  assert.equal(lines.length, 23, 'two notes, a header and twenty seats');
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
  assert.equal(L.eth(PP.totalWei(parsed.rows)), '0.9996');
});

test('6. the dust carries rather than being paid or lost', () => {
  const run = L.loadRun(runId);
  assert.equal(run.poolWei - run.distributedWei, run.dustWei);
  assert.equal(L.eth(run.dustWei), '0.0004');
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
  const post = await said('/ledger post', { chat: GROUP });

  // The arithmetic the room checks.
  assert.match(post, /gross income\s+10\.0000 ETH/);
  assert.match(post, /the room's 10%\s+1\.0000 ETH/);
  assert.match(post, /this run\s+1\.0000 ETH/);
  assert.match(post, /total shares\s+42/);
  assert.match(post, /paid out\s+0\.9996 ETH/);
  assert.match(post, /undistributed\s+0\.0004 ETH/);
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

test('12. the room sees tiers, never people', async () => {
  const post = await said('/ledger post', { chat: GROUP });
  assert.match(post, /T1\s+4 seats · 0\.1190 ETH each · 0\.4760 ETH/);
  assert.match(post, /T2\s+6 seats · 0\.0476 ETH each · 0\.2856 ETH/);
  assert.match(post, /T3\s+10 seats · 0\.0238 ETH each · 0\.2380 ETH/);
  // 4*5 + 6*2 + 10*1 shares at 0.0238 each.
  assert.equal(0.4760 + 0.2856 + 0.2380, 0.9996);
  assert.doesNotMatch(post, /!/);
  assert.ok(!post.includes(String.fromCharCode(0x2014)));
});

test('13. the next run starts from the dust, not from zero', async () => {
  // The same wallet balance, less what went out: the room has been paid
  // 0.9996 of its 1.0000, so the next run owes the 0.0004 and nothing more.
  const out = await said('/ledger preview 9.0004');
  assert.match(out, /gross income\s+= 10\.0000 ETH/);
  assert.match(out, /the room's 10%\s+1\.0000 ETH/);
  assert.match(out, /paid out to date\s+\+ 0\.9996 ETH/);
  assert.match(out, /pool now\s+= 0\.0004 ETH/);
  // Below the floor over 42 shares, so it pays nothing and carries again.
  assert.match(out, /per share\s+0\.0000 ETH/);
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
