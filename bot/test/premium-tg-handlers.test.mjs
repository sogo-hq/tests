/**
 * /myid and the /premium admin subcommands, through the real handlers.
 *
 * The acceptance case is one command: an admin pastes eighty ids and a KOL who
 * sent /myid has premium in a DM a second later, with no wallet anywhere. So
 * the paste shapes, the one reply and the DM failure path are what is driven
 * here rather than the storage, which has its own file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('premium-tg-handlers');
process.env.ADMIN_IDS = '9001';

const { createBot } = await import('../dist/bot.js');
const { db } = await import('../dist/db.js');
const G = await import('../dist/tggrants.js');

const bot = createBot('123456:FAKE');
bot.botInfo = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};

const calls = [];
/** Ids the fake Telegram refuses to deliver to, as a blocked user would. */
const blocked = new Set();
bot.api.config.use(async (_p, method, payload) => {
  if (method === 'sendMessage' && blocked.has(payload.chat_id)) {
    throw new Error('Forbidden: bot was blocked by the user');
  }
  calls.push({ method, payload });
  if (method === 'getChatMember') {
    return { ok: true, result: { status: 'administrator', user: { id: payload.user_id, is_bot: false } } };
  }
  return { ok: true, result: { message_id: 1, chat: { id: payload.chat_id }, date: 0 } };
});

let uid = 0;
const DM = (id) => ({ id, type: 'private', first_name: 'A' });
const GROUP = { id: -1001, type: 'supergroup', title: 'the floor' };

const send = async (text, { from = 9001, chat } = {}) => {
  calls.length = 0;
  await bot.handleUpdate({
    update_id: ++uid,
    message: {
      message_id: 1000 + uid, date: 1_789_000_000,
      chat: chat ?? DM(from), from: { id: from, is_bot: false, first_name: 'U' },
      text, entities: [{ type: 'bot_command', offset: 0, length: text.split(/[\s\n]/)[0].length }],
    },
  });
  return calls.filter((c) => c.method !== 'getChatMember');
};

/** Everything the admin was told, as one string. */
const said = async (text, o) => (await send(text, o)).map((c) => c.payload.text ?? '').join('\n');

/** The messages sent to somebody other than the person who typed. */
const dmsTo = (sent, id) => sent.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === id);

const reset = () => {
  db.prepare('DELETE FROM premium_tg_grants').run();
  db.prepare('DELETE FROM premium_tg_reminders').run();
  blocked.clear();
};

// ------------------------------------------------------------------- /myid

test('/myid in a DM gives the number and what to do with it', async () => {
  const out = await said('/myid', { from: 5551 });
  assert.match(out, /^5551$/m);
  assert.match(out, /send this to sirius/);
});

test('/myid in a group does not put an id in the room', async () => {
  const out = await said('/myid', { from: 5551, chat: GROUP });
  assert.equal(out, 'DM me /myid');
  assert.doesNotMatch(out, /5551/, 'the id reached a group');
});

test('/myid is for everybody, not only admins', async () => {
  assert.match(await said('/myid', { from: 12345 }), /^12345$/m);
});

// ------------------------------------------------------- grant and ungrant

test('/premium grant tg: grants, DMs the person, and says both', async () => {
  reset();
  const sent = await send('/premium grant tg:7001 30 floor kol');
  const reply = sent.filter((c) => c.payload.chat_id === 9001).map((c) => c.payload.text).join('\n');
  assert.match(reply, /tg:7001: premium granted until \d{4}-\d{2}-\d{2} UTC \(30 days\)/);
  assert.match(reply, /note: floor kol/);
  assert.match(reply, /told them in a DM/);

  const dm = dmsTo(sent, 7001);
  assert.equal(dm.length, 1);
  assert.match(dm[0].payload.text, /^vitals premium active until \d{4}-\d{2}-\d{2} UTC\. no token needed\.$/);
  assert.ok(G.activeTgGrant(7001));
});

test('granting again extends rather than doubling, and says so', async () => {
  const reply = await said('/premium grant tg:7001 30 floor kol');
  assert.match(reply, /already runs longer, unchanged|extended/);
  assert.equal(G.liveTgGrants().length, 1);
});

test('a grant to somebody who has not started the bot still lands', async () => {
  reset();
  blocked.add(7002);
  const reply = await said('/premium grant tg:7002 30');
  assert.match(reply, /tg:7002: premium granted/);
  assert.match(reply, /could not DM them/);
  assert.match(reply, /they have premium/);
  assert.ok(G.activeTgGrant(7002), 'a failed DM took the grant with it');
});

test('/premium ungrant tg: removes it and says when there was nothing', async () => {
  reset();
  await said('/premium grant tg:7003 30');
  assert.match(await said('/premium ungrant tg:7003'), /tg:7003: grant removed/);
  assert.equal(G.activeTgGrant(7003), null);
  assert.match(await said('/premium ungrant tg:7003'), /tg:7003: no grant/);
});

test('a bad id or a bad day count is refused with the usage line', async () => {
  reset();
  assert.match(await said('/premium grant tg:abc 30'), /\/premium grant tg:<user id> <days> \[note\]/);
  assert.match(await said('/premium grant tg:7004 0'), /days has to be a number from 1 to 3650/);
  assert.match(await said('/premium grant tg:7004 9999'), /days has to be a number from 1 to 3650/);
  assert.deepEqual(G.liveTgGrants(), []);
});

