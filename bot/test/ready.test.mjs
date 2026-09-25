/**
 * Section 2R: registration, the totals block, and the promise that makes it
 * safe to register at all.
 *
 * The load-bearing assertion in this file is the last one. Everything else is
 * mechanics; "no wallet, label or user id ever appears in a group message" is
 * the reason anybody would send their address to this bot, and it is one
 * careless template away from being false. It is asserted against every
 * group-facing command rather than against the one that happens to be under
 * test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('ready');
process.env.ADMIN_IDS = '900001';
process.env.READY_BLOCK_TTL_MS = '600000';

const { db } = await import('../dist/db.js');
const { client } = await import('../dist/chain.js');

// ---- chain stubs. Registration reads two things and nothing else. ----------
const balances = new Map();   // lowercase address -> wei
const contracts = new Set();  // lowercase addresses that answer with code
const reads = { count: 0 };
client.getBalance = async ({ address }) => {
  reads.count++;
  return balances.get(String(address).toLowerCase()) ?? 0n;
};
client.getCode = async ({ address }) => {
  reads.count++;
  return contracts.has(String(address).toLowerCase()) ? '0xfe' : '0x';
};

const R = await import('../dist/ready.js');
const T = await import('../dist/tge.js');
const { createBot, postTotals, readyAutoPostTick, resetReadyBlockCache } = await import('../dist/bot.js');
const { rememberDm } = await import('../dist/watch.js');

const A = (n) => '0x' + String(n).repeat(40).slice(0, 40);
const WALLET = '0x1111111111111111111111111111111111111111';
const eth = (n) => BigInt(Math.round(n * 1e18));

const reset = () => {
  db.prepare('DELETE FROM ready_wallets').run();
  db.prepare('DELETE FROM ready_settings').run();
  db.prepare('DELETE FROM ready_snapshots').run();
  R.resetReadyCooldowns();
  resetReadyBlockCache();
  balances.clear();
  contracts.clear();
};

// ---------------------------------------------------------------- registering

test('a member registers a funded wallet', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  const res = await R.registerMember(7, WALLET);
  assert.equal(res.ok, true);
  assert.equal(res.replaced, false);
  assert.equal(R.totals().wallets, 1);
  assert.equal(R.totals().external, 0);
});

test('re-sending replaces the previous wallet rather than adding one', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  balances.set(A(2), eth(0.5));
  await R.registerMember(7, WALLET);
  R.resetReadyCooldowns();
  const res = await R.registerMember(7, A(2));
  assert.equal(res.ok, true);
  assert.equal(res.replaced, true, 'the reply has to say it replaced something');
  assert.equal(R.totals().wallets, 1, 'one wallet per user, always');
  assert.equal(R.statusOf(7).wallet, A(2));
});

test('below the minimum is refused, with the figure that was read', async () => {
  reset();
  balances.set(WALLET, eth(0.021));
  const res = await R.registerMember(7, WALLET);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'low');
  assert.equal(res.balanceWei, eth(0.021));
  assert.equal(R.totals().wallets, 0);
});

test('a contract address is refused', async () => {
  reset();
  balances.set(WALLET, eth(10));
  contracts.add(WALLET);
  const res = await R.registerMember(7, WALLET);
  assert.equal(res.reason, 'contract');
});

test('an all-uppercase address is accepted by lowercasing it', async () => {
  reset();
  // Both halves shouted, which is how a QR reader and some explorers render it.
  const upper = ('0x' + 'b'.repeat(40)).toUpperCase();
  assert.equal(upper.slice(0, 2), '0X');
  assert.equal(R.normaliseWallet(upper), upper.toLowerCase(), 'the 0X prefix is a keyboard, not a different address');
  balances.set(upper.toLowerCase(), eth(0.31));
  const res = await R.registerMember(8, upper);
  assert.equal(res.ok, true);
  assert.equal(res.wallet, upper.toLowerCase());
});

test('a mixed-case address that fails its checksum is refused', () => {
  // Mixed case IS the checksum, so a mistyped address is caught here for free.
  // These two differ only in the final nibble; one is EIP-55, one is not.
  const good = '0xd384722f6adfe7d79E8e6623896DF199afD31B76';
  const typo = '0xd384722f6adfe7d79E8e6623896DF199afD31B77';
  assert.equal(R.normaliseWallet(good), good.toLowerCase());
  assert.equal(R.normaliseWallet(typo), null, 'a wallet with one character wrong is ETH nobody holds');
  // And the same address in one case is still accepted -- no checksum to fail.
  assert.equal(R.normaliseWallet(typo.toLowerCase()), typo.toLowerCase());
});

test('anything that is not address-shaped is refused', () => {
  for (const bad of ['', '0x', 'not an address', '0x' + '1'.repeat(39), '0x' + '1'.repeat(41), '1'.repeat(40)]) {
    assert.equal(R.normaliseWallet(bad), null, `"${bad}" must not parse`);
  }
});

test('one registration per user per ten minutes', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  balances.set(A(2), eth(0.31));
  await R.registerMember(7, WALLET);
  const res = await R.registerMember(7, A(2));
  assert.equal(res.reason, 'cooldown');
  assert.ok(res.retryInMs > 0 && res.retryInMs <= R.REGISTER_COOLDOWN_MS);
});

test('an admin adds an external wallet with a label, and it is counted apart', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  balances.set(A(2), eth(2));
  await R.registerMember(7, WALLET);
  const res = await R.addExternal(A(2), 'rh trader #3');
  assert.equal(res.ok, true);
  const t = R.totals();
  assert.equal(t.wallets, 2);
  assert.equal(t.external, 1, 'external wallets are counted and marked as such');
});

test('a member claiming a wallet an admin added wins, and it stops being external', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.addExternal(WALLET, 'someone we know');
  assert.equal(R.totals().external, 1);
  const res = await R.registerMember(7, WALLET);
  assert.equal(res.ok, true);
  assert.equal(res.replaced, true);
  const t = R.totals();
  assert.equal(t.wallets, 1, 'one wallet, not two rows for the same address');
  assert.equal(t.external, 0, 'the member record wins');
});

test('an admin cannot overwrite a wallet a member registered', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  const res = await R.addExternal(WALLET, 'mine now');
  assert.equal(res.reason, 'claimed');
  assert.equal(R.statusOf(7).source, 'member');
});

test('a wallet that drops below the minimum drops out of the totals', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  assert.equal(R.totals().wallets, 1);
  balances.set(WALLET, eth(0.004));
  await R.refreshBalances();
  assert.equal(R.totals().wallets, 0, 'the number is allowed to go down');
});

test('a balance read that fails leaves the previous figure rather than zeroing it', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  const good = client.getBalance;
  client.getBalance = async () => { throw new Error('rpc down'); };
  try {
    await R.refreshBalances();
  } finally {
    client.getBalance = good;
  }
  assert.equal(R.totals().wallets, 1, 'an unread balance is not a drained wallet');
});

// ------------------------------------------------------------- the attribution

test('a named invite link is recorded at join and attached at registration', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  R.rememberJoin(7, 'kol-batch-2');
  await R.registerMember(7, WALLET, { inviteLink: R.inviteOf(7) });
  assert.equal(R.statusOf(7).inviteLink, 'kol-batch-2');
});

test('a user who joined minutes ago is not yet trusted with /ready', () => {
  reset();
  R.rememberJoin(7, null, Date.now());
  assert.equal(R.joinedTooRecently(7), true);
  R.rememberJoin(8, null, Date.now() - 20 * 60_000);
  assert.equal(R.joinedTooRecently(8), false);
  assert.equal(R.joinedTooRecently(999), false, 'a join we never saw is not a new join');
});

// ---------------------------------------------------------------- totals block

test('the totals block has the shape the group was promised', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  balances.set(A(2), eth(51));
  await R.registerMember(7, WALLET);
  await R.addExternal(A(2), 'rh trader #3');
  R.setSetting('gate_members', '300');
  R.setSetting('gate_wallets', '150');
  R.setSetting('gate_eth', '100');
  R.setSetting('kols', '14');
  R.setSetting('gate_kols', '30');

  const out = T.totalsBlock({ members: 212, botUsername: 'vitalscheck_bot' });
  const lines = out.split('\n');
  assert.equal(lines[0], 'READY FOR LAUNCH');
  assert.match(out, /members\s+212 \/ 300/);
  assert.match(out, /kols\s+14 \/ 30/);
  assert.match(out, /wallets ready\s+2 \/ 150\s+\(1 external\)/);
  assert.match(out, /eth ready\s+51\.3 \/ 100/);
  assert.match(out, /count in: DM @vitalscheck_bot → \/ready 0x…/);
  assert.match(out, /min 0\.05 ETH · wallets never shown/);
});

test('a target nobody set is left out rather than shown against zero', () => {
  reset();
  const out = T.totalsBlock({ members: 5 });
  assert.ok(!/\/ 0/.test(out), `no "/ 0" targets:\n${out}`);
});

test('"since yesterday" compares against a real earlier snapshot', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  const dayMs = 86_400_000;
  const now = Date.now();
  R.snapshot(now - 2 * dayMs);
  await R.registerMember(7, WALLET);
  const out = T.totalsBlock({ members: null, now });
  assert.match(out, /\+1 wallets · \+0\.3 ETH since yesterday/);
});

test('the gate is only hit once every target an admin set is reached', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  assert.equal(T.gateHit(R.totals(), 400), false, 'no targets set is not a gate hit');
  R.setSetting('gate_wallets', '1');
  await R.registerMember(7, WALLET);
  assert.equal(T.gateHit(R.totals(), null), true);
  R.setSetting('gate_members', '300');
  assert.equal(T.gateHit(R.totals(), 212), false, 'one target short is not a hit');
  assert.equal(T.gateHit(R.totals(), 300), true);
});

test('the countdown appears only once a launch time is set', () => {
  reset();
  assert.equal(T.countdownLine(), null);
  const now = Date.now();
  R.setSetting('launch_at', String(Math.floor(now / 1000) + 3 * 3600 + 25 * 60));
  assert.equal(T.countdownLine(now), 'launch in 3h 25m');
});

// ------------------------------------------------------------- the auto-posts

test('the first run adopts the day rather than announcing one it never watched', () => {
  reset();
  // A group set up at 16:00 asked for a block and got one. A daily block a
  // minute later is the same numbers twice, on the worst day for it.
  const afternoon = Date.parse('2026-07-01T14:00:00Z');
  assert.equal(T.dueAutoPost(afternoon, 0), null, 'nothing is announced on the first tick');
  assert.equal(R.getSetting('autopost_day'), '2026-07-01', 'today is adopted instead');
  assert.equal(T.dueAutoPost(afternoon + 3600_000, 0), null, 'and stays adopted');
});

test('the daily post fires once at 15:00 local and not again that day', () => {
  reset();
  // A bot that has been running since yesterday.
  R.setSetting('autopost_day', '2026-06-30');
  // 13:00Z is 15:00 in Bratislava under CEST.
  const summerAfternoon = Date.parse('2026-07-01T13:00:00Z');
  assert.equal(T.localDayHour(summerAfternoon).hour, 15);
  assert.equal(T.dueAutoPost(Date.parse('2026-07-01T11:59:00Z'), 0), null, 'not before the hour');
  assert.equal(T.dueAutoPost(summerAfternoon, 0), 'daily');
  T.markAutoPost('daily', summerAfternoon, 0);
  assert.equal(T.dueAutoPost(summerAfternoon + 3600_000, 0), null, 'once a day');
  assert.equal(T.dueAutoPost(Date.parse('2026-07-02T13:00:00Z'), 0), 'daily', 'and again tomorrow');
});

test('the daily post follows the clock change rather than a fixed offset', () => {
  reset();
  // 14:00Z is 15:00 in Bratislava under CET, in January.
  assert.equal(T.localDayHour(Date.parse('2026-01-15T14:00:00Z')).hour, 15);
  assert.equal(T.localDayHour(Date.parse('2026-01-15T13:00:00Z')).hour, 14);
});

test('every tenth wallet posts, debounced to once an hour', () => {
  reset();
  const noon = Date.parse('2026-07-01T09:00:00Z'); // 11:00 local, before the daily
  assert.equal(T.dueAutoPost(noon, 8), null, 'the first tick adopts the count, it does not announce it');
  assert.equal(T.dueAutoPost(noon, 9), null);
  assert.equal(T.dueAutoPost(noon, 10), 'threshold');
  T.markAutoPost('threshold', noon, 10);
  assert.equal(T.dueAutoPost(noon + 60_000, 22), null, 'twelve more inside the hour stays quiet');
  assert.equal(T.dueAutoPost(noon + 3600_000, 22), 'threshold', 'and goes out once the hour is up');
});

test('a fall below a step is silent, and climbing back over it counts again', () => {
  reset();
  const t0 = Date.parse('2026-07-01T09:00:00Z');
  T.dueAutoPost(t0, 20);
  assert.equal(T.dueAutoPost(t0, 11), null, 'nothing is announced for a fall');
  assert.equal(T.dueAutoPost(t0 + 7200_000, 20), 'threshold');
});

test('a post that failed to send stays due', () => {
  reset();
  R.setSetting('autopost_day', '2026-06-30');
  const at = Date.parse('2026-07-01T13:00:00Z');
  assert.equal(T.dueAutoPost(at, 0), 'daily');
  // markAutoPost is deliberately not called: the send threw.
  assert.equal(T.dueAutoPost(at, 0), 'daily', 'an unsent post is not a sent one');
});

// -------------------------------------------------------------- the group side

const BOT_INFO = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};
const GROUP = -100200300;
const ADMIN = 900001;

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
  return { bot, msg, drain, groupPosts: () => calls.filter((c) => c.payload?.chat_id === GROUP) };
}

/**
 * Everything the bot said to the group, as one string.
 *
 * The privacy assertion runs against this rather than against a single message,
 * so a leak in a follow-up (a GATE HIT line, an error) is caught too.
 */
