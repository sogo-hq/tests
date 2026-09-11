/**
 * The fake-CA guard.
 *
 * From /launch set until the real CA is pinned, an address in the group is
 * either the one the bot posted or something a reader should not paste into a
 * wallet. The policy is pure so every branch is decided without a Telegram
 * server; the transport half is asserted separately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = process.env.DB_PATH || `/tmp/vitals-fakeca-${process.pid}.db`;
const { db } = await import('../dist/db.js');
const R = await import('../dist/ready.js');
const D = await import('../dist/launchday.js');

const CA = '0xd384722f6adfe7d79E8e6623896DF199afD31B76';
const FAKE = '0x1111111111111111111111111111111111111111';
const on = (over = {}) => ({ pinnedCa: CA, isAdmin: false, priorOffences: 0, active: true, ...over });

const reset = () => { db.prepare('DELETE FROM ready_settings').run(); };

test('a wrong address is warned on the first offence and muted on the second', () => {
  assert.deepEqual(D.guardVerdict(`buy here ${FAKE}`, on()), { action: 'warn', addresses: [FAKE] });
  assert.deepEqual(D.guardVerdict(`buy here ${FAKE}`, on({ priorOffences: 1 })), { action: 'mute', addresses: [FAKE] });
  assert.equal(D.guardVerdict(`buy here ${FAKE}`, on({ priorOffences: 5 })).action, 'mute');
});

test('the real CA is left alone, whatever its casing', () => {
  for (const form of [CA, CA.toLowerCase(), CA.toUpperCase().replace('0X', '0x')]) {
    assert.equal(D.guardVerdict(`the CA is ${form}`, on()).action, 'ignore', form);
  }
});

test('a message with the real CA and a fake one is still caught', () => {
  const v = D.guardVerdict(`real ${CA} but also ${FAKE}`, on());
  assert.equal(v.action, 'warn');
  assert.deepEqual(v.addresses, [FAKE], 'only the wrong one is reported');
});

test('admins are exempt', () => {
  assert.equal(D.guardVerdict(`${FAKE}`, on({ isAdmin: true })).action, 'ignore');
});

test('outside the window nothing is touched', () => {
  assert.equal(D.guardVerdict(`${FAKE}`, on({ active: false })).action, 'ignore');
});

test('a message with no address is never touched', () => {
  for (const text of ['gm', 'when launch', '0x', '0xdeadbeef', 'the price is 0x1 lol']) {
    assert.equal(D.guardVerdict(text, on()).action, 'ignore', text);
  }
});

test('before any CA exists, every address is wrong', () => {
  const v = D.guardVerdict(`${CA}`, on({ pinnedCa: null }));
  assert.equal(v.action, 'warn', 'nothing is the CA until the bot has posted one');
});

test('several fakes in one message are all reported, and count as one offence', () => {
  const b = '0x2222222222222222222222222222222222222222';
  const v = D.guardVerdict(`${FAKE} or ${b}`, on());
  assert.deepEqual(v.addresses, [FAKE, b]);
  assert.equal(v.action, 'warn');
});

test('the window opens at /launch set and closes when the CA is known', () => {
  reset();
  const at = Date.parse('2026-09-22T14:00:00Z');
  assert.equal(D.guardActive(at - 86_400_000), false, 'no launch set, no guard');

  R.setSetting('launch_at', String(Math.floor(at / 1000)));
  assert.equal(D.guardActive(at - 86_400_000), true, 'from the moment a launch is set');
  assert.equal(D.guardActive(at + 3_600_000), true,
    'and it stays on past a late launch: that is when a fake is most believed');

  R.setSetting('launch_ca', CA);
  assert.equal(D.guardActive(at + 3_600_000), false, 'until the real CA is known');
  assert.equal(D.pinnedCa(), CA.toLowerCase());
});

test('offences are counted per user and persist', () => {
  reset();
  assert.equal(D.offencesOf(5001), 0);
  assert.equal(D.recordOffence(5001), 1);
  assert.equal(D.recordOffence(5001), 2);
  assert.equal(D.offencesOf(5001), 2);
  assert.equal(D.offencesOf(5002), 0, 'counted per user, not globally');
});

test('the warning tells the reader where the only CA will come from', () => {
  assert.match(D.GUARD_WARNING, /the only CA will be posted by this bot, pinned, 3 s after launch/);
  assert.match(D.GUARD_MUTED, /muted for 24 h/);
  assert.equal(D.MUTE_SECONDS, 86_400);
  // The deleted message is never quoted back, in the group or the DM.
  for (const text of [D.GUARD_WARNING, D.GUARD_MUTED]) {
    assert.ok(!/0x[0-9a-f]{40}/i.test(text), 'the warning must not repeat the address');
  }
});

// ------------------------------------------------------- the transport half

const { createBot } = await import('../dist/bot.js');
const { rememberDm } = await import('../dist/watch.js');
process.env.ADMIN_IDS = '900001';
const GROUP = -100888;
const ADMIN = 900001;

function harness(over = {}) {
  const bot = createBot('123456:FAKE');
  bot.botInfo = {
    id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
  };
  const calls = [];
  let sentId = 300;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'getChatMember') {
      return { ok: true, result: over.members?.[payload.user_id] ?? { status: 'member', user: { id: payload.user_id } } };
    }
    if (method === 'getChatMemberCount') return { ok: true, result: 212 };
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: ++sentId, chat: { id: payload.chat_id }, date: 0, text: payload.text } };
    }
    if (method === 'deleteMessage' && over.deleteThrows) throw new Error('not enough rights');
    return { ok: true, result: true };
  });
  let uid = 0;
  const mk = (kind, text, fromId, messageId) => ({
    update_id: ++uid,
    [kind]: {
      message_id: messageId ?? 2000 + uid,
      date: Math.floor(Date.now() / 1000),
      chat: { id: GROUP, type: 'supergroup', title: 'g' },
      from: { id: fromId, is_bot: false, first_name: 'U' },
      text,
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }]
        : undefined,
    },
  });
  return {
    bot,
    msg: (text, fromId, id) => mk('message', text, fromId, id),
    edit: (text, fromId, id) => mk('edited_message', text, fromId, id),
    drain: () => { const c = [...calls]; calls.length = 0; return c; },
  };
}

const armed = () => {
  reset();
  R.setSetting('ready_chat', String(GROUP));
  R.setSetting('launch_at', String(Math.floor((Date.now() + 86_400_000) / 1000)));
  R.setSetting('launch_ca', '');
};

test('a fake CA in the group is deleted and the sender warned in DM', async () => {
  armed();
  const h = harness();
  rememberDm(6001, 6001);
  await h.bot.handleUpdate(h.msg(`ape in early ${FAKE}`, 6001));
  const c = h.drain();

  const del = c.filter((x) => x.method === 'deleteMessage');
  assert.equal(del.length, 1, 'deleted');
  assert.equal(del[0].payload.chat_id, GROUP);
  assert.equal(c.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === GROUP).length, 0,
    'and nothing is said in the group about it');

  const dm = c.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === 6001);
  assert.equal(dm.length, 1);
  assert.match(dm[0].payload.text, /deleted/);
  assert.ok(!dm[0].payload.text.includes(FAKE), 'the warning does not repeat the address');
  assert.equal(c.filter((x) => x.method === 'restrictChatMember').length, 0, 'no mute on a first offence');
});

test('a second offence mutes for 24 h, with until_date clear of the forever cliff', async () => {
  armed();
  const h = harness();
  rememberDm(6002, 6002);
  await h.bot.handleUpdate(h.msg(`${FAKE}`, 6002));
  h.drain();
  await h.bot.handleUpdate(h.msg(`${FAKE} for real this time`, 6002));
  const c = h.drain();

  const mute = c.filter((x) => x.method === 'restrictChatMember');
  assert.equal(mute.length, 1);
  const until = mute[0].payload.until_date;
  const now = Math.floor(Date.now() / 1000);
  assert.ok(until >= now + 60, 'under 30 s from now means restricted FOREVER, not briefly');
  assert.ok(until <= now + 364 * 86_400, 'over 366 days means forever too');
  assert.ok(Math.abs(until - (now + 86_400)) < 5, '24 h');

  // All ten send permissions, not just can_send_messages: the implication rule
  // is permissive, so a stray true re-grants text sending.
  const perms = mute[0].payload.permissions;
  for (const k of [
    'can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos',
    'can_send_videos', 'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls',
    'can_send_other_messages', 'can_add_web_page_previews',
  ]) {
    assert.equal(perms[k], false, `${k} must be false or the mute silently fails`);
  }
  assert.match(c.find((x) => x.method === 'sendMessage').payload.text, /muted for 24 h/);
});

test('an address edited into an old message is caught', async () => {
  armed();
  const h = harness();
  rememberDm(6003, 6003);
  await h.bot.handleUpdate(h.msg('gm', 6003, 7777));
  assert.equal(h.drain().filter((x) => x.method === 'deleteMessage').length, 0, 'gm is fine');

  await h.bot.handleUpdate(h.edit(`gm ${FAKE}`, 6003, 7777));
  const c = h.drain();
  assert.equal(c.filter((x) => x.method === 'deleteMessage').length, 1,
    'an edit is a separate update type and must be scanned too');
});

test('re-editing the same message does not walk a first offender into a mute', async () => {
  armed();
  const h = harness();
  rememberDm(6004, 6004);
  await h.bot.handleUpdate(h.msg(`${FAKE}`, 6004, 8888));
  h.drain();
  // Telegram fires edited_message for field changes too, so the same message
  // can arrive several times.
  await h.bot.handleUpdate(h.edit(`${FAKE}`, 6004, 8888));
  await h.bot.handleUpdate(h.edit(`${FAKE} `, 6004, 8888));
  const c = h.drain();
  assert.equal(c.filter((x) => x.method === 'restrictChatMember').length, 0,
    'one message is one offence however many times it is re-delivered');
  assert.equal(D.offencesOf(6004), 1);
});

test('a group admin is exempt', async () => {
  armed();
  const h = harness({ members: { 6005: { status: 'administrator', user: { id: 6005 } } } });
  await h.bot.handleUpdate(h.msg(`${FAKE}`, 6005));
  assert.equal(h.drain().filter((x) => x.method === 'deleteMessage').length, 0);
});

test('the real CA is left alone once it is known', async () => {
  armed();
  R.setSetting('launch_ca', CA);
  const h = harness();
  await h.bot.handleUpdate(h.msg(`CA: ${CA}`, 6006));
  assert.equal(h.drain().filter((x) => x.method === 'deleteMessage').length, 0);
});

test('with no launch set the guard is inert', async () => {
  reset();
  const h = harness();
  await h.bot.handleUpdate(h.msg(`${FAKE}`, 6007));
  const c = h.drain();
  assert.equal(c.filter((x) => x.method === 'deleteMessage').length, 0);
  assert.equal(c.filter((x) => x.method === 'getChatMember').length, 0, 'and costs no API calls');
});

test('the guard passes ordinary messages through to the commands behind it', async () => {
  armed();
  const h = harness();
  // /tge is registered after the guard; an earlier version of this handler
  // swallowed the middleware chain and silently disabled every command below it.
  await h.bot.handleUpdate(h.msg('/tge', 6008));
  const sends = h.drain().filter((x) => x.method === 'sendMessage' && x.payload.chat_id === GROUP);
  assert.equal(sends.length, 1, 'the command behind the guard still runs');
  assert.match(sends[0].payload.text, /READY FOR LAUNCH/);
});

test('a failed delete still warns, and never leaves the offence unrecorded', async () => {
  armed();
  const h = harness({ deleteThrows: true });
  rememberDm(6009, 6009);
  await h.bot.handleUpdate(h.msg(`${FAKE}`, 6009));
  const c = h.drain();
  assert.equal(D.offencesOf(6009), 1, 'a delete the bot lacks rights for is still an offence');
  assert.match(c.find((x) => x.method === 'sendMessage')?.payload.text ?? '', /deleted/);
});

test('a user with no DM open is still deleted and counted, silently', async () => {
  armed();
  const h = harness();
  await h.bot.handleUpdate(h.msg(`${FAKE}`, 6010));
  const c = h.drain();
  assert.equal(c.filter((x) => x.method === 'deleteMessage').length, 1);
  assert.equal(c.filter((x) => x.method === 'sendMessage').length, 0, 'nothing is said in the group instead');
  assert.equal(D.offencesOf(6010), 1);
});
