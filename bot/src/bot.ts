import { Bot, InputFile, type Context } from 'grammy';
import type { InlineQueryResult } from 'grammy/types';
import { performScan, scanImage, normaliseToken, looksLikeTxHash, looksLikeSolanaAddress, inlineCacheSeconds, rateLimitFrom, rateLimitedMessage, SCAN_FAILED, type ScanSource, type ScanOutcome } from './service.js';
import { scanCache, startCacheReporter } from './cache.js';
import { userQuota, floodQuota, scanSemaphore, startQuotaSweeper } from './quota.js';
import { benchmarkCoverageLine } from './metrics/benchmark.js';
import { exemptedHoldTime, holdTimeLine, MIN_HOLD_SAMPLES, type HoldTime } from './holdtime.js';
export { exemptedHoldTime, holdTimeLine, MIN_HOLD_SAMPLES, type HoldTime };
import { concentrationCoverageLine } from './metrics/concentration.js';
import { inlineDescription } from './card.js';
import { db } from './db.js';
import { indexCoverage } from './coverage.js';
import { TELEGRAM_BOT_TOKEN, DISCLAIMER } from './config.js';

/** Inline answers are dropped by Telegram after ~15s; bail well before that. */
const INLINE_DEADLINE_MS = 10_000;

/**
 * Telegram posts every anonymous group admin's message as this single shared
 * bot account, so keying limits on the sender would put every anonymous admin
 * across every group into one bucket -- one group's spam would rate-limit an
 * unrelated group. Those are keyed on the chat instead.
 */
const GROUP_ANONYMOUS_BOT_ID = 1087968824;

/** How long a bot-posted prompt survives in a group before it is taken down. */
const EPHEMERAL_MS = Number(process.env.GROUP_PROMPT_TTL_MS || 20_000);

/** How long a chat's last scanned token stays available to a bare /full. */
const LAST_TOKEN_TTL_MS = Number(process.env.LAST_TOKEN_TTL_MS || 10 * 60_000);

/**
 * The last token each chat scanned.
 *
 * A user scans something, reads the card, then sends /full -- and used to get
 * the usage prompt, because the command carried no address. In memory only and
 * per chat, so it survives a conversation but not a restart.
 */
const lastToken = new Map<number, { token: string; at: number }>();

function rememberToken(chatId: number | undefined, token: string): void {
  if (chatId === undefined) return;
  lastToken.set(chatId, { token, at: Date.now() });
  if (lastToken.size > 5_000) {
    const cutoff = Date.now() - LAST_TOKEN_TTL_MS;
    for (const [k, v] of lastToken) if (v.at < cutoff) lastToken.delete(k);
  }
}

function recallToken(chatId: number | undefined): string | null {
  if (chatId === undefined) return null;
  const hit = lastToken.get(chatId);
  if (!hit) return null;
  if (Date.now() - hit.at > LAST_TOKEN_TTL_MS) {
    lastToken.delete(chatId);
    return null;
  }
  return hit.token;
}

/**
 * Say something in a group and take it back down.
 *
 * A bare /scan used to post the full usage block; in a busy group that fired
 * fifteen times in one session, which is how bots get removed. In a group the
 * bot says one line, as a reply so it is attached to whoever asked, and deletes
 * it shortly after.
 */
async function replyEphemeral(ctx: Context, text: string, replyOpts: Record<string, unknown>): Promise<void> {
  const sent = await ctx.reply(text, { ...replyOpts });
  const timer = setTimeout(() => {
    void ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch((err) => {
      // Deleting needs permission the bot may not have, and the message may
      // already be gone. Neither is worth failing over, but a persistent
      // failure means every prompt is staying up and should be visible.
      console.warn('[group] could not delete a prompt:', String(err?.message ?? err).slice(0, 140));
    });
  }, EPHEMERAL_MS);
  timer.unref?.();
}

/** The identity the limiters should key on for this update. */
function quotaIdentity(ctx: Context): number | undefined {
  const uid = ctx.from?.id;
  if (uid === undefined || uid === GROUP_ANONYMOUS_BOT_ID) return ctx.chat?.id ?? uid;
  return uid;
}

