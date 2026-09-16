/**
 * The three admin tools, driven through the real handlers.
 *
 * What is pinned is the gate: /scout and /numbers answer an admin and nobody
 * else, /scout only in a DM, and /stats tax reaches the tax text rather than
 * the plain /stats reply. The tools' own arithmetic is tested in their own
 * files; here it is who gets an answer, and in which chat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('paste5-handlers');
process.env.ADMIN_IDS = '9001';
const { createBot } = await import('../dist/bot.js');
const { recordIndexAdvance } = await import('../dist/indexer/health.js');
recordIndexAdvance(1n);

const bot = createBot('123456:FAKE');
bot.botInfo = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};

const calls = [];
let sentId = 7000;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') {
    return { ok: true, result: { message_id: ++sentId, chat: { id: payload.chat_id }, date: 0 } };
  }
  if (method === 'getChatMember') {
    return { ok: true, result: { status: 'member', user: { id: payload.user_id, is_bot: false, first_name: 'U' } } };
  }
  return { ok: true, result: true };
});

let uid = 0;
const msg = (text, from, chat) => ({
  update_id: ++uid,
  message: {
    message_id: 1000 + uid,
    date: Math.floor(Date.now() / 1000),
    chat,
    from: { id: from, is_bot: false, first_name: 'U' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
  },
});
const DM = (id) => ({ id, type: 'private', first_name: 'U' });
const GROUP = { id: -1001, type: 'supergroup', title: 'g' };
const send = async (text, from, chat) => {
  calls.length = 0;
  await bot.handleUpdate(msg(text, from, chat));
  return calls.filter((x) => x.method !== 'getChatMember');
};

test('/scout from a non-admin: nothing at all', async () => {
  assert.deepEqual(await send('/scout', 5000, DM(5000)), []);
});

test('/scout from an admin in a group: nothing, it is a DM tool', async () => {
  assert.deepEqual(await send('/scout', 9001, GROUP), []);
});

test('/scout from an admin in a DM answers with the digest', async () => {
  const c = await send('/scout', 9001, DM(9001));
  assert.equal(c[0].method, 'sendMessage');
  assert.match(c[0].payload.text, /^scout · 0 of 0 launches graduated in 7d match/);
  assert.match(c[0].payload.text, /not checked: 0 exemptions undetermined/);
  // No rows, no CSV: an empty file is not a deliverable.
  assert.equal(c.length, 1);
});

test('/scout serial from an admin in a DM', async () => {
  const c = await send('/scout serial', 9001, DM(9001));
  assert.equal(c.length, 1);
  assert.match(c[0].payload.text, /serial/);
});

test('/numbers from a non-admin: nothing', async () => {
  assert.deepEqual(await send('/numbers', 5000, DM(5000)), []);
});

test('/numbers from an admin sends a PNG with the caption', async () => {
  const c = await send('/numbers', 9001, DM(9001));
  assert.equal(c.length, 1);
  assert.equal(c[0].method, 'sendPhoto');
  assert.match(c[0].payload.caption, /daily numbers/);
  assert.match(c[0].payload.caption, /launches indexed/);
  assert.doesNotMatch(c[0].payload.caption, new RegExp(String.fromCharCode(0x2014)));
});

test('/stats tax reaches the tax text, /stats the plain one', async () => {
  const tax = await send('/stats tax', 5000, DM(5000));
  assert.match(tax[0].payload.text, /creator tax, all launches/);
  assert.match(tax[0].payload.text, /pool trades after graduation are not indexed/);
  const plain = await send('/stats', 5000, DM(5000));
  assert.match(plain[0].payload.text, /launches indexed/);
  assert.doesNotMatch(plain[0].payload.text, /creator tax, all launches/);
});

test('none of the three prints a verdict word or an em dash', async () => {
  for (const [t, from] of [['/scout', 9001], ['/scout serial', 9001], ['/numbers', 9001], ['/stats tax', 5000]]) {
    const c = await send(t, from, DM(from));
    for (const x of c) {
      const s = x.payload.text ?? x.payload.caption ?? '';
      assert.doesNotMatch(s, new RegExp(`\\bclean\\b|\\bsafe\\b|looks good|${String.fromCharCode(0x2014)}|!`), `${t}: ${s.slice(0, 80)}`);
    }
  }
});
