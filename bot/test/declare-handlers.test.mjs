/**
 * /declare and /declared, driven through the real handlers.
 *
 * No chain: the form, its prompts, and the listing are all local. The signing
 * step reads a block and is covered in declare.test.mjs, which hands it one.
 * Kept out of the live handler suite for that reason, so the whole command
 * surface is checked on every run rather than only when a node is reachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('declare-handlers');
const { createBot } = await import('../dist/bot.js');
const { db } = await import('../dist/db.js');

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
  if (method === 'sendPhoto') {
    return { ok: true, result: { message_id: ++sentId, chat: { id: payload.chat_id }, date: 0, photo: [] } };
  }
  return { ok: true, result: true };
});

const USER = 6701;
const DEPLOYER = '0x' + '9'.repeat(40);
let uid = 0;
const at = (chatType, text) => ({
  update_id: ++uid,
  message: {
    message_id: 1000 + uid,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatType === 'private' ? USER : -700, type: chatType, ...(chatType === 'private' ? {} : { title: 'g' }) },
    from: { id: USER, is_bot: false, first_name: 'U' },
    text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
  },
});
// The one-time legend follows a first DM and would displace the message under
// test; it has its own file.
const isLegend = (x) => /^\u{1F6A9} a finding —/u.test(x.payload?.text ?? '');
const send = async (chatType, text) => {
  calls.length = 0;
  await bot.handleUpdate(at(chatType, text));
  return calls.filter((x) => !isLegend(x));
};

test('/declare in a group points at the DM and does nothing else', async () => {
  const c = await send('group', '/declare');
  assert.match(c[0].payload.text, /declaring is a DM/);
  assert.ok(!c.some((x) => x.method === 'sendPhoto'));
});

test('the form walks six questions and keeps its place on a bad answer', async () => {
  let c = await send('private', '/declare');
  assert.match(c[0].payload.text, /six questions/);
  // What it costs, before six answers rather than after them.
  assert.match(c[0].payload.text, /the first 100 declarations are free\. this would be #1\./);
  assert.match(c[0].payload.text, /1 of 6\./);

  c = await send('private', 'my main wallet');
  assert.match(c[0].payload.text, /not an address/);
  assert.match(c[0].payload.text, /1 of 6\./, 'a rejected answer must not advance the form');

  // An address typed into an open form is an ANSWER, never a scan. Without
  // this the very first question would have its answer scanned instead.
  c = await send('private', DEPLOYER);
  assert.match(c[0].payload.text, /2 of 6\./);
  assert.ok(!c.some((x) => /^VITALS {2}/.test(x.payload?.text ?? '')));

  for (const [answer, expect] of [
    ['2.5', /3 of 6\./],
    ['dev wallet only', /4 of 6\./],
    ['400, half to the artist', /5 of 6\./],
    ['no team allocation', /6 of 6\./],
  ]) {
    c = await send('private', answer);
    assert.match(c[0].payload.text, expect);
  }

  c = await send('private', 'https://docs.checkvitals.xyz');
  const text = c[0].payload.text;
  assert.match(text, /sign this exact text with the deployer wallet/);
  assert.match(text, /^vitals declaration$/m);
  assert.match(text, new RegExp(`^deployer: ${DEPLOYER}$`, 'm'));
  assert.match(text, /^dev buy: 2\.5% of supply$/m);
  assert.match(text, /^tax-free at launch: the deployer only$/m);
  assert.match(text, /^creator tax: 400 bps$/m);
  assert.match(text, /^team tokens: no team allocation$/m);
  assert.match(text, /\/declare sign <signature>/);
});

test('an unsigned form stores nothing, and cancel clears it', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM launch_declarations').get().n, 0,
    'a form that was never signed is not a declaration');
  const c = await send('private', '/declare cancel');
  assert.match(c[0].payload.text, /form cleared/);
  // With the form closed, a plain address is a scan request again.
  const after = await send('private', 'hello');
  assert.equal(after.length, 0, 'ordinary chat is not an answer once the form is closed');
});

test('/declared says so when there are none, then lists them', async () => {
  let c = await send('private', '/declared');
  assert.match(c[0].payload.text, /no declarations yet/);

  db.prepare(
    `INSERT INTO launch_declarations (deployer, declared_by, declared_at, block_number,
       dev_buy_pct, exempt_list, exempt_count, creator_tax_bps, tax_split, vesting,
       docs_url, canonical, signature, free_slot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(DEPLOYER, USER, 1_789_000_000, 100, 2.5, '[]', 1, 400, 'x', 'y',
    'https://docs.checkvitals.xyz', 'c', '0xsig', 1);

  c = await send('private', '/declared');
  const text = c[0].payload.text;
  assert.match(text, /declared launches, newest first/);
  assert.match(text, /#1 {2}0x9999…9999/);
  assert.match(text, /dev buy 2\.5%, 1 tax-free, 400 bps/);
  assert.match(text, /no launch from this wallet yet/);
  // The deployer is published by design. Nothing about the Telegram account
  // that made the declaration appears anywhere in it.
  assert.ok(!new RegExp(String(USER)).test(text), 'a user id leaked into a listing');
});

test('the deep link opens the declaration it names', async () => {
  const c = await send('private', '/start d1');
  const text = c[0].payload.text;
  assert.match(text, /founding declared launch #1/);
  assert.match(text, /signed at block 100/);
  assert.match(text, /no launch from this wallet yet/);
  assert.match(text, /nothing in it was checked against a chain/);

  const missing = await send('private', '/start d999');
  assert.match(missing[0].payload.text, /no declaration with that id/);
});