const EXAMPLE = '0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67';

/**
 * Plain text, like every card the bot sends.
 *
 * No parse_mode at all: Telegram autolinks bare @handles and bare domains on
 * its own, so the contact block needs no markup, and dropping the tags means a
 * copy-paste of /help is what was on screen rather than a mess of entities.
 * The previous version was the last HTML message left in the bot.
 */
const HELP = [
  'VITALS — pons v2 launch scanner, Robinhood Chain',
  '',
  'Send /scan <token address> for a card of what the chain shows.',
  '',
  'Works three ways, same card on each:',
  '  • DM — /scan <address>, or just paste an address',
  '  • Groups — /scan <address>',
  '  • Inline — type @BOTNAME <address> in any chat',
  '',
  '/full <address> adds the technical detail behind every line.',
  '/stats shows what has been indexed.',
  '',
  'The card leads with concerns — the things fixed at creation, which are',
  'readable the second a token exists — and puts the counts underneath. There',
  'is no grade and no score. The absence of a raised flag is not an all-clear:',
  'the card says how many checks ran and how many could not be determined.',
  '',
  DISCLAIMER,
  '',
  'checkvitals.xyz',
  '@vitalsofficial — every change lands here first',
  '@siriusthemaster — dev, tell me what\'s broken',
].join('\n');

/**
 * The bot's own username, taken from the context rather than module state.
 *
 * grammY populates ctx.me on every update, so this is always correct even when
 * the bot is constructed without going through startBot() -- which module-level
 * state was not, silently dropping the "via @bot" attribution the compact card
 * footer is specified to carry.
 */
function usernameOf(ctx: Context): string | undefined {
  return ctx.me?.username;
}

function sourceOf(ctx: Context): ScanSource {
  const type = ctx.chat?.type;
  if (type === 'group' || type === 'supergroup') return 'group';
  return 'dm';
}

// ---------------------------------------------------------------------------
// DM and group scanning
// ---------------------------------------------------------------------------

