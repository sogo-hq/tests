import { Bot, InputFile, type Api, type Context } from 'grammy';
import type { InlineQueryResult } from 'grammy/types';
import { performScan, scanImage, normaliseToken, looksLikeTxHash, looksLikeSolanaAddress, inlineCacheSeconds, rateLimitFrom, rateLimitedMessage, SCAN_FAILED, type ScanSource, type ScanOutcome } from './service.js';
import { scanCache, startCacheReporter } from './cache.js';
import { userQuota, floodQuota, scanSemaphore, startQuotaSweeper } from './quota.js';
import { benchmarkCoverageLine } from './metrics/benchmark.js';
import { indexHealth, agoWords, type IndexHealth } from './indexer/health.js';
import { providerLimitLine } from './providerlimits.js';
import {
  addWatch, listWatches, removeWatch, countWatches, rememberDm, dmChatFor, MAX_WATCHES,
  addFilterWatch, listFilterWatches, removeFilterWatch,
} from './watch.js';
import { isFilterKey, filterDef, filterRates, rateLine } from './filters.js';
import { LEGEND, claimLegend } from './legend.js';
import { age } from './card.js';
import {
  registerMember, addExternal, removeExternal, statusOf, allRows, refreshBalances,
  totals, snapshot, selfRegistrationOpen, setSetting, getSetting, normaliseWallet,
  rememberJoin, inviteOf, joinedTooRecently,
  READY_MIN_ETH, REGISTER_COOLDOWN_MS,
} from './ready.js';
import {
  totalsBlock, isAdmin, gateHit, countdownLine, dueAutoPost, markAutoPost,
} from './tge.js';
import { parseLaunchTime, launchTimeLine, getLaunchPlan, clearLaunchPlan } from './launch.js';
import {
  launchChat, preflight, preflightLine, startLaunchLoop,
  guardVerdict, guardActive, pinnedCa, offencesOf, recordOffence,
  alreadyHandled, markHandled, muteFor24h, GUARD_WARNING, GUARD_MUTED,
  launchDetected,
} from './launchday.js';
import { ALERTS_PER_HOUR } from './alerts.js';
import { buildAlerts } from './alerts.js';
import { exemptedHoldTime, holdTimeLine, MIN_HOLD_SAMPLES, type HoldTime } from './holdtime.js';
export { exemptedHoldTime, holdTimeLine, MIN_HOLD_SAMPLES, type HoldTime };
import { concentrationCoverageLine } from './metrics/concentration.js';
import { inlineDescription, footerLine, GROUP_HANDLE } from './card.js';
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
  'VITALS: pons v2 launch scanner, Robinhood Chain',
  '',
  'Send /scan <token address> for a card of what the chain shows.',
  '',
  'Works three ways, same card on each:',
  '  • DM: /scan <address>, or just paste an address',
  '  • Groups: /scan <address>',
  '  • Inline: type @BOTNAME <address> in any chat',
  '',
  '/full <address> adds the technical detail behind every line.',
  '/stats shows what has been indexed.',
  '',
  'Launch readiness:',
  '  • /ready in the group: the totals, and only the totals',
  '  • /tge: the same, with the countdown once a time is set',
  '  • register in DM only. a wallet posted in the group is deleted unread,',
  '    and no wallet, label or user id is ever shown in a group message.',
  '',
  'Alerts, delivered here and only here, never into a group:',
  '  • /watch deployer <address>: when that address launches again',
  '  • /watch wallet <address>: when that address is pre-exempted on a launch',
  '  • /watch filter <name>: when a new launch has a shape you picked',
  '  • /filters lists the filters and how often each fires',
  '  • /watching lists your subscriptions, /unwatch <address|filter> removes one',
  '',
  'one paid line at the bottom funds this. it never touches what a card says,',
  'and it always points at a scan. /sponsor for the numbers.',
  '',
  'The card leads with concerns (the things fixed at creation, which are',
  'readable the second a token exists) and puts the counts underneath. There',
  'is no grade and no score. The absence of a raised flag is not an all-clear:',
  'the card says how many checks ran and how many could not be determined.',
  '',
  DISCLAIMER,
  '',
  'checkvitals.xyz',
  '@vitalsofficial: every change lands here first',
  '@siriusthemaster: dev, tell me what\'s broken',
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
      await replyEphemeral(ctx, lead ?? `send a pons v2 token address: /${cmd} 0x…`, replyOpts);
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

  // A first card is where the markers first appear, so it is where they first
  // need explaining -- somebody who was handed the bot by a friend never typed
  // /start. DM only: a group has many readers and only one of them is new, and
  // the legend is not worth a message to the rest of them.
  const uid = ctx.from?.id;
  if (uid !== undefined && ctx.chat?.type === 'private' && outcome.kind === 'ok' && claimLegend(uid)) {
    await ctx.reply(LEGEND, { link_preview_options: { is_disabled: true } });
  }
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
    case 'unreadable':
      // No hourglass and no card: this is not a wait and not a finding, it is
      // an admission. The user asked a fair question and the chain did not
      // answer it.
      return outcome.message;
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
  return `VITALS\n${line}\n${footerLine(usernameOf(ctx))}`;
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
          'VITALS: pons v2 launch scanner',
          `Paste a token address after @${usernameOf(ctx) ?? 'the bot'} to scan it.`,
          footerLine(usernameOf(ctx)),
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
          'VITALS: pons v2 launch scanner',
          `${lead} Expected 0x followed by 40 hex characters, e.g.`,
          EXAMPLE,
          footerLine(usernameOf(ctx)),
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
        [article(token, `VITALS: ${label}`, inlineDescription(outcome.meta), outcome.defaultCard)],
        inlineCacheSeconds(outcome.meta),
      );
      return;
    case 'not_found':
      await answerShared([
        article(`nf:${token}`, `VITALS: ${short}`, 'not a pons v2 launch on this chain', outcome.defaultCard),
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
    case 'unreadable':
      // Titled for what it is. "Not a pons v2 launch" was the wrong answer
      // here and this one must not be mistakable for it.
      await answerTransient([
        article(
          `unread:${token}`,
          'Could not read the chain',
          outcome.message,
          transientCard(ctx, outcome.message),
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

// ---------------------------------------------------------------- ready / tge

/**
 * The posted totals, cached.
 *
 * Balances are re-read from chain before every post, which is the expensive
 * part, so the whole block is cached for ten minutes and a /ready inside that
 * window EDITS the last one rather than posting another. Net effect: at most
 * one new block per ten minutes however many people ask, which is what keeps a
 * 300-member group from turning one command into a wall.
 */
const BLOCK_TTL_MS = Number(process.env.READY_BLOCK_TTL_MS || 600_000) || 600_000;
let posted: { chatId: number; messageId: number; at: number } | null = null;
let blockAt = 0;

/** For tests, and for a restart to behave like a cold one. */
export function resetReadyBlockCache(): void {
  posted = null;
  blockAt = 0;
}

async function memberCount(api: Api, chatId: number): Promise<number | null> {
  try {
    return await api.getChatMemberCount(chatId);
  } catch (err) {
    // A count we could not read is omitted, never guessed: the block is the one
    // number this group is asked to trust.
    console.warn('[ready] member count unreadable:', String((err as Error)?.message ?? err).slice(0, 120));
    return null;
  }
}

export interface PostTotalsOpts {
  withCountdown?: boolean;
  botUsername?: string;
  isGroup?: boolean;
  now?: number;
  /**
   * Post a new block from figures the caller has already refreshed.
   *
   * The scheduled poster needs this for two reasons: it has read the balances
   * itself in order to decide whether a post is due at all, and editing a block
   * from hours ago would make the daily post invisible to everyone who has
   * scrolled past it.
   */
  force?: boolean;
}

/**
 * Post -- or edit -- the totals block in one chat.
 *
 * Returns the reason it did nothing, or 'posted'/'edited'. The caller uses that
 * only for logging; the group sees the block either way.
 */
export async function postTotals(
  api: Api,
  chatId: number,
  opts: PostTotalsOpts = {},
): Promise<'posted' | 'edited'> {
  const now = opts.now ?? Date.now();
  const fresh = opts.force || now - blockAt >= BLOCK_TTL_MS;
  if (fresh && !opts.force) {
    await refreshBalances(now);
    snapshot(now);
  }
  const readAt = fresh ? now : blockAt;
  if (fresh) blockAt = now;
  const members = await memberCount(api, chatId);
  const t = totals();
  const body = totalsBlock({
    members,
    now,
    botUsername: opts.botUsername,
    updatedMinutesAgo: fresh ? undefined : Math.round((now - readAt) / 60_000),
  }, t);
  const countdown = opts.withCountdown ? countdownLine(now) : null;
  const text = countdown ? `${body}\n${countdown}` : body;

  // Inside the window, edit the last block in this chat instead of adding one.
  if (!fresh && posted && posted.chatId === chatId) {
    try {
      await api.editMessageText(posted.chatId, posted.messageId, text);
      return 'edited';
    } catch (err) {
      // Edited too late, deleted, or unchanged. Falling through to a new post is
      // better than saying nothing to somebody who asked.
      console.warn('[ready] block edit failed, posting a new one:', String((err as Error)?.message ?? err).slice(0, 120));
    }
  }
  const sent = await api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
  posted = { chatId, messageId: sent.message_id, at: now };
  // Remember where the block lives so the daily and threshold posts have a
  // group to go to without an admin configuring a chat id by hand.
  if (opts.isGroup) setSetting('ready_chat', String(chatId));
  if (gateHit(t, members) && !getSetting('gate_announced')) {
    setSetting('gate_announced', String(Math.floor(now / 1000)));
    await api.sendMessage(chatId, 'GATE HIT');
  }
  return 'posted';
}

/**
 * One tick of the scheduled poster.
 *
 * Idempotent: dueAutoPost() decides from stored marks, and the mark is written
 * only after the send succeeds, so a crash between the two leaves the post due
 * rather than lost. Does nothing at all until a block has been posted in a
 * group once, which is what names the chat.
 */
export async function readyAutoPostTick(api: Api, opts: { now?: number; botUsername?: string } = {}): Promise<boolean> {
  const chat = getSetting('ready_chat');
  if (!chat) return false;
  const now = opts.now ?? Date.now();
  // Read before deciding: the threshold trigger is a question about the current
  // number of ready wallets, and deciding it from ten-minute-old figures would
  // announce a count the bot no longer believes.
  await refreshBalances(now);
  snapshot(now);
  blockAt = now;
  const t = totals();
  const reason = dueAutoPost(now, t.wallets);
  if (!reason) return false;
  const chatId = Number(chat);
  try {
    posted = null;
    await postTotals(api, chatId, { botUsername: opts.botUsername, isGroup: true, now, force: true });
  } catch (err) {
    console.warn('[ready] auto-post failed:', String((err as Error)?.message ?? err).slice(0, 160));
    return false;
  }
  markAutoPost(reason, now, t.wallets);
  console.log(`[ready] auto-posted (${reason}) · ${t.wallets} wallets`);
  return true;
}

export function startReadyAutoPost(api: Api, botUsername?: string, intervalMs = 60_000): NodeJS.Timeout {
  const t = setInterval(() => {
    void readyAutoPostTick(api, { botUsername }).catch(() => {});
  }, intervalMs);
  t.unref?.();
  return t;
}


// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export function createBot(token = TELEGRAM_BOT_TOKEN): Bot {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const bot = new Bot(token);

  // Recorded so the index loop can deliver alerts through this same bot. It was
  // declared and never assigned at first, which would have made every alert
  // silently do nothing -- the exact shape of failure this codebase keeps
  // producing when one half of a pair is written and the other is assumed.
  liveBot = bot;

  /** Group admins are exempt, as are the ADMIN_IDS list. */
  const isGroupAdmin = async (ctx: Context, userId: number): Promise<boolean> => {
    if (isAdmin(userId)) return true;
    try {
      const m = await ctx.api.getChatMember(ctx.chat!.id, userId);
      return m.status === 'administrator' || m.status === 'creator';
    } catch (err) {
      // Unreadable membership is not admin. Being wrong that way deletes an
      // admin's message, which is recoverable; guessing "admin" leaves a fake
      // CA standing, which is not.
      console.warn('[launch] admin check failed:', String((err as Error)?.message ?? err).slice(0, 120));
      return false;
    }
  };

  /**
   * The fake-CA guard.
   *
   * Registered before every command and it calls next() unless it acted, so the
   * rest of the bot still sees the message. Written the other way round first,
   * where it swallowed the middleware chain and silently disabled every command
   * declared after it.
   *
   * Runs on new messages AND on edits: a scammer can post "gm", let it settle,
   * then edit a contract address into it, and with only 'message' in
   * allowed_updates the bot never sees the edit. Bot API 10.3,
   * Update.edited_message.
   *
   * The bot must be an administrator of the group for any of this to arrive at
   * all. An administrator receives every message regardless of privacy mode,
   * which is what makes the guard possible without turning privacy mode off.
   * Privacy mode stays ON.
   */
  const caGuard = async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message ?? ctx.editedMessage;
    const userId = ctx.from?.id;
    if (!msg || userId === undefined || ctx.chat?.type === 'private' || !guardActive()) {
      await next();
      return;
    }
    // A caption carries an address as readily as a body does.
    const text = `${msg.text ?? ''} ${msg.caption ?? ''}`.trim();
    if (!text || !/0x[0-9a-fA-F]{40}/.test(text)) {
      await next();
      return;
    }

    const verdict = guardVerdict(text, {
      pinnedCa: pinnedCa(),
      isAdmin: await isGroupAdmin(ctx, userId),
      priorOffences: offencesOf(userId),
      active: true,
    });
    if (verdict.action === 'ignore') {
      await next();
      return;
    }

    // Delete first and always, whatever happens afterwards: the address being
    // readable is the harm, and every step below it is slower.
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, msg.message_id);
    } catch (err) {
      console.warn('[launch] could not delete a wrong CA:', String((err as Error)?.message ?? err).slice(0, 120));
    }

    // An edit re-delivers a message already acted on, and the docs warn edits
    // fire for unrelated field changes too. Counting that as a second offence
    // would mute a first offender over one pasted address.
    if (alreadyHandled(ctx.chat!.id, msg.message_id)) return;
    markHandled(ctx.chat!.id, msg.message_id);
    const n = recordOffence(userId);

    const dm = dmChatFor(userId);
    if (verdict.action === 'mute' || n > 1) {
      const muted = await muteFor24h(ctx.api, ctx.chat!.id, userId);
      if (dm !== null) await ctx.api.sendMessage(dm, muted ? GUARD_MUTED : GUARD_WARNING);
      return;
    }
    if (dm !== null) await ctx.api.sendMessage(dm, GUARD_WARNING);
  };

  bot.on('message', caGuard);
  bot.on('edited_message', caGuard);


  // Any private message means this user is reachable. Recorded here rather than
  // inferred from what they scanned: /help in a DM is just as good a proof of a
  // reachable chat as a scan, and inferring it told people who had already
  // written to "message me first".
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid !== undefined && ctx.chat?.type === 'private') rememberDm(uid, ctx.chat.id);
    await next();
  });

  bot.command(['start', 'help'], async (ctx) => {
    await ctx.reply(HELP.replace(/BOTNAME/g, usernameOf(ctx) ?? 'bot'), {
      // No preview: the footer carries a domain, and a link card would push the
      // text off the first screen.
      link_preview_options: { is_disabled: true },
    });
    // The markers mean nothing to somebody seeing them for the first time, and
    // the one thing a card cannot convey by itself is that a missing marker is
    // not an all-clear. Said once, on the way in.
    const userId = ctx.from?.id;
    if (userId !== undefined && claimLegend(userId)) {
      await ctx.reply(LEGEND, { link_preview_options: { is_disabled: true } });
    }
  });

  bot.command('legend', (ctx) =>
    ctx.reply(LEGEND, { link_preview_options: { is_disabled: true } }),
  );

  // Works in private, group and supergroup. grammY strips the @botname suffix,
  // so /scan and /scan@vitalscheck_bot both land here.
  bot.command('scan', (ctx) => handleScan(ctx, ctx.match || ''));

  // Everything the default card leaves out: the technical wording of every
  // flag, the traction block, phase, pair and links.
  bot.command('full', (ctx) => handleScan(ctx, ctx.match || '', true));

    const normaliseAddress = (raw: string): string | null => {
    const m = String(raw).match(/0x[a-fA-F0-9]{40}/);
    return m ? m[0].toLowerCase() : null;
  };

  /** A DM gets the full prompt; a group gets one short line that deletes itself. */
  const replyOrPrompt = async (ctx: Context, text: string): Promise<void> => {
    if (sourceOf(ctx) === 'group') {
      await replyEphemeral(ctx, text.split('\n')[0]!, ctx.msg
        ? { reply_parameters: { message_id: ctx.msg.message_id, allow_sending_without_reply: true } as const }
        : {});
      return;
    }
    await ctx.reply(text);
  };

  /**
   * Said once per user, then never again.
   *
   * Somebody who keeps typing /watch in a group should not keep producing
   * messages there. The reply is ephemeral in a group for the same reason.
   */
  const toldToDm = new Set<number>();
  const replyEphemeralOnce = async (ctx: Context, userId: number, text: string): Promise<void> => {
    if (toldToDm.has(userId)) return;
    toldToDm.add(userId);
    await replyOrPrompt(ctx, text);
  };

  // ---------------------------------------------------------------- alerts
  bot.command('watch', async (ctx) => {
    const raw = (ctx.match ?? '').toString().trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const kind = parts[0]?.toLowerCase();
    const address = normaliseAddress(parts.slice(1).join(' '));

    if (kind !== 'deployer' && kind !== 'wallet' && kind !== 'filter') {
      await replyOrPrompt(
        ctx,
        'watch a deployer, a wallet, or a filter:\n/watch deployer 0x…\n/watch wallet 0x…\n' +
          '/watch filter <name>. /filters lists them',
      );
      return;
    }

    const userId = ctx.from?.id;
    if (userId === undefined) return;

    // DM only, always. An alert nobody in the room asked for is spam, and it
    // is what gets a bot removed from a group -- so a watch cannot even be
    // created without somewhere private to deliver it.
    const dm = dmChatFor(userId);
    if (dm === null) {
      await replyEphemeralOnce(ctx, userId, 'message me directly first. alerts only ever go to a DM, never to a group');
      return;
    }

    if (kind === 'filter') {
      const name = (parts[1] ?? '').toLowerCase();
      if (!isFilterKey(name)) {
        await replyOrPrompt(
          ctx,
          // The name is echoed back, so it is stripped to what a filter name
          // can contain rather than trusted: this is user text on its way into
          // a reply.
          `unknown filter${name ? ` "${name.replace(/[^a-z0-9-]/g, '').slice(0, 24)}"` : ''}. ` +
            '/filters lists them with how often each fires.',
        );
        return;
      }
      const res = addFilterWatch(userId, name, dm);
      if ('reason' in res && res.reason === 'limit') {
        await ctx.reply(`that is ${res.count} watches, which is the limit. /unwatch one first.`);
        return;
      }
      if ('reason' in res) {
        await ctx.reply(`already watching the ${name} filter`);
        return;
      }
      const def = filterDef(name);
      const rate = filterRates().find((r) => r.key === name);
      const lines = [
        `watching filter ${name}: ${def.describe}.`,
        `${countWatches(userId)} of ${MAX_WATCHES}. alerts arrive here.`,
      ];
      // Said before the feed starts, not discovered from it: a filter matching
      // most launches is a subscription to nearly everything, and the number is
      // the only honest way to say so.
      if (def.loud) {
        lines.push(
          rate?.perDay != null
            ? `heads up: this one fires on most launches, about ${Math.round(rate.perDay)} a day.`
            : 'heads up: this one fires on most launches.',
        );
      }
      lines.push(`capped at ${ALERTS_PER_HOUR} alerts an hour.`);
      await ctx.reply(lines.join('\n'));
      return;
    }

    if (!address) {
      await replyOrPrompt(ctx, `send an address to watch: /watch ${kind} 0x…`);
      return;
    }

    const res = addWatch(userId, kind, address, dm);
    if (!res.ok && res.reason === 'limit') {
      await ctx.reply(`that is ${res.count} watches, which is the limit. /unwatch one first.`);
      return;
    }
    if (!res.ok) {
      await ctx.reply(`already watching that ${kind}`);
      return;
    }
    await ctx.reply(
      `watching ${kind} ${address.slice(0, 6)}…${address.slice(-4)}, ` +
        `${countWatches(userId)} of ${MAX_WATCHES}. alerts arrive here.`,
    );
  });

  bot.command('watching', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const list = listWatches(userId);
    const filters = listFilterWatches(userId);
    if (!list.length && !filters.length) {
      await ctx.reply(
        'not watching anything yet. /watch deployer 0x…, /watch wallet 0x…, or /watch filter <name> (/filters)',
      );
      return;
    }
    await ctx.reply(
      [
        `${list.length + filters.length} of ${MAX_WATCHES} watches`,
        ...list.map((w) => `${w.kind}  ${w.address}`),
        ...filters.map((f) => `filter  ${f.filter}`),
      ].join('\n'),
    );
  });

  bot.command('unwatch', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const raw = (ctx.match ?? '').toString().trim();
    if (isFilterKey(raw.toLowerCase())) {
      const gone = removeFilterWatch(userId, raw.toLowerCase());
      await ctx.reply(gone ? `stopped watching the ${raw.toLowerCase()} filter` : 'not watching that filter');
      return;
    }
    const address = normaliseAddress(raw);
    if (!address) {
      await replyOrPrompt(ctx, 'send the address or filter name to stop watching: /unwatch 0x… or /unwatch <filter>');
      return;
    }
    const gone = removeWatch(userId, address);
    await ctx.reply(gone ? `stopped watching ${address.slice(0, 6)}…${address.slice(-4)}` : 'not watching that address');
  });

  // ------------------------------------------------------------ ready / tge
  bot.command('ready', async (ctx) => {
    const userId = ctx.from?.id;
    // Bots and minutes-old accounts are ignored in silence. Answering either
    // one turns the group into a place where saying /ready gets a reaction,
    // which is the whole payoff for spamming it.
    if (userId === undefined || ctx.from?.is_bot || joinedTooRecently(userId)) return;
    const raw = (ctx.match ?? '').toString().trim();
    const inGroup = ctx.chat?.type !== 'private';

    // A wallet pasted in a group is deleted before anyone reads it, and nothing
    // is posted in its place: an address in the channel is exactly what
    // registering privately exists to avoid. Every word is checked, not just
    // the first -- `/ready add 0x… label` typed in the group leaks the same
    // address as `/ready 0x…` does.
    if (inGroup && raw.split(/\s+/).some((w) => normaliseWallet(w))) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, ctx.message!.message_id);
      } catch (err) {
        // No delete permission, or older than 48h. Still never echo it -- and
        // this is worth a log line, because it means addresses are sitting in
        // the group until an admin grants the bot delete rights.
        console.warn('[ready] could not delete a pasted wallet:', String((err as Error)?.message ?? err).slice(0, 120));
      }
      const dm = dmChatFor(userId);
      if (dm !== null) {
        await ctx.api.sendMessage(dm, 'register in DM, never in the group. send /ready 0x… here');
      }
      return;
    }

    if (inGroup) {
      await postTotals(ctx.api, ctx.chat!.id, { botUsername: usernameOf(ctx), isGroup: true });
      return;
    }

    // ---- DM ----
    const parts = raw.split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();

    if (sub === 'add' || sub === 'remove' || sub === 'list' || sub === 'open') {
      if (!isAdmin(userId)) return;
      if (sub === 'list') {
        const rows = allRows();
        const csv = [
          'wallet,balance_eth,source,label,invite_link,first_seen,last_checked',
          ...rows.map((r) => [
            r.wallet, (Number(r.balanceWei) / 1e18).toFixed(4), r.source,
            JSON.stringify(r.label ?? ''), JSON.stringify(r.inviteLink ?? ''),
            r.firstSeen, r.lastChecked,
          ].join(',')),
        ].join('\n');
        await ctx.reply(rows.length ? csv : 'no wallets registered');
        return;
      }
      if (sub === 'open') {
        const on = parts[1]?.toLowerCase() === 'on';
        setSetting('ready_open', on ? 'on' : 'off');
        await ctx.reply(`self-registration ${on ? 'open' : 'closed'}`);
        return;
      }
      if (sub === 'remove') {
        await ctx.reply(removeExternal(parts[1] ?? '') ? 'removed' : 'no external wallet with that address');
        return;
      }
      const res = await addExternal(parts[1] ?? '', parts.slice(2).join(' ') || 'external');
      if (!res.ok) {
        await ctx.reply(
          res.reason === 'claimed' ? 'a member already registered that wallet'
          : res.reason === 'contract' ? 'that is a contract, not a wallet'
          : res.reason === 'low' ? `below the ${READY_MIN_ETH} ETH minimum`
          : 'that is not an address',
        );
        return;
      }
      await ctx.reply(`added · ${(Number(res.balanceWei) / 1e18).toFixed(3)} ETH · ${totals().wallets} wallets ready`);
      return;
    }

    if (!parts.length) {
      const me = statusOf(userId);
      await ctx.reply(
        me
          ? `you: READY · ${(Number(me.balanceWei) / 1e18).toFixed(2)} ETH · registered ${age(Math.floor(Date.now() / 1000) - me.firstSeen)} ago`
          : 'not registered',
      );
      return;
    }

    if (!selfRegistrationOpen()) {
      await ctx.reply('registration is handled by the team right now. ask an admin to add you');
      return;
    }

    const res = await registerMember(userId, parts[0]!, { inviteLink: inviteOf(userId) });
    if (!res.ok) {
      await ctx.reply(
        res.reason === 'malformed' ? 'that is not an address'
        : res.reason === 'contract' ? 'that is a contract, not a wallet'
        : res.reason === 'cooldown' ? `one registration per ${Math.round(REGISTER_COOLDOWN_MS / 60_000)} min. try again shortly`
        : res.reason === 'closed' ? 'registration is closed'
        : `not yet: ${(Number(res.balanceWei) / 1e18).toFixed(3)} ETH on Robinhood Chain, minimum ${READY_MIN_ETH}. ` +
          'fastest: Maestro → /relay → Robinhood Chain, then /ready again.',
      );
      return;
    }
    await ctx.reply(
      `READY · ${(Number(res.balanceWei) / 1e18).toFixed(2)} ETH on Robinhood Chain · ` +
        `you are wallet #${totals().wallets}${res.replaced ? ' (replaced your previous one)' : ''}`,
    );
  });

  bot.on('chat_member', (ctx) => {
    const u = ctx.chatMember;
    const joined = u.new_chat_member.status === 'member' || u.new_chat_member.status === 'restricted';
    const wasOut = u.old_chat_member.status === 'left' || u.old_chat_member.status === 'kicked';
    if (!joined || !wasOut || u.new_chat_member.user.is_bot) return;
    // The link name is on the join event and nowhere else afterwards.
    rememberJoin(u.new_chat_member.user.id, u.invite_link?.name ?? null);
  });

  bot.command('tge', async (ctx) => {
    if (ctx.from?.is_bot) return;
    await postTotals(ctx.api, ctx.chat!.id, {
      withCountdown: true,
      botUsername: usernameOf(ctx),
      isGroup: ctx.chat?.type !== 'private',
    });
  });

  bot.command('launch', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const parts = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    const rest = parts.slice(1).join(' ');

    if (sub === 'cancel' || sub === 'clear') {
      const had = getLaunchPlan();
      clearLaunchPlan();
      await ctx.reply(had ? 'launch cancelled' : 'no launch was set');
      const chat = launchChat();
      if (had && chat !== null) {
        // One line, in the group, so the countdown does not simply stop with no
        // explanation for everyone who has been watching it.
        await ctx.api.sendMessage(chat, 'the launch has been cancelled.');
      }
      return;
    }

    if (sub === 'name') {
      if (!rest) { await ctx.reply('/launch name $VITALS'); return; }
      setSetting('launch_name', rest.slice(0, 32));
      await ctx.reply(`launch name: ${rest.slice(0, 32)}`);
      return;
    }

    if (sub === 'watch') {
      const addr = normaliseWallet(parts[1] ?? '');
      if (!addr) { await ctx.reply('/launch watch 0xDEPLOYER'); return; }
      setSetting('launch_deployer', addr);
      await ctx.reply(`watching ${addr.slice(0, 10)}… for its next launch. the CA will be posted and pinned here.`);
      return;
    }

    if (sub === 'set') {
      const res = parseLaunchTime(rest, Date.now());
      if (!res.ok) { await ctx.reply(res.reason); return; }
      setSetting('launch_at', String(Math.floor(res.at / 1000)));
      const lines = [launchTimeLine(res.at)];

      // Everything promised from here on needs rights an admin grants by hand.
      // Reported now rather than discovered at T-0.
      const chat = launchChat();
      if (chat === null) {
        lines.push('no group yet: run /ready in the group once so the bot knows where to post.');
      } else {
        lines.push(preflightLine(await preflight(ctx.api, chat, ctx.me.id)));
      }
      if (!getSetting('launch_deployer')) {
        lines.push('no deployer watched yet: /launch watch 0xDEPLOYER so the CA can be posted automatically.');
      }
      await ctx.reply(lines.join('\n'));
      return;
    }

    const plan = getLaunchPlan();
    await ctx.reply([
      plan ? launchTimeLine(plan.at) : 'no launch set',
      plan?.name ? `name: ${plan.name}` : '',
      plan?.deployer ? `watching: ${plan.deployer.slice(0, 10)}…` : '',
      '',
      '/launch set 2026-09-22 16:00',
      '/launch name $VITALS',
      '/launch watch 0xDEPLOYER',
      '/launch cancel',
    ].filter(Boolean).join('\n'));
  });

  bot.command('kols', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const n = Number((ctx.match ?? '').toString().trim());
    if (!Number.isFinite(n) || n < 0) { await ctx.reply('/kols <n>'); return; }
    setSetting('kols', String(Math.floor(n)));
    await ctx.reply(`kols ${Math.floor(n)}`);
  });

  bot.command('gate', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const raw = (ctx.match ?? '').toString().trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts[0]?.toLowerCase() === 'reset') {
      setSetting('gate_announced', '');
      await ctx.reply('gate reset');
      return;
    }
    if (parts[0]?.toLowerCase() !== 'set') { await ctx.reply('/gate set members=300 kols=30 wallets=150 eth=100'); return; }
    const applied: string[] = [];
    for (const kv of parts.slice(1)) {
      const [k, v] = kv.split('=');
      const n = Number(v);
      if (!k || !Number.isFinite(n)) continue;
      if (!['members', 'kols', 'wallets', 'eth'].includes(k)) continue;
      setSetting(`gate_${k}`, String(n));
      applied.push(`${k}=${n}`);
    }
    await ctx.reply(applied.length ? `gate set · ${applied.join(' · ')}` : 'nothing set');
  });

  bot.command('filters', async (ctx) => {
    // The rates come from COUNT over the index, so this goes through the same
    // flood cap as anything else that touches the database on the event loop.
    const rates = filterRates();
    await ctx.reply(
      [
        'filters: subscribe with /watch filter <name>',
        '',
        ...rates.map((r) => rateLine(r)),
        '',
        `alerts are capped at ${ALERTS_PER_HOUR} an hour and only ever arrive by DM.`,
      ].join('\n'),
    );
  });

  bot.command('sponsor', async (ctx) => {
    // Counting queries against SQLite on the event loop, like /stats, so it
    // goes through the same flood cap rather than being a free way to spin it.
    await ctx.reply(sponsorText());
  });

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
/**
 * Send the alerts for a batch of new launches.
 *
 * Held here because this is where the Telegram transport lives; everything
 * about which alerts exist and what they say is in alerts.ts, which needs no
 * bot token to test. A null bot means alerts are built and dropped, which is
 * what happens in every non-bot mode.
 */
