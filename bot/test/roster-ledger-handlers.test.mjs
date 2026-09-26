/**
 * The roster and the ledger, driven through the real commands.
 *
 * The seeded roster is the one the payout table was specified against: 4 T1,
 * 6 T2 and 10 T3, which the roster still adds to 42 shares and which the
 * payout path no longer reads. Twenty seats, paid equally. The balance is
 * typed in, so the arithmetic can be checked against a figure rather than
 * against a wallet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('roster-ledger-handlers');
process.env.ADMIN_IDS = '9001';
const { createBot } = await import('../dist/bot.js');
const L = await import('../dist/ledger.js');
const { liveSeats, totalShares } = await import('../dist/roster.js');

const bot = createBot('123456:FAKE');
bot.botInfo = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};
const calls = [];
let sent = 8000;
bot.api.config.use(async (_p, method, payload) => {
  calls.push({ method, payload });
  if (method === 'sendMessage' || method === 'sendDocument') {
    return { ok: true, result: { message_id: ++sent, chat: { id: payload.chat_id }, date: 0 } };
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

const W = (n) => '0x' + String(n).padStart(40, '0');

test('seeding: 4 T1, 6 T2, 10 T3', async () => {
  let n = 0;
  for (const [tier, count] of [['T1', 4], ['T2', 6], ['T3', 10]]) {
    for (let i = 0; i < count; i++) {
      n++;
      const out = await said(`/seat add ${tier.toLowerCase()}_member_${i + 1} ${tier} ${W(n)}`);
      assert.match(out, new RegExp(`seat ${n}: ${tier.toLowerCase()}_member_${i + 1} ${tier}`), out);
    }
  }
  const seats = liveSeats();
  assert.equal(seats.length, 20);
  assert.equal(seats.filter((s) => s.tier === 'T1').length, 4);
  assert.equal(seats.filter((s) => s.tier === 'T2').length, 6);
  assert.equal(seats.filter((s) => s.tier === 'T3').length, 10);
  assert.equal(totalShares(), 42, '4*5 + 6*2 + 10*1');
});

test('the payout table against a balance of 10 ETH', async () => {
  const out = await said('/ledger preview 10');
  // The terms, so the total can be derived by anyone reading it.
  assert.match(out, /fee wallet balance {3}10\.0000 ETH/);
  // Every term of the reconstruction, so the pool can be derived by anyone.
  assert.match(out, /paid out to date\s+\+ 0\.0000 ETH, payout values and their gas/);
  assert.match(out, /swept to date\s+\+ 0\.0000 ETH, moved out by hand and recorded/);
  assert.match(out, /gross income\s+= 10\.0000 ETH, everything this wallet has ever earned/);
  assert.match(out, /the room's 10%\s+1\.0000 ETH of it, in total, ever/);
  assert.match(out, /pool now\s+= 1\.0000 ETH/);
  assert.doesNotMatch(out, /unpaid remainder/);
  assert.match(out, /equal split, 20 seats held today/);
  assert.doesNotMatch(out, /total shares/);
  // 1 / 20 = 0.0500, and every seat is paid it whatever tier it carries.
  assert.match(out, /per seat {13}0\.0500 ETH/);
  assert.match(out, /t1_member_1\s+T1\s+0\.0500/);
  assert.match(out, /t2_member_1\s+T2\s+0\.0500/);
  assert.match(out, /t3_member_1\s+T3\s+0\.0500/);
  // 0.0500 * 20 = 1.0000, which is the whole pool and leaves nothing behind.
  assert.match(out, /distributed {10}1\.0000 ETH to 20 wallets/);
  assert.match(out, /dust, stays in the wallet and goes out with the next run: 0 ETH/);
});

test('the run adds up, in wei, not just on screen', () => {
  const run = L.computeRun({ escrowWei: 0n, balanceWei: 10n * 10n ** 18n, paidToDateWei: 0n, sweptToDateWei: 0n });
  assert.equal(run.poolWei, 10n ** 18n);
  assert.equal(run.perShareWei, 5n * 10n ** 16n);
  assert.equal(run.rows.reduce((a, r) => a + r.amountWei, 0n), run.distributedWei);
  assert.equal(run.distributedWei + run.dustWei, run.poolWei, 'the pool is exactly what went out plus what stayed');
  for (const r of run.rows) {
    assert.equal(r.shares, 1, 'a seat carries a payout weight other than one');
    assert.equal(r.amountWei, run.perShareWei);
    assert.equal(r.amountWei % L.PAYOUT_PRECISION_WEI, 0n, 'a payout that is not a whole number of the printed unit');
  }
});

test('the csv is the table, and the send command holds no key', async () => {
  // The run above was computed from a typed balance, so it is exported by id.
  // Bare /ledger csv will not reach a hypothetical, which the next test is.
  const id = L.latestRun().id;
  const doc = (await send(`/ledger csv ${id}`)).find((c) => c.method === 'sendDocument');
  const csv = Buffer.from(doc.payload.document.fileData ?? doc.payload.document.file ?? '').toString('utf8');
  const lines = csv.trim().split('\n');
  const rows = lines.filter((l) => !l.startsWith('#') && l !== 'wallet,amount');
  assert.match(lines[0], /^# HYPOTHETICAL: run \d+ was computed against a balance typed into \/ledger preview$/);
  assert.equal(lines.find((l) => !l.startsWith('#')), 'wallet,amount');
  assert.equal(rows.length, 20);
  assert.ok(rows.every((l) => /^0x[0-9a-fA-F]{40},\d+\.\d{4}$/.test(l)), rows[0]);
  const total = rows.reduce((a, l) => a + Math.round(Number(l.split(',')[1]) * 1e4), 0);
  assert.equal(total, 10_000, '1.0000 ETH in units of 0.0001');

  const cmd = await said(`/ledger send ${id}`);
  // Named explicitly, so the command it prints says what it is before the
  // line that gets copied rather than after it.
  const cmdLines = cmd.split('\n');
  assert.match(cmdLines[0], new RegExp(`^HYPOTHETICAL: run ${id} was computed against a typed balance\\.`), cmd);
  assert.match(cmdLines[0], /would send real ETH against amounts nobody is owed/);
  assert.ok(cmdLines.findIndex((l) => l.includes('pay.mjs')) > 0, 'the label came after the command');
  assert.match(cmd, /the bot holds no key and sends nothing/);
  assert.match(cmd, /node tools\/pay\.mjs --csv vitals-ledger-run-\d+\.csv --run \d+/);
  assert.doesNotMatch(cmd, /0x[0-9a-fA-F]{40}/, 'the send command named a wallet');
});

test('neither csv nor send reaches a hypothetical run without being told to', async () => {
  const id = L.latestRun().id;
  assert.equal(L.latestRun().hypothetical, true, 'the run above was computed from a typed balance');
  assert.equal(L.latestRealRun(), null, 'nothing here was computed from the wallet');

  for (const [cmd, verb] of [['/ledger csv', 'export'], ['/ledger send', 'send']]) {
    const out = await said(cmd);
    assert.match(out, new RegExp(`no run computed from the fee wallet to ${verb}`), out);
    // It says which run it refused and how to have it anyway, because the
    // alternative is somebody deciding the bot has lost the table.
    assert.match(out, new RegExp(`the latest run, ${id}, was a hypothetical`), out);
    assert.match(out, new RegExp(`${id} takes the hypothetical anyway`), out);
    assert.doesNotMatch(out, /0x[0-9a-fA-F]{40}/, 'the refusal named a wallet');
  }
  // And nothing was written out.
  const docs = (await send('/ledger csv')).filter((c) => c.method === 'sendDocument');
  assert.equal(docs.length, 0);
});

// --------------------------------------------------------------- privacy

test('no view that can reach a group ever carries a wallet', async () => {
  const roster = await said('/roster', { chat: GROUP });
  assert.match(roster, /^roster/m);
  assert.match(roster, /t1_member_1\s+T1/);
  assert.doesNotMatch(roster, /0x[0-9a-fA-F]{40}/, 'the public roster carried a wallet');
  assert.doesNotMatch(roster, /\bsh\b|shares/, 'the public roster carried a share count');

  // The run here was computed from a typed balance, so the room is told about
  // it only because the id was typed. Bare /ledger post refuses it.
  const bare = await said('/ledger post', { chat: GROUP });
  assert.match(bare, /was a hypothetical/, bare);

  const post = await said(`/ledger post ${L.latestRun().id}`, { chat: GROUP });
  assert.doesNotMatch(post, /0x[0-9a-fA-F]{40}/, 'the public ledger post carried a wallet');
  assert.match(post, /equal split, 20 seats held today/);
  assert.match(post, /0\.0500 ETH each/);
  // Grouping by tier is how the post showed that seats were paid differently.
  // None is, and a tier line would say the tier decided it.
  assert.doesNotMatch(post, /^T[123] {2}\d+ seats/m);
  assert.match(post, /undistributed {5}0 ETH/);
  assert.match(post, /no transaction hashes recorded yet/);
});

test('the admin views refuse to answer in a group at all', async () => {
  for (const cmd of ['/seat list', '/seat add x T1 ' + W(99), '/ledger preview', '/ledger csv', '/ledger history']) {
    const out = await said(cmd, { chat: GROUP });
    assert.doesNotMatch(out, /0x[0-9a-fA-F]{40}/, `${cmd} leaked a wallet into a group`);
    assert.match(out, /DM/, `${cmd} did not say why: ${out}`);
  }
});

test('nobody but an admin gets an answer', async () => {
  for (const cmd of ['/seat list', '/roster', '/ledger preview 1', '/ledger history']) {
    assert.deepEqual(await send(cmd, { from: 5000 }), [], `${cmd} answered a non-admin`);
  }
});

// ------------------------------- the preview against a typed balance, any time

test('a typed preview prints the whole table and says it is hypothetical', async () => {
  const out = await said('/ledger preview 12.5');
  assert.match(out, /HYPOTHETICAL: the balance below was typed in, not read from the fee wallet/);
  assert.match(out, /fee wallet balance {3}12\.5000 ETH/);
  assert.match(out, /gross income\s+= 12\.5000 ETH/);
  assert.match(out, /the room's 10%\s+1\.2500 ETH/);
  assert.match(out, /equal split, 20 seats held today/);
  // Every seat is in it, so it is the real roster and not a sketch: a row per
  // seat with its tier, its amount and its wallet.
  assert.match(out, /seat {2}handle {11}tier {2}amount ETH {2}wallet/);
  for (const s of liveSeats()) {
    assert.ok(out.includes(s.handle), `${s.handle} is missing from the preview`);
    assert.ok(out.includes(s.wallet), `${s.handle}'s wallet is missing`);
  }
  assert.equal(liveSeats().length, 20);
  // And the arithmetic: 1.2500 over twenty seats is 0.0625 each.
  assert.match(out, /per seat {13}0\.0625 ETH/);
});

test('running it twice leaves no warning about an unpaid run', async () => {
  await said('/ledger preview 10');
  const second = await said('/ledger preview 11');
  // The warning that matters is about a real run that may have been paid. A
  // hypothetical was never payable, and turning it into that warning would
  // bury the real one on the day it appears.
  assert.doesNotMatch(second, /was previewed and has \d+ payments? with no transaction hash/);
  assert.doesNotMatch(second, /distributes it again/);
});

test('the preview says on its face that the balance was typed', async () => {
  const out = await said('/ledger preview 10');
  // The one thing standing between a hypothetical and a real run is this line,
  // because the csv and the send command that follow do not repeat it.
  assert.match(out, /HYPOTHETICAL/);
  assert.match(out, /typed in, not read from the fee wallet/);
});

test('it refuses in a group, like every view with a wallet in it', async () => {
  const out = await said('/ledger preview 10', { chat: GROUP });
  assert.doesNotMatch(out, /fee wallet balance/);
  assert.doesNotMatch(out, /0x[0-9a-fA-F]{40}/);
});

test('with no seats it says so rather than printing an empty table', async () => {
  const seats = liveSeats();
  for (const s of seats) await said(`/seat remove ${s.handle}`);
  const out = await said('/ledger preview 10');
  assert.match(out, /no seats yet/);
  for (const s of seats) await said(`/seat add ${s.handle} ${s.tier} ${s.wallet}`);
  assert.equal(liveSeats().length, seats.length);
});
