/**
 * The roster and the ledger, driven through the real commands.
 *
 * The seeded roster is the one the payout table was specified against: 4 T1,
 * 6 T2 and 10 T3, which is 42 shares. The balance is typed in, so the
 * arithmetic can be checked against a figure rather than against a wallet.
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
  assert.match(out, /gross income\s+= 10\.0000 ETH, everything this wallet has ever taken in/);
  assert.match(out, /the room's 10%\s+1\.0000 ETH of it, in total, ever/);
  assert.match(out, /pool now\s+= 1\.0000 ETH/);
  assert.doesNotMatch(out, /unpaid remainder/);
  assert.match(out, /total shares\s+42/);
  // 1 / 42 = 0.0238095..., rounded down to the four places the table prints.
  assert.match(out, /per share {12}0\.0238 ETH/);
  // And the rows, one per tier.
  assert.match(out, /t1_member_1\s+T1\s+5\s+0\.1190/);
  assert.match(out, /t2_member_1\s+T2\s+2\s+0\.0476/);
  assert.match(out, /t3_member_1\s+T3\s+1\s+0\.0238/);
  // 0.0238 * 42 = 0.9996, leaving 0.0004 of the 1 ETH pool.
  assert.match(out, /distributed {10}0\.9996 ETH to 20 wallets/);
  assert.match(out, /dust, stays in the wallet and goes out with the next run: 0\.0004 ETH/);
});

test('the run adds up, in wei, not just on screen', () => {
  const run = L.computeRun({ balanceWei: 10n * 10n ** 18n, paidToDateWei: 0n, sweptToDateWei: 0n });
  assert.equal(run.poolWei, 10n ** 18n);
  assert.equal(run.perShareWei, 23_800_000_000_000_00n * 10n);
  assert.equal(run.rows.reduce((a, r) => a + r.amountWei, 0n), run.distributedWei);
  assert.equal(run.distributedWei + run.dustWei, run.poolWei, 'the pool is exactly what went out plus what stayed');
  for (const r of run.rows) {
    assert.equal(r.amountWei, run.perShareWei * BigInt(r.shares));
    assert.equal(r.amountWei % L.PAYOUT_PRECISION_WEI, 0n, 'a payout that is not a whole number of the printed unit');
  }
});

test('the csv is the table, and the send command holds no key', async () => {
  const doc = (await send('/ledger csv')).find((c) => c.method === 'sendDocument');
  const csv = Buffer.from(doc.payload.document.fileData ?? doc.payload.document.file ?? '').toString('utf8');
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'wallet,amount');
  assert.equal(lines.length, 21);
  assert.ok(lines.slice(1).every((l) => /^0x[0-9a-fA-F]{40},\d+\.\d{4}$/.test(l)), lines[1]);
  const total = lines.slice(1).reduce((a, l) => a + Math.round(Number(l.split(',')[1]) * 1e4), 0);
  assert.equal(total, 9996, '0.9996 ETH in units of 0.0001');

  const cmd = await said('/ledger send');
  assert.match(cmd, /the bot holds no key and sends nothing/);
  assert.match(cmd, /node tools\/pay\.mjs --csv vitals-ledger-run-\d+\.csv --run \d+/);
  assert.doesNotMatch(cmd, /0x[0-9a-fA-F]{40}/, 'the send command named a wallet');
});

// --------------------------------------------------------------- privacy

test('no view that can reach a group ever carries a wallet', async () => {
  const roster = await said('/roster', { chat: GROUP });
  assert.match(roster, /^roster/m);
  assert.match(roster, /t1_member_1\s+T1/);
  assert.doesNotMatch(roster, /0x[0-9a-fA-F]{40}/, 'the public roster carried a wallet');
  assert.doesNotMatch(roster, /\bsh\b|shares/, 'the public roster carried a share count');

  const post = await said('/ledger post', { chat: GROUP });
  assert.doesNotMatch(post, /0x[0-9a-fA-F]{40}/, 'the public ledger post carried a wallet');
  assert.match(post, /T1 {2}4 seats · 0\.1190 ETH each · 0\.4760 ETH/);
  assert.match(post, /T2 {2}6 seats · 0\.0476 ETH each · 0\.2856 ETH/);
  assert.match(post, /T3 {2}10 seats · 0\.0238 ETH each · 0\.2380 ETH/);
  assert.match(post, /undistributed {5}0\.0004 ETH/);
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
  assert.match(out, /total shares\s+42/);
  // Every seat is in it, so it is the real roster and not a sketch: a row per
  // seat with its tier, its shares, its amount and its wallet.
  assert.match(out, /seat {2}handle {11}tier sh {2}amount ETH {2}wallet/);
  for (const s of liveSeats()) {
    assert.ok(out.includes(s.handle), `${s.handle} is missing from the preview`);
    assert.ok(out.includes(s.wallet), `${s.handle}'s wallet is missing`);
  }
  assert.equal(liveSeats().length, 20);
  // And the arithmetic: 1.2500 over 42 shares is 0.0297 a share, rounded down.
  assert.match(out, /per share {12}0\.0297 ETH/);
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
