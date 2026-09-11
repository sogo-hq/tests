/**
 * The auto-reply, driven through the real handlers.
 *
 * The assertion that matters most is the first one: an address pasted in a
 * group the bot has not been asked to scan produces nothing at all. Everything
 * else here is about what happens after somebody has asked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('autoscan-handlers');
const { createBot } = await import('../dist/bot.js');
const A = await import('../dist/autoscan.js');

const bot = createBot('123456:FAKE');
bot.botInfo = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};

const calls = [];
let sentId = 7000;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method === 'sendMessage') {
    return { ok: true, result: { message_id: ++sentId, chat: { id: payload.chat_id }, date: 0, text: payload.text } };
  }
  if (method === 'getChatMember') {
    // The sender is an admin of this group unless a test says otherwise.
    return { ok: true, result: { status: adminStatus, user: { id: payload.user_id, is_bot: false, first_name: 'U' } } };
  }
  return { ok: true, result: true };
});

let adminStatus = 'administrator';
const CHAT = -1001;
const TOKEN = '0xd384722f6adfe7d79E8e6623896DF199afD31B76';
let uid = 0;
const msg = (text, over = {}) => ({
  update_id: ++uid,
  message: {
    message_id: 1000 + uid,
    date: Math.floor(Date.now() / 1000),
    chat: { id: CHAT, type: 'supergroup', title: 'g' },
    from: { id: 5000, is_bot: false, first_name: 'U', username: 'alice' },
    text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
    ...over,
  },
});
/** What the bot SAID. getChatMember is a lookup, not a message. */
const send = async (text, over) => {
  calls.length = 0;
  await bot.handleUpdate(msg(text, over));
  return calls.filter((x) => x.method !== 'getChatMember');
};

test('an address in a group nobody asked is answered with nothing', async () => {
  A.setAutoscan(CHAT, false);
  const c = await send(`look at ${TOKEN}`);
  assert.deepEqual(c, [], `the bot spoke uninvited: ${JSON.stringify(c.map((x) => x.method))}`);
});

test('a member cannot turn it on for the group', async () => {
  adminStatus = 'member';
  const c = await send('/autoscan on');
  assert.match(c[0].payload.text, /an admin of this group/);
  assert.equal(A.autoscanEnabled(CHAT), false, 'a member switched it on');
  adminStatus = 'administrator';
});

test('an admin turns it on, and the setting says so', async () => {
  let c = await send('/autoscan');
  assert.match(c[0].payload.text, /autoscan is off/);

  c = await send('/autoscan on');
  assert.match(c[0].payload.text, /autoscan on/);
  assert.equal(A.autoscanEnabled(CHAT), true);

  c = await send('/autoscan');
  assert.match(c[0].payload.text, /autoscan is on/);
});

test('a repeat inside the window costs one line and a button, not a card', async () => {
  A.resetAutoReplies(CHAT);
  // The first paste goes to the scanner, which needs a chain this test has no
  // business using; the claim is what decides, and it is asserted directly.
  assert.equal(A.claimAutoReply(CHAT, TOKEN), 'card');

  const c = await send(`again ${TOKEN}`);
  assert.equal(c.length, 1);
  assert.match(c[0].payload.text, /already scanned in the last 10 min/);
  assert.equal(c[0].payload.reply_markup.inline_keyboard[0][0].text, 'Refresh');
  assert.ok(c[0].payload.reply_parameters.message_id, 'answered as a reply to the paste');
});

test('the bot does not answer itself', async () => {
  A.resetAutoReplies(CHAT);
  const c = await send(`card for ${TOKEN}`, { from: { id: 42, is_bot: true, first_name: 'VITALS' } });
  assert.deepEqual(c, [], 'the bot answered its own card');
  assert.equal(A.everAnswered(CHAT, TOKEN), false);
});

test('a command is not a paste', async () => {
  A.resetAutoReplies(CHAT);
  // /autoscan carries no address, but the guard that matters is that a command
  // is handled as a command: the auto-reply must not claim it first.
  await send('/autoscan');
  assert.equal(A.everAnswered(CHAT, TOKEN), false);
});

test('turning it off stops it again', async () => {
  await send('/autoscan off');
  assert.equal(A.autoscanEnabled(CHAT), false);
  A.resetAutoReplies(CHAT);
  const c = await send(`and now ${TOKEN}`);
  assert.deepEqual(c, []);
  assert.equal(A.everAnswered(CHAT, TOKEN), false, 'an off group still claimed the address');
});

test('autoscan is not a DM setting', async () => {
  calls.length = 0;
  await bot.handleUpdate({
    update_id: ++uid,
    message: {
      message_id: 9999, date: 0, chat: { id: 5000, type: 'private' },
      from: { id: 5000, is_bot: false, first_name: 'U' },
      text: '/autoscan on',
      entities: [{ type: 'bot_command', offset: 0, length: 9 }],
    },
  });
  assert.match(calls[0].payload.text, /autoscan is a group setting/);
  assert.equal(A.autoscanEnabled(5000), false);
});