let liveBot: Bot | null = null;

/**
 * The launch post, on the same callback the alerts ride.
 *
 * Called before deliverAlerts on purpose: this is the one message in the system
 * with a published three second budget, and the alert loop deliberately yields
 * to interactive work. A launch is exactly when interactive work never stops.
 */
export async function deliverLaunch(tokens: string[]): Promise<void> {
  if (!liveBot || !tokens.length) return;
  try {
    await launchDetected(liveBot.api, tokens, { botUsername: liveBot.botInfo?.username });
  } catch (err) {
    console.warn('[launch] detection failed:', String((err as Error)?.message ?? err).slice(0, 160));
  }
}

export async function deliverAlerts(tokens: string[]): Promise<number> {
  if (!liveBot || !tokens.length) return 0;
  const { sends, deferred, capped } = await buildAlerts(tokens, liveBot.botInfo?.username);
  let sent = 0;
  for (const s of sends) {
    try {
      await liveBot.api.sendMessage(s.chatId, s.text, { link_preview_options: { is_disabled: true } });
      sent++;
    } catch (err) {
      // A user who blocked the bot or deleted the chat is not an error worth
      // retrying; the delivery is already claimed and will not be attempted
      // again for this token.
      console.warn(`[alerts] could not deliver ${s.token.slice(0, 10)} to ${s.userId}:`, String((err as any)?.message ?? err).slice(0, 120));
    }
  }
  if (sent || deferred || capped) {
    console.log(
      `[alerts] ${sent} sent` +
        `${deferred ? `, ${deferred} deferred to the next pass` : ''}` +
        `${capped ? `, ${capped} held by the hourly cap` : ''}`,
    );
  }
  return sent;
}

