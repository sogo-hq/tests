import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('collision-handler');
process.env.ADMIN_IDS = '9001';
const { createBot } = await import('../dist/bot.js');
const { db, normaliseKey } = await import('../dist/db.js');

const bot = createBot('123456:FAKE');
bot.botInfo = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};
const calls = [];
bot.api.config.use(async (_p, method, payload) => {
  calls.push({ method, payload });
  if (method === 'getChatMember') return { ok: true, result: { status: 'administrator', user: { id: payload.user_id, is_bot: false } } };
  return { ok: true, result: { message_id: 1, chat: { id: payload.chat_id }, date: 0 } };
});

let uid = 0;
const DM = { id: 9001, type: 'private', first_name: 'A' };
const GROUP = { id: -1001, type: 'supergroup', title: 'room' };
const said = async (text, { from = 9001, chat = DM } = {}) => {
  calls.length = 0;
  await bot.handleUpdate({
    update_id: ++uid,
    message: {
      message_id: 1000 + uid, date: 1_789_000_000, chat, from: { id: from, is_bot: false, first_name: 'U' },
      text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    },
  });
  return calls.filter((c) => c.method !== 'getChatMember').map((c) => c.payload.text ?? '').join('\n');
};

let seq = 0;
const launch = (name, symbol) => {
  seq++;
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
        graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key, symbol_key)
      VALUES (?,?,?,?,0,'0',?,?,?,?,?,?,?)`,
  ).run('0x' + String(seq).padStart(40, '0'), '0x' + String(900000 + seq).padStart(40, '0'),
        '0x' + String(98).padStart(40, '0'), '0x'.padEnd(42, '0'), 1000 + seq,
        '0x' + String(seq).padStart(64, '0'), 1_000_000 + seq,
        name, symbol, normaliseKey(name), normaliseKey(symbol));
};

test('/collision answers an admin in a DM with the count and the keys', async () => {
  launch('Vitals', 'ІTALS');
  const out = await said('/collision VITALS VITALS');
  assert.match(out, /collision check/);
  assert.match(out, /compared as/);
  assert.match(out, /other indexed token/);
});

test('/collision refuses in a group and says why', async () => {
  const out = await said('/collision VITALS VITALS', { chat: GROUP });
  assert.match(out, /DM/);
  assert.doesNotMatch(out, /compared as/, 'the count reached a group');
});

test('/collision says nothing at all to a non-admin', async () => {
  assert.equal(await said('/collision VITALS VITALS', { from: 5 }), '');
  assert.equal(await said('/collision VITALS VITALS', { from: 5, chat: GROUP }), '');
});

test('/collision with too few arguments prints the usage, not a count', async () => {
  const out = await said('/collision VITALS');
  assert.match(out, /\/collision <name> <symbol>/);
  assert.doesNotMatch(out, /compared as/);
});

test('/collision writes nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM launches').get().n;
  await said('/collision VITALS VITALS');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM launches').get().n, before);
});

// ------------------------------------------------------------- the watch

test('/collision watch starts one and says what it compares on', async () => {
  const out = await said('/collision watch VITALS VITALS');
  assert.match(out, /watching VITALS \/ VITALS as \d+/);
  assert.match(out, /compared as vitals \/ vitals/);
  assert.match(out, /every admin gets a DM/);
  assert.match(out, /\/collision unwatch \d+ stops it/);
});

test('/collision watch twice does not start a second', async () => {
  const again = await said('/collision watch vitals VITALS');
  assert.match(again, /already watching that, as \d+\. nothing was started twice/);
  const list = await said('/collision watch');
  assert.equal((list.match(/compared as/g) ?? []).length, 1);
});

test('/collision watch with no arguments lists what is running', async () => {
  const out = await said('/collision watch');
  assert.match(out, /watching, until stopped:/);
  assert.match(out, /VITALS \/ VITALS/);
});

test('a launch landing on a watched key DMs every admin, once', async () => {
  const { db, normaliseKey } = await import('../dist/db.js');
  const { deliverCollisionWatch } = await import('../dist/bot.js');
  const token = '0x' + 'ab'.repeat(20);
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
        graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key, symbol_key)
      VALUES (?,?,?,?,0,'0',?,?,?,?,?,?,?)`,
  ).run(token, '0x' + 'c'.repeat(40), '0x' + 'd'.repeat(40), '0x'.padEnd(42, '0'),
        64_623_813, '0x' + 'e'.repeat(64), 1_700_000_000,
        'Vitals', 'VІTALS', normaliseKey('Vitals'), normaliseKey('VІTALS'));

  calls.length = 0;
  const sent = await deliverCollisionWatch([token]);
  const dms = calls.filter((c) => c.method === 'sendMessage');
  // ADMIN_IDS is one id in this file, so one DM.
  assert.equal(sent, 1);
  assert.equal(dms.length, 1);
  assert.equal(dms[0].payload.chat_id, 9001);
  assert.match(dms[0].payload.text, new RegExp(`CA {9}${token}`));
  assert.match(dms[0].payload.text, /block {6}64,623,813/);
  // No markup, because the ticker in it was written by somebody else.
  assert.equal(dms[0].payload.parse_mode, undefined);

  // The same token again is not a second DM.
  calls.length = 0;
  assert.equal(await deliverCollisionWatch([token]), 0);
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 0);
});

test('/collision unwatch stops it, and nothing is sent after', async () => {
  const { db, normaliseKey } = await import('../dist/db.js');
  const { deliverCollisionWatch } = await import('../dist/bot.js');
  const live = db.prepare('SELECT id FROM collision_watches WHERE stopped_at IS NULL').get();
  assert.match(await said(`/collision unwatch ${live.id}`), new RegExp(`stopped ${live.id}`));
  assert.match(await said(`/collision unwatch ${live.id}`), /is not a watch that is running/);

  const token = '0x' + 'ba'.repeat(20);
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
        graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key, symbol_key)
      VALUES (?,?,?,?,0,'0',?,?,?,?,?,?,?)`,
  ).run(token, '0x' + 'f'.repeat(40), '0x' + 'd'.repeat(40), '0x'.padEnd(42, '0'),
        64_623_900, '0x' + 'a'.repeat(64), 1_700_000_100,
        'Vitals', 'VITALS', normaliseKey('Vitals'), normaliseKey('VITALS'));
  calls.length = 0;
  assert.equal(await deliverCollisionWatch([token]), 0, 'a stopped watch still sent');
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 0);
});

test('a non-admin cannot start, list or stop a watch', async () => {
  for (const cmd of ['/collision watch FAKE FAKE', '/collision watch', '/collision unwatch 1']) {
    assert.equal(await said(cmd, { from: 5 }), '', cmd);
  }
});

test('/collision watch refuses in a group', async () => {
  const out = await said('/collision watch VITALS VITALS', { chat: GROUP });
  assert.match(out, /DM/);
  assert.doesNotMatch(out, /compared as/);
});

test('a watch that would match nothing is refused', async () => {
  const out = await said('/collision watch ... !!!');
  assert.match(out, /nothing would ever match it/);
});