const groupText = (calls) =>
  calls
    .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload.chat_id === GROUP)
    .map((c) => c.payload.text)
    .join('\n');

test('/ready in a group posts totals only', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  const c = drain();
  const sends = c.filter((x) => x.method === 'sendMessage');
  assert.equal(sends.length, 1, `exactly one message, got ${sends.length}`);
  assert.match(sends[0].payload.text, /^READY FOR LAUNCH/);
  assert.match(sends[0].payload.text, /wallets ready/);
});

test('a wallet pasted in the group is deleted, answered in DM, and never echoed', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  const { bot, msg, drain } = harness();
  rememberDm(5002, 5002);
  await bot.handleUpdate(msg('supergroup', `/ready ${WALLET}`, GROUP, 5002));
  const c = drain();

  const deleted = c.filter((x) => x.method === 'deleteMessage');
  assert.equal(deleted.length, 1, 'the message with the address in it is deleted');
  assert.equal(deleted[0].payload.chat_id, GROUP);

  const toGroup = c.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === GROUP);
  assert.equal(toGroup.length, 0, 'and nothing is posted in its place');

  const dm = c.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === 5002);
  assert.equal(dm.length, 1);
  assert.match(dm[0].payload.text, /register in DM, never in the group/);
  assert.ok(!dm[0].payload.text.includes(WALLET), 'not even the DM repeats it back into a log');
});

