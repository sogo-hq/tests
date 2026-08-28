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
  if (method === 'sendPhoto') {
    return { ok: true, result: { message_id: calls.length, chat: { id: payload.chat_id }, date: 0, photo: [] } };
  }
  if (method === 'answerCallbackQuery') return { ok: true, result: true };
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
assert.ok(c[0].payload.text.startsWith('VITALS  '), 'group gets the default card');
assert.ok(c[0].payload.text.split('\n').length <= 12, 'default card is <=12 lines in a group');
assert.equal(c[0].payload.parse_mode, undefined, 'the default card is sent as plain text');
assert.ok(c[0].payload.reply_parameters?.message_id, 'sent as a reply to the triggering message');
assert.equal(c[0].payload.link_preview_options?.is_disabled, true);
assert.ok(c[0].payload.text.trim().endsWith('@vitalscheck_bot · not financial advice'), 'footer names the bot and is last');
ok('group /scan -> single default card, plain text, sent as a reply, attributed footer');

// supergroup, and the @botname suffix form
await bot.handleUpdate(msg('supergroup', `/scan@vitalscheck_bot ${TOKEN}`, -201));
c = drain();
assert.equal(c.length, 1);
assert.ok(c[0].payload.text.startsWith('VITALS  '), '/scan@botname works in a supergroup');
ok('supergroup /scan@botname -> default card');

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
assert.ok(dmText.startsWith('VITALS  '), 'a DM gets the same default card as every other surface');
assert.ok(dmText.split('\n').length <= 12, 'default card is <=12 lines in a DM too');
assert.ok(!/TRACTION/.test(dmText), 'the traction block belongs to /full now');
ok('bare address in a DM -> the same default card');

// --- /full is the only way to the long card ---------------------------------
await bot.handleUpdate(msg('private', `/full ${TOKEN}`, -301));
c = drain();
const fullText = c[c.length - 1].payload.text;
assert.ok(fullText.includes('TRACTION') || fullText.includes('too early for traction'), '/full renders the long card');
assert.ok(fullText.split('\n').length > 12, '/full is longer than the default card');
assert.equal(c[c.length - 1].payload.parse_mode, 'HTML', '/full keeps HTML');
ok('/full -> the long card, unchanged');

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
assert.ok(r.input_message_content.message_text.startsWith('VITALS  '), 'message_text is the default card');
assert.equal(r.input_message_content.parse_mode, undefined, 'inline sends plain text, like every other surface');
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

// --- inline answer caching must not leak per-user state --------------------
{
  await bot.handleUpdate(inline(TOKEN, 8100));
  const good = drain()[0].payload;
  assert.equal(good.cache_time, 60, 'a scan result is shared for 60s, per spec');
  assert.equal(good.is_personal, false);

  // exhaust one user, then check their rate-limit answer is NOT shared
  const VICTIM = 8200;
  for (let i = 0; i < 40; i++) {
    await bot.handleUpdate(inline('0x' + ('b' + i.toString(16).padStart(2, '0')).repeat(13) + 'b', VICTIM));
    drain();
  }
  await bot.handleUpdate(inline('0xfeed' + 'aa'.repeat(18), VICTIM));
  const limited = drain()[0].payload;
  assert.match(limited.results[0].title + limited.results[0].description, /[Rr]ate limited/);
  assert.equal(limited.cache_time, 0, 'a rate-limit answer must not be cached by Telegram');
  assert.equal(limited.is_personal, true, 'a rate-limit answer must not be served to other users');
  ok('inline: scan answers shared (60s), rate-limit answers uncached and personal');
}

// --- rate limiting reaches inline too --------------------------------------
// Not-found scans are refunded, so they cannot exhaust the scan quota by
// design. The flood cap is what bounds this: it counts EVERY request including
// cache hits, which is exactly the replay a single cached card would otherwise
// allow. Re-using one address keeps this fast -- the first is a real scan, the
// rest are cache hits, and the cap must still bite.
const SPAMMER = 4242;
const SPAM_ADDR = '0x' + 'c7'.repeat(20);
let limitedAt = null;
for (let i = 1; i <= 40; i++) {
  await bot.handleUpdate(inline(SPAM_ADDR, SPAMMER));
  const res = drain()[0].payload.results[0];
  if (/[Rr]ate limited/.test(res.title + res.description)) { limitedAt = i; break; }
}
assert.ok(limitedAt, 'inline was never rate limited across 40 requests');
assert.ok(limitedAt > 25 && limitedAt <= 35, `flood cap tripped at request ${limitedAt}, expected ~31`);
ok(`inline is rate limited too: flood cap tripped at request ${limitedAt} (cache hits counted)`);

