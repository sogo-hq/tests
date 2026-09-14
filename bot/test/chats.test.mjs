/**
 * Which groups the bot is in, from its own membership updates.
 *
 * The count exists for the daily numbers card, so what is pinned is that it
 * can go DOWN: a group that removed the bot is not a group the bot is in, and a
 * count that only ever rose would be a vanity number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('chats');
const { createBot } = await import('../dist/bot.js');
const C = await import('../dist/chats.js');
const { db } = await import('../dist/db.js');

const bot = createBot('123456:FAKE');
bot.botInfo = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};
bot.api.config.use(async () => ({ ok: true, result: true }));

let uid = 0;
const me = { id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot' };
const membership = (chat, from, to) => ({
  update_id: ++uid,
  my_chat_member: {
    chat, date: 1_700_000_000 + uid,
    from: { id: 5000, is_bot: false, first_name: 'U' },
    old_chat_member: { status: from, user: me },
    new_chat_member: { status: to, user: me },
  },
});

test('nothing recorded, nothing counted', () => {
  assert.equal(C.groupsBotIsIn(), 0);
});

test('added to a group: counted, with its title', async () => {
  await bot.handleUpdate(membership({ id: -1001, type: 'supergroup', title: 'alpha' }, 'left', 'member'));
  assert.equal(C.groupsBotIsIn(), 1);
  const row = db.prepare('SELECT * FROM bot_chats WHERE chat_id = -1001').get();
  assert.equal(row.title, 'alpha');
  assert.equal(row.status, 'member');
});

test('promoted to admin in the same group: still one group', async () => {
  await bot.handleUpdate(membership({ id: -1001, type: 'supergroup', title: 'alpha' }, 'member', 'administrator'));
  assert.equal(C.groupsBotIsIn(), 1);
});

test('removed from the group: the count goes down', async () => {
  await bot.handleUpdate(membership({ id: -1002, type: 'group', title: 'beta' }, 'left', 'member'));
  assert.equal(C.groupsBotIsIn(), 2);
  await bot.handleUpdate(membership({ id: -1001, type: 'supergroup', title: 'alpha' }, 'administrator', 'kicked'));
  assert.equal(C.groupsBotIsIn(), 1, 'a group that removed the bot is not a group the bot is in');
});

test('a private chat or channel is not a group', async () => {
  await bot.handleUpdate(membership({ id: 777, type: 'private', first_name: 'U' }, 'left', 'member'));
  await bot.handleUpdate(membership({ id: -1003, type: 'channel', title: 'news' }, 'left', 'administrator'));
  assert.equal(C.groupsBotIsIn(), 1);
});

test('activity seeds a group the handler never saw, and never overwrites one it did', () => {
  db.prepare(
    `INSERT INTO scan_events (ts, source, chat_id, user_id, token, cache_hit, duration_ms, outcome)
     VALUES (1, 'group', -1004, 1, NULL, 0, 1, 'ok')`,
  ).run();
  // alpha was kicked above; a scan event from it in the past must not resurrect it
  db.prepare(
    `INSERT INTO scan_events (ts, source, chat_id, user_id, token, cache_hit, duration_ms, outcome)
     VALUES (1, 'group', -1001, 1, NULL, 0, 1, 'ok')`,
  ).run();
  const n = C.seedBotChatsFromActivity();
  assert.equal(n, 1, 'only the group with no row is seeded');
  assert.equal(C.groupsBotIsIn(), 2);
  assert.equal(db.prepare('SELECT status FROM bot_chats WHERE chat_id = -1001').get().status, 'kicked');
  // idempotent
  assert.equal(C.seedBotChatsFromActivity(), 0);
});