test('an address anywhere in a group /ready is deleted, not just the first word', async () => {
  reset();
  balances.set(A(2), eth(2));
  const { bot, msg, drain } = harness();
  // An admin typing the DM-only form in the group leaks the same address.
  await bot.handleUpdate(msg('supergroup', `/ready add ${A(2)} rh trader #3`, GROUP, ADMIN));
  const c = drain();
  assert.equal(c.filter((x) => x.method === 'deleteMessage').length, 1);
  assert.equal(c.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === GROUP).length, 0);
  assert.equal(R.totals().wallets, 0, 'and the admin command does not run from a group either');
});

test('a second /ready inside the cache window edits the block instead of posting again', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  const first = drain().filter((x) => x.method === 'sendMessage');
  assert.equal(first.length, 1);

  balances.set(A(3), eth(9));
  await R.addExternal(A(3), 'later arrival');
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  const second = drain();
  assert.equal(second.filter((x) => x.method === 'sendMessage').length, 0, 'no second block');
  const edits = second.filter((x) => x.method === 'editMessageText');
  assert.equal(edits.length, 1, 'the existing block is edited');
  assert.equal(edits[0].payload.message_id, first[0].messageId, 'and it is the block that was posted');
});

test('the edited block says how old its figures are', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  const { bot, drain } = harness();
  const t0 = Date.parse('2026-07-01T09:00:00Z');
  await postTotals(bot.api, GROUP, { now: t0, isGroup: true });
  drain();
  await postTotals(bot.api, GROUP, { now: t0 + 3 * 60_000, isGroup: true });
  const edits = drain().filter((x) => x.method === 'editMessageText');
  assert.equal(edits.length, 1);
  assert.match(edits[0].payload.text, /updated 3 min ago/);
});