async function handleScan(ctx: Context, raw: string, full = false): Promise<void> {
  const source = sourceOf(ctx);
  const isGroup = source === 'group';
  const replyOpts = isGroup && ctx.msg
    ? { reply_parameters: { message_id: ctx.msg.message_id, allow_sending_without_reply: true } as const }
    : {};

  // A *bare* /full falls back to whatever this chat last scanned. Only bare:
  // falling back on unparseable input meant "/full <a solana address>" silently
  // rendered a completely different token, with nothing on the card to say so.
  const parsed = normaliseToken(raw);
  const token = parsed ?? (full && !raw.trim() ? recallToken(ctx.chat?.id) : null);
  if (!token) {
    const cmd = full ? 'full' : 'scan';
    // What went wrong, in one sentence. Same wording on every surface.
    const lead = looksLikeSolanaAddress(raw)
      ? "that's a solana address. this bot covers pons v2 on Robinhood Chain."
      : looksLikeTxHash(raw)
        ? "that's a transaction hash, not a token address."
        : null;

    if (isGroup) {
      // One short line, attached to whoever asked, gone in twenty seconds.
      // The full usage block posted here fifteen times in one session, which is
      // how a bot gets removed from a group.
      await replyEphemeral(ctx, lead ?? `send a pons v2 token address — /${cmd} 0x…`, replyOpts);
    } else {
      // A DM is nobody else's timeline, so it keeps the example in full.
      await ctx.reply(
        lead
          ? `${lead}\nSend a pons v2 token address:\n/${cmd} ${EXAMPLE}`
          : `Send a pons v2 token address:\n/${cmd} ${EXAMPLE}`,
        {},
      );
    }
    return;
  }
  // A cached answer arrives instantly, so the "Scanning..." notice would only
  // flicker. Groups never get the notice at all -- an extra message per scan is
  // exactly the kind of noise that gets a bot removed from a group.
  const cached = scanCache.peek(token);
  let notice: { chat: { id: number }; message_id: number } | null = null;
  if (!cached && !isGroup) {
    notice = await ctx.reply(`Scanning ${token}…`, { ...replyOpts });
  }

  // performScan converts anything it can into an outcome, but the reply path
  // must not depend on that discipline holding: anything thrown here would
  // otherwise escape to bot.catch, leaving "Scanning..." on screen forever with
  // the user given no reason and no way to tell it is finished.
  let outcome: ScanOutcome;
  try {
    outcome = await performScan({
      token,
      source,
      userId: ctx.from?.id,
      chatId: ctx.chat?.id,
      quotaKey: quotaIdentity(ctx),
      botUsername: usernameOf(ctx),
    });
  } catch (err) {
    // performScan classifies limits itself, but this is the last line before the
    // user sees a message and a limit must never reach them as a failure.
    const retryAfter = rateLimitFrom(err);
    if (retryAfter !== null) {
      console.warn(`[scan] rpc rate limited for ${token} (${source}), retry after ${retryAfter}s`);
      outcome = {
        kind: 'rate_limited',
        retryAfterSec: retryAfter,
        window: 'minute',
        message: rateLimitedMessage(retryAfter),
      };
    } else {
      console.error(`[scan] unexpected failure for ${token} (${source}):`, err);
      outcome = { kind: 'error', message: SCAN_FAILED };
    }
  }

  // Remember it only once a card actually exists for it. Remembering on the way
  // in meant a scan that was flood-limited -- no scan, no card -- still rewrote
  // the chat's memory, so a later bare /full detailed a token nobody had seen.
  if (parsed && (outcome.kind === 'ok' || outcome.kind === 'not_found')) {
    rememberToken(ctx.chat?.id, token);
  }

  // The image is opt-in and lives behind this button. It is never rendered
  // automatically: it is slower than the text and most people do not want it.
  const withImage =
    !full && (outcome.kind === 'ok')
      ? { reply_markup: { inline_keyboard: [[{ text: 'Image', callback_data: `img:${token}` }]] } }
      : {};
  await deliver(ctx, notice, messageFor(outcome, full), { ...replyOpts, ...withImage }, full);
}

/**
 * Render and send the PNG for a token.
 *
 * Answered on the callback query first so the button stops spinning while the
 * render happens, then sent as a photo reply. Failures are reported rather than
 * left silent -- a button that does nothing reads as a broken bot.
 */
async function handleImageButton(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const token = normaliseToken(data.slice(4));
  if (!token) {
    await ctx.answerCallbackQuery({ text: 'unrecognised token', show_alert: false });
    return;
  }

  // Every text path is flood-capped inside performScan, but a cached card short
  // -circuits before that, so the button was the one way to post unlimited
  // photos into a group -- the noise problem this whole change set out to fix.
  // Reported on the callback query so the cap does not itself add a message.
  const quotaKey = quotaIdentity(ctx);
  if (quotaKey !== undefined) {
    const d = floodQuota.consume(quotaKey);
    if (!d.allowed) {
      await ctx.answerCallbackQuery({ text: rateLimitedMessage(d.retryAfterSec), show_alert: true });
      return;
    }
  }

  await ctx.answerCallbackQuery({ text: 'rendering…' });
  const source = sourceOf(ctx);
  try {
    const res = await scanImage({
      token,
      source,
      userId: ctx.from?.id,
      chatId: ctx.chat?.id,
      quotaKey,
      botUsername: usernameOf(ctx),
    });
    if (res.kind !== 'ok') {
      await ctx.reply(messageFor(res.outcome, false));
      return;
    }
    await ctx.replyWithPhoto(new InputFile(res.png, `vitals-${token.slice(0, 10)}.png`), {
      reply_parameters: ctx.callbackQuery?.message
        ? { message_id: ctx.callbackQuery.message.message_id, allow_sending_without_reply: true }
        : undefined,
    });
  } catch (err) {
    console.error(`[image] render failed for ${token}:`, err);
    try {
      await ctx.reply('could not render the image, the text card above still stands');
    } catch (replyErr) {
      console.error('[image] could not report the failure either:', replyErr);
    }
  }
}

