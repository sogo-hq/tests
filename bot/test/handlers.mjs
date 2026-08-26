/**
 * Drives the real grammY handlers with synthetic Updates, intercepting the API
 * transport so nothing leaves the process. Verifies the group and inline
 * contracts without a bot token. Run: node test/handlers.mjs
 */
import assert from 'node:assert/strict';
import { createBot } from '../dist/bot.js';
import { scanCache } from '../dist/cache.js';

const BOT_INFO = {
  id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
};
const TOKEN = '0xd384722f6adfe7d79E8e6623896DF199afD31B76';
const ok = (m) => console.log(`  PASS  ${m}`);

const bot = createBot('123456:FAKE');
bot.botInfo = BOT_INFO;

/** Capture every outgoing API call instead of sending it. */
const calls = [];
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  // grammY expects the Bot API envelope, not a bare result.
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
    message_id: 1000 + uid,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: chatType, ...(chatType === 'private' ? {} : { title: 'g' }) },
    from: { id: 5000 + uid, is_bot: false, first_name: 'U' },
    text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
  },
});
const inline = (query, userId = 9001) => ({
  update_id: ++uid,
  inline_query: { id: `q${uid}`, from: { id: userId, is_bot: false, first_name: 'U' }, query, offset: '' },
});

const drain = () => { const c = [...calls]; calls.length = 0; return c; };

// warm the cache so timings stay tight and the token is known
await bot.handleUpdate(msg('private', `/scan ${TOKEN}`, -100));
drain();

// --- groups ---------------------------------------------------------------
await bot.handleUpdate(msg('group', `/scan ${TOKEN}`, -200));
let c = drain();
assert.equal(c.length, 1, `group scan should send exactly one message, sent ${c.length}`);
assert.equal(c[0].method, 'sendMessage');
assert.ok(c[0].payload.text.startsWith('<b>VITALS</b>'), 'group gets the compact card');
assert.ok(c[0].payload.text.split('\n').length <= 8, 'compact card is <=8 lines in a group');
assert.ok(c[0].payload.reply_parameters?.message_id, 'sent as a reply to the triggering message');
assert.equal(c[0].payload.link_preview_options?.is_disabled, true);
assert.ok(c[0].payload.text.includes('via @vitalscheck_bot'), 'compact footer names the bot');
assert.ok(c[0].payload.text.trim().endsWith('not financial advice</i>'), 'footer is last');
ok('group /scan -> single compact card, sent as a reply, no preview, attributed footer');

// supergroup, and the @botname suffix form
await bot.handleUpdate(msg('supergroup', `/scan@vitalscheck_bot ${TOKEN}`, -201));
c = drain();
assert.equal(c.length, 1);
assert.ok(c[0].payload.text.startsWith('<b>VITALS</b>'), '/scan@botname works in a supergroup');
ok('supergroup /scan@botname -> compact card');

// --- the DO NOT rule: no auto-scanning in groups ---------------------------
await bot.handleUpdate(msg('group', `look at ${TOKEN} everyone`, -202));
c = drain();
assert.equal(c.length, 0, `bare address in a group must be ignored, but ${c.length} message(s) were sent`);
ok('bare address in a group -> ignored (no auto-scanning)');

await bot.handleUpdate(msg('supergroup', TOKEN, -203));
c = drain();
assert.equal(c.length, 0, 'bare address in a supergroup must be ignored');
ok('bare address in a supergroup -> ignored');

// --- DM still accepts a bare address ---------------------------------------
await bot.handleUpdate(msg('private', TOKEN, -300));
c = drain();
assert.ok(c.length >= 1, 'bare address in a DM is scanned');
const dmText = c[c.length - 1].payload.text;
assert.ok(dmText.includes('TRACTION'), 'DM gets the FULL card');
assert.ok(dmText.split('\n').length > 8, 'full card is longer than the compact one');
ok('bare address in a DM -> full card');

// --- inline ---------------------------------------------------------------
await bot.handleUpdate(inline(''));
c = drain();
assert.equal(c.length, 1);
assert.equal(c[0].method, 'answerInlineQuery');
assert.equal(c[0].payload.cache_time, 60, 'cache_time is 60');
assert.equal(c[0].payload.is_personal, false, 'is_personal is false');
assert.equal(c[0].payload.results.length, 1, 'empty query returns exactly one article');
assert.match(c[0].payload.results[0].title, /Paste a pons token address/);
ok('inline empty query -> one "Paste a pons token address" article');

await bot.handleUpdate(inline('hello not an address'));
c = drain();
assert.equal(c.length, 1);
assert.equal(c[0].payload.results.length, 1);
assert.match(c[0].payload.results[0].description, /0x.*40 hex/i, 'explains the format');
assert.equal(c[0].payload.results[0].type, 'article', 'an article, not an error');
ok('inline invalid address -> one explanatory article, not an error');

await bot.handleUpdate(inline(TOKEN));
c = drain();
assert.equal(c.length, 1);
const r = c[0].payload.results[0];
assert.equal(r.type, 'article');
assert.match(r.title, /^VITALS — \$/, `title was: ${r.title}`);
assert.ok(r.description.length > 0 && r.description.length <= 120);
assert.ok(r.input_message_content.message_text.startsWith('<b>VITALS</b>'), 'message_text is the compact card');
assert.equal(r.input_message_content.parse_mode, 'HTML');
assert.equal(r.input_message_content.link_preview_options.is_disabled, true);
assert.ok(Buffer.byteLength(r.id) <= 64, `inline result id must be <=64 bytes, was ${Buffer.byteLength(r.id)}`);
ok(`inline valid address -> article "${r.title}" / "${r.description}"`);

// every inline path must answer, or the client spins forever
for (const q of ['', 'garbage', TOKEN, '0x' + '22'.repeat(20)]) {
  await bot.handleUpdate(inline(q));
  const cc = drain();
  assert.equal(cc.length, 1, `query ${JSON.stringify(q)} produced ${cc.length} answers`);
  assert.equal(cc[0].method, 'answerInlineQuery');
  assert.ok(cc[0].payload.results.length >= 1, `query ${JSON.stringify(q)} returned no results`);
  for (const res of cc[0].payload.results) {
    assert.ok(Buffer.byteLength(res.id) <= 64, `id too long for ${JSON.stringify(q)}: ${res.id}`);
  }
}
ok('every inline path answers with at least one result and a valid id');

// --- rate limiting reaches inline too --------------------------------------
const SPAMMER = 4242;
for (let i = 0; i < 12; i++) {
  scanCache.sweep();
  await bot.handleUpdate(inline('0x' + i.toString(16).padStart(2, '0').repeat(20), SPAMMER));
  drain();
}
await bot.handleUpdate(inline('0xdeadbeef' + '11'.repeat(16), SPAMMER));
c = drain();
const rl = c[0].payload.results[0];
assert.match(rl.title + rl.description, /[Rr]ate limited/, `expected a rate-limit article, got: ${rl.title} / ${rl.description}`);
ok(`inline is rate limited too: "${rl.description}"`);

console.log('\nAll handler checks passed.');
process.exit(0);