test('past the cache window a new block is posted', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  const { bot, drain } = harness();
  const t0 = Date.parse('2026-07-01T09:00:00Z');
  await postTotals(bot.api, GROUP, { now: t0, isGroup: true });
  drain();
  await postTotals(bot.api, GROUP, { now: t0 + 11 * 60_000, isGroup: true });
  const c = drain();
  assert.equal(c.filter((x) => x.method === 'editMessageText').length, 0);
  assert.equal(c.filter((x) => x.method === 'sendMessage').length, 1);
  assert.ok(!/updated \d+ min ago/.test(c.find((x) => x.method === 'sendMessage').payload.text),
    'a block read just now does not claim to be old');
});

test('a scheduled post is a new message, not an edit of an old block', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  drain();
  R.setSetting('autopost_day', '2026-06-30');
  const at = Date.parse('2026-07-01T13:00:00Z');
  const posted = await readyAutoPostTick(bot.api, { now: at, botUsername: 'vitalscheck_bot' });
  assert.equal(posted, true);
  const c = drain();
  assert.equal(c.filter((x) => x.method === 'editMessageText').length, 0);
  assert.equal(c.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === GROUP).length, 1);
});

test('/tge adds the countdown when a launch time is set', async () => {
  reset();
  R.setSetting('launch_at', String(Math.floor(Date.now() / 1000) + 2 * 3600));
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/tge', GROUP, ADMIN));
  const c = drain().filter((x) => x.method === 'sendMessage');
  assert.equal(c.length, 1);
  assert.match(c[0].payload.text, /launch in 1h 59m|launch in 2h 0m/);
});

