/**
 * The countdown: nine posts, each exactly once, pinned one at a time.
 *
 * Driven entirely off a fake clock and a stub Api. Nothing here waits for a
 * real second to pass, which is the only way a five day countdown is testable
 * at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = process.env.DB_PATH || `/tmp/vitals-countdown-${process.pid}.db`;
process.env.ADMIN_IDS = '900001';

const { db } = await import('../dist/db.js');
const { client } = await import('../dist/chain.js');

const balances = new Map();
client.getBalance = async ({ address }) => balances.get(String(address).toLowerCase()) ?? 0n;
client.getCode = async () => '0x';

const R = await import('../dist/ready.js');
const L = await import('../dist/launch.js');
const D = await import('../dist/launchday.js');

const GROUP = -100777;
const LAUNCH = Date.parse('2026-09-22T14:00:00Z'); // 16:00 CEST, a Tuesday
const WALLET = '0x1111111111111111111111111111111111111111';
const eth = (n) => BigInt(Math.round(n * 1e18));

/** A stub Api that records what it was asked to do. */
function stubApi(over = {}) {
  const calls = [];
  let id = 900;
  return {
    calls,
    drain: () => { const c = [...calls]; calls.length = 0; return c; },
    api: {
      async sendMessage(chat_id, text, extra) {
        const message_id = ++id;
        calls.push({ method: 'sendMessage', chat_id, text, extra, message_id });
        return { message_id, chat: { id: chat_id }, text };
      },
      async pinChatMessage(chat_id, message_id, extra) {
        calls.push({ method: 'pin', chat_id, message_id, extra });
        if (over.pinThrows) throw new Error('not enough rights');
        return true;
      },
      async unpinChatMessage(chat_id, message_id) {
        calls.push({ method: 'unpin', chat_id, message_id });
        return true;
      },
      async getChatMemberCount() { return 212; },
      async getChatMember(chat_id, user_id) {
        calls.push({ method: 'getChatMember', chat_id, user_id });
        if (over.memberThrows) throw new Error('chat not found');
        return over.member ?? {
          status: 'administrator', can_pin_messages: true,
          can_delete_messages: true, can_restrict_members: true,
        };
      },
      ...(over.api ?? {}),
    },
  };
}

const reset = (withPlan = true) => {
  db.prepare('DELETE FROM ready_wallets').run();
  db.prepare('DELETE FROM ready_settings').run();
  balances.clear();
  balances.set(WALLET, eth(0.31));
  R.setSetting('ready_chat', String(GROUP));
  if (withPlan) R.setSetting('launch_at', String(Math.floor(LAUNCH / 1000)));
};

test('every offset posts exactly once, closest-first as time runs down', async () => {
  reset();
  await R.registerMember(7, WALLET);
  const s = stubApi();
  const fired = [];
  for (const o of L.COUNTDOWN_OFFSETS) {
    const now = LAUNCH - o.seconds * 1000 + 1000;
    fired.push(await D.countdownTick(s.api, { now }));
    // A second tick at the same moment must do nothing.
    assert.equal(await D.countdownTick(s.api, { now: now + 500 }), null, `${o.key} fired twice`);
  }
  assert.deepEqual(fired, ['T-5d', 'T-4d', 'T-3d', 'T-2d', 'T-24h', 'T-12h', 'T-6h', 'T-1h', 'T-10min']);
  assert.equal(s.calls.filter((c) => c.method === 'sendMessage').length, 9);
});

test('each post carries the READY block and both fixed lines', async () => {
  reset();
  await R.registerMember(7, WALLET);
  R.setSetting('launch_name', '$VITALS');
  const s = stubApi();
  await D.countdownTick(s.api, { now: LAUNCH - 5 * 86_400_000 + 1000, botUsername: 'vitalscheck_bot' });
  const sent = s.drain().find((c) => c.method === 'sendMessage');
  assert.equal(sent.chat_id, GROUP);
  const lines = sent.text.split('\n');
  assert.equal(lines[0], 'READY FOR LAUNCH: $VITALS', 'the name an admin set is on the block');
  assert.match(sent.text, /wallets ready/);
  assert.match(sent.text, /^launch: 2026-09-22 16:00 CEST$/m);
  assert.match(sent.text, /^CA lands here 3 s after launch\. anything before that is fake\.$/m);
  assert.equal(sent.extra?.link_preview_options?.is_disabled, true);
});

test('the declared count is printed when set and omitted when not', async () => {
  reset();
  const s = stubApi();
  delete process.env.DECLARED_COUNT;
  await D.countdownTick(s.api, { now: LAUNCH - 5 * 86_400_000 + 1000 });
  assert.ok(!/declared launches/.test(s.drain().find((c) => c.method === 'sendMessage').text));

  process.env.DECLARED_COUNT = '12';
  await D.countdownTick(s.api, { now: LAUNCH - 4 * 86_400_000 + 1000 });
  assert.match(s.drain().find((c) => c.method === 'sendMessage').text, /^declared launches so far: 12$/m);
  delete process.env.DECLARED_COUNT;
});

