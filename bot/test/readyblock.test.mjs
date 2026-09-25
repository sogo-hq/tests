/**
 * Who may post the READY block, where the scheduled posts go, and the one
 * per-group switch that turns the block off without moving anything else.
 *
 * The load-bearing assertions here are the two that have nothing to do with the
 * block. `ready_chat` carries the countdown, the fake-CA guard, the self-scan
 * cards and the cancel notice, and it used to be captured by any group block,
 * from any member, with /tge having no gate at all. So the tests that matter are
 * "a member cannot move it" and "muting a group does not move it either": both
 * are ways the guard could have been out of the room the CA lands in at T+3s.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('readyblock');
process.env.ADMIN_IDS = '900001';
process.env.READY_BLOCK_TTL_MS = '600000';

const { db } = await import('../dist/db.js');
const { client } = await import('../dist/chain.js');

const balances = new Map();
client.getBalance = async ({ address }) => balances.get(String(address).toLowerCase()) ?? 0n;
client.getCode = async () => '0x';

const R = await import('../dist/ready.js');
const B = await import('../dist/readyblock.js');
const D = await import('../dist/launchday.js');
const W = await import('../dist/launchwatch.js');
const { createBot, postTotals, readyAutoPostTick, resetReadyBlockCache } = await import('../dist/bot.js');

const GROUP = -100200300;
const OTHER_GROUP = -100400500;
const ADMIN = 900001;
const MEMBER = 5001;
const WALLET = '0x1111111111111111111111111111111111111111';
const eth = (n) => BigInt(Math.round(n * 1e18));

const reset = () => {
  for (const t of ['ready_wallets', 'ready_settings', 'ready_snapshots', 'group_settings', 'launch_watchers']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  R.resetReadyCooldowns();
  resetReadyBlockCache();
  balances.clear();
};

const BOT_INFO = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};

function harness() {
  const bot = createBot('123456:FAKE');
  bot.botInfo = BOT_INFO;
  const calls = [];
  let sentId = 500;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'getChatMemberCount') return { ok: true, result: 212 };
    if (method === 'sendMessage') {
      const id = ++sentId;
      calls[calls.length - 1].messageId = id;
      return { ok: true, result: { message_id: id, chat: { id: payload.chat_id }, date: 0, text: payload.text } };
    }
    if (method === 'editMessageText') {
      return { ok: true, result: { message_id: payload.message_id, chat: { id: payload.chat_id }, date: 0, text: payload.text } };
    }
    return { ok: true, result: true };
  });
  let uid = 0;
  const msg = (chatType, text, chatId, fromId) => ({
    update_id: ++uid,
    message: {
      message_id: 1000 + uid,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: chatType, ...(chatType === 'private' ? {} : { title: 'g' }) },
      from: { id: fromId, is_bot: false, first_name: 'U' },
      text,
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }]
        : undefined,
    },
  });
  const drain = () => { const c = [...calls]; calls.length = 0; return c; };
  const sentTo = (calls, chatId) => calls
    .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload.chat_id === chatId)
    .map((c) => c.payload.text);
  return { bot, msg, drain, sentTo };
}

const registered = async () => {
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
};

// ------------------------------------------------------- who may post it

test('a member gets nothing from /ready in a group, and moves nothing', async () => {
  reset();
  await registered();
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, MEMBER));
  assert.equal(drain().filter((x) => x.method === 'sendMessage').length, 0,
    'answering makes the group a place where saying /ready gets a reaction');
  assert.ok(!R.getSetting('ready_chat'),
    'and a member must never be able to name the chat the launch posts go to');
});

test('a member gets nothing from /tge in a group either', async () => {
  reset();
  await registered();
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/tge', GROUP, MEMBER));
  assert.equal(drain().filter((x) => x.method === 'sendMessage').length, 0);
  assert.ok(!R.getSetting('ready_chat'));
});

test('/tge in a DM still answers anybody, because it captures nothing', async () => {
  reset();
  await registered();
  const { bot, msg, drain, sentTo } = harness();
  await bot.handleUpdate(msg('private', '/tge', MEMBER, MEMBER));
  assert.match(sentTo(drain(), MEMBER).join('\n'), /READY FOR LAUNCH/,
    'members are told to DM the bot, and the totals are public by design');
  assert.ok(!R.getSetting('ready_chat'), 'a DM names no group');
});

test('an admin posts the block and that is what names the chat', async () => {
  reset();
  await registered();
  const { bot, msg, drain, sentTo } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  assert.match(sentTo(drain(), GROUP).join('\n'), /^READY FOR LAUNCH/);
  assert.equal(R.getSetting('ready_chat'), String(GROUP));
});

test('a member cannot take ready_chat back off the group an admin set it to', async () => {
  // The launch-day failure this prevents: the countdown, the fake-CA guard and
  // the self-scan cards all follow ready_chat, so five characters from any
  // member of any group the bot sits in used to move the guard out of the room
  // the real CA lands in.
  reset();
  await registered();
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  drain();
  await bot.handleUpdate(msg('supergroup', '/tge', OTHER_GROUP, MEMBER));
  await bot.handleUpdate(msg('supergroup', '/ready', OTHER_GROUP, MEMBER));
  assert.equal(drain().filter((x) => x.method === 'sendMessage').length, 0);
  assert.equal(R.getSetting('ready_chat'), String(GROUP), 'still the group the admin named');
  assert.equal(D.launchChat(), GROUP);
});

// ------------------------------------------------------------- the switch

test('/ready off silences the block in one group and says so', async () => {
  reset();
  await registered();
  const { bot, msg, drain, sentTo } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready off', GROUP, ADMIN));
  const said = sentTo(drain(), GROUP).join('\n');
  assert.match(said, /READY block is off in this group/);
  assert.ok(!said.includes('READY FOR LAUNCH'), 'and it does not post one on the way out');
  assert.equal(B.readyBlockMuted(GROUP), true);

  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  assert.ok(!sentTo(drain(), GROUP).join('\n').includes('READY FOR LAUNCH'),
    'and the block does not come back on request');
});

test('a muted group is not the other group', async () => {
  reset();
  await registered();
  const { bot, msg, drain, sentTo } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready off', GROUP, ADMIN));
  drain();
  await bot.handleUpdate(msg('supergroup', '/ready', OTHER_GROUP, ADMIN));
  assert.match(sentTo(drain(), OTHER_GROUP).join('\n'), /READY FOR LAUNCH/);
  assert.equal(B.readyBlockMuted(OTHER_GROUP), false);
});

test('muting does not move where the launch posts go', async () => {
  // The whole reason this switch exists rather than "point ready_chat elsewhere".
  reset();
  await registered();
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  drain();
  await bot.handleUpdate(msg('supergroup', '/ready off', GROUP, ADMIN));
  assert.equal(R.getSetting('ready_chat'), String(GROUP));
  assert.equal(D.launchChat(), GROUP, 'the countdown and the fake-CA guard stay here');
});

test('a muted chat cannot capture ready_chat even from an admin', async () => {
  reset();
  await registered();
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', OTHER_GROUP, ADMIN));
  drain();
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  await bot.handleUpdate(msg('supergroup', '/tge', GROUP, ADMIN));
  drain();
  assert.equal(R.getSetting('ready_chat'), String(OTHER_GROUP),
    'a chat that cannot show the block is not the chat the launch posts belong in');
});

test('/ready on brings it back', async () => {
  reset();
  await registered();
  const { bot, msg, drain, sentTo } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready off', GROUP, ADMIN));
  drain();
  await bot.handleUpdate(msg('supergroup', '/ready on', GROUP, ADMIN));
  assert.match(sentTo(drain(), GROUP).join('\n'), /READY block is on in this group/);
  assert.equal(B.readyBlockMuted(GROUP), false);
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  assert.match(sentTo(drain(), GROUP).join('\n'), /READY FOR LAUNCH/);
});

test('a member cannot mute or unmute', async () => {
  reset();
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready off', GROUP, MEMBER));
  assert.equal(drain().filter((x) => x.method === 'sendMessage').length, 0);
  assert.equal(B.readyBlockMuted(GROUP), false);

  B.setReadyBlockMuted(GROUP, true, ADMIN);
  await bot.handleUpdate(msg('supergroup', '/ready on', GROUP, MEMBER));
  assert.equal(drain().filter((x) => x.method === 'sendMessage').length, 0);
  assert.equal(B.readyBlockMuted(GROUP), true, 'nor turn it back on over an admin');
});

// ------------------------------------------------------- the armed edge

test('muting is refused while a launch is armed, and says why', () => {
  // The reason is the pin, not the posts still to come: those now honour the
  // mute themselves. Muting does not reach back into a countdown already pinned.
  const refused = B.canMute('2026-09-28 16:00 CEST');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /countdown already pinned here carries the block it was posted with/);
  assert.match(refused.reason, /cancel the launch, mute, then set it again/);
  assert.equal(B.canMute(null).ok, true);
});

test('/ready off during an armed launch changes nothing at all', async () => {
  reset();
  await registered();
  R.setSetting('launch_at', String(Math.floor(Date.parse('2026-09-28T14:00:00Z') / 1000)));
  const { bot, msg, drain, sentTo } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready off', GROUP, ADMIN));
  assert.match(sentTo(drain(), GROUP).join('\n'), /a launch is armed for 2026-09-28 16:00 CEST/);
  assert.equal(B.readyBlockMuted(GROUP), false, 'refused means not applied');
  R.setSetting('launch_at', '');
});

test('unmuting during an armed launch is allowed, because it only adds posts', async () => {
  reset();
  await registered();
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  R.setSetting('launch_at', String(Math.floor(Date.parse('2026-09-28T14:00:00Z') / 1000)));
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready on', GROUP, ADMIN));
  drain();
  assert.equal(B.readyBlockMuted(GROUP), false);
  R.setSetting('launch_at', '');
});

// -------------------------------------------------------- the scheduler

test('the scheduled post does not go to a muted chat, and stays due', async () => {
  reset();
  await registered();
  R.setSetting('ready_chat', String(GROUP));
  R.setSetting('autopost_day', '2026-06-30');
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  const { bot, drain } = harness();
  const at = Date.parse('2026-07-01T13:00:00Z');

  assert.equal(await readyAutoPostTick(bot.api, { now: at }), false);
  assert.equal(drain().filter((x) => x.method === 'sendMessage').length, 0);
  // dailyDue adopts the current day as a side effect on its first run. Asking it
  // about a chat that cannot receive a post would burn that mark and swallow the
  // first real post after an unmute.
  assert.equal(R.getSetting('autopost_day'), '2026-06-30', 'the mark is untouched');

  B.setReadyBlockMuted(GROUP, false, ADMIN);
  assert.equal(await readyAutoPostTick(bot.api, { now: at }), true, 'and it posts once unmuted');
});

test('postTotals reports a muted chat rather than pretending it posted', async () => {
  reset();
  await registered();
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  const { bot, drain } = harness();
  assert.equal(await postTotals(bot.api, GROUP, { isGroup: true, capture: true }), 'muted');
  const c = drain();
  assert.equal(c.filter((x) => x.method === 'sendMessage').length, 0);
  assert.equal(c.filter((x) => x.method === 'getChatMemberCount').length, 0,
    'and costs no API call and no balance refresh');
});

// ------------------------------------------------------------- the CA

test('a muted group still gets the CA, posted and pinned', async () => {
  // The requirement the switch exists to serve: quiet in the group, and the
  // bot still an admin there because it posts the CA at T+3s.
  reset();
  R.setSetting('ready_chat', String(GROUP));
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  W.addWatcher(GROUP, 0, ADMIN);

  const calls = [];
  let id = 400;
  const api = {
    async sendMessage(chat_id, text) {
      const message_id = ++id;
      calls.push({ method: 'sendMessage', chat_id, text, message_id });
      return { message_id, chat: { id: chat_id }, text };
    },
    async pinChatMessage(chat_id, message_id) { calls.push({ method: 'pin', chat_id, message_id }); return true; },
    async unpinChatMessage(chat_id, message_id) { calls.push({ method: 'unpin', chat_id, message_id }); return true; },
  };

  const CA = '0x37b7534fc61274694638866b73bb68b7add306c8';
  const nowSec = Math.floor(Date.parse('2026-09-28T14:00:03Z') / 1000);
  assert.equal(await D.deliverCa(api, CA, '$VITALS', nowSec), 1);

  const posted = calls.filter((c) => c.method === 'sendMessage' && c.chat_id === GROUP);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /\$VITALS is live\. CA: 0x37b7534f/);
  assert.match(posted[0].text, /this is the only CA\./);
  assert.equal(calls.filter((c) => c.method === 'pin' && c.chat_id === GROUP).length, 1,
    'and pinned, which is what the bot stays an admin for');
});

// -------------------------------------------------------- /launch status

test('/launch status says which chat the launch posts go to', async () => {
  // It was in the usage list with no branch behind it, so it printed the usage
  // list back. The one thing nothing anywhere said was where ready_chat pointed,
  // and the only way to find out was to wait and see where a post came out.
  reset();
  await registered();
  R.setSetting('ready_chat', String(GROUP));
  W.addWatcher(GROUP, 0, ADMIN);
  W.addWatcher(OTHER_GROUP, 8, ADMIN);
  const { bot, msg, drain, sentTo } = harness();

  await bot.handleUpdate(msg('private', '/launch status', ADMIN, ADMIN));
  const said = sentTo(drain(), ADMIN).join('\n');
  assert.match(said, new RegExp(`launch posts: ${GROUP}`), said);
  assert.match(said, /countdown, fake-CA guard, self-scan cards and the cancel notice all go here/);
  assert.match(said, /READY block: on/);
  assert.match(said, /bookable until \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]{3}/, 'and the cutoff it can be set inside');
  assert.match(said, /2 chats watching/);
  assert.match(said, new RegExp(`${OTHER_GROUP}\\s+after 8s`), 'each with its own delay');
});

test('/launch status shows a muted group as muted', async () => {
  reset();
  R.setSetting('ready_chat', String(GROUP));
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  const { bot, msg, drain, sentTo } = harness();
  await bot.handleUpdate(msg('private', '/launch status', ADMIN, ADMIN));
  assert.match(sentTo(drain(), ADMIN).join('\n'), /READY block: off/);
});

test('/launch status is admin only', async () => {
  reset();
  R.setSetting('ready_chat', String(GROUP));
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('private', '/launch status', MEMBER, MEMBER));
  assert.equal(drain().filter((x) => x.method === 'sendMessage').length, 0);
});

// ------------------------------------------------- the anonymous admin

const ANON = 1087968824;

const anonMsg = (text, chatId) => ({
  update_id: 7000 + text.length,
  message: {
    message_id: 7000 + text.length, date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'supergroup', title: 'g' },
    // Telegram attributes an anonymous admin's message to GroupAnonymousBot.
    from: { id: ANON, is_bot: true, first_name: 'GroupAnonymousBot' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
  },
});

for (const cmd of ['/ready', '/tge']) {
  test(`an anonymous admin's ${cmd} says why nothing happened`, async () => {
    // Posting anonymously is the default for admins in most crypto groups, and
    // GroupAnonymousBot is in no ADMIN_IDS list. Silent, this is the operator
    // running the command in the launch room on Saturday, seeing nothing, and
    // finding out at T-0 that ready_chat was never set.
    reset();
    await registered();
    const { bot, drain, sentTo } = harness();
    await bot.handleUpdate(anonMsg(cmd, GROUP));
    const said = sentTo(drain(), GROUP).join('\n');
    assert.match(said, /an anonymous admin cannot be identified/);
    assert.ok(!said.includes('READY FOR LAUNCH'), 'and no block goes out');
    assert.ok(!R.getSetting('ready_chat'), 'and nothing is captured');
  });
}

test('/ready off in a DM says where it belongs instead of failing as an address', async () => {
  reset();
  const { bot, msg, drain, sentTo } = harness();
  await bot.handleUpdate(msg('private', '/ready off', ADMIN, ADMIN));
  assert.match(sentTo(drain(), ADMIN).join('\n'), /a group setting\. run \/ready off in the group itself/);
  assert.equal(B.readyBlockMuted(ADMIN), false);
});

test('/help in a muted group says the block is off here', async () => {
  reset();
  const { bot, msg, drain, sentTo } = harness();
  await bot.handleUpdate(msg('supergroup', '/help', GROUP, MEMBER));
  assert.ok(!sentTo(drain(), GROUP).join('\n').includes('READY block is off'),
    'nothing to say when it is on');
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  await bot.handleUpdate(msg('supergroup', '/help', GROUP, MEMBER));
  assert.match(sentTo(drain(), GROUP).join('\n'), /READY block is off here/);
});

// ------------------------------------------------- arm and countdown posts

const L = await import('../dist/launch.js');

const LAUNCH = Date.parse('2026-09-28T14:00:00Z');
// Three days out is what arming on the Friday looks like, and it is why the
// defect showed up as an "arm post": T-3d is due the minute the plan is set.
const ARMED_AT = LAUNCH - 2.5 * 86_400_000;

function stubApi() {
  const calls = [];
  let id = 400;
  return {
    calls,
    drain: () => { const c = [...calls]; calls.length = 0; return c; },
    api: {
      async sendMessage(chat_id, text, extra) {
        const message_id = ++id;
        calls.push({ method: 'sendMessage', chat_id, text, extra, message_id });
        return { message_id, chat: { id: chat_id }, text };
      },
      async pinChatMessage(chat_id, message_id) { calls.push({ method: 'pin', chat_id, message_id }); return true; },
      async unpinChatMessage(chat_id, message_id) { calls.push({ method: 'unpin', chat_id, message_id }); return true; },
      async getChatMemberCount(chat_id) { calls.push({ method: 'getChatMemberCount', chat_id }); return 7; },
    },
  };
}

const armed = async () => {
  await registered();
  R.setSetting('ready_chat', String(GROUP));
  R.setSetting('launch_at', String(Math.floor(LAUNCH / 1000)));
  R.setSetting('launch_name', '$VITALS');
};

test('countdownPost with no block is the time line and the warning, nothing else', () => {
  const only = L.countdownPost(null, LAUNCH);
  assert.equal(only, `launch: 2026-09-28 16:00 CEST\n${L.CA_NOTICE}`);
  assert.ok(!only.includes('READY FOR LAUNCH'));
  assert.ok(!only.includes('wallets ready'));
  assert.ok(!only.includes('declared launches so far'),
    'off in a room means off, not one tally instead of four');
});

test('countdownPost with a block is unchanged', () => {
  const withBlock = L.countdownPost('READY FOR LAUNCH\nwallets ready     3', LAUNCH);
  assert.match(withBlock, /^READY FOR LAUNCH\nwallets ready {5}3\nlaunch: 2026-09-28 16:00 CEST\n/);
  assert.ok(withBlock.includes(L.CA_NOTICE));
});

test('the countdown in a muted room drops the block and keeps the two lines', async () => {
  // The defect as reported: armed from a chat with /ready off, and the post that
  // followed carried "members 7, wallets 0, eth 0.0".
  reset();
  await armed();
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  const h = stubApi();

  assert.equal(await D.countdownTick(h.api, { now: ARMED_AT, botUsername: 'vitalscheck_bot' }), 'T-3d');
  const c = h.drain();
  const sent = c.filter((x) => x.method === 'sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, `launch: 2026-09-28 16:00 CEST\n${L.CA_NOTICE}`);
  assert.ok(!/READY FOR LAUNCH|wallets ready|eth ready|members/.test(sent[0].text),
    `the block reached a muted room:\n${sent[0].text}`);
  assert.equal(c.filter((x) => x.method === 'pin').length, 1,
    'and it is still pinned: the time and the fake-CA warning are why it is pinned at all');
  assert.equal(c.filter((x) => x.method === 'getChatMemberCount').length, 0,
    'and no member count is read to build a block that is not sent');
});

test('the countdown in an ordinary room still carries the block', async () => {
  reset();
  await armed();
  const h = stubApi();
  assert.equal(await D.countdownTick(h.api, { now: ARMED_AT, botUsername: 'vitalscheck_bot' }), 'T-3d');
  const sent = h.drain().filter((x) => x.method === 'sendMessage');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^READY FOR LAUNCH: \$VITALS/);
  assert.match(sent[0].text, /wallets ready/);
  assert.match(sent[0].text, /launch: 2026-09-28 16:00 CEST/);
  assert.ok(sent[0].text.includes(L.CA_NOTICE));
});

test('every countdown offset in a muted room stays clean, not just the first', async () => {
  // The offsets are separate posts on separate marks. One of them honouring the
  // mute is not the promise; T-10min is the one that matters most.
  reset();
  await armed();
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  const h = stubApi();
  for (const [key, at] of [
    ['T-3d', LAUNCH - 2.5 * 86_400_000],
    ['T-24h', LAUNCH - 20 * 3_600_000],
    ['T-1h', LAUNCH - 50 * 60_000],
    ['T-10min', LAUNCH - 9 * 60_000],
  ]) {
    assert.equal(await D.countdownTick(h.api, { now: at }), key);
    const sent = h.drain().filter((x) => x.method === 'sendMessage');
    assert.equal(sent.length, 1, key);
    assert.equal(sent[0].text, `launch: 2026-09-28 16:00 CEST\n${L.CA_NOTICE}`, key);
  }
});

test('unmuting mid-countdown brings the block back to the next post', async () => {
  reset();
  await armed();
  B.setReadyBlockMuted(GROUP, true, ADMIN);
  const h = stubApi();
  await D.countdownTick(h.api, { now: LAUNCH - 2.5 * 86_400_000 });
  h.drain();
  B.setReadyBlockMuted(GROUP, false, ADMIN);
  await D.countdownTick(h.api, { now: LAUNCH - 20 * 3_600_000 });
  assert.match(h.drain().find((x) => x.method === 'sendMessage').text, /READY FOR LAUNCH/);
});