// ---------------------------------------------------------------------- admin

test('admin commands do nothing at all for a non-admin', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  const { bot, msg, drain } = harness();
  for (const cmd of [`/ready add ${A(4)} spy`, '/ready list', '/ready open on', '/kols 14', '/gate set wallets=150', '/launch set 2026-10-01T15:00Z']) {
    await bot.handleUpdate(msg('private', cmd, 5007, 5007));
  }
  assert.equal(drain().length, 0, 'a non-admin gets silence, not an error that confirms the command exists');
  assert.equal(R.selfRegistrationOpen(), false);
  assert.equal(R.getNumber('kols', 0), 0);
});

test('an admin lists the register as CSV, in DM', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  balances.set(A(2), eth(2));
  await R.registerMember(7, WALLET);
  await R.addExternal(A(2), 'rh trader #3');
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('private', '/ready list', ADMIN, ADMIN));
  const c = drain().filter((x) => x.method === 'sendMessage');
  assert.equal(c.length, 1);
  const text = c[0].payload.text;
  assert.equal(c[0].payload.chat_id, ADMIN, 'the register goes to the admin, in DM');
  assert.match(text.split('\n')[0], /^wallet,balance_eth,source,label,invite_link,first_seen,last_checked$/);
  assert.match(text, new RegExp(`${WALLET},0\\.3100,member`));
  assert.match(text, new RegExp(`${A(2)},2\\.0000,external,"rh trader #3"`));
});

test('self-registration is off until an admin opens it', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('private', `/ready ${WALLET}`, 5008, 5008));
  let c = drain().filter((x) => x.method === 'sendMessage');
  assert.equal(c.length, 1);
  assert.match(c[0].payload.text, /handled by the team/);
  assert.equal(R.totals().wallets, 0, 'and nothing was registered');

  await bot.handleUpdate(msg('private', '/ready open on', ADMIN, ADMIN));
  drain();
  assert.equal(R.selfRegistrationOpen(), true);
  await bot.handleUpdate(msg('private', `/ready ${WALLET}`, 5009, 5009));
  c = drain().filter((x) => x.method === 'sendMessage');
  assert.match(c[0].payload.text, /READY · 0\.31 ETH/);
  assert.equal(R.totals().wallets, 1);
});

