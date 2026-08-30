/**
 * Every failure mode must produce a reply, on all three surfaces, and a DM must
 * always resolve its "Scanning..." notice by EDITING it -- never by leaving it
 * on screen while a second message appears, and never by leaving it at all.
 * Needs network. Run: node test/errors.mjs
 */
import assert from 'node:assert/strict';
import { createBot } from '../dist/bot.js';
import { scanCache } from '../dist/cache.js';

const BOT_INFO = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};
const ok = (m) => console.log(`  PASS  ${m}`);

// A real contract that is not a pons launch, and an address with no code at all.
//
// This used to be 0x49bac477…, described here as "not a pons launch". It is
// one: the factory reports exists=true, phase=2, launched 23 days ago. The
// scan called it "not a pons v2 launch" only because it is older than the
// ten-day log lookback, and this test asserted that answer was correct — which
// is how a real launch being reported as not-a-launch survived until a user hit
// it. The replacement is verified against getLaunchedToken: the pair asset
// $NVDA is a genuine contract the factory has never launched.
const NON_PONS = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const NO_CODE = '0x00000000000000000000000000000000deadbeef';
// a real pons v2 launch, used where the reads themselves are the subject
const LIVE_TOKEN = '0xd384722f6adfe7d79E8e6623896DF199afD31B76';

const bot = createBot('123456:FAKE');
bot.botInfo = BOT_INFO;

const calls = [];
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method === 'sendMessage') {
    return { ok: true, result: { message_id: calls.length, chat: { id: payload.chat_id }, date: 0, text: payload.text } };
  }
  if (method === 'editMessageText') {
    return { ok: true, result: { message_id: payload.message_id, chat: { id: payload.chat_id }, date: 0, text: payload.text } };
  }
  return { ok: true, result: true };
});

let uid = 0;
const msg = (chatType, text, chatId) => ({
  update_id: ++uid,
  message: {
    message_id: 1000 + uid, date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: chatType, ...(chatType === 'private' ? {} : { title: 'g' }) },
    from: { id: 6000 + uid, is_bot: false, first_name: 'U' },
    text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
  },
});
const inline = (query, userId) => ({
  update_id: ++uid,
  inline_query: { id: `q${uid}`, from: { id: userId, is_bot: false, first_name: 'U' }, query, offset: '' },
});
const drain = () => { const c = [...calls]; calls.length = 0; return c; };

/** DM: notice sent, then EDITED with the answer. Nothing left hanging. */
async function checkDm(label, addr, expect) {
  scanCache.sweep();
  await bot.handleUpdate(msg('private', `/scan ${addr}`, -900));
  const c = drain();
  assert.ok(c.length >= 1, `${label}: DM produced NO reply at all`);
  const last = c[c.length - 1];
  const first = c[0];
  assert.equal(first.method, 'sendMessage');
  assert.match(first.payload.text, /Scanning/, `${label}: expected a "Scanning..." notice first`);
  assert.equal(last.method, 'editMessageText',
    `${label}: the notice must be EDITED, not left hanging with a new message sent`);
  assert.equal(last.payload.message_id, first.payload ? 1 : last.payload.message_id);
  assert.match(last.payload.text, expect, `${label}: DM text was ${JSON.stringify(last.payload.text)}`);
  assert.doesNotMatch(last.payload.text, /Scanning/, `${label}: notice text still present after edit`);
}

async function checkGroup(label, addr, expect) {
  scanCache.sweep();
  await bot.handleUpdate(msg('group', `/scan ${addr}`, -901));
  const c = drain();
  assert.equal(c.length, 1, `${label}: group produced ${c.length} messages, expected exactly 1`);
  assert.match(c[0].payload.text, expect, `${label}: group text was ${JSON.stringify(c[0].payload.text)}`);
}

async function checkInline(label, addr, expect, user) {
  scanCache.sweep();
  await bot.handleUpdate(inline(addr, user));
  const c = drain();
  assert.equal(c.length, 1, `${label}: inline was not answered — the client would spin forever`);
  assert.equal(c[0].method, 'answerInlineQuery');
  assert.ok(c[0].payload.results.length >= 1, `${label}: inline answered with zero results`);
  const r = c[0].payload.results[0];
  assert.match(r.input_message_content.message_text, expect,
    `${label}: inline text was ${JSON.stringify(r.input_message_content.message_text)}`);
}

const NOT_PONS = /not a pons v2 launch\. this bot only covers pons v2 on Robinhood Chain\./;

// ---- 1. a real contract that is not a pons launch --------------------------
await checkDm('non-pons contract', NON_PONS, NOT_PONS);
await checkGroup('non-pons contract', NON_PONS, NOT_PONS);
await checkInline('non-pons contract', NON_PONS, NOT_PONS, 7001);
ok('non-pons contract: DM edits the notice, group replies, inline answers');

