/**
 * The tier commands, driven through the real handlers.
 *
 * The gate that matters is negative: a check that did not run must never read
 * as a check you failed. An unreadable balance, an unconfigured token and an
 * unlinked wallet are three different sentences, and none of them is "you do
 * not hold enough".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('tier-cmd');
process.env.ADMIN_IDS = '900001';
process.env.PREMIUM_PAY_ADDRESS = '0x9999999999999999999999999999999999999999';
process.env.VERIFY_ADDRESS = '0x8888888888888888888888888888888888888888';

const { db } = await import('../dist/db.js');
const { client } = await import('../dist/chain.js');

const TOKEN = '0x2222222222222222222222222222222222222222';
let balances = new Map();
let readThrows = false;
client.readContract = async ({ functionName, args }) => {
  if (readThrows) throw new Error('rpc down');
  if (functionName === 'decimals') return 18;
  if (functionName === 'balanceOf') return (balances.get(String(args[0]).toLowerCase()) ?? 0n) * 10n ** 18n;
  throw new Error(`unexpected ${functionName}`);
};
client.getBalance = async () => 10n ** 18n;
client.getCode = async () => '0x';

const { createBot } = await import('../dist/bot.js');
const T = await import('../dist/tiers.js');
const H = await import('../dist/holder.js');
const F = await import('../dist/feed.js');

const acct = privateKeyToAccount('0x' + '33'.repeat(32));
const WALLET = acct.address.toLowerCase();
const ADMIN = 900001;
const GROUP = -100555;

function harness() {
  const bot = createBot('123456:FAKE');
  bot.botInfo = {
    id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
  };
  const calls = [];
  let id = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: ++id, chat: { id: payload.chat_id }, date: 0, text: payload.text } };
    }
    if (method === 'getChatMemberCount') return { ok: true, result: 10 };
    return { ok: true, result: true };
  });
  let uid = 0;
  const msg = (chatType, text, chatId, fromId) => ({
    update_id: ++uid,
    message: {
      message_id: 3000 + uid, date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: chatType, ...(chatType === 'private' ? {} : { title: 'g' }) },
      from: { id: fromId, is_bot: false, first_name: 'U' },
      text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined,
    },
  });
  const drain = () => { const c = [...calls]; calls.length = 0; return c; };
  const said = () => drain().filter((x) => x.method === 'sendMessage').map((x) => x.payload.text).join('\n');
  return { bot, msg, drain, said };
}

const reset = () => {
  for (const t of ['ready_settings', 'holder_links', 'holder_nonces', 'tier_grants', 'feed_subs', 'licences', 'watches', 'filter_watches', 'dm_chats']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  balances = new Map();
  readThrows = false;
  T.resetBalanceCache();
  T.setVitalsToken(TOKEN);
};

const linkUser = async (userId) => {
  const n = H.issueNonce(userId);
  return H.linkBySignature(userId, await acct.signMessage({ message: H.linkMessage(n) }));
};

test('/holder link issues the exact message the wallet must sign', async () => {
  reset();
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/holder link', 5001, 5001));
  const said = h.said();
  const m = /vitals holder link ([0-9a-f]{16})/.exec(said);
  assert.ok(m, `no challenge in: ${said}`);
  assert.match(said, /custodial wallet that cannot sign/);
  assert.match(said, /0x8888888888888888888888888888888888888888/);

  const sig = await acct.signMessage({ message: `vitals holder link ${m[1]}` });
  await h.bot.handleUpdate(h.msg('private', `/holder link ${sig}`, 5001, 5001));
  const after = h.said();
  assert.match(after, new RegExp(`linked ${WALLET}`));
  assert.equal(T.linkedWallet(5001), WALLET);
});

test('an unlinked user is told to link, not that they hold too little', async () => {
  reset();
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/feed', 5002, 5002));
  const said = h.said();
  assert.match(said, /link a wallet first/);
  assert.ok(!/\$VITALS held/.test(said),
    'nobody has measured anything yet, so no claim about how much they hold');
});

test('an unreadable balance says so rather than denying', async () => {
  reset();
  await linkUser(5003);
  readThrows = true;
  T.resetBalanceCache();
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/feed', 5003, 5003));
  const said = h.said();
  assert.match(said, /could not be read.*try again/);
  assert.ok(!/premium\. /.test(said), 'a failed read is not a refusal');
});

test('a holder at premium can turn the feed on, and below it cannot', async () => {
  reset();
  await linkUser(5004);
  balances.set(WALLET, 999_999n);
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/feed', 5004, 5004));
  assert.match(h.said(), /the feed is premium\. 1,000,000 \$VITALS held, or \/premium/);
  assert.equal(F.subOf(5004), null);

  balances.set(WALLET, 1_000_000n);
  T.resetBalanceCache();
  await h.bot.handleUpdate(h.msg('private', '/feed', 5004, 5004));
  assert.match(h.said(), /feed on/);
  assert.ok(F.subOf(5004));
});

test('the feed refuses to exist in a group', async () => {
  reset();
  const h = harness();
  await h.bot.handleUpdate(h.msg('supergroup', '/feed', GROUP, 5005));
  assert.match(h.said(), /the feed is a DM/);
  assert.equal(F.subOf(5005), null);
});

test('/feed filters refuses a clause it does not understand', async () => {
  reset();
  await linkUser(5006);
  balances.set(WALLET, 2_000_000n);
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/feed on', 5006, 5006));
  h.drain();
  await h.bot.handleUpdate(h.msg('private', '/feed filters exempt>0 nonsense=1', 5006, 5006));
  assert.match(h.said(), /could not read "nonsense=1"/);
  assert.deepEqual(F.subOf(5006).filters, {}, 'and nothing was half-applied');

  await h.bot.handleUpdate(h.msg('private', '/feed filters exempt>0 pair=eth', 5006, 5006));
  assert.match(h.said(), /filters: exempt>0 pair=eth/);
});

test('the filter help warns that min_buyers matches almost nothing live', async () => {
  reset();
  await linkUser(5007);
  balances.set(WALLET, 2_000_000n);
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/feed on', 5007, 5007));
  h.drain();
  await h.bot.handleUpdate(h.msg('private', '/feed filters', 5007, 5007));
  assert.match(h.said(), /min_buyers=n only matches once the opening window has been indexed/);
});

test('/tiers shows the thresholds, and only an admin can move them', async () => {
  reset();
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/tiers', 5008, 5008));
  const said = h.said();
  assert.match(said, /watch\s+250,000 \$VITALS/);
  assert.match(said, /premium\s+1,000,000 \$VITALS/);
  assert.match(said, /desk\s+10,000,000 \$VITALS/);

  await h.bot.handleUpdate(h.msg('private', '/tiers set premium 500000', 5008, 5008));
  assert.equal(h.said(), '', 'a non-admin gets silence');
  assert.equal(T.thresholds().premium, 1_000_000n);

  await h.bot.handleUpdate(h.msg('private', '/tiers set premium 500000', ADMIN, ADMIN));
  assert.match(h.said(), /premium: 1,000,000 → 500,000/);
  assert.equal(T.thresholds().premium, 500_000n);
});

test('raising a threshold is refused with the reason', async () => {
  reset();
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/tiers set premium 2000000', ADMIN, ADMIN));
  assert.match(h.said(), /a threshold can only go down.*would take access from people who bought to have it/s);
  assert.equal(T.thresholds().premium, 1_000_000n);
});

test('/premium names the address and the price, and needs a linked wallet', async () => {
  reset();
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/premium', 5009, 5009));
  assert.match(h.said(), /link the wallet you will pay from first/);

  await linkUser(5009);
  await h.bot.handleUpdate(h.msg('private', '/premium', 5009, 5009));
  const said = h.said();
  assert.match(said, /send 0\.05 ETH to 0x9999999999999999999999999999999999999999 on Robinhood Chain/);
  assert.match(said, /30 days start when it lands/);
  assert.match(said, /\/premium <tx hash>/);
});

test('/grant and /revoke are admin only, and show up as days remaining', async () => {
  reset();
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/grant 4242 30d', 5010, 5010));
  assert.equal(h.said(), '', 'a non-admin gets silence');
  assert.equal(T.grantOf(4242), null);

  await h.bot.handleUpdate(h.msg('private', '/grant 4242 30d', ADMIN, ADMIN));
  assert.match(h.said(), /4242: premium until \d{4}-\d{2}-\d{2}/);
  assert.equal(T.grantOf(4242).tier, 'premium');

  await h.bot.handleUpdate(h.msg('private', '/help', 4242, 4242));
  assert.match(h.said(), /premium: 30 days remaining/);

  await h.bot.handleUpdate(h.msg('private', '/revoke 4242', ADMIN, ADMIN));
  assert.match(h.said(), /grant revoked/);
});

test('/help carries the one line, and says nothing about days to somebody with none', async () => {
  reset();
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/help', 5011, 5011));
  const said = h.said();
  assert.match(said, /holding \$VITALS unlocks access, not yield\. tiers: 250k, 1M, 10M\./);
  assert.ok(!/days remaining/.test(said), 'a line reading "0 days" is an advert, not a status');
});

test('the watch allowance follows the tier, and never confiscates', async () => {
  reset();
  const h = harness();
  // Free: three.
  await h.bot.handleUpdate(h.msg('private', 'hi', 5012, 5012));
  h.drain();
  for (let i = 1; i <= 3; i++) {
    await h.bot.handleUpdate(h.msg('private', `/watch deployer 0x${String(i).repeat(40)}`, 5012, 5012));
    h.drain();
  }
  await h.bot.handleUpdate(h.msg('private', '/watch deployer 0x' + '9'.repeat(40), 5012, 5012));
  assert.match(h.said(), /that is 3 watches, which is your limit.*250,000 \$VITALS held raises it to 10/s);

  // WATCH tier: ten.
  await linkUser(5012);
  balances.set(WALLET, 250_000n);
  T.resetBalanceCache();
  await h.bot.handleUpdate(h.msg('private', '/watch deployer 0x' + '9'.repeat(40), 5012, 5012));
  assert.match(h.said(), /watching deployer/);
});

test('/export and /license are desk only', async () => {
  reset();
  await linkUser(5013);
  balances.set(WALLET, 1_000_000n);
  const h = harness();
  await h.bot.handleUpdate(h.msg('private', '/export', 5013, 5013));
  assert.match(h.said(), /\/export is desk: 10,000,000 \$VITALS held/);

  await h.bot.handleUpdate(h.msg('supergroup', '/license', GROUP, 5013));
  assert.match(h.said(), /a group licence is desk/);

  balances.set(WALLET, 10_000_000n);
  T.resetBalanceCache();
  await h.bot.handleUpdate(h.msg('supergroup', '/license', GROUP, 5013));
  assert.match(h.said(), /licensed/);
});

test('one holder licenses one group, not every group they can type in', async () => {
  reset();
  await linkUser(5014);
  balances.set(WALLET, 10_000_000n);
  const h = harness();
  await h.bot.handleUpdate(h.msg('supergroup', '/license', GROUP, 5014));
  h.drain();
  await h.bot.handleUpdate(h.msg('supergroup', '/license', -100666, 5014));
  assert.match(h.said(), /you have already licensed a group/);
  const n = db.prepare('SELECT COUNT(*) AS n FROM licences').get().n;
  assert.equal(n, 1);
});