test('a bot that was down posts only the closest offset', async () => {
  reset();
  const s = stubApi();
  // Back up at T-2d having missed T-5d, T-4d and T-3d.
  assert.equal(await D.countdownTick(s.api, { now: LAUNCH - 2 * 86_400_000 + 1000 }), 'T-2d');
  assert.equal(s.calls.filter((c) => c.method === 'sendMessage').length, 1, 'one post, not four');
  // And the buried ones never fire late.
  assert.equal(await D.countdownTick(s.api, { now: LAUNCH - 86_400_000 * 1.5 }), null);
});

test('each post is pinned and the one before it unpinned', async () => {
  reset();
  const s = stubApi();
  await D.countdownTick(s.api, { now: LAUNCH - 5 * 86_400_000 + 1000 });
  let c = s.drain();
  const first = c.find((x) => x.method === 'sendMessage');
  const pin1 = c.find((x) => x.method === 'pin');
  assert.equal(pin1.message_id, first.message_id);
  assert.equal(pin1.extra?.disable_notification, true, 'a pin should not ping 212 people');
  assert.equal(c.filter((x) => x.method === 'unpin').length, 0, 'nothing to unpin on the first');

  await D.countdownTick(s.api, { now: LAUNCH - 4 * 86_400_000 + 1000 });
  c = s.drain();
  const second = c.find((x) => x.method === 'sendMessage');
  assert.equal(c.find((x) => x.method === 'pin').message_id, second.message_id);
  assert.equal(c.find((x) => x.method === 'unpin').message_id, first.message_id,
    'exactly one launch time is pinned at a time');
});

test('a pin that fails leaves the previous pin in place and does not lose the post', async () => {
  reset();
  const s = stubApi({ pinThrows: true });
  const key = await D.countdownTick(s.api, { now: LAUNCH - 5 * 86_400_000 + 1000 });
  assert.equal(key, 'T-5d', 'the post still went out');
  const c = s.drain();
  assert.equal(c.filter((x) => x.method === 'sendMessage').length, 1);
  assert.equal(c.filter((x) => x.method === 'unpin').length, 0,
    'nothing is unpinned when the replacement pin failed');
});

test('nothing fires with no launch set, no group, or after launch', async () => {
  reset(false);
  const s = stubApi();
  assert.equal(await D.countdownTick(s.api, { now: LAUNCH - 86_400_000 }), null, 'no launch set');

  reset();
  R.setSetting('ready_chat', '');
  assert.equal(await D.countdownTick(s.api, { now: LAUNCH - 86_400_000 }), null, 'no group known');

  reset();
  assert.equal(await D.countdownTick(s.api, { now: LAUNCH }), null, 'at T-0');
  assert.equal(await D.countdownTick(s.api, { now: LAUNCH + 3_600_000 }), null, 'after launch');
  assert.equal(s.calls.filter((x) => x.method === 'sendMessage').length, 0);
});

test('cancelling clears every countdown mark, so a re-set starts clean', async () => {
  reset();
  const s = stubApi();
  await D.countdownTick(s.api, { now: LAUNCH - 5 * 86_400_000 + 1000 });
  s.drain();
  L.clearLaunchPlan();
  assert.equal(L.getLaunchPlan(), null);

  R.setSetting('launch_at', String(Math.floor(LAUNCH / 1000)));
  assert.equal(await D.countdownTick(s.api, { now: LAUNCH - 5 * 86_400_000 + 1000 }), 'T-5d',
    'the same offset fires again for a freshly set launch');
});

// ------------------------------------------------------------------- preflight

test('preflight names exactly the rights that are missing', async () => {
  reset();
  const full = stubApi();
  assert.deepEqual(await D.preflight(full.api, GROUP, 42), { ok: true, missing: [], undetermined: false });

  const partial = stubApi({ member: { status: 'administrator', can_pin_messages: true } });
  const p = await D.preflight(partial.api, GROUP, 42);
  assert.equal(p.ok, false);
  assert.deepEqual(p.missing, ['delete messages', 'restrict members']);
  assert.match(D.preflightLine(p), /rights missing: delete messages, restrict members/);
});

test('a bot that is only a member is told that first', async () => {
  reset();
  const s = stubApi({ member: { status: 'member' } });
  const p = await D.preflight(s.api, GROUP, 42);
  assert.equal(p.ok, false);
  assert.match(p.missing[0], /^admin in this group/);
});

test('a rights check that could not be made is undetermined, never ready', async () => {
  reset();
  const s = stubApi({ memberThrows: true });
  const p = await D.preflight(s.api, GROUP, 42);
  assert.equal(p.undetermined, true);
  assert.equal(p.ok, false, 'a check that did not run is not a check that passed');
  assert.match(D.preflightLine(p), /could not check the bot's rights/);
});