test('the wallet path is untouched by any of it', async () => {
  reset();
  const wallet = '0x' + '5'.repeat(40);
  assert.match(await said(`/premium grant ${wallet} 30`), /premium granted until/);
  assert.match(await said(`/premium ungrant ${wallet}`), /grant removed/);
});

test('a non-admin gets nothing at all from any of it', async () => {
  reset();
  for (const cmd of ['/premium grant tg:7005 30', '/premium ungrant tg:7005', '/premium grantmany 30 x\n7005', '/premium list']) {
    assert.equal(await said(cmd, { from: 4242 }), '', cmd);
  }
  assert.deepEqual(G.liveTgGrants(), []);
});

// -------------------------------------------------------------- grantmany

test('grantmany takes a newline paste and answers in one message', async () => {
  reset();
  const sent = await send('/premium grantmany 30 floor kol\n7101\n7102\n7103');
  const replies = sent.filter((c) => c.payload.chat_id === 9001);
  assert.equal(replies.length, 1, 'the admin got more than one message');
  const reply = replies[0].payload.text;
  assert.match(reply, /3 ids, 30 days, note "floor kol"/);
  assert.match(reply, /added 3/);
  assert.match(reply, /extended 0/);
  assert.match(reply, /invalid 0/);
  assert.equal(G.liveTgGrants().length, 3);
  for (const id of [7101, 7102, 7103]) assert.equal(dmsTo(sent, id).length, 1);
});

test('grantmany takes commas, spaces and a mix, and names what it could not read', async () => {
  reset();
  assert.match(await said('/premium grantmany 30 x\n7201, 7202,7203'), /added 3/);
  reset();
  assert.match(await said('/premium grantmany 30 x\n7301 7302\n7303, notanid\n-5'), /added 3/);
  const out = await said('/premium grantmany 30 x\n7401\nnotanid\n-5\n0');
  assert.match(out, /added 1/);
  assert.match(out, /invalid 3: notanid -5 0/);
});

test('running the same batch twice extends nothing and adds nothing', async () => {
  reset();
  await said('/premium grantmany 30 floor kol\n7501\n7502');
  const again = await said('/premium grantmany 30 floor kol\n7501\n7502');
  assert.match(again, /added 0/);
  assert.match(again, /already longer, unchanged 2/);
  assert.equal(G.liveTgGrants().length, 2);
});

test('a duplicate inside one paste is granted once and counted', async () => {
  reset();
  const out = await said('/premium grantmany 30 x\n7601\n7601\n7602');
  assert.match(out, /added 2/);
  assert.match(out, /1 duplicate id in the paste, granted once/);
  assert.equal(G.liveTgGrants().length, 2);
});

test('grantmany reports the ids it could not reach without failing the grant', async () => {
  reset();
  blocked.add(7702);
  const out = await said('/premium grantmany 30 x\n7701\n7702\n7703');
  assert.match(out, /added 3/);
  assert.match(out, /could not DM 1: 7702/);
  assert.match(out, /they have premium\./);
  assert.ok(G.activeTgGrant(7702));
});

test('grantmany with no ids and with a bad day count says which it was', async () => {
  reset();
  assert.match(await said('/premium grantmany 30 floor kol'), /no user ids in that/);
  assert.match(await said('/premium grantmany nope x\n7801'), /days is 1 to 3650/);
  assert.deepEqual(G.liveTgGrants(), []);
});

test('eighty ids in one paste is one message and eighty grants', async () => {
  reset();
  const ids = Array.from({ length: 80 }, (_, i) => 8000 + i);
  const sent = await send(`/premium grantmany 30 floor kol\n${ids.join('\n')}`);
  const replies = sent.filter((c) => c.payload.chat_id === 9001);
  assert.equal(replies.length, 1);
  assert.match(replies[0].payload.text, /80 ids, 30 days/);
  assert.match(replies[0].payload.text, /added 80/);
  assert.equal(G.liveTgGrants().length, 80);
  assert.equal(sent.filter((c) => c.method === 'sendMessage' && c.payload.chat_id !== 9001).length, 80);
});

// ------------------------------------------------------------------- list

test('/premium list shows id, expiry, days left and note, soonest first', async () => {
  reset();
  await said('/premium grantmany 60 later\n9101');
  await said('/premium grantmany 30 sooner\n9102');
  const out = await said('/premium list tg');
  assert.match(out, /by telegram id: 2/);
  const rows = out.split('\n').filter((l) => /^\s+91\d\d/.test(l));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /9102.+30d.+sooner/);
  assert.match(rows[1], /9101.+60d.+later/);
});

test('/premium list wallet and all keep the two apart', async () => {
  const wallet = '0x' + '6'.repeat(40);
  await said(`/premium grant ${wallet} 45 partner`);
  const walletOnly = await said('/premium list wallet');
  assert.match(walletOnly, /by wallet: 1/);
  assert.doesNotMatch(walletOnly, /by telegram id/);
  const all = await said('/premium list');
  assert.match(all, /by telegram id: 2/);
  assert.match(all, /by wallet: 1/);
  assert.match(all, new RegExp(wallet));
});

test('/premium list refuses a filter it does not have', async () => {
  assert.match(await said('/premium list nope'), /\/premium list \[tg\|wallet\|all\]/);
});

test('/premium list says when there is nothing', async () => {
  reset();
  db.prepare('DELETE FROM access_grants').run();
  const out = await said('/premium list');
  assert.match(out, /by telegram id: 0/);
  assert.match(out, /by wallet: 0/);
});