// --- the image is opt-in, behind a button ----------------------------------
{
  await bot.handleUpdate(msg('private', `/scan ${TOKEN}`, -500));
  const c2 = drain();
  const card = c2[c2.length - 1].payload;
  assert.ok(card.reply_markup, 'the text card carries a button');
  const button = card.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, 'Image');
  assert.ok(button.callback_data.startsWith('img:'));
  assert.ok(Buffer.byteLength(button.callback_data) <= 64, 'callback_data must fit 64 bytes');
  assert.ok(!c2.some((x) => x.method === 'sendPhoto'), 'no image is rendered until asked for');
  ok('text card carries an Image button; nothing rendered automatically');

  // pressing it renders and sends a photo
  await bot.handleUpdate({
    update_id: ++uid,
    callback_query: {
      id: 'cb1', from: { id: 6001, is_bot: false, first_name: 'U' },
      chat_instance: 'x', data: button.callback_data,
      message: { message_id: 999, date: 0, chat: { id: -500, type: 'private' } },
    },
  });
  const c3 = drain();
  assert.ok(c3.some((x) => x.method === 'answerCallbackQuery'), 'the button stops spinning');
  const photo = c3.find((x) => x.method === 'sendPhoto');
  assert.ok(photo, 'pressing the button sends a photo');
  ok('pressing Image renders and sends a PNG');

  // a second press is served from the cache, not re-rendered
  await bot.handleUpdate({
    update_id: ++uid,
    callback_query: {
      id: 'cb2', from: { id: 6002, is_bot: false, first_name: 'U' },
      chat_instance: 'x', data: button.callback_data,
      message: { message_id: 999, date: 0, chat: { id: -500, type: 'private' } },
    },
  });
  const c4 = drain();
  assert.ok(c4.find((x) => x.method === 'sendPhoto'), 'second press also sends');
  ok('a second press reuses the cached render');
}

// --- /full has no button: it is not the forwardable card --------------------
await bot.handleUpdate(msg('private', `/full ${TOKEN}`, -501));
{
  const c5 = drain();
  assert.ok(!c5[c5.length - 1].payload.reply_markup, '/full carries no image button');
  ok('/full carries no image button');
}

// --- /stats renders and is valid HTML --------------------------------------
await bot.handleUpdate(msg('private', '/stats', -400));
c = drain();
assert.equal(c.length, 1, '/stats replies once');
const stats = c[0].payload.text;
assert.match(stats, /^launches indexed [\d,]+$/m);
assert.match(stats, /^launches with pre-exempted wallets [\d,]+ \(/m);
assert.match(stats, /^median hold time of exempted wallets /m);
assert.match(stats, /^scans served [\d,]+$/m);
assert.equal(stats.split('\n').length, 4, '/stats is four counter lines and nothing else');
assert.ok(!/<[a-z/]/i.test(stats), '/stats is plain text');
ok('/stats renders four public counters, numbers only');

// --- /help renders ----------------------------------------------------------
await bot.handleUpdate(msg('private', '/help', -401));
c = drain();
assert.equal(c.length, 1);
const help = c[0].payload.text;
assert.ok(help.includes('@vitalscheck_bot'), '/help names the bot for inline usage');
assert.ok(!help.includes('BOTNAME'), 'BOTNAME placeholder substituted');
// plain text: no parse_mode, so any tag would render literally and any entity
// would survive a copy-paste as "&lt;"
assert.equal(c[0].payload.parse_mode, undefined, '/help is sent as plain text');
// actual HTML tags, not the literal angle brackets in "/scan <token address>"
const htmlTag = /<\/?(b|i|u|s|a|em|strong|code|pre|span|tg-spoiler)\b[^>]*>/i;
assert.ok(!htmlTag.test(help), `/help still carries markup: ${help.match(htmlTag)?.[0]}`);
assert.ok(!/&(amp|lt|gt|quot);/.test(help), '/help carries an HTML entity');
assert.ok(help.includes('/scan <token address>'), 'angle brackets survive as themselves');
// the contact block, last and unlinked — Telegram autolinks bare handles
const tail = help.trimEnd().split('\n').slice(-3);
assert.deepEqual(tail, [
  'checkvitals.xyz',
  '@vitalsofficial — every change lands here first',
  "@siriusthemaster — dev, tell me what's broken",
]);
assert.equal(c[0].payload.link_preview_options?.is_disabled, true, 'the domain must not spawn a preview card');
ok('/help is plain text and ends with the contact block');

console.log('\nAll handler checks passed.');
process.exit(0);