test('the below-minimum reply says the figure, the minimum, and the way out', async () => {
  reset();
  R.setSetting('ready_open', 'on');
  balances.set(WALLET, eth(0.021));
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('private', `/ready ${WALLET}`, 5010, 5010));
  const text = drain().find((x) => x.method === 'sendMessage').payload.text;
  assert.match(text, /not yet: 0\.021 ETH on Robinhood Chain, minimum 0\.05/);
  assert.match(text, /Maestro → \/relay → Robinhood Chain, then \/ready again/);
});

test('/ready in DM without an address reports your own status', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('private', '/ready', 5011, 5011));
  assert.match(drain().find((x) => x.method === 'sendMessage').payload.text, /^not registered$/);
  await R.registerMember(5011, WALLET);
  await bot.handleUpdate(msg('private', '/ready', 5011, 5011));
  assert.match(drain().find((x) => x.method === 'sendMessage').payload.text, /^you: READY · 0\.31 ETH · registered /);
});

test('a bot saying /ready is ignored', async () => {
  reset();
  const { bot, drain } = harness();
  await bot.handleUpdate({
    update_id: 99,
    message: {
      message_id: 99, date: 0,
      chat: { id: GROUP, type: 'supergroup', title: 'g' },
      from: { id: 4242, is_bot: true, first_name: 'B' },
      text: '/ready',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  });
  assert.equal(drain().length, 0);
});

// ------------------------------------------------ the promise, asserted always

test('no wallet, label or user id ever appears in a group message', async () => {
  reset();
  R.setSetting('ready_open', 'on');
  R.setSetting('gate_wallets', '1');
  balances.set(WALLET, eth(0.31));
  balances.set(A(2), eth(2));
  await R.registerMember(7007007, WALLET, { inviteLink: 'kol-batch-2' });
  await R.addExternal(A(2), 'rh trader #3');

  const { bot, msg, drain } = harness();
  rememberDm(5100, 5100);

  // Every command a group member can reach, including the admin ones typed in
  // the wrong place and the address pasted where it must never appear.
  const inGroup = [
    '/ready',
    `/ready ${WALLET}`,
    `/ready add ${A(2)} rh trader #3`,
    '/ready list',
    '/ready open on',
    '/tge',
    '/kols 14',
    '/gate set wallets=1',
    '/launch set 2026-10-01T15:00Z',
  ];
  for (const cmd of inGroup) {
    await bot.handleUpdate(msg('supergroup', cmd, GROUP, 5100));
  }
  // The same two again from an admin, because the group surface is admin-only
  // now and a member hears nothing. Without these the assertion below would be
  // checking that silence contains no wallets, which it trivially does.
  for (const cmd of ['/ready', '/tge']) {
    await bot.handleUpdate(msg('supergroup', cmd, GROUP, ADMIN));
  }
  // And the scheduled post, which nobody typed.
  await readyAutoPostTick(bot.api, { now: Date.parse('2026-07-01T13:00:00Z'), botUsername: 'vitalscheck_bot' });

  const said = groupText(drain());
  assert.ok(said.length > 0, 'the group did hear something, or this asserts nothing');
  for (const secret of [WALLET, WALLET.slice(2), A(2), A(2).slice(2), 'rh trader #3', 'kol-batch-2', '7007007', '5100']) {
    assert.ok(!said.toLowerCase().includes(secret.toLowerCase()),
      `"${secret}" reached the group:\n${said}`);
  }
  assert.ok(!/0x[0-9a-f]{40}/i.test(said), `an address reached the group:\n${said}`);
});

// ------------------------------------------------- defects found by audit

test('every realistic paste form of an address is deleted from the group', async () => {
  reset();
  const A1 = '0x147bbaa458ab7cd11e1e478b87f08fe5a42a9e67';
  const forms = [
    A1,                                                   // plain lowercase
    '0X147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67',          // 0X prefix
    '0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E68'.slice(0, 41) + '7', // flipped case, bad checksum
    `${A1}.`, `${A1},`, `(${A1})`, '`' + A1 + '`',         // punctuation around it
    `my wallet is ${A1} btw`,                              // mid-sentence
  ];
  for (const form of forms) {
    const { bot, msg, drain } = harness();
    await bot.handleUpdate(msg('supergroup', `/ready ${form}`, GROUP, 5200));
    const c = drain();
    assert.equal(c.filter((x) => x.method === 'deleteMessage').length, 1, `not deleted: ${form}`);
    assert.equal(c.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === GROUP).length, 0,
      `the bot answered in the group under a surviving address: ${form}`);
  }
});

