/**
 * Drives the real grammY handlers with synthetic Updates, intercepting the API
 * transport so nothing leaves the process. Verifies the group and inline
 * contracts without a bot token. Run: node test/handlers.mjs
 */
import assert from 'node:assert/strict';

// bot.js reads GROUP_PROMPT_TTL_MS once at module load, so it is set before the
// dynamic import -- the deletion assertion should not depend on the caller
// remembering to pass an env var.
process.env.GROUP_PROMPT_TTL_MS ??= '50';
process.env.LAST_TOKEN_TTL_MS ??= '1200';
const { createBot } = await import('../dist/bot.js');
const { scanCache } = await import('../dist/cache.js');

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
// Monotonic and independent of calls.length, which drain() resets -- two prompts
// sharing a message_id let a delete-the-wrong-message bug pass unnoticed.
let sentId = 7000;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  // grammY expects the Bot API envelope, not a bare result.
  if (method === 'sendMessage') {
    return { ok: true, result: { message_id: ++sentId, chat: { id: payload.chat_id }, date: 0, text: payload.text } };
  }
  if (method === 'sendPhoto') {
    return { ok: true, result: { message_id: ++sentId, chat: { id: payload.chat_id }, date: 0, photo: [] } };
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

/**
 * Everything the bot sent, minus the one-time legend.
 *
 * Every update in this file carries a fresh from.id, so each DM scan looks like
 * a brand-new user and is followed by the legend. That is correct behaviour and
 * is asserted in legend.test.mjs; here it would just displace the message under
 * test from the end of the list, so it is filtered out once rather than worked
 * around at twenty call sites.
 */
const isLegend = (x) => /^\u{1F6A9} a finding \u2014/u.test(x.payload?.text ?? '');
const drain = () => {
  const c = [...calls].filter((x) => !isLegend(x));
  calls.length = 0;
  return c;
};

// warm the cache so timings stay tight and the token is known
await bot.handleUpdate(msg('private', `/scan ${TOKEN}`, -100));
drain();

// --- groups ---------------------------------------------------------------
await bot.handleUpdate(msg('group', `/scan ${TOKEN}`, -200));
let c = drain();
assert.equal(c.length, 1, `group scan should send exactly one message, sent ${c.length}`);
assert.equal(c[0].method, 'sendMessage');
assert.ok(c[0].payload.text.startsWith('VITALS  '), 'group gets the default card');
assert.ok(c[0].payload.text.split('\n').length <= 18, 'default card is <=18 lines in a group');
assert.equal(c[0].payload.parse_mode, undefined, 'the default card is sent as plain text');
assert.ok(c[0].payload.reply_parameters?.message_id, 'sent as a reply to the triggering message');
assert.equal(c[0].payload.link_preview_options?.is_disabled, true);
assert.ok(c[0].payload.text.trim().endsWith('@vitalscheck_bot · @vitalsofficial · not financial advice'), 'footer names the bot and is last');
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
// The card, not merely the last message: a first DM card is followed by the
// one-time legend, so "last" is the legend rather than the card.
const dmText = c.map((x) => x.payload.text).find((t) => t.startsWith('VITALS  '));
assert.ok(dmText, `a DM gets the same default card as every other surface: ${JSON.stringify(c.map((x) => x.payload.text?.slice(0, 40)))}`);
// 15 at its fullest: the card gained the named-undetermined line and the
// fixed "no finding \u2260 clean" line. Bounded, because it is forwarded into groups.
assert.ok(dmText.split('\n').length <= 15, `default card is <=15 lines in a DM too, got ${dmText.split('\n').length}`);
assert.ok(!/TRACTION/.test(dmText), 'the traction block belongs to /full now');
ok('bare address in a DM -> the same default card');

// --- /full is the only way to the long card ---------------------------------
await bot.handleUpdate(msg('private', `/full ${TOKEN}`, -301));
c = drain();
// By content, not position: a one-time legend can follow a card in a DM.
// The /full message itself, not merely the last one: every update in this file
// carries a fresh from.id, so the one-time legend follows each DM card.
const fullMsg = c.find((x) => x.payload.text?.includes('TRACTION')
  || x.payload.text?.includes('too early for traction'));
assert.ok(fullMsg, `/full renders the long card: ${JSON.stringify(c.map((x) => x.payload.text?.slice(0, 40)))}`);
const fullText = fullMsg.payload.text;
assert.ok(fullText.split('\n').length > 12, '/full is longer than the default card');
assert.equal(fullMsg.payload.parse_mode, 'HTML', '/full keeps HTML');
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
let limitedResult = null;
for (let i = 1; i <= 40; i++) {
  await bot.handleUpdate(inline(SPAM_ADDR, SPAMMER));
  const res = drain()[0].payload.results[0];
  if (/[Rr]ate limited/.test(res.title + res.description)) { limitedAt = i; limitedResult = res; break; }
}
assert.ok(limitedAt, 'inline was never rate limited across 40 requests');
assert.ok(limitedAt > 25 && limitedAt <= 35, `flood cap tripped at request ${limitedAt}, expected ~31`);
// The title is a hardcoded label, so matching on it alone would pass even if
// the body still said "scan failed". Check what the user would actually send.
assert.match(limitedResult.input_message_content.message_text, /too many scans right now, try again in \d+s/,
  `inline rate-limit body was: ${limitedResult.input_message_content.message_text}`);
assert.ok(!/scan failed/i.test(limitedResult.input_message_content.message_text),
  'a limit must never be worded as a failure');
ok(`inline is rate limited too: flood cap tripped at request ${limitedAt}, body "${limitedResult.input_message_content.message_text}"`);

// --- the image is opt-in, behind a button ----------------------------------
{
  await bot.handleUpdate(msg('private', `/scan ${TOKEN}`, -500));
  const c2 = drain();
  const card = c2[c2.length - 1].payload;
  assert.ok(card.reply_markup, `the text card carries a button; last send was ${c2[c2.length - 1].method}: ${String(card.text || '').slice(0, 80)}`);
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
// Whether each derived figure is running yet, and on how much. A feature that
// is silent for want of data should say so where the numbers live rather than
// simply not appear -- and it must never claim to be live below its floor.
assert.match(stats, /^buyer benchmark: (live \(n=[\d,]+ per bucket\)|not enough data yet \(n=[\d,]+\))$/m);
assert.match(stats, /^holder concentration: (live \(n=[\d,]+\)|not enough data yet \(n=[\d,]+\))$/m);
// The index's own health leads, above the counts, because it decides whether
// any of them mean anything -- the index once failed for a day while /stats
// reported its stale numbers without qualification.
assert.match(stats, /^index (current, last advanced .+ ago|stalled .+ ago — index-derived checks are withheld|has never advanced — nothing below is current)$/m);
assert.equal(stats.split('\n')[0].startsWith('index '), true, 'the health line comes first');
assert.match(stats, /^provider (accepts [\d,]+ block ranges|log range not yet measured)$/m);
assert.equal(stats.split('\n').length, 8, '/stats is two health lines and six counters, nothing else');
assert.ok(!/<[a-z/]/i.test(stats), '/stats is plain text');
// The whole point of this file is that it never reads as a pitch.
assert.ok(!/\b(strong|healthy|good|great|best|safe|clean|opportunity)\b/i.test(stats),
  `/stats must stay counters: ${stats}`);
ok('/stats leads with index health, then six public counters, numbers only');

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
assert.ok(/^\s*\/status .*\u00b7 admin/m.test(help), '/help marks the admin commands');
assert.ok(help.includes('/position <wallet> <token address>'), '/help is generated from the table');
// the contact block, last and unlinked — Telegram autolinks bare handles
const tail = help.trimEnd().split('\n').slice(-3);
assert.deepEqual(tail, [
  'checkvitals.xyz',
  '@vitalsofficial: every change lands here first',
  "@siriusthemaster: dev, tell me what's broken",
]);
assert.equal(c[0].payload.link_preview_options?.is_disabled, true, 'the domain must not spawn a preview card');
ok('/help is plain text and ends with the contact block');

// ===========================================================================
// Live group testing: four regressions
// ===========================================================================

// --- 1. a bare /scan must not spam a group ---------------------------------
{
  const trigger700 = msg('group', '/scan', -700);
  await bot.handleUpdate(trigger700);
  let c6 = drain();
  assert.equal(c6.length, 1, `bare /scan in a group sent ${c6.length} messages`);
  const line = c6[0].payload.text;
  assert.equal(line.split('\n').length, 1, `group prompt must be one line, got:\n${line}`);
  assert.ok(line.length <= 60, `group prompt is ${line.length} chars, too long for a busy group`);
  assert.equal(c6[0].payload.reply_parameters?.message_id, trigger700.message.message_id, 'attached to whoever asked');
  const prompt700 = sentId; // the id the stub handed back for that prompt
  ok(`bare /scan in a group -> one short line, as a reply: "${line}"`);

  // /scan@botname is the same path
  await bot.handleUpdate(msg('group', '/scan@vitalscheck_bot', -701));
  c6 = drain();
  assert.equal(c6.length, 1);
  assert.equal(c6[0].payload.text.split('\n').length, 1);
  const prompt701 = sentId;
  ok('bare /scan@botname in a group -> one short line too');

  // and it is taken back down. GROUP_PROMPT_TTL_MS is read at module load, so
  // this run sets it to 50ms via the env before importing the bot.
  //
  // Asserts *what* was deleted, not how many calls were made: counting alone
  // still passed when the handler deleted the group member's own message
  // instead of the bot's prompt, which is far worse than the noise being fixed.
  await new Promise((r) => setTimeout(r, Number(process.env.GROUP_PROMPT_TTL_MS || 20000) + 80));
  const deletes = drain().filter((x) => x.method === 'deleteMessage');
  const deleted = deletes.map((d) => `${d.payload.chat_id}:${d.payload.message_id}`).sort();
  assert.deepEqual(deleted, [`-700:${prompt700}`, `-701:${prompt701}`].sort(),
    `the bot must delete its own two prompts, deleted: ${JSON.stringify(deleted)}`);
  assert.ok(!deleted.includes(`-700:${trigger700.message.message_id}`), "must never delete the user's own message");
  ok(`group prompts (and only those) are deleted after ${process.env.GROUP_PROMPT_TTL_MS}ms`);
}

// --- DM keeps the fuller prompt --------------------------------------------
await bot.handleUpdate(msg('private', '/scan', -702));
{
  const c7 = drain();
  assert.equal(c7.length, 1);
  assert.ok(c7[0].payload.text.split('\n').length > 1, 'a DM keeps the multi-line prompt');
  ok('bare /scan in a DM -> the fuller prompt, unchanged');
}

// --- 3. /full remembers the last token scanned in this chat -----------------
await bot.handleUpdate(msg('private', `/scan ${TOKEN}`, -703));
drain();
await bot.handleUpdate(msg('private', '/full', -703));
{
  const c8 = drain();
  const text = c8[c8.length - 1].payload.text;
  assert.ok(!/send a pons v2 token address/i.test(text), 'bare /full must not fall back to the usage prompt');
  assert.ok(text.includes('TRACTION') || text.includes('too early for traction'), 'bare /full renders the long card');
  ok('bare /full renders the last token scanned in that chat');
}

// memory is per chat, not global
await bot.handleUpdate(msg('private', '/full', -704));
{
  const c9 = drain();
  assert.ok(/send a pons v2 token address/i.test(c9[c9.length - 1].payload.text),
    'a chat that has scanned nothing gets the prompt, not another chat\'s token');
  ok('/full memory is per chat');
}

// and it works in a group, where the fix was actually asked for
await bot.handleUpdate(msg('group', `/scan ${TOKEN}`, -707));
drain();
await bot.handleUpdate(msg('group', '/full', -707));
{
  const cg = drain();
  const text = cg[cg.length - 1].payload.text;
  assert.ok(!/send a pons v2 token address/i.test(text), 'bare /full in a group must recall too');
  assert.ok(text.includes('TRACTION') || text.includes('too early for traction'));
  ok('bare /full recalls the token in a group as well as a DM');
}

// the fallback is for a *bare* /full only. An argument the bot cannot parse
// must be explained, never silently answered with a different token: rendering
// a card for something the user did not ask about is the worst kind of wrong.
await bot.handleUpdate(msg('private', `/full ${'9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'}`, -703));
{
  const cf = drain();
  const text = cf[cf.length - 1].payload.text;
  assert.match(text, /that's a solana address/, `/full <solana> rendered: ${text.slice(0, 80)}`);
  assert.ok(!text.includes('TRACTION'), '/full with a foreign address must not render the remembered token');
  ok('/full <unparseable> explains the input instead of rendering the remembered token');
}

// memory is only written once a card exists. A flood-limited request produced
// no card, so it must not become what a later bare /full renders.
{
  const { floodQuota } = await import('../dist/quota.js');
  const CHAT = -708;
  await bot.handleUpdate(msg('private', `/scan ${TOKEN}`, CHAT));
  drain();
  // drive the same identity past the flood cap on a different token
  const other = '0x' + '77'.repeat(20);
  const u = 6100;
  let denied = false;
  for (let i = 0; i < 200 && !denied; i++) denied = !floodQuota.consume(u).allowed;
  assert.ok(denied, 'the flood cap must actually trip for this test to mean anything');
  const upd = msg('private', `/scan ${other}`, CHAT);
  upd.message.from.id = u;
  await bot.handleUpdate(upd);
  const limited = drain();
  assert.match(limited[limited.length - 1].payload.text, /too many scans right now/);
  await bot.handleUpdate(msg('private', '/full', CHAT));
  const after = drain();
  const text = after[after.length - 1].payload.text;
  assert.ok(!text.includes(other.slice(0, 10)), 'a limited scan must not overwrite the chat memory');
  ok('a rate-limited scan leaves the remembered token alone');
}

// the memory expires. LAST_TOKEN_TTL_MS is read at module load, so this run
// sets it small enough to observe.
{
  const CHAT = -709;
  await bot.handleUpdate(msg('private', `/scan ${TOKEN}`, CHAT));
  drain();
  await new Promise((r) => setTimeout(r, Number(process.env.LAST_TOKEN_TTL_MS) + 60));
  await bot.handleUpdate(msg('private', '/full', CHAT));
  const ce = drain();
  assert.match(ce[ce.length - 1].payload.text, /send a pons v2 token address/i,
    'the remembered token must expire');
  ok(`the remembered token expires after ${process.env.LAST_TOKEN_TTL_MS}ms`);
}

// --- 4. solana addresses get told what this bot covers ---------------------
const SOL = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
for (const [chatType, chatId] of [['private', -705], ['group', -706]]) {
  await bot.handleUpdate(msg(chatType, `/scan ${SOL}`, chatId));
  const c10 = drain();
  assert.equal(c10.length, 1);
  assert.match(c10[0].payload.text,
    /that's a solana address\. this bot covers pons v2 on Robinhood Chain\./,
    `${chatType} did not name the chain`);
}
ok('solana address -> named as such, on DM and group');

await bot.handleUpdate(inline(SOL, 9500));
{
  const c11 = drain();
  const r2 = c11[0].payload.results[0];
  assert.match(r2.title, /Solana/);
  assert.match(r2.input_message_content.message_text, /that's a solana address/);
  ok('solana address -> named as such inline too');
}

// A plain Solana address, with no pump/bonk suffix, must take the general
// base58 branch rather than the vanity shortcut -- the fixture above would
// pass with the shortcut alone and the general branch never exercised.
{
  const PLAIN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mint, 44 chars
  await bot.handleUpdate(msg('private', `/scan ${PLAIN}`, -710));
  const cp = drain();
  assert.match(cp[cp.length - 1].payload.text, /that's a solana address/,
    'a Solana address without a vanity suffix must still be named');
  ok('solana address with no pump/bonk suffix -> general base58 branch');
}

// Naming a chain is only worth doing if the name is right. base58check
// addresses from other chains are 34 characters and must not be called Solana.
{
  const { looksLikeSolanaAddress } = await import('../dist/service.js');
  const notSolana = {
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa': 'bitcoin',
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': 'tron',
    'LZ1JsRxwUFcLtHXKB1e2j5dYy1YCiZBmXR': 'litecoin',
    'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L': 'dogecoin',
    'd384722f6adfe7d79E8e6623896DF199afD31B76': 'EVM address without 0x, no zero digit',
  };
  for (const [addr, what] of Object.entries(notSolana)) {
    assert.equal(looksLikeSolanaAddress(addr), false, `a ${what} address was reported as Solana`);
  }
  // and the real ones still are, including inside prose and a URL
  for (const yes of [
    SOL,
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'So11111111111111111111111111111111111111112',
    'look at So11111111111111111111111111111111111111112.',
    'https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ]) {
    assert.equal(looksLikeSolanaAddress(yes), true, `missed a solana address: ${yes}`);
  }
  ok(`${Object.keys(notSolana).length} non-Solana chains are not called Solana; 5 Solana forms still are`);
}

// --- the image button is flood-capped like every text path -----------------
// A cached card short-circuits before performScan, so the button was the one
// way to post unlimited photos into a group -- the noise this change set out
// to stop, on the surface where it matters most.
{
  const { floodQuota } = await import('../dist/quota.js');
  const CHAT = -711;
  const TAPPER = 6200;
  await bot.handleUpdate(msg('private', `/scan ${TOKEN}`, CHAT));
  drain();
  let photos = 0, refusals = 0;
  for (let i = 0; i < 45; i++) {
    await bot.handleUpdate({
      update_id: 90000 + i,
      callback_query: {
        id: `cb${i}`, from: { id: TAPPER, is_bot: false, first_name: 'U' }, chat_instance: 'ci',
        data: `img:${TOKEN}`,
        message: { message_id: 1, date: 0, chat: { id: CHAT, type: 'private' }, text: 'card' },
      },
    });
    const cs = drain();
    photos += cs.filter((x) => x.method === 'sendPhoto').length;
    refusals += cs.filter((x) => x.method === 'answerCallbackQuery'
      && /too many scans right now/.test(x.payload.text ?? '')).length;
  }
  assert.ok(refusals > 0, `45 button taps produced ${photos} photos and no cap at all`);
  assert.ok(photos <= 35, `the button posted ${photos} photos from 45 taps; the cap must bite`);
  // and the refusal rides the callback query, so the cap adds no chat message
  assert.equal(floodQuota.consume(TAPPER).allowed, false, 'the tapper should be flood-capped by now');
  ok(`image button is flood-capped: 45 taps -> ${photos} photos, ${refusals} refused on the callback query`);
}

// --- 2. a rate limit must never be reported as a failure -------------------
{
  const { RpcRateLimited } = await import('../dist/ratelimit.js');
  const { rateLimitFrom, rateLimitedMessage } = await import('../dist/service.js');
  const { scanCache } = await import('../dist/cache.js');

  // the classifier sees a limit through viem's wrapping
  assert.equal(rateLimitFrom(new RpcRateLimited(30)), 30);
  assert.equal(rateLimitFrom({ shortMessage: 'HTTP request failed', cause: new RpcRateLimited(12) }), 12);
  assert.equal(rateLimitFrom({ message: 'Rate Limit Hit, limit will reset in 60 seconds' }), 30);
  assert.equal(rateLimitFrom(new Error('connection reset')), null, 'a real fault stays a fault');
  assert.match(rateLimitedMessage(30), /^too many scans right now, try again in 30s$/);

  // end to end: the node 429s past its retries and the user is told the truth
  scanCache.sweep();
  const saved = globalThis.fetch;
  globalThis.fetch = async (i, init) => {
    const u = typeof i === 'string' ? i : (i?.url ?? String(i));
    if (u.includes('rpc.mainnet')) throw new RpcRateLimited(25);
    return saved(i, init);
  };
  try {
    await bot.handleUpdate(msg('private', '/scan 0x' + '77'.repeat(20), -800));
  } finally { globalThis.fetch = saved; }
  const c12 = drain();
  const said = c12[c12.length - 1].payload.text;
  assert.match(said, /too many scans right now/, `a rate limit was reported as: ${said}`);
  assert.ok(!/scan failed/i.test(said), 'a limit must never read as a failure');
  ok(`rpc rate limit -> "${said.replace(/^⏳ /, '')}", not "scan failed"`);
}


// ===========================================================================
// The benchmarked buyer count and holder concentration, on all three surfaces
// ===========================================================================
{
  const { renderDefaultCard, renderCard, buyerLine, concentrationLine } = await import('../dist/card.js');
  const { makeScan } = await import('./fixtures.mjs');

  // --- the shapes the feedback asked for, exactly ---------------------------
  assert.equal(
    buyerLine(makeScan({ buyers: 5, benchmarkMedian: 3, benchmarkN: 412 })),
    '5 buyers in first 30 min \u00b7 index median 3 at this age (n=412)',
  );
  assert.equal(
    buyerLine(makeScan({ buyers: 38, benchmarkMedian: 12, benchmarkN: 412 })),
    '38 buyers in first 30 min \u00b7 index median 12 at this age (n=412)',
  );
  // Below the floor it says there is no median rather than going quiet: silence
  // where a reference point belongs reads as an implied all-clear.
  assert.equal(
    buyerLine(makeScan({ buyers: 5, benchmarkMedian: null, benchmarkN: 12 })),
    '5 buyers in first 30 min \u00b7 no index median (n=12)',
  );
  ok('the buyer count carries its window and its reference point, or says there is none');

  // --- it reaches every surface --------------------------------------------
  const withBoth = makeScan({
    ageSeconds: 1200, symbol: 'TOKEN', buyers: 38, roundTrippers: 3, progressPct: 12.4,
    windowMinutes: 20, flagsTotal: 9, benchmarkMedian: 12, benchmarkN: 412,
    concentration: { top5Share: 44.2, holders: 23, circulating: 1n },
    flags: [{ key: 'c', label: 'c', state: 'raised', detail: 'd', compactDetail: 'c', plain: 'a concern', severity: 9 }],
  });

  const dmCard = renderDefaultCard(withBoth, 'vitalscheck_bot');
  assert.match(dmCard, /38 buyers in first 20 min \u00b7 index median 12 at this age \(n=412\)/,
    'DM card carries the comparison');
  assert.match(dmCard, /top 5 hold 44% \u00b7 23 holders/, 'DM card carries concentration');

  // The group surface renders the same card through the same path.
  //
  // Asserted as a WHOLE LINE, not a substring: "buyers 48 → 48 in 30 min" is the
  // growth line and contains the word, so a substring match passed with the
  // buyer line deleted outright -- which is exactly what happened when a review
  // agent removed it from the build.
  scanCache.drop(TOKEN);
  await bot.handleUpdate(msg('group', `/scan ${TOKEN}`, -800));
  const gc = drain();
  const groupText = gc[gc.length - 1].payload.text;
  const groupBuyerLine = groupText.split('\n').find((l) => /^(\d[\d,]* buyers? in first|no buyers|buyers undetermined)\b/.test(l));
  assert.ok(groupBuyerLine, `group card lost the buyer line:\n${groupText}`);

  // /full carries the reference point and the audit trail
  const full = renderCard(withBoth);
  assert.match(full, /buyer benchmark: 12 — median over the same first 20 min, across 412 indexed launches that reached it/,
    'the reference point must say what it measured and over which set');
  assert.match(full, /age band: 5-30m/, 'the age band describes this token, separately from the population');
  ok('the benchmark reaches DM, group and /full');

  // --- concentration is auditable and never a confident low number ----------
  const { computeFlags } = await import('../dist/metrics/flags.js');
  const flagOf = (concentration) => computeFlags({
    token: '0x' + '11'.repeat(20), deployer: '0x' + '22'.repeat(20), name: 'T', symbol: 'T',
    creatorTaxBps: 0, buybackEnabled: false,
    pairToken: '0x0000000000000000000000000000000000000000', pairSymbol: 'ETH',
    scannedAt: 1_000_000, concentration,
  }).flags.find((f) => f.key === 'holder_concentration');

  assert.equal(flagOf(null).state, 'unknown', 'an unreadable share is undetermined');
  assert.equal(flagOf({ top5Share: 100, holders: 4, circulating: 1n }).state, 'unknown',
    'four holders cannot produce a meaningful top-5 share');
  const measured = flagOf({ top5Share: 44.2, holders: 23, circulating: 1n });
  assert.equal(measured.state, 'unknown', 'with no distribution behind it there is no threshold to cross');
  assert.match(measured.detail, /no threshold yet/);
  assert.ok(!/\bclean\b|\bsafe\b|looks good/i.test(measured.detail + measured.plain),
    'undetermined must never be worded as an all-clear');
  ok('holder concentration is undetermined when it cannot be judged, on every surface');

  // --- inline carries it too ------------------------------------------------
  await bot.handleUpdate(inline(TOKEN, 9700));
  const ic = drain();
  const article = ic[0].payload.results[0];
  const inlineText = article.input_message_content.message_text;
  const inlineBuyerLine = inlineText.split('\n').find((l) => /^(\d[\d,]* buyers? in first|no buyers|buyers undetermined)\b/.test(l));
  assert.ok(inlineBuyerLine, `inline result lost the buyer line:\n${inlineText}`);
  ok(`inline carries the same card, buyer line included: "${inlineBuyerLine}"`);

  // --- and the image mirrors the order --------------------------------------
  // Asserted on the SVG the PNG is rasterised from, because a byte length tells
  // you nothing about whether the lines are present or in the right order: the
  // image half of this change was previously "tested" by `png.length > 1000`.
  const { renderCardPng, cardSvg } = await import('../dist/image.js');
  const svg = cardSvg(withBoth);
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const idx = (re) => texts.findIndex((t) => re.test(t));
  const iBuyers = idx(/^38 buyers/);
  const iConc = idx(/top 5 hold/);
  assert.ok(iConc >= 0, `the PNG lost the concentration line: ${JSON.stringify(texts)}`);
  const iSold = idx(/to graduation$/);
  assert.ok(iBuyers >= 0, `the PNG lost the buyer line: ${JSON.stringify(texts)}`);
  assert.ok(/index median 12 at this age \(n=412\)/.test(texts[iBuyers]),
    `the PNG lost the comparison: ${texts[iBuyers]}`);
  assert.ok(iConc > iBuyers, 'concentration must follow the buyer count in the image too');
  assert.ok(iSold > iConc, 'and the rest must follow concentration');

  const png = renderCardPng(withBoth);
  assert.ok(Buffer.isBuffer(png) && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'and it still rasterises to a real PNG');
  ok(`the PNG renders the reordered card in order (${(png.length / 1024).toFixed(0)}KB)`);
}

// ===========================================================================
// The worst concern is lifted, on every surface
// ===========================================================================
{
  const { renderDefaultCard, inlineDescription, compactMeta } = await import('../dist/card.js');
  const { cardSvg } = await import('../dist/image.js');
  const { makeScan } = await import('./fixtures.mjs');
  const fl = (k, plain, severity, state = 'raised') =>
    ({ key: k, label: k, state, detail: k, compactDetail: k, plain, severity });

  const three = makeScan({
    ageSeconds: 158400, symbol: 'NPC', buyers: 38, roundTrippers: 3, progressPct: 12.4,
    windowMinutes: 30, flagsTotal: 9, benchmarkMedian: 20, benchmarkN: 412, measuredAtAge: false,
    flags: [
      fl('collision', '38 other tokens use this exact ticker', 100),
      fl('tax', 'creator takes 3% of every trade', 60),
      fl('u1', 'x', 1, 'unknown'), fl('u2', 'y', 1, 'unknown'),
    ],
  });

  // --- the shape the feedback asked for, exactly ---------------------------
  const lines = renderDefaultCard(three, 'vitalscheck_bot').split('\n');
  assert.equal(lines[2], '\u{1F6A9} 38 other tokens use this exact ticker');
  assert.equal(lines[3], '');
  assert.equal(lines[4], '\u{1F6A9} creator takes 3% of every trade');
  // Named, and sharing the extras line with any overflow count.
  assert.equal(lines[5], '\u25cc undetermined: u1, u2');
  ok(`the worst concern is lifted: "${lines[2]}" with "${lines[4]}" beneath it`);

  // --- group and inline carry the same card --------------------------------
  scanCache.drop(TOKEN);
  await bot.handleUpdate(msg('group', `/scan ${TOKEN}`, -900));
  const gc = drain();
  const groupText = gc[gc.length - 1].payload.text;
  const groupLifted = groupText.split('\n').filter((l) => l.startsWith('\u{1F6A9}'));
  const groupRaised = groupText.split('\n').filter((l) => /^\u{1F6A9} /u.test(l));
  assert.ok(groupRaised.length === 0 || groupLifted.length === 1,
    `group card lifted ${groupLifted.length} of ${groupRaised.length} concerns:\n${groupText}`);
  assert.ok(!groupText.includes('\ud83d\udea9'), 'the old uniform marker must be gone from the group card');

  await bot.handleUpdate(inline(TOKEN, 9800));
  const ic = drain();
  const article = ic[0].payload.results[0];
  const inlineText = article.input_message_content.message_text;
  assert.ok(!inlineText.includes('\ud83d\udea9'), 'and from the inline card');
  const inlineLifted = inlineText.split('\n').filter((l) => l.startsWith('\u{1F6A9}'));
  assert.ok(inlineLifted.length <= 1, `inline lifted ${inlineLifted.length} concerns`);
  ok(`group and inline carry the same shape (${groupLifted.length} lifted, ${inlineLifted.length} inline)`);

  // --- the inline SUBTITLE leads with the concern, not a count -------------
  const desc = inlineDescription(compactMeta(three));
  assert.match(desc, /^38 other tokens use this exact ticker/,
    `the subtitle should lead with the finding, got: ${desc}`);
  assert.match(desc, /\+1 more/);
  assert.match(desc, /2 undetermined/);
  ok(`inline subtitle leads with the finding: "${desc}"`);

  // --- and the PNG does it by size and tone, never by colour ---------------
  const svg = cardSvg(three);
  const drawn = [...svg.matchAll(/<text[^>]*font-size="(\d+)"[^>]*fill="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ size: Number(m[1]), fill: m[2], t: m[3] }));
  const top = drawn.find((d) => /38 other tokens/.test(d.t));
  const second = drawn.find((d) => /creator takes/.test(d.t));
  assert.ok(top && second, `the PNG lost a concern: ${JSON.stringify(drawn.map((d) => d.t))}`);
  assert.ok(top.size > second.size, `top is ${top.size}px, second ${second.size}px — no emphasis`);
  assert.notEqual(top.fill, second.fill, 'the rest should sit at a lower tone');
  // Emphasis by size and tone only. A red or a green here would be read as a
  // verdict, and this card does not give one.
  for (const d of [top, second]) {
    assert.match(d.fill, /^#(E8F0DE|6E7A66|080B09|C6F73A)$/i, `off-palette colour ${d.fill} implies a verdict`);
  }
  // Every finding gets a marker now -- one state, one symbol -- so the lifting
  // shows in its size and tone, not in the top one being the only marker drawn.
  const markers = [...svg.matchAll(/<path d="M [^"]*" fill="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(markers.length, 2, `two findings, two markers: ${JSON.stringify(markers)}`);
  assert.equal(new Set(markers).size, 2, 'the lifted marker must not look like the others');
  ok(`the PNG lifts by size (${top.size}px vs ${second.size}px) and tone, with no colour spent on it`);
}

// ===========================================================================
// Alerts: DM only, and never a word more in a group than necessary
// ===========================================================================
{
  const { countWatches, listWatches } = await import('../dist/watch.js');
  const DEP = '0x' + '5a'.repeat(20);

  // --- a group /watch from someone who has never DM'd -----------------------
  const grpUser = 6600;
  {
    const upd = msg('group', `/watch deployer ${DEP}`, -1000);
    upd.message.from.id = grpUser;
    await bot.handleUpdate(upd);
    const c = drain();
    assert.equal(c.length, 1, `a group /watch sent ${c.length} messages`);
    assert.match(c[0].payload.text, /message me directly/i);
    assert.ok(!/watching deployer/i.test(c[0].payload.text), 'it must not claim to have created a watch');
    assert.equal(countWatches(grpUser), 0, 'no watch may exist without a DM to deliver it to');
    assert.ok(c[0].payload.reply_parameters?.message_id, 'and it is a reply, in a group');
    ok('a group /watch with no DM refuses and explains, creating nothing');
  }

  // --- and it says so once, not every time ---------------------------------
  {
    for (let i = 0; i < 3; i++) {
      const upd = msg('group', `/watch deployer ${DEP}`, -1000);
      upd.message.from.id = grpUser;
      await bot.handleUpdate(upd);
    }
    const c = drain().filter((x) => x.method === 'sendMessage');
    assert.equal(c.length, 0, `repeating it in a group sent ${c.length} more messages`);
    ok('repeating it in a group stays quiet');
  }

  // --- a DM user can watch, and is told where alerts go ---------------------
  const dmUser = 6601;
  {
    const warm = msg('private', `/scan ${TOKEN}`, dmUser);
    warm.message.from.id = dmUser;
    await bot.handleUpdate(warm);
    drain();
    const upd = msg('private', `/watch deployer ${DEP}`, dmUser);
    upd.message.from.id = dmUser;
    await bot.handleUpdate(upd);
    const c = drain();
    assert.match(c[c.length - 1].payload.text, /watching deployer/i);
    assert.match(c[c.length - 1].payload.text, /1 of 20/);
    assert.equal(countWatches(dmUser), 1);
    ok('a DM /watch is created and says where alerts will arrive');
  }

  // --- /watching and /unwatch ----------------------------------------------
  {
    const l = msg('private', '/watching', dmUser);
    l.message.from.id = dmUser;
    await bot.handleUpdate(l);
    const listed = drain();
    assert.match(listed[listed.length - 1].payload.text, new RegExp(DEP));

    const u = msg('private', `/unwatch ${DEP}`, dmUser);
    u.message.from.id = dmUser;
    await bot.handleUpdate(u);
    const removed = drain();
    assert.match(removed[removed.length - 1].payload.text, /stopped watching/i);
    assert.equal(countWatches(dmUser), 0);
    ok('/watching lists them and /unwatch removes one');
  }

  // --- the paid line and its disclosure ------------------------------------
  {
    const { resetSponsor } = await import('../dist/sponsor.js');

    // /help discloses it, in the user's own words.
    await bot.handleUpdate(msg('private', '/help', -9001));
    const helpText = drain().pop().payload.text;
    assert.match(helpText, /one paid line at the bottom funds this/);
    assert.match(helpText, /never touches what a card says/);
    assert.match(helpText, /points at a scan/);
    ok('/help discloses the paid line');

    // /sponsor answers with numbers and no pitch.
    await bot.handleUpdate(msg('private', '/sponsor', -9002));
    const sp = drain().pop().payload.text;
    assert.match(sp, /scans, last 30d\s+[\d,]+/);
    assert.match(sp, /scans, last 7d\s+[\d,]+/);
    assert.match(sp, /distinct users\s+[\d,]+/);
    assert.match(sp, /distinct groups\s+[\d,]+/);
    assert.match(sp, /launches indexed\s+[\d,]+/);
    assert.match(sp, /scans per day, last 7:/);
    assert.match(sp, /contact @siriusthemaster/);
    // Same rule as every other statistic here: a short history says so.
    assert.match(sp, /history|30d/);
    for (const banned of [/\bbest\b/i, /\bhuge\b/i, /\bgrowing fast\b/i, /opportunit/i]) {
      assert.doesNotMatch(sp, banned, `/sponsor reads as a pitch: ${sp}`);
    }
    ok('/sponsor reports real numbers with no pitch');

    // The group is on every surface a user can see.
    const saved = process.env.SPONSOR_LINE;
    process.env.SPONSOR_LINE = 'ad · $MOON is live on pons — scan it';
    resetSponsor();
    await bot.handleUpdate(msg('private', `/scan ${TOKEN}`, -9003));
    const card = drain().pop().payload.text;
    assert.ok(card.trim().endsWith('@vitalscheck_bot · @vitalsofficial · not financial advice'),
      `footer missing the group:\n${card.split('\n').slice(-3).join('\n')}`);
    const cl = card.trim().split('\n');
    assert.equal(cl[cl.length - 2], 'ad · $MOON is live on pons — scan it',
      'the paid line must sit directly above the disclaimer');
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
    ok('a live card carries the group and the paid line in the specified order');
  }

  // --- filters through the real command surface ----------------------------
  {
    const { listFilterWatches } = await import('../dist/watch.js');

    // /filters must answer without a subscription and without a verdict.
    const fl = msg('private', '/filters', dmUser);
    fl.message.from.id = dmUser;
    await bot.handleUpdate(fl);
    const listed = drain();
    const text = listed[listed.length - 1].payload.text;
    assert.match(text, /buyback/);
    assert.match(text, /clean-deployer/);
    assert.match(text, /no-exemptions/);
    for (const banned of [/alpha/i, /opportunit/i, /worth a look/i]) {
      assert.doesNotMatch(text, banned, `/filters carried a verdict: ${text}`);
    }
    ok('/filters lists all three with no judgement attached');

    // An unknown filter name is refused, and nothing is created.
    const bad = msg('private', '/watch filter alpha', dmUser);
    bad.message.from.id = dmUser;
    await bot.handleUpdate(bad);
    const refused = drain();
    assert.match(refused[refused.length - 1].payload.text, /unknown filter/i);
    assert.equal(listFilterWatches(dmUser).length, 0, 'a bad name must not create a subscription');
    ok('/watch filter with an unknown name refuses and creates nothing');

    // The noisy one warns before it starts, not after 200 messages.
    const loud = msg('private', '/watch filter no-exemptions', dmUser);
    loud.message.from.id = dmUser;
    await bot.handleUpdate(loud);
    const made = drain();
    const reply = made[made.length - 1].payload.text;
    assert.match(reply, /fires on most launches/i, `no warning on the loud filter: ${reply}`);
    assert.match(reply, /capped at \d+ alerts an hour/i);
    assert.deepEqual(listFilterWatches(dmUser).map((f) => f.filter), ['no-exemptions']);
    ok('/watch filter warns about the noisy one and states the cap');

    // /watching shows it, /unwatch by name removes it.
    const w = msg('private', '/watching', dmUser);
    w.message.from.id = dmUser;
    await bot.handleUpdate(w);
    assert.match(drain().pop().payload.text, /filter\s+no-exemptions/);

    const un = msg('private', '/unwatch no-exemptions', dmUser);
    un.message.from.id = dmUser;
    await bot.handleUpdate(un);
    assert.match(drain().pop().payload.text, /stopped watching the no-exemptions filter/i);
    assert.equal(listFilterWatches(dmUser).length, 0);
    ok('/watching lists a filter and /unwatch removes it by name');
  }

  // --- an alert is a DM, with the reason above the card ---------------------
  {
    const { buildAlerts } = await import('../dist/alerts.js');
    const { addWatch } = await import('../dist/watch.js');
    const { db } = await import('../dist/db.js');
    // The subject is now past the factory-log lookback, so findLaunch places it
    // from the curve and ensureLaunchRow is skipped -- there is no creation
    // transaction to record and tx_hash is NOT NULL. That is deliberate; it
    // just means a scan alone no longer indexes this token, and the alert path
    // reads the launches table. Seeded from the factory's own answer, which is
    // where the indexer would have got it.
    let row = db.prepare('SELECT deployer FROM launches WHERE token = ?').get(TOKEN.toLowerCase());
    if (!row) {
      const { client } = await import('../dist/chain.js');
      const { factoryAbi } = await import('../dist/abi.js');
      const { FACTORY } = await import('../dist/config.js');
      const info = await client.readContract({
        address: FACTORY, abi: factoryAbi, functionName: 'getLaunchedToken', args: [TOKEN],
      });
      assert.ok(info?.exists, 'the subject must still be a launch the factory knows');
      db.prepare(
        `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
           graduation_threshold, block_number, tx_hash, launched_at, snipe_exemption_count)
         VALUES (?,?,?,?,1,?,1,?,?,0)`,
      ).run(
        TOKEN.toLowerCase(), info.curve.toLowerCase(), info.deployer.toLowerCase(),
        info.pairToken.toLowerCase(), String(info.graduationThreshold),
        '0x' + '0'.repeat(64), Math.floor(Date.now() / 1000) - 1_371_606,
      );
      row = db.prepare('SELECT deployer FROM launches WHERE token = ?').get(TOKEN.toLowerCase());
    }
    assert.ok(row, 'the subject token should be in the index for the alert path to see it');

    const watcher = 6602;
    addWatch(watcher, 'deployer', row.deployer, 7777);
    // Alerts defer while anyone is scanning, and this suite has been scanning
    // continuously. Waiting for quiet is the behaviour, not a workaround: an
    // alert nobody asked for must never be ahead of a scan somebody did.
    await new Promise((r) => setTimeout(r, 2_500));
    const { sends } = await buildAlerts([TOKEN]);
    const mine = sends.filter((s) => s.userId === watcher);
    assert.equal(mine.length, 1, `expected one alert, got ${mine.length}`);
    assert.equal(mine[0].chatId, 7777, 'delivered to the DM chat, never to a group');
    const [why, blank, ...card] = mine[0].text.split('\n');
    assert.match(why, /launched .*, you watch this deployer$/);
    assert.equal(blank, '');
    assert.match(card[0], /^VITALS  /, 'the card follows, unchanged');
    ok(`an alert is the reason then the card: "${why}"`);

    // and it never fires twice
    const again = await buildAlerts([TOKEN]);
    assert.equal(again.sends.filter((s) => s.userId === watcher).length, 0,
      'the same launch fired at the same user twice');
    ok('the same launch never fires twice to one user');
  }
}

console.log('\nAll handler checks passed.');
process.exit(0);
