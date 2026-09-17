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
const ROOM_LINE =
  "the room: 50 seats. the room is owed 10% of the fee wallet's cumulative gross income, "
  + 'paid daily in ETH for 30 days by shares (T1 5, T2 2, T3 1), every payout printed before '
  + 'it leaves and recorded with its hash. a seat is given by the deployer, its tier is fixed '
  + 'when taken and reviewed once after the 30 days. a seat given up is reused and both '
  + 'occupants stay in the history. 10% of gross income goes to ecosystem integrations, '
  + '80% to the build.';
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
// The one-time legend has its own file. It used to be filtered out here by a
// helper matching a first line that had since changed, so the filter matched
// nothing and every assertion below was already written against the unfiltered
// calls. Removed rather than repaired: two of them read the legend itself.
const send = async (chatType, text) => {
  calls.length = 0;
  await bot.handleUpdate(at(chatType, text));
  return calls;
};

test('/declare in a group points at the DM and does nothing else', async () => {
  const c = await send('group', '/declare');
  assert.match(c[0].payload.text, /declaring is a DM/);
  assert.ok(!c.some((x) => x.method === 'sendPhoto'));
});

test('the form walks six questions and keeps its place on a bad answer', async () => {
  let c = await send('private', '/declare');
  assert.match(c[0].payload.text, /8 questions/);
  // What it costs, before six answers rather than after them.
  assert.match(c[0].payload.text, /the first 100 declarations are free\. this would be #1\./);
  assert.match(c[0].payload.text, /1 of 8\./);

  c = await send('private', 'my main wallet');
  assert.match(c[0].payload.text, /not an address/);
  assert.match(c[0].payload.text, /1 of 8\./, 'a rejected answer must not advance the form');

  // An address typed into an open form is an ANSWER, never a scan. Without
  // this the very first question would have its answer scanned instead.
  c = await send('private', DEPLOYER);
  assert.match(c[0].payload.text, /2 of 8\./);
  assert.ok(!c.some((x) => /^VITALS {2}/.test(x.payload?.text ?? '')));

  for (const [answer, expect] of [
    ['2.5', /3 of 8\./],
    ['dev wallet only', /4 of 8\./],
    ['400, half to the artist', /5 of 8\./],
    ['held by the deployer, vesting contracts in october, nothing distributed at launch', /6 of 8\./],
    [ROOM_LINE, /7 of 8\./],
    ['holder fee share is off at launch.', /8 of 8\./],
  ]) {
    c = await send('private', answer);
    assert.match(c[0].payload.text, expect);
  }

  c = await send('private', 'https://docs.checkvitals.xyz');
  const text = c[0].payload.text;
  assert.match(text, /sign this exact text with the deployer wallet/);
  assert.match(text, /^vitals declaration$/m);
  assert.match(text, new RegExp(`^deployer: ${DEPLOYER}$`, 'm'));
  // One dev buy line, carrying what that buy holds. There is no separate
  // team tokens line to answer falsely any more.
  assert.match(text, /^dev buy: 2\.5% of supply, held by the deployer, vesting contracts in october, nothing distributed at launch$/m);
  assert.doesNotMatch(text, /^team tokens:/m);
  assert.match(text, /^tax-free at launch: the deployer only$/m);
  assert.match(text, /^creator tax: 400 bps$/m);
  assert.match(text, /^tax split: half to the artist$/m);
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

// --------------------------------------------------- the launch notice

test('the launch notice ends /start and /legend, once per user', async () => {
  const LINE = '$VITALS, the first declared launch on pons: 24 Sep · t.me/vitals_official';
  process.env.LAUNCH_NOTICE = LINE;
  delete process.env.LAUNCH_NOTICE_UNTIL;
  const N = await import('../dist/launchnotice.js');
  N.resetLaunchNotice();
  N.resetLaunchNoticeSeen(USER);

  // /start carries it once. The legend that follows a first /start must not
  // repeat it: two copies in two messages is the thing "once per user" is for.
  let c = await send('private', '/start');
  const withNotice = c.filter((x) => (x.payload?.text ?? '').endsWith(LINE));
  assert.equal(withNotice.length, 1, `${withNotice.length} messages carried the notice`);

  c = await send('private', '/legend');
  assert.ok(!(c[0].payload.text ?? '').endsWith(LINE), 'said twice to the same user');
  assert.match(c[0].payload.text, /no finding/);

  // A different user gets their own copy.
  calls.length = 0;
  const other = { ...at('private', '/legend') };
  other.message.from = { id: 9999, is_bot: false, first_name: 'V' };
  await bot.handleUpdate(other);
  assert.ok(calls[0].payload.text.endsWith(LINE));

  delete process.env.LAUNCH_NOTICE;
  N.resetLaunchNotice();
});