test('an anonymous admin pasting an address is not exempt from deletion', async () => {
  reset();
  const { bot, drain } = harness();
  // Telegram attributes anonymous admin messages to GroupAnonymousBot.
  await bot.handleUpdate({
    update_id: 5001,
    message: {
      message_id: 4242, date: 0,
      chat: { id: GROUP, type: 'supergroup', title: 'g' },
      from: { id: 1087968824, is_bot: true, first_name: 'GroupAnonymousBot' },
      text: `/ready ${WALLET}`,
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  });
  assert.equal(drain().filter((x) => x.method === 'deleteMessage').length, 1,
    'posting anonymously is the default for admins in most crypto groups');
});

test('/ready keeps working in the group hour after hour', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  R.setSetting('ready_chat', String(GROUP));
  const { bot, drain } = harness();
  const t0 = Date.parse('2026-07-01T09:00:00Z');
  R.setSetting('autopost_day', '2026-07-01');
  await postTotals(bot.api, GROUP, { now: t0, isGroup: true });
  drain();

  // The scheduler ticks every 60s. Bumping the cache stamp on each tick kept it
  // permanently warm, so every later /ready edited a block that had scrolled
  // away an hour ago and the group saw nothing at all.
  for (let i = 1; i <= 40; i++) await readyAutoPostTick(bot.api, { now: t0 + i * 60_000 });
  drain();
  await postTotals(bot.api, GROUP, { now: t0 + 41 * 60_000, isGroup: true });
  const c = drain();
  assert.equal(c.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === GROUP).length, 1,
    'past the window /ready posts a visible block, it does not edit an hour-old one');
});

test('a scheduler tick that has nothing to do reads no balances', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  R.setSetting('ready_chat', String(GROUP));
  const { bot } = harness();
  const t0 = Date.parse('2026-07-01T09:00:00Z');
  R.setSetting('autopost_day', '2026-07-01');
  R.setSetting('autopost_polled_at', String(t0));
  const before = reads.count;
  for (let i = 1; i <= 10; i++) await readyAutoPostTick(bot.api, { now: t0 + i * 60_000 });
  // Ten minutes of ticks. The threshold trigger is allowed to look every five,
  // so this is two refreshes of one wallet, not ten -- the old shape refreshed
  // every registered balance on every tick, 288,000 chain reads a day at two
  // hundred wallets to publish two posts.
  assert.ok(reads.count - before <= 2, `${reads.count - before} reads over ten idle minutes`);
});

test('GATE HIT is announced in the group and cannot be burned in a DM', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  R.setSetting('gate_wallets', '1');
  const { bot, msg, drain } = harness();

  // A member DMs /tge first. That must not consume the announcement.
  await bot.handleUpdate(msg('private', '/tge', 5203, 5203));
  let c = drain();
  assert.equal(c.filter((x) => x.payload?.text === 'GATE HIT').length, 0, 'not in a DM');
  assert.ok(!R.getSetting('gate_announced'), 'and the flag is not burned');

  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  c = drain();
  const hit = c.filter((x) => x.payload?.text === 'GATE HIT');
  assert.equal(hit.length, 1, 'the group gets it');
  assert.equal(hit[0].payload.chat_id, GROUP);
});

test('two chats do not defeat the ten-minute cache', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(7, WALLET);
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  drain();
  // A DM in between must not evict the group's cached block.
  await bot.handleUpdate(msg('private', '/tge', 5206, 5206));
  drain();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  const c = drain();
  assert.equal(c.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === GROUP).length, 0);
  assert.equal(c.filter((x) => x.method === 'editMessageText').length, 1, 'still an edit, as promised');
});