/**
 * Deliver a result, resolving the "Scanning..." notice if one was posted.
 *
 * Editing rather than sending matters: a fresh message would leave the notice
 * sitting above it, which reads as though the scan is still running.
 */
async function deliver(
  ctx: Context,
  notice: { chat: { id: number }; message_id: number } | null,
  text: string,
  replyOpts: Record<string, unknown>,
  html = false,
): Promise<void> {
  // The default card is sent with no parse_mode at all. It is built to be
  // forwarded, and a card someone copies out of Telegram should be exactly what
  // they saw -- no tags, no &amp; where an ampersand belongs. /full keeps HTML
  // because it is a reference view, not something anyone pastes into a group.
  const opts = html
    ? { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } }
    : { link_preview_options: { is_disabled: true } };

  if (!notice) {
    await ctx.reply(text, { ...opts, ...replyOpts });
    return;
  }

  try {
    await ctx.api.editMessageText(notice.chat.id, notice.message_id, text, opts);
  } catch (editErr) {
    // The notice can legitimately be gone -- deleted by a user or an admin --
    // so fall back to a fresh message. Logged rather than swallowed: a
    // persistent edit failure means every scan is posting twice.
    console.error('[scan] editMessageText failed, sending a new message instead:', editErr);
    try {
      await ctx.reply(text, { ...opts, ...replyOpts });
    } catch (replyErr) {
      console.error('[scan] could not deliver the result at all:', replyErr);
    }
  }
}

/**
 * Render an outcome for a chat message.
 *
 * The same default card on every surface -- DM, group and inline. /full is the
 * only thing that gets the long HTML card, and only in a DM or group.
 */
function messageFor(outcome: ScanOutcome, full: boolean): string {
  switch (outcome.kind) {
    case 'ok':
    case 'not_found':
      return full ? outcome.fullCard : outcome.defaultCard;
    case 'rate_limited':
      return `⏳ ${outcome.message}`;
    case 'busy':
      return `⏳ ${outcome.message}`;
    case 'error':
      return outcome.message;
  }
}

// ---------------------------------------------------------------------------
// Inline mode
// ---------------------------------------------------------------------------

/**
 * A one-line inline card for an outcome that is not a scan result. Carries the
 * same attribution and disclaimer as every other card the bot emits.
 */
function transientCard(ctx: Context, line: string): string {
  const via = ctx.me?.username ? `@${ctx.me.username} · ` : '';
  return `VITALS\n${line}\n${via}not financial advice`;
}

function article(id: string, title: string, description: string, text: string): InlineQueryResult {
  return {
    type: 'article',
    id,
    title,
    description,
    input_message_content: {
      // No parse_mode: inline sends the same plain-text card as every other
      // surface. With escaping removed, declaring HTML here would let a token
      // whose ticker contains "<" or "&" break the message outright.
      message_text: text,
      link_preview_options: { is_disabled: true },
    },
  };
}