/**
 * Whether the index is current, stated plainly.
 *
 * "index stalled 26h ago" is the whole point: a number that has not moved in a
 * day should not sit silently among numbers that have.
 */
export function indexStatusLine(h: IndexHealth): string {
  if (h.behindSeconds === null) return 'index has never advanced, nothing below is current';
  if (h.stalled) {
    return `index stalled ${agoWords(h.behindSeconds)} ago, index-derived checks are withheld`;
  }
  return `index current, last advanced ${agoWords(h.behindSeconds)} ago`;
}

/**
 * What a sponsor is actually buying, in numbers anyone can ask for.
 *
 * Public and computed at call time from scan_events, because a media kit that
 * only the seller can see is a claim, not a number. The same floor rule as
 * every other statistic here: where the history is shorter than the window, the
 * window is stated rather than the number being presented as thirty days of it.
 * Never rounded up, never padded.
 */
export function sponsorText(now = Math.floor(Date.now() / 1000)): string {
  const n = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...(args as any[])) as { n: number }).n;

  const oldest = (db.prepare('SELECT MIN(ts) AS t FROM scan_events').get() as { t: number | null }).t;
  const historyDays = oldest === null ? 0 : (now - oldest) / 86_400;

  const since30 = now - 30 * 86_400;
  const since7 = now - 7 * 86_400;

  const scans30 = n('SELECT COUNT(*) n FROM scan_events WHERE ts >= ?', since30);
  const scans7 = n('SELECT COUNT(*) n FROM scan_events WHERE ts >= ?', since7);
  const users30 = n('SELECT COUNT(DISTINCT user_id) n FROM scan_events WHERE ts >= ? AND user_id IS NOT NULL', since30);
  const groups30 = n(
    "SELECT COUNT(DISTINCT chat_id) n FROM scan_events WHERE ts >= ? AND source = 'group' AND chat_id IS NOT NULL",
    since30,
  );
  const launches = n('SELECT COUNT(*) n FROM launches');

  // One row per day for the last seven, zeros included: a missing day is a real
  // zero and leaving it out would make a quiet week look like a busy short one.
  const daily = db
    .prepare(
      `SELECT CAST(ts / 86400 AS INTEGER) AS day, COUNT(*) AS n
         FROM scan_events WHERE ts >= ? GROUP BY day ORDER BY day ASC`,
    )
    .all(since7) as { day: number; n: number }[];
  const byDay = new Map(daily.map((d) => [d.day, d.n]));
  const today = Math.floor(now / 86_400);
  const series: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = today - i;
    const date = new Date(day * 86_400_000).toISOString().slice(5, 10);
    series.push(`  ${date}  ${byDay.get(day) ?? 0}`);
  }

  const short =
    historyDays < 30
      ? [
          `this bot has ${historyDays < 1 ? 'under a day' : `${Math.floor(historyDays)} days`} of history,`,
          'so the 30-day figures below cover only that. not extrapolated.',
          '',
        ]
      : [];

  return [
    'VITALS: sponsorship',
    '',
    ...short,
    `scans, last 30d   ${scans30.toLocaleString()}`,
    `scans, last 7d    ${scans7.toLocaleString()}`,
    `distinct users    ${users30.toLocaleString()} (30d)`,
    `distinct groups   ${groups30.toLocaleString()} (30d)`,
    `launches indexed  ${launches.toLocaleString()}`,
    '',
    'scans per day, last 7:',
    ...series,
    '',
    'one line, second from the bottom of every card. it points at a scan,',
    'never at a buy, and it is identical on every card, a sponsor cannot',
    'buy a different card, or a different reading of one.',
    '',
    'contact @siriusthemaster',
  ].join('\n');
}