test('a /ready inside the window does not strip the countdown /tge posted', async () => {
  reset();
  R.setSetting('launch_at', String(Math.floor(Date.now() / 1000) + 7200));
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/tge', GROUP, ADMIN));
  assert.match(drain().find((x) => x.method === 'sendMessage').payload.text, /launch in /);
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, ADMIN));
  const edit = drain().find((x) => x.method === 'editMessageText');
  assert.match(edit.payload.text, /launch in /, 'the countdown belongs to the launch, not to the command');
});

test('the register stays readable past forty wallets', async () => {
  reset();
  for (let i = 0; i < 60; i++) {
    const w = '0x' + String(i).padStart(40, 'e');
    balances.set(w, eth(1));
    await R.addExternal(w, `rh trader #${i}`);
  }
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('private', '/ready list', ADMIN, ADMIN));
  const sends = drain().filter((x) => x.method === 'sendMessage');
  assert.ok(sends.length > 1, 'chunked rather than rejected by Telegram and swallowed');
  for (const s of sends) {
    assert.ok(s.payload.text.length <= 4096, `chunk of ${s.payload.text.length} exceeds the limit`);
  }
  const all = sends.map((s) => s.payload.text).join('\n');
  assert.equal(all.split('\n').filter((l) => l.startsWith('0x')).length, 60, 'every row survives');
});

test('a member cannot be silently evicted by someone registering their address', async () => {
  reset();
  R.setSetting('ready_open', 'on');
  balances.set(WALLET, eth(0.31));
  await R.registerMember(111, WALLET);
  assert.equal(R.statusOf(111).wallet, WALLET);

  // Addresses are public and get pasted in group chats constantly.
  const res = await R.registerMember(222, WALLET);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'claimed');
  assert.ok(R.statusOf(111), 'the original registrant is still registered');
  assert.equal(R.statusOf(222), null);
});

test('re-registering your own wallet is still allowed', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  await R.registerMember(111, WALLET);
  R.resetReadyCooldowns();
  assert.equal((await R.registerMember(111, WALLET)).ok, true);
});

test('the cooldown starts before the chain reads, and a failure starts it too', async () => {
  reset();
  balances.set(WALLET, eth(0.31));
  const before = reads.count;
  const results = await Promise.all(Array.from({ length: 5 }, () => R.registerMember(77, WALLET)));
  assert.equal(results.filter((r) => r.ok).length, 1, 'one registration per ten minutes, not five');
  assert.ok(reads.count - before <= 2, `a burst must not amplify into chain reads, made ${reads.count - before}`);

  R.resetReadyCooldowns();
  balances.set(A(9), eth(0.001));
  assert.equal((await R.registerMember(78, A(9))).reason, 'low');
  assert.equal((await R.registerMember(78, A(9))).reason, 'cooldown', 'a failed attempt starts the clock too');
});

test('a member who just joined can still register in a DM', async () => {
  reset();
  R.setSetting('ready_open', 'on');
  balances.set(WALLET, eth(0.31));
  R.rememberJoin(5210, 'twitter', Date.now());
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('private', `/ready ${WALLET}`, 5210, 5210));
  assert.match(drain().find((x) => x.method === 'sendMessage')?.payload.text ?? '', /READY/,
    'joining from a campaign link and registering straight away is the funnel, not abuse');
  assert.ok(R.statusOf(5210), 'and is registered');
});

test('a member who just joined is still ignored in the group', async () => {
  reset();
  R.rememberJoin(5211, null, Date.now());
  const { bot, msg, drain } = harness();
  await bot.handleUpdate(msg('supergroup', '/ready', GROUP, 5211));
  assert.equal(drain().length, 0);
});

test('a channel post cannot hijack where the scheduled posts go', async () => {
  reset();
  R.setSetting('ready_chat', String(GROUP));
  const { bot, drain } = harness();
  await bot.handleUpdate({
    update_id: 6001,
    channel_post: {
      message_id: 1, date: 0,
      chat: { id: -1009999, type: 'channel', title: 'c' },
      text: '/tge',
      entities: [{ type: 'bot_command', offset: 0, length: 4 }],
    },
  });
  assert.equal(drain().length, 0, 'a post with no sender is not a command');
  assert.equal(R.getSetting('ready_chat'), String(GROUP), 'and never redirects the auto-posts');
});