async function handleInline(ctx: Context): Promise<void> {
  const q = (ctx.inlineQuery?.query ?? '').trim();

  /**
   * A scan result is the same for everybody, so it is cached for 60s and shared
   * (cache_time 60, is_personal false) exactly as specified.
   *
   * A rate-limit, busy or error answer is neither. Answering one of those with
   * the shared settings hands Telegram a per-user, per-moment result to serve to
   * every other user asking the same thing for the next minute: one user
   * exhausting their quota would show "rate limited" to everyone, and a
   * transient "still indexing" would outlive the indexing. Those are answered
   * uncached and personal.
   */
  const answerShared = (results: InlineQueryResult[], cacheSeconds = 60) =>
    ctx.answerInlineQuery(results, { cache_time: cacheSeconds, is_personal: false });
  const answerTransient = (results: InlineQueryResult[]) =>
    ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });

  // Empty query — tell the user what to paste rather than returning nothing.
  if (!q) {
    await answerShared([
      article(
        'empty',
        'Paste a pons token address',
        'VITALS scans pons v2 launches on Robinhood Chain',
        [
          'VITALS — pons v2 launch scanner',
          `Paste a token address after @${usernameOf(ctx) ?? 'the bot'} to scan it.`,
          `@${usernameOf(ctx) ?? 'the bot'} · not financial advice`,
        ].join('\n'),
      ),
    ]);
    return;
  }

  const token = normaliseToken(q);
  if (!token) {
    // Not an error — an explanation. An empty inline result list just shows a
    // spinner that never resolves, which reads as the bot being broken.
    const isSol = looksLikeSolanaAddress(q);
    const isTx = !isSol && looksLikeTxHash(q);
    const lead = isSol
      ? "that's a solana address. this bot covers pons v2 on Robinhood Chain."
      : isTx
        ? "that's a transaction hash, not a token address."
        : 'That is not a token address.';
    await answerShared([
      article(
        isSol ? 'invalid-sol' : isTx ? 'invalid-tx' : 'invalid',
        isSol ? 'Solana address' : isTx ? 'That is a transaction hash' : 'Not a token address',
        isSol ? 'this bot covers pons v2 on Robinhood Chain' : 'Expected 0x followed by 40 hex characters',
        [
          'VITALS — pons v2 launch scanner',
          `${lead} Expected 0x followed by 40 hex characters, e.g.`,
          EXAMPLE,
          `@${usernameOf(ctx) ?? 'the bot'} · not financial advice`,
        ].join('\n'),
      ),
    ]);
    return;
  }

  const outcome = await performScan({
    token,
    source: 'inline',
    userId: ctx.from?.id,
    chatId: undefined,
    quotaKey: quotaIdentity(ctx),
    deadlineMs: INLINE_DEADLINE_MS,
    botUsername: usernameOf(ctx),
  });

  const short = `${token.slice(0, 6)}…${token.slice(-4)}`;

  switch (outcome.kind) {
    case 'ok':
      // A symbol-less token must not render as "$0X147B...9E67" -- no dollar
      // prefix and no upper-casing of hex.
      const label = outcome.meta.symbol
        ? `$${outcome.meta.symbol.toUpperCase()}`
        : short;
      // An early card is only true for a few seconds. Telegram's own answer
      // cache is shared across every user, so leaving it at 60s would keep
      // serving "launched 12s ago" for a full minute and defeat the short
      // server-side TTL entirely.
      await answerShared(
        [article(token, `VITALS — ${label}`, inlineDescription(outcome.meta), outcome.defaultCard)],
        inlineCacheSeconds(outcome.meta),
      );
      return;
    case 'not_found':
      await answerShared([
        article(`nf:${token}`, `VITALS — ${short}`, 'not a pons v2 launch on this chain', outcome.defaultCard),
      ]);
      return;
    case 'rate_limited':
      await answerTransient([
        article(
          `rl:${token}:${outcome.retryAfterSec}`,
          'Rate limited',
          outcome.message,
          transientCard(ctx, `⏳ ${outcome.message}`),
        ),
      ]);
      return;
    case 'busy':
      await answerTransient([
        article(
          `busy:${token}`,
          'Still indexing',
          outcome.message,
          transientCard(ctx, `⏳ ${outcome.message}`),
        ),
      ]);
      return;
    case 'error':
      await answerTransient([
        article(
          `err:${token}`,
          'Scan failed',
          outcome.message.slice(0, 100),
          transientCard(ctx, outcome.message),
        ),
      ]);
      return;
  }
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export function createBot(token = TELEGRAM_BOT_TOKEN): Bot {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const bot = new Bot(token);

  bot.command(['start', 'help'], (ctx) =>
    ctx.reply(HELP.replace(/BOTNAME/g, usernameOf(ctx) ?? 'bot'), {
      // No preview: the footer carries a domain, and a link card would push the
      // text off the first screen.
      link_preview_options: { is_disabled: true },
    }),
  );

  // Works in private, group and supergroup. grammY strips the @botname suffix,
  // so /scan and /scan@vitalscheck_bot both land here.
  bot.command('scan', (ctx) => handleScan(ctx, ctx.match || ''));

  // Everything the default card leaves out: the technical wording of every
  // flag, the traction block, phase, pair and links.
  bot.command('full', (ctx) => handleScan(ctx, ctx.match || '', true));

  bot.command('stats', async (ctx) => {
    // /stats runs several COUNT(*) queries against SQLite on the event loop, so
    // it goes through the same flood cap as everything else rather than being a
    // free, unmetered way to make the bot work.
    const key = quotaIdentity(ctx);
    if (key !== undefined) {
      const d = floodQuota.consume(key);
      if (!d.allowed) {
        await ctx.reply(`⏳ ${rateLimitedMessage(d.retryAfterSec)}`);
        return;
      }
    }
    await ctx.reply(statsText());
  });

  bot.on('inline_query', handleInline);

  // Only the chat surfaces get the button. An inline result is posted into a
  // chat the bot may not be in, so a photo reply to it has nowhere to go.
  bot.callbackQuery(/^img:/, handleImageButton);

  /**
   * A bare address is treated as a scan in DMs only.
   *
   * Groups are deliberately excluded: auto-scanning every address someone posts
   * turns the bot into an unsolicited spammer, and it is the behaviour that most
   * often gets a bot banned from a group. In a group the bot acts only when
   * explicitly addressed with /scan.
   */
  bot.chatType('private').on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    if (normaliseToken(text)) await handleScan(ctx, text);
  });

  bot.catch((err) => console.error('[bot] error:', err));
  return bot;
}

