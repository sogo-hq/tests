/**
 * The DM gate.
 *
 * Two things it must get right, and the second matters more: a non-member in a
 * DM is asked to join, and everything else is never gated. A group card is read
 * by people who did not choose this bot, and an inline result appears in a chat
 * the bot is not even in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('gate');
process.env.START_GATE = 'on';
process.env.GATE_CHANNEL = '@vitals_official';
const { createBot } = await import('../dist/bot.js');
const G = await import('../dist/membership.js');

const bot = createBot('123456:FAKE');
bot.botInfo = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};

let status = 'member';
let memberCalls = 0;
const calls = [];
bot.api.config.use(async (_prev, method, payload) => {
  if (method === 'getChatMember' && payload.chat_id === '@vitals_official') {
    memberCalls++;
    if (status === 'throw') throw new Error('bot is not an admin of the channel');
    return { ok: true, result: { status, user: { id: payload.user_id, is_bot: false, first_name: 'U' } } };
  }
  calls.push({ method, payload });
  if (method === 'sendMessage') {
    return { ok: true, result: { message_id: 1, chat: { id: payload.chat_id }, date: 0, text: payload.text } };
  }
  return { ok: true, result: true };
});

let uid = 0;
const dm = (text, userId) => ({
  update_id: ++uid,
  message: {
    message_id: 1000 + uid, date: 0,
    chat: { id: userId, type: 'private' },
    from: { id: userId, is_bot: false, first_name: 'U' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
  },
});
const group = (text, userId) => ({
  update_id: ++uid,
  message: {
    message_id: 2000 + uid, date: 0,
    chat: { id: -1001, type: 'supergroup', title: 'g' },
    from: { id: userId, is_bot: false, first_name: 'U' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
  },
});
const send = async (update) => {
  calls.length = 0;
  await bot.handleUpdate(update);
  return calls.filter((x) => x.method !== 'getChatMember');
};

test('a non-member in a DM is asked to join, with a button', async () => {
  status = 'left';
  G.resetMembership();
  const c = await send(dm('/start', 7001));
  assert.equal(c.length, 1);
  assert.match(c[0].payload.text, /open to members of @vitals_official/);
  assert.match(c[0].payload.reply_markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\/vitals_official$/);
  // And the help itself is not sent alongside it.
  assert.ok(!/pons v2 launch scanner/.test(c[0].payload.text));
});

test('the gate is not just on /start', async () => {
  status = 'left';
  G.resetMembership();
  for (const cmd of ['/legend', '/stats', '/declared']) {
    const c = await send(dm(cmd, 7002));
    assert.match(c[0].payload.text, /open to members of/, `${cmd} was not gated`);
  }
});

test('a member gets the command', async () => {
  status = 'member';
  G.resetMembership();
  const c = await send(dm('/start', 7003));
  assert.match(c[0].payload.text, /pons v2 launch scanner/);
});

test('a group is never gated', async () => {
  status = 'left';
  G.resetMembership();
  const c = await send(group('/leaderboard', 7004));
  assert.ok(!/open to members of/.test(c[0].payload.text),
    'a group member who does not follow the channel was locked out of a group');
  assert.match(c[0].payload.text, /calls in this group/);
});

test('an unreadable membership is never treated as absent', async () => {
  // The bot may not be an admin of the channel, or Telegram may be having a
  // minute. Neither is evidence that somebody is not a member, and locking
  // them out over a failed lookup is the wrong way to be wrong.
  status = 'throw';
  G.resetMembership();
  const c = await send(dm('/start', 7005));
  assert.match(c[0].payload.text, /pons v2 launch scanner/);
});

test('the answer is cached, and joining clears it', async () => {
  status = 'member';
  G.resetMembership();
  memberCalls = 0;
  for (let i = 0; i < 4; i++) await send(dm('/legend', 7006));
  assert.equal(memberCalls, 1, `asked Telegram ${memberCalls} times for one user`);

  // Somebody who joins does not wait out the window.
  status = 'left';
  G.markJoined(7006);
  await send(dm('/legend', 7006));
  assert.equal(memberCalls, 2);
});

test('with the gate off nothing is checked at all', async () => {
  process.env.START_GATE = 'off';
  status = 'left';
  G.resetMembership();
  memberCalls = 0;
  const c = await send(dm('/start', 7007));
  assert.equal(memberCalls, 0, 'the gate asked Telegram while switched off');
  assert.match(c[0].payload.text, /pons v2 launch scanner/);
  process.env.START_GATE = 'on';
});