// ---- 2. an address with no code at all -------------------------------------
await checkDm('address with no code', NO_CODE, NOT_PONS);
await checkGroup('address with no code', NO_CODE, NOT_PONS);
await checkInline('address with no code', NO_CODE, NOT_PONS, 7002);
ok('address with no code: DM edits the notice, group replies, inline answers');

// ---- 3. scanToken throws ----------------------------------------------------
// Break the RPC underneath so the scan genuinely throws, rather than asserting
// against a hand-built error object that could not happen in production.
const THROWER = '0x1111111111111111111111111111111111111111';
const savedFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (url.includes('rpc.mainnet.chain.robinhood.com')) throw new Error('simulated RPC outage');
  return savedFetch(input, init);
};
try {
  const FAILED = /scan failed, try again/;
  await checkDm('scanToken throws', THROWER, FAILED);
  await checkGroup('scanToken throws', THROWER, FAILED);
  await checkInline('scanToken throws', THROWER, FAILED, 7003);
  ok('scanToken throws: DM edits the notice, group replies, inline answers');
} finally {
  globalThis.fetch = savedFetch;
}

// ---- the concurrency slot must survive all of that -------------------------
const { scanSemaphore } = await import('../dist/quota.js');
const { inFlightCount } = await import('../dist/service.js');
assert.equal(scanSemaphore.stats().active, 0, `slots leaked: ${scanSemaphore.stats().active} still held`);
assert.equal(inFlightCount(), 0, 'in-flight map not drained after failures');
ok(`no concurrency slot leaked across ${9} failing scans (active=0, in-flight=0)`);

// ---- a failed or empty scan must not be charged to the user ---------------
{
  const { userQuota } = await import('../dist/quota.js');
  const { performScan } = await import('../dist/service.js');
  const USER = 77123;

  scanCache.sweep();
  const before = userQuota.check(USER);
  assert.equal(before.allowed, true, 'fresh user starts unlimited');

  // ten not-found scans: without the refund this alone exhausts 10/min
  for (let i = 0; i < 10; i++) {
    scanCache.sweep();
    const r = await performScan({ token: NON_PONS, source: 'dm', userId: USER });
    assert.equal(r.kind, 'not_found');
  }
  assert.equal(userQuota.check(USER).allowed, true,
    'a token that does not exist must not consume scan quota');
  ok('10 not-found scans consumed no scan quota');

  // and a hard failure is not charged either
  scanCache.sweep();
  const saved2 = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (url.includes('rpc.mainnet.chain.robinhood.com')) throw new Error('simulated RPC outage');
    return saved2(input, init);
  };
  try {
    const r = await performScan({ token: '0x3333333333333333333333333333333333333333', source: 'dm', userId: USER });
    assert.equal(r.kind, 'error');
  } finally {
    globalThis.fetch = saved2;
  }
  assert.equal(userQuota.check(USER).allowed, true, 'a failed scan must not consume scan quota');
  ok('a failed scan consumed no scan quota');
}

// ---------------------------------------------------------------------------
// A rate limit must never be turned into a measurement.
//
// readToken fires 17 optional reads in one Promise.all, and tryRead used to
// swallow every throw into a fallback. A limit hitting that burst therefore
// produced realQuoteReserve=0, totalSupply=0, symbol=null -- and the scan then
// rendered "no buyers yet · 0.0%" for a token at 80% of its threshold and wrote
// those zeros into the scans table as though they had been observed. Reporting
// the limit is the only honest answer; inventing a number is the worst outcome
// this product has.
{
  const { performScan } = await import('../dist/service.js');
  scanCache.sweep();

  // Let the launch lookup through, then limit the read burst behind it.
  const saved = globalThis.fetch;
  let passed = 0;
  const PASS_THROUGH = 4;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (url.includes('rpc.mainnet.chain.robinhood.com') && passed >= PASS_THROUGH) {
      return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } });
    }
    if (url.includes('rpc.mainnet.chain.robinhood.com')) passed++;
    return saved(input, init);
  };

  let outcome;
  try {
    outcome = await performScan({ token: LIVE_TOKEN, source: 'dm', userId: 88881, quotaKey: 88881 });
  } finally {
    globalThis.fetch = saved;
  }

  assert.notEqual(outcome.kind, 'ok',
    'a scan whose reads were rate limited must not be rendered as a completed card');
  if (outcome.kind === 'ok') {
    assert.fail(`rendered a card from limited reads: ${outcome.defaultCard?.slice(0, 200)}`);
  }
  assert.equal(outcome.kind, 'rate_limited',
    `a 429 must be reported as a limit, not as "${outcome.message}"`);
  assert.ok(!/scan failed/i.test(outcome.message), 'a limit must never be worded as a failure');
  ok(`reads that were rate limited report "${outcome.message}" rather than zeros`);
}

console.log('\nAll error-path checks passed.');
process.exit(0);