export function statsText(): string {
  const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  const launches = q('SELECT COUNT(*) n FROM launches');
  const decoded = q('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count IS NOT NULL');
  const withExempt = q('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count > 0');
  const pct = decoded > 0 ? ((withExempt / decoded) * 100).toFixed(1) : '0.0';
  const hold = exemptedHoldTime();
  const scans = q('SELECT COUNT(*) n FROM scan_events');

  const cov = indexCoverage();
  const health = indexHealth();
  return [
    ...(cov.recovering ? ['index rebuilding after restart, counts below are incomplete'] : []),
    // First line, above the counts, because it is the one that decides whether
    // any of them mean anything. The index failed for a day without this, and
    // every count below stayed confidently wrong the whole time.
    indexStatusLine(health),
    // What the provider will actually serve. An operator switching to a paid
    // node needs to see that the bot noticed, and a cramped ceiling explains a
    // slow index without anyone having to read the log.
    providerLimitLine(),
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
    { command: 'scan', description: 'What the chain shows about a pons v2 launch' },
    { command: 'legend', description: 'What the markers on a card mean' },
    { command: 'ready', description: 'How many wallets are ready for launch' },
    { command: 'tge', description: 'Readiness totals and the countdown' },
    { command: 'stats', description: 'Index, cache and usage statistics' },
    { command: 'help', description: 'What this bot reports' },
  ]);

  console.log(`[bot] running as @${me.username}`);

  // Privacy mode and inline mode are BotFather settings, not API calls, so the
  // best the bot can do is report what it actually has and say how to fix it.
  if (me.can_read_all_group_messages) {
    console.warn(
      '[bot] WARNING: privacy mode is OFF. this bot can read every group message.\n' +
      '[bot]          Turn it on: BotFather -> /setprivacy -> Enable.\n' +
      '[bot]          The bot never acts on unaddressed group messages regardless,\n' +
      '[bot]          but with privacy off it still receives them.',
    );
  } else {
    console.log('[bot] privacy mode ON, only sees messages addressed to it');
  }
  if (me.supports_inline_queries) {
    console.log('[bot] inline mode enabled');
  } else {
    console.warn('[bot] WARNING: inline mode is disabled. BotFather -> /setinline to enable');
  }

  startCacheReporter();
  startQuotaSweeper();

  startReadyAutoPost(bot.api, me.username);
  startLaunchLoop(bot.api, me.username);

  // chat_member has to be asked for explicitly -- it is excluded from the
  // default update set, and without it the invite-link attribution records
  // nothing while looking like it works.
  await bot.start({
    // Every one of these is load bearing. chat_member is excluded from the
    // default set entirely, so invite attribution records nothing without it.
    // edited_message is a separate update type that 'message' does not cover,
    // which is the hole a fake CA edited into an old message would go through.
    // my_chat_member is how the bot learns it was demoted mid-launch, which
    // silently disables the guard.
    allowed_updates: [
      'message', 'edited_message', 'inline_query', 'callback_query',
      'chat_member', 'my_chat_member',
    ],
  });
}