/**
 * Public counters. Numbers only -- this is shown to anyone who types /stats, and
 * a line that reads as a pitch has no place in a tool whose whole claim is that
 * it does not make calls.
 */
export function statsText(): string {
  const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  const launches = q('SELECT COUNT(*) n FROM launches');
  const decoded = q('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count IS NOT NULL');
  const withExempt = q('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count > 0');
  const pct = decoded > 0 ? ((withExempt / decoded) * 100).toFixed(1) : '0.0';
  const hold = exemptedHoldTime();
  const scans = q('SELECT COUNT(*) n FROM scan_events');

  const cov = indexCoverage();
  return [
    ...(cov.recovering ? ['index rebuilding after restart — counts below are incomplete'] : []),
    `launches indexed ${launches.toLocaleString()}`,
    `launches with pre-exempted wallets ${withExempt.toLocaleString()} (${pct}% of ${decoded.toLocaleString()} decoded)`,
    holdTimeLine(hold),
    // Whether the comparison on every card is running yet, and on how much. A
    // feature that is silent for want of data should say so where the numbers
    // live rather than just not appear.
    benchmarkCoverageLine(),
    concentrationCoverageLine(),
    `scans served ${scans.toLocaleString()}`,
  ].join('\n');
}

export async function startBot(): Promise<void> {
  const bot = createBot();
  const me = await bot.api.getMe();

  await bot.api.setMyCommands([
    { command: 'scan', description: 'Score a pons v2 token launch' },
    { command: 'stats', description: 'Index, cache and usage statistics' },
    { command: 'help', description: 'What this bot reports' },
  ]);

  console.log(`[bot] running as @${me.username}`);

  // Privacy mode and inline mode are BotFather settings, not API calls, so the
  // best the bot can do is report what it actually has and say how to fix it.
  if (me.can_read_all_group_messages) {
    console.warn(
      '[bot] WARNING: privacy mode is OFF — this bot can read every group message.\n' +
      '[bot]          Turn it on: BotFather -> /setprivacy -> Enable.\n' +
      '[bot]          The bot never acts on unaddressed group messages regardless,\n' +
      '[bot]          but with privacy off it still receives them.',
    );
  } else {
    console.log('[bot] privacy mode ON — only sees messages addressed to it');
  }
  if (me.supports_inline_queries) {
    console.log('[bot] inline mode enabled');
  } else {
    console.warn('[bot] WARNING: inline mode is disabled — BotFather -> /setinline to enable');
  }

  startCacheReporter();
  startQuotaSweeper();

  await bot.start({ allowed_updates: ['message', 'inline_query', 'callback_query'] });
}
