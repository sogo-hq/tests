import { Bot, InputFile, type Api, type Context } from 'grammy';
import type { InlineQueryResult } from 'grammy/types';
import { performScan, scanImage, normaliseToken, looksLikeTxHash, looksLikeSolanaAddress, inlineCacheSeconds, rateLimitFrom, rateLimitedMessage, SCAN_FAILED, type ScanSource, type ScanOutcome } from './service.js';
import { scanCache, startCacheReporter } from './cache.js';
import { userQuota, floodQuota, scanSemaphore, startQuotaSweeper } from './quota.js';
import { benchmarkCoverageLine, MIN_BENCHMARK_SAMPLES } from './metrics/benchmark.js';
import { indexHealth, agoWords, type IndexHealth } from './indexer/health.js';
import { providerLimitLine } from './providerlimits.js';
import {
  addWatch, listWatches, removeWatch, countWatches, rememberDm, dmChatFor, MAX_WATCHES,
  TIER_WATCH_LIMIT,
  addFilterWatch, listFilterWatches, removeFilterWatch,
} from './watch.js';
import { isFilterKey, filterDef, filterRates, rateLine } from './filters.js';
import { LEGEND, claimLegend } from './legend.js';
import { launchNotice, claimLaunchNotice } from './launchnotice.js';
import { age } from './card.js';
import { buildPosition, positionText } from './position.js';
import {
  grantAccess, revokeGrant as revokeAccessGrant, activeGrant, liveGrants, grantLine,
  groupLicensed, MAX_GRANT_DAYS,
} from './grants.js';
import { entitlement, entitlementLine } from './premium.js';
import { statusReport, statusText, resetWatchdog } from './watchdog.js';
import { startDecodeRun, stopDecodeRun, decodeStatusText } from './decoderun.js';
import { pinDocsHash, checkDocsPage, docsHashLine } from './declare.js';
import { shouldOnboard, markOnboarded, onboardingText } from './onboard.js';
import { addWatcher, removeWatcher, watchers, watchersText, MAX_WATCH_DELAY_SECONDS } from './launchwatch.js';
import { setSeatNote, MAX_SEAT_NOTE } from './roster.js';
import { commandList, COMMANDS, registeredNames } from './commands.js';
import { clamp, clampMessage, TELEGRAM_MAX_MESSAGE, ADDRESS_PATTERN, containsAddress } from './text.js';
import {
  tierOf, atLeast, thresholds, setThreshold, setVitalsToken, vitalsToken,
  grant, revokeGrant, linkedWallet, effectiveTier, type Tier,
} from './tiers.js';
import { issueNonce, linkMessage, linkBySignature, linkByTxHash, unlink, verifyAddress } from './holder.js';
import {
  subscribe as feedSubscribe, unsubscribe as feedUnsubscribe, setPaused, setFilters,
  subOf, parseFilters, describeFilters, behindCount, startFeedLoop,
} from './feed.js';
import {
  premiumPayAddress, expectPayment, creditPayment, PREMIUM_DAYS, PREMIUM_PRICE_WEI,
  startInboundLoop,
} from './inbound.js';
import {
  registerMember, addExternal, removeExternal, statusOf, allRows, refreshBalances,
  totals, snapshot, selfRegistrationOpen, setSetting, getSetting, getNumber, normaliseWallet,
  rememberJoin, inviteOf, joinedTooRecently,
  READY_MIN_ETH, REGISTER_COOLDOWN_MS,
} from './ready.js';
import {
  totalsBlock, isAdmin, gateHit, countdownLine, dueAutoPost, markAutoPost, dailyDue,
} from './tge.js';
import {
  parseLaunchTime, launchTimeLine, getLaunchPlan, clearLaunchPlan, resetCountdownMarks,
  retireLandedLaunch,
} from './launch.js';
import {
  launchChat, preflight, preflightLine, startLaunchLoop, retirePin,
  guardVerdict, guardActive, pinnedCa, offencesOf, recordOffence,
  alreadyHandled, markHandled, muteFor24h, GUARD_WARNING, GUARD_MUTED,
  launchDetected, ADDRESS_ANYWHERE,
} from './launchday.js';
import { ALERTS_PER_HOUR } from './alerts.js';
import { buildAlerts } from './alerts.js';
import { exemptedHoldTime, holdTimeLine, MIN_HOLD_SAMPLES, type HoldTime } from './holdtime.js';
export { exemptedHoldTime, holdTimeLine, MIN_HOLD_SAMPLES, type HoldTime };
import { concentrationCoverageLine } from './metrics/concentration.js';
import { inlineDescription, footerLine, GROUP_HANDLE } from './card.js';
import { db } from './db.js';
import {
  autoscanEnabled, setAutoscan, autoscanSetting, addressesIn, claimAutoReply,
  everAnswered, AUTOSCAN_DEDUPE_MS,
} from './autoscan.js';
import { recordBotChat, seedBotChatsFromActivity, type BotChatStatus } from './chats.js';
import {
  addSeat, setTier, removeSeat, liveSeats, seatTableForAdmin, publicRoster,
  totalShares, seatHistory, TIER_SHARES,
} from './roster.js';
import * as Ledger from './ledger.js';
import { toWei as toWeiEth } from './launchplan.js';
import { scout, scoutCsv, scoutMessage, scoutSerial, scoutSerialMessage, startScoutLoop } from './scout.js';
import { dailyNumbers, renderNumbersPng, numbersText } from './numbers.js';
import { taxStatsText } from './taxstats.js';
import {
  recordFirstCall, firstCallOf, renderLeaderboard, leaderboard,
  LEADERBOARD_WINDOWS,
} from './firstcall.js';
import { renderCallPng } from './image.js';
import {
  membershipOf, gateActive, joinMessage, joinButton, markJoined,
} from './membership.js';
import { renderGroupCard } from './groupcard.js';
import { holderBreakdown } from './metrics/concentration.js';
import type { ScanResult } from './scan.js';
import { marketSnapshot, resetMarketFor, MARKET_BUDGET_MS, type MarketSnapshot } from './metrics/market.js';
import { indexOneCurve } from './indexer/trades.js';
import {
  startDraft, answerDraft, draftOpen, clearDraft, signDraft, recentDeclarations,
  STEPS, DECLARE_PRICE, DECLARE_FREE_UNTIL, declarationCount,
  declarationLink, declarationOutcome, shortWallet, byId,
} from './declare.js';
import { renderDeclarationPng } from './image.js';
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
  'Send /scan <token address> for a card of what the chain shows. In a DM you',
  'can paste an address on its own, and @BOTNAME <address> works inline in any',
  'chat. Add it to a group: t.me/BOTNAME?startgroup=true',
  '',
  // Generated from the table every handler is registered against, so a
  // command cannot exist without a line here and a line cannot outlive its
  // command. Both directions are checked by a test.
  commandList(),
  '',
  'holding $VITALS unlocks access, not yield. tiers: 250k, 1M, 10M.',
  'one paid line at the bottom funds this. it never touches what a card says.',
  '',
  'No grade and no score. A check that found nothing is not a check that found',
  'the launch to be fine: the card says how many ran and how many could not be',
  'determined. /legend for the markers.',
  '',
  DISCLAIMER,
  '',
  'checkvitals.xyz',
  '@vitals_official: every change lands here first',
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
/**
 * The launch notice, appended once per user.
 *
 * /start and /legend are the two surfaces somebody reads deliberately rather
 * than scrolls past, so the line goes at the end of both. Claimed per user and
 * keyed on the notice itself, so it is said once, and said again only when it
 * changes from a date to an address.
 *
 * The card footer carries its own copy on every card; that is a different rule
 * and this one must not be made to serve it, or a group would see the line on
 * one card and not the next.
 */
function withLaunchNotice(text: string, userId: number | undefined): string {
  const notice = launchNotice();
  if (!notice || userId === undefined || !claimLaunchNotice(userId, notice)) return text;
  return `${text}\n\n${notice}`;
}

/**
 * The unit every market figure on every surface is in.
 *
 * One place, because a leaderboard in ETH beside a card in something else would
 * be two different numbers under one name. Most launches pair against the
 * native asset; a launch that does not is stated in its own pair on its card,
 * where the pair is known.
 */
function quoteUnit(): string {
  return process.env.QUOTE_SYMBOL || 'ETH';
}

function leaderboardTabs(active: number): { text: string; callback_data: string }[] {
  return LEADERBOARD_WINDOWS.map((d) => ({
    text: d === active ? `\u00b7 ${d}d \u00b7` : `${d}d`,
    callback_data: `lb:${d}`,
  }));
}

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

  /**
   * Who put this address in front of this group first, and what it was worth.
   *
   * Groups only: a DM has one reader and there is nobody to be first in front
   * of. Recorded on any route to a card, typed or automatic, because the person
   * who pasted the address is the caller whether or not they also typed /scan.
   * First writer wins and nothing overwrites it.
   */
  const callerId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (
    outcome.kind === 'ok' && parsed && chatId !== undefined && callerId !== undefined
    && ctx.chat?.type !== 'private' && !ctx.from?.is_bot
  ) {
    try {
      const mcap = Number(outcome.meta.mcapQuote || '0');
      if (Number.isFinite(mcap) && mcap > 0) {
        recordFirstCall({
          chatId, token, userId: callerId,
          username: ctx.from?.username ?? null,
          mcapQuote: mcap, blockNumber: outcome.meta.blockNumber,
        });
      }
    } catch (err) {
      // A call that cannot be recorded is not a card that should fail.
      console.warn('[firstcall] could not record:', String((err as Error)?.message ?? err).slice(0, 120));
    }
  }

  // The image is opt-in and lives behind this button. It is never rendered
  // automatically: it is slower than the text and most people do not want it.
  /**
   * In a group, and not /full, the card is the group card.
   *
   * Rendered here rather than in the service because it names who called this
   * address FIRST IN THIS CHAT: one cached string cannot serve two groups. The
   * findings go out on the scan's own timing, and the market block joins them
   * only if it is ready inside its budget; otherwise the message is sent
   * without it and edited once the read lands. A finding never waits on a price.
   */
  if (isGroup && !full && outcome.kind === 'ok' && outcome.result) {
    await deliverGroupCard(ctx, outcome.result, token, replyOpts);
    return;
  }

  const withImage =
    outcome.kind === 'ok'
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
    // A premium holder's renders are not metered. The flag is explicit rather
    // than a missing quota key, because service.ts falls back through userId
    // and chatId and a merely absent key still charges somebody.
    const premiumRender = ctx.from?.id !== undefined
      && atLeast(await effectiveTier(ctx.from.id), 'premium');
    const res = await scanImage({
      token,
      source,
      userId: ctx.from?.id,
      chatId: ctx.chat?.id,
      quotaKey,
      unlimited: premiumRender,
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
/**
 * The group card, with the market block on a budget.
 *
 * Two paths, and which one runs is decided by a clock rather than by whether
 * the data is available: the findings are what the card is for and they never
 * wait on a market read. Inside the budget the card goes out whole; past it the
 * card goes out without the market block and is edited when the read lands.
 *
 * A failed or late read is not an error anybody needs to see. The card was
 * already correct without it.
 */
async function deliverGroupCard(
  ctx: Context,
  result: ScanResult,
  token: string,
  replyOpts: Record<string, unknown>,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const opts = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
    ...replyOpts,
  };

  const pending = freshMarket(result);
  const market = await Promise.race([
    pending,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), MARKET_BUDGET_MS)),
  ]);

  const render = (m: MarketSnapshot | null) =>
    renderGroupCard(result, { chatId, botUsername: usernameOf(ctx), market: m });

  const first = render(market);
  const sent = await ctx.reply(first.text, {
    ...opts,
    reply_markup: { inline_keyboard: first.buttons },
  });
  if (market) return;

  // The read is still running. When it lands the same card is rendered again,
  // with the block, and edited over the one already on screen.
  try {
    const late = await pending;
    if (!late) return;
    const second = render(late);
    if (second.text === first.text) return;
    await ctx.api.editMessageText(sent.chat.id, sent.message_id, second.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: second.buttons },
    });
  } catch (err) {
    // The card on screen is already right. A market block that never arrives is
    // a missing line, not a wrong one.
    console.warn('[market] could not edit the block in:', String((err as Error)?.message ?? err).slice(0, 140));
  }
}

/**
 * Bring the trade log up to the head, then read the block off it.
 *
 * The slow part is the indexing, not the arithmetic: the snapshot itself is a
 * query against a local table. A token whose log is already current comes back
 * immediately, which is the common case in a group where the same addresses
 * are pasted repeatedly.
 */
async function freshMarket(r: ScanResult): Promise<MarketSnapshot | null> {
  const input = {
    token: r.reads.token,
    mcapQuote: r.reads.mcapInQuote,
    liquidityQuote: Number(r.reads.realQuoteReserve) / 10 ** r.reads.pairDecimals,
    pairDecimals: r.reads.pairDecimals,
    currentBlock: r.currentBlock,
  };
  const have = marketSnapshot(input);
  if (have.complete) return have;
  try {
    await indexOneCurve(
      r.reads.curve, r.reads.token,
      BigInt(Math.max(0, r.launchBlock)), BigInt(r.currentBlock),
    );
  } catch (err) {
    console.warn('[market] trade read failed:', String((err as Error)?.message ?? err).slice(0, 140));
    // What is already in the log is still real, and less of a window than it
    // names is what `complete: false` on the card says.
    return have;
  }
  resetMarketFor(r.reads.token);
  return marketSnapshot(input);
}

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

  // Empty query: tell the user what to paste rather than returning nothing.
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
    // Not an error, an explanation. An empty inline result list just shows a
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

/**
 * Anything shaped like an address, wherever it sits in the text.
 *
 * For DETECTION only. Case-insensitive on the prefix and the body, and happy
 * with punctuation on either side, because a reader can copy an address out of
 * backticks or a trailing comma just as easily.
 */
const LOOSE_ADDRESS = new RegExp(ADDRESS_PATTERN);

/** Split on line boundaries so a CSV row is never cut in half. */
function chunkText(text: string, limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > limit) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
    // A single line longer than the limit still has to go somewhere.
    while (cur.length > limit) { out.push(cur.slice(0, limit)); cur = cur.slice(limit); }
  }
  if (cur) out.push(cur);
  return out;
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

/**
 * Per chat, not one global slot.
 *
 * Held as a single slot first, which meant a second chat defeated the whole
 * ten-minute cache: a group post, a DM /tge a minute later, and the group's
 * next /ready all posted fresh blocks, because each one found the slot pointing
 * at somebody else's chat. The documented flow is a group plus DMs, so that was
 * the normal case rather than an edge.
 */
const blocks = new Map<number, { messageId: number; readAt: number }>();

/** For tests, and for a restart to behave like a cold one. */
export function resetReadyBlockCache(): void {
  blocks.clear();
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
  const cached = blocks.get(chatId);
  const fresh = opts.force || !cached || now - cached.readAt >= BLOCK_TTL_MS;
  if (fresh && !opts.force) {
    await refreshBalances(now);
    snapshot(now);
  }
  const readAt = fresh ? now : cached!.readAt;
  const members = await memberCount(api, chatId);
  const t = totals();
  const body = totalsBlock({
    members,
    now,
    name: getSetting('launch_name'),
    botUsername: opts.botUsername,
    updatedMinutesAgo: fresh ? undefined : Math.round((now - readAt) / 60_000),
  }, t);
  // The countdown rides on whether a launch time EXISTS, not on which command
  // asked. Keyed to the command, a /ready inside the window would edit the block
  // /tge had just posted and silently strip its countdown line.
  const countdown = countdownLine(now);
  const text = countdown ? `${body}\n${countdown}` : body;

  // Inside the window, edit this chat's last block instead of adding one.
  if (!fresh && cached) {
    try {
      await api.editMessageText(chatId, cached.messageId, text);
      return 'edited';
    } catch (err) {
      // Edited too late, deleted, or unchanged. Falling through to a new post is
      // better than saying nothing to somebody who asked.
      console.warn('[ready] block edit failed, posting a new one:', String((err as Error)?.message ?? err).slice(0, 120));
    }
  }
  const sent = await api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
  blocks.set(chatId, { messageId: sent.message_id, readAt });
  // Remember where the block lives so the daily and threshold posts have a
  // group to go to without an admin configuring a chat id by hand. Only a real
  // group: a channel post carries no sender and would otherwise redirect every
  // scheduled post into the channel.
  if (opts.isGroup) setSetting('ready_chat', String(chatId));

  // The gate is announced in the group and nowhere else. Announced from any
  // chat, one member's DM /tge burned the global flag and the group never heard
  // it at all.
  const readyChat = Number(getSetting('ready_chat') || 0);
  if (opts.isGroup && chatId === readyChat && gateHit(t, members) && !getSetting('gate_announced')) {
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

  // Decide what can be decided for free FIRST. Refreshing every registered
  // balance before asking whether anything is due cost a full re-read of the
  // register once a minute -- 288,000 chain reads a day at 200 wallets, to
  // publish two posts -- and made a tick routinely outlast its own interval.
  const daily = dailyDue(now);
  const pollDue = now - getNumber('autopost_polled_at', 0) >= THRESHOLD_POLL_MS;
  if (!daily && !pollDue) return false;

  await refreshBalances(now);
  setSetting('autopost_polled_at', String(now));
  const t = totals();
  const reason = daily ? 'daily' as const : dueAutoPost(now, t.wallets);
  if (!reason) return false;
  const chatId = Number(chat);
  try {
    // A scheduled post is always a new message: editing a block from hours ago
    // would make the daily post invisible to everyone who has scrolled past.
    blocks.delete(chatId);
    await postTotals(api, chatId, { botUsername: opts.botUsername, isGroup: true, now, force: true });
  } catch (err) {
    console.warn('[ready] auto-post failed:', String((err as Error)?.message ?? err).slice(0, 160));
    return false;
  }
  markAutoPost(reason, now, t.wallets);
  console.log(`[ready] auto-posted (${reason}) · ${t.wallets} wallets`);
  return true;
}

/** How often the threshold trigger is allowed to cost a full balance refresh. */
const THRESHOLD_POLL_MS = Number(process.env.READY_POLL_MS || 300_000) || 300_000;

export function startReadyAutoPost(api: Api, botUsername?: string, intervalMs = 60_000): NodeJS.Timeout {
  // A tick that refreshes balances and posts can outlast its interval, and two
  // overlapping ticks both saw the mark unset and both posted the daily block.
  // Single process, so an in-flight flag is the whole fix.
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    void readyAutoPostTick(api, { botUsername })
      .catch(() => {})
      .finally(() => { running = false; });
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
    // ONE group: the one the countdown is running in. The bot is a public
    // scanner that sits in many groups, and an unscoped guard deleted messages
    // and muted members in every one of them for the five days before somebody
    // else's launch, with no countdown there to explain it.
    if (ctx.chat!.id !== launchChat()) {
      await next();
      return;
    }
    // A command addressed to the bot is the bot's own advertised surface, and
    // /ready already deletes an address pasted with it. Treating `/scan 0x…`
    // as a fake-CA offence deleted the command, recorded a strike and DM'd a
    // warning, so using the tool during its own launch walked members into a
    // 24 hour mute.
    // caption_entities too: a chart screenshot captioned "/scan 0x…" has
    // entities undefined, so it was struck as a fake CA and the second one
    // muted the sender for a day, which is the exact outcome the exemption
    // exists to prevent.
    if ([...(msg.entities ?? []), ...(msg.caption_entities ?? [])]
      .some((e) => e.type === 'bot_command' && e.offset === 0)) {
      await next();
      return;
    }

    // Everything readable in the message, not just the body: a caption carries
    // an address as readily, a poll question is 300 characters of plain text
    // the guard cannot see otherwise, and a text_link hides the address in a
    // URL behind words like "BUY HERE".
    const text = [
      msg.text ?? '',
      msg.caption ?? '',
      (msg as any).poll?.question ?? '',
      ...(((msg as any).poll?.options ?? []) as any[]).map((o) => o?.text ?? ''),
      ...[...(msg.entities ?? []), ...(msg.caption_entities ?? [])].map((e: any) => e.url ?? ''),
    ].join(' ').trim();
    if (!text || !ADDRESS_ANYWHERE.test(text)) {
      // A global regex carries lastIndex between calls, so it is reset rather
      // than left to skip every other message.
      ADDRESS_ANYWHERE.lastIndex = 0;
      await next();
      return;
    }
    ADDRESS_ANYWHERE.lastIndex = 0;

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

  /**
   * Answer an address pasted in a group, when the group has asked to be.
   *
   * Registered after the fake-CA guard and before the commands, and it calls
   * next() on every path it does not act on. Off in every group until an admin
   * turns it on: a scanner that answers every address in every group it is in
   * is an unsolicited poster, which is both how a bot gets removed and a thing
   * nobody asked for.
   *
   * Never on an edit. An edited message re-delivers text already answered, and
   * the docs warn edits fire for unrelated field changes too, so a card would
   * arrive again for a typo fix.
   */
  const autoReply = async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message;
    const chatId = ctx.chat?.id;
    if (!msg || chatId === undefined || ctx.chat?.type === 'private') {
      await next();
      return;
    }
    if (!autoscanEnabled(chatId)) {
      await next();
      return;
    }
    // Our own cards carry addresses, and so does anything posted through us.
    if (msg.from?.is_bot || (msg as any).via_bot) {
      await next();
      return;
    }
    // A command is the bot's own surface and already does this explicitly.
    if ([...(msg.entities ?? []), ...(msg.caption_entities ?? [])]
      .some((e) => e.type === 'bot_command' && e.offset === 0)) {
      await next();
      return;
    }

    const found = addressesIn(msg);
    if (!found.length) {
      await next();
      return;
    }

    // One card per message even when somebody pastes a list. The first address
    // is the one they are talking about; the rest are noise or a rug of links.
    const address = found[0]!;

    // The launch room's pinned CA is answered once, ever. The countdown pins
    // it, a hundred people quote it, and the group does not need a hundred
    // cards, or one every ten minutes for a week.
    const pinned = pinnedCa()?.toLowerCase() ?? null;
    if (pinned && address === pinned && chatId === launchChat() && everAnswered(chatId, address)) {
      await next();
      return;
    }

    const kind = claimAutoReply(chatId, address);
    if (kind === 'repeat') {
      await ctx.reply(
        `already scanned in the last ${Math.round(AUTOSCAN_DEDUPE_MS / 60_000)} min`,
        {
          reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
          reply_markup: { inline_keyboard: [[{ text: 'Refresh', callback_data: `rf:${address}` }]] },
        },
      );
      return;
    }

    await handleScan(ctx, address);
    return;
  };

  bot.on('message', autoReply);

  /**
   * The DM gate.
   *
   * Private chats only. A group card is read by people who did not choose this
   * bot, and an inline result appears in a chat the bot is not even in; gating
   * either would make the tool useless where it is most useful and turn every
   * card into an advert for joining.
   *
   * An unreadable membership is not a refusal. The bot may not be an admin of
   * the channel, or Telegram may be having a minute, and neither is evidence
   * that a person is not a member.
   */
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!gateActive() || ctx.chat?.type !== 'private' || userId === undefined || isAdmin(userId)) {
      await next();
      return;
    }
    const verdict = await membershipOf(ctx.api, userId);
    if (verdict !== 'absent') {
      await next();
      return;
    }
    // Answered once per message, whatever the message was: a gate that only
    // caught /start would let every other command through.
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: joinMessage().split('\n')[0], show_alert: true });
      return;
    }
    await ctx.reply(joinMessage(), {
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: joinButton() },
    });
  });

  // Somebody joining lifts their own gate immediately rather than at the end of
  // the cache window.
  bot.on('chat_member', (ctx) => {
    const uid = ctx.chatMember?.new_chat_member?.user?.id;
    if (uid !== undefined) markJoined(uid);
  });

  /**
   * Turn the auto-reply on or off for this chat.
   *
   * Admins only, and per chat: one person deciding for one group is the whole
   * consent model, and an ordinary member switching it on for everyone else
   * would be the same unsolicited posting by another route.
   */
  bot.command('autoscan', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (userId === undefined || chatId === undefined) return;
    if (ctx.chat?.type === 'private') {
      await ctx.reply('autoscan is a group setting. run it in the group, as an admin.');
      return;
    }
    const arg = (ctx.match ?? '').toString().trim().toLowerCase();
    const current = autoscanSetting(chatId);
    if (arg !== 'on' && arg !== 'off') {
      await replyEphemeral(ctx, `autoscan is ${current.on ? 'on' : 'off'}. /autoscan on, /autoscan off`, {});
      return;
    }
    if (!(await isGroupAdmin(ctx, userId))) {
      await replyEphemeral(ctx, 'an admin of this group turns autoscan on or off', {});
      return;
    }
    setAutoscan(chatId, arg === 'on', userId);
    await ctx.reply(
      arg === 'on'
        ? 'autoscan on. an address posted here gets a card, once per address per '
          + `${Math.round(AUTOSCAN_DEDUPE_MS / 60_000)} min. /autoscan off to stop.`
        : 'autoscan off. addresses posted here are ignored. /scan still works.',
    );
  });


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
    // The permalink a declaration card carries, until the site route exists.
    const deep = /^d(\d+)$/.exec((ctx.match ?? '').toString().trim());
    if (deep) {
      const d = byId(Number(deep[1]));
      if (!d) {
        await ctx.reply('no declaration with that id');
        return;
      }
      // Read now, not when it was signed: the point of the hash is that the
      // page can change afterwards, so the answer has to come from today.
      const docs = await checkDocsPage(d);
      await ctx.reply([
        d.freeSlot !== null ? `founding declared launch #${d.freeSlot}` : `declaration ${d.id}`,
        '',
        d.canonical,
        '',
        `signed at block ${d.blockNumber.toLocaleString()}`,
        d.signature,
        '',
        docsHashLine(docs),
        declarationOutcome(d),
        '',
        'a claim made before the launch. nothing in it was checked against a chain.',
      ].join('\n'), { link_preview_options: { is_disabled: true } });
      return;
    }

    // Days remaining, when there are any. Nothing is said to somebody who has
    // no grant: a line reading "0 days" is an advert, not a status.
    let text = HELP.replace(/BOTNAME/g, usernameOf(ctx) ?? 'bot');
    const userId = ctx.from?.id;
    if (userId !== undefined && ctx.chat?.type === 'private') {
      const r = await tierOf(userId);
      if (r.state === 'ok' && r.grantUntil) {
        const days = Math.max(0, Math.ceil((r.grantUntil - Date.now()) / 86_400_000));
        if (days > 0) text += `\n\npremium: ${days} day${days === 1 ? '' : 's'} remaining`;
      }
    }
    // In a group, what THIS group is currently set to. A features list that
    // does not say whether the feature is on here answers the wrong question.
    if (ctx.chat?.type !== 'private' && ctx.chat?.id !== undefined) {
      const set = autoscanSetting(ctx.chat.id);
      text += `\n\nin this group: autoscan is ${set.on ? 'on' : 'off'}`
        + (set.setAt ? `, set ${agoWords(Math.floor(Date.now() / 1000) - set.setAt)} ago`
           : set.byDefault ? ', on because this group is licensed, never set here'
           : ', never changed')
        + '. an admin changes it with /autoscan on or /autoscan off.';
    }

    // Clamped rather than trusted to fit: the list is generated from the
    // command table, so it grows whenever a command is added, and a message
    // one character over the limit is not a truncated /help but no /help.
    await ctx.reply(clampMessage(withLaunchNotice(text, userId)), {
      // No preview: the footer carries a domain, and a link card would push the
      // text off the first screen.
      link_preview_options: { is_disabled: true },
    });
    // The markers mean nothing to somebody seeing them for the first time, and
    // the one thing a card cannot convey by itself is that a missing marker is
    // not an all-clear. Said once, on the way in.
    if (userId !== undefined && claimLegend(userId)) {
      await ctx.reply(withLaunchNotice(LEGEND, userId), { link_preview_options: { is_disabled: true } });
    }
  });

  bot.command('legend', (ctx) =>
    ctx.reply(withLaunchNotice(LEGEND, ctx.from?.id), { link_preview_options: { is_disabled: true } }),
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
      const res = addFilterWatch(userId, name, dm, undefined, await watchLimit(userId));
      if ('reason' in res && res.reason === 'limit') {
        await ctx.reply(await limitLine(userId, res.count));
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

    const res = addWatch(userId, kind, address, dm, undefined, await watchLimit(userId));
    if (!res.ok && res.reason === 'limit') {
      await ctx.reply(await limitLine(userId, res.count));
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

  /**
   * The card as an image, asked for directly.
   *
   * The same render the button produces; this exists because somebody sharing a
   * card elsewhere wants the picture first, not the text and then a tap.
   */
  bot.command('image', async (ctx) => {
    const raw = (ctx.match ?? '').toString().trim();
    const token = normaliseToken(raw) ?? recallToken(ctx.chat?.id);
    if (!token) {
      await replyOrPrompt(ctx, 'send a pons v2 token address: /image 0x…');
      return;
    }
    const source = sourceOf(ctx);
    const premiumRender = ctx.from?.id !== undefined
      && atLeast(await effectiveTier(ctx.from.id), 'premium');
    try {
      const res = await scanImage({
        token,
        source,
        userId: ctx.from?.id,
        chatId: ctx.chat?.id,
        quotaKey: quotaIdentity(ctx),
        unlimited: premiumRender,
        botUsername: usernameOf(ctx),
      });
      if (res.kind !== 'ok') {
        await ctx.reply(messageFor(res.outcome, false));
        return;
      }
      rememberToken(ctx.chat?.id, token);
      await ctx.replyWithPhoto(new InputFile(res.png, `vitals-${token.slice(0, 10)}.png`), {
        reply_parameters: ctx.message
          ? { message_id: ctx.message.message_id, allow_sending_without_reply: true }
          : undefined,
      });
    } catch (err) {
      console.error(`[image] render failed for ${token}:`, err);
      await ctx.reply(SCAN_FAILED);
    }
  });

  // ------------------------------------------------------------------ tiers

  /** What a gated command says when it cannot answer, rather than refusing. */
  const tierLine = async (userId: number): Promise<{ tier: Tier; note: string | null }> => {
    const r = await tierOf(userId);
    if (r.state === 'unlinked') {
      return { tier: 'none', note: 'link a wallet first: /holder link' };
    }
    if (r.state === 'undetermined') {
      // A check that did not run is not a check you failed.
      return { tier: 'none', note: `${r.reason}. try again` };
    }
    return { tier: r.tier, note: null };
  };

  /**
   * How many targets this user may watch.
   *
   * Nobody is ever cut back: somebody holding twenty watches from before these
   * limits existed keeps all twenty, and the limit only refuses a NEW one. A
   * cap is not a confiscation.
   */
  const watchLimit = async (userId: number): Promise<number> => {
    const r = await tierOf(userId);
    // A tier that could not be read must not silently demote somebody to the
    // free allowance, so an undetermined answer keeps the old flat limit.
    if (r.state === 'undetermined') return MAX_WATCHES;
    const tier = r.state === 'ok' ? r.tier : 'none';
    return TIER_WATCH_LIMIT[tier] ?? MAX_WATCHES;
  };

  const limitLine = async (userId: number, count: number): Promise<string> => {
    const r = await tierOf(userId);
    const tier = r.state === 'ok' ? r.tier : 'none';
    const more = tier === 'none'
      ? ` ${thresholds().watch.toLocaleString()} $VITALS held raises it to ${TIER_WATCH_LIMIT.watch}.`
      : tier === 'watch'
        ? ` ${thresholds().premium.toLocaleString()} $VITALS held removes the limit.`
        : '';
    return `that is ${count} watches, which is your limit. /unwatch one first.${more}`;
  };

  bot.command('token', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const arg = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    if (arg[0]?.toLowerCase() !== 'set' || !arg[1]) {
      const cur = vitalsToken();
      await ctx.reply(cur ? `$VITALS: ${cur}` : 'no $VITALS token set. /token set 0x…');
      return;
    }
    const set = setVitalsToken(arg[1]);
    await ctx.reply(set ? `$VITALS: ${set}` : 'that is not an address');
  });

  bot.command('tiers', async (ctx) => {
    const t = thresholds();
    const arg = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    if (arg[0]?.toLowerCase() === 'set') {
      if (!isAdmin(ctx.from?.id)) return;
      const res = setThreshold(arg[1] ?? '', arg[2] ?? '');
      if (res.ok) {
        await ctx.reply(`${res.tier}: ${res.from.toLocaleString()} → ${res.to.toLocaleString()}`);
        return;
      }
      await ctx.reply(
        res.reason === 'raise'
          ? `a threshold can only go down. ${res.current.toLocaleString()} is the current one, ` +
            'and raising it would take access from people who bought to have it'
          : res.reason === 'unknown-tier' ? 'which tier: watch, premium or desk'
          : 'that is not a number',
      );
      return;
    }
    const me = await tierLine(ctx.from?.id ?? 0);
    await ctx.reply([
      `watch    ${t.watch.toLocaleString()} $VITALS`,
      `premium  ${t.premium.toLocaleString()} $VITALS`,
      `desk     ${t.desk.toLocaleString()} $VITALS`,
      '',
      me.note ?? `you: ${me.tier}`,
    ].join('\n'));
  });

  bot.command('holder', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined || ctx.chat?.type !== 'private') return;
    const parts = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();

    if (sub === 'unlink') {
      await ctx.reply(unlink(userId) ? 'wallet unlinked' : 'no wallet linked');
      return;
    }
    if (sub === 'link' && parts[1]) {
      // A signature or a transaction hash, told apart by length.
      const arg = parts[1];
      const res = /^0x[0-9a-fA-F]{64}$/.test(arg)
        ? await linkByTxHash(userId, arg)
        : await linkBySignature(userId, arg);
      if (res.ok) {
        const t = await tierLine(userId);
        await ctx.reply(`linked ${res.wallet}\ntier: ${t.tier}`);
        return;
      }
      await ctx.reply(
        res.reason === 'no-nonce' ? 'that code has expired. /holder link for a new one'
        : res.reason === 'taken' ? 'that wallet is already linked to another account'
        : res.reason === 'unreadable' ? `could not check that: ${res.detail ?? 'unknown'}. try again`
        : `that did not verify${res.detail ? `: ${res.detail}` : ''}`,
      );
      return;
    }
    if (sub === 'link') {
      const nonce = issueNonce(userId);
      const verify = verifyAddress();
      const lines = [
        'prove the wallet is yours. sign this exact message in your wallet:',
        '',
        linkMessage(nonce),
        '',
        'then send: /holder link <signature>',
      ];
      if (verify) {
        lines.push(
          '',
          'custodial wallet that cannot sign? send 0.0001 ETH on Robinhood Chain to',
          verify,
          `with ${nonce} in the data field, then send: /holder link <tx hash>`,
        );
      }
      await ctx.reply(lines.join('\n'));
      return;
    }

    const wallet = linkedWallet(userId);
    const t = await tierLine(userId);
    await ctx.reply(wallet ? `${wallet}\ntier: ${t.tier}` : 'no wallet linked. /holder link');
  });

  // ------------------------------------------------------------------- feed

  bot.command('feed', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined || ctx.chat?.type !== 'private') {
      if (ctx.chat?.type !== 'private') {
        await replyEphemeral(ctx, 'the feed is a DM. message me directly.', {});
      }
      return;
    }
    const raw = (ctx.match ?? '').toString().trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();

    if (sub === 'pause' || sub === 'resume') {
      if (!subOf(userId)) { await ctx.reply('not subscribed. /feed on'); return; }
      setPaused(userId, sub === 'pause');
      await ctx.reply(sub === 'pause' ? 'feed paused. /feed resume when you want it back' : 'feed resumed');
      return;
    }
    if (sub === 'off') {
      await ctx.reply(feedUnsubscribe(userId) ? 'feed off' : 'not subscribed');
      return;
    }
    if (sub === 'filters') {
      const current = subOf(userId);
      if (!current) { await ctx.reply('not subscribed. /feed on'); return; }
      if (parts.length === 1) {
        await ctx.reply([
          `filters: ${describeFilters(current.filters)}`,
          '',
          'set them like: /feed filters exempt>0 tax>4 pair=eth mute 22:00-07:00',
          'pair is eth or stock: this chain pairs against native ETH or a tokenised',
          'equity, and has no stablecoin pair.',
          '/feed filters clear removes them.',
        ].join('\n'));
        return;
      }
      const parsed = parseFilters(parts.slice(1).join(' '));
      if (!parsed.ok) { await ctx.reply(parsed.reason); return; }
      setFilters(userId, parsed.filters);
      await ctx.reply(`filters: ${describeFilters(parsed.filters)}`);
      return;
    }

    const t = await tierLine(userId);
    if (!atLeast(t.tier, 'premium')) {
      await ctx.reply(t.note ?? `the feed is premium. ${thresholds().premium.toLocaleString()} $VITALS held, or /premium`);
      return;
    }
    const existing = subOf(userId);
    if (sub === 'on' || !existing) {
      feedSubscribe(userId);
      await ctx.reply('feed on. every new pons v2 launch, as the quick card, here. /feed filters to narrow it');
      return;
    }
    await ctx.reply([
      existing.paused ? 'feed paused' : 'feed on',
      `filters: ${describeFilters(existing.filters)}`,
      `${behindCount(existing)} launches not sent yet`,
    ].join('\n'));
  });

  // ---------------------------------------------------------------- premium

  bot.command('premium', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined || ctx.chat?.type !== 'private') return;
    const arg = (ctx.match ?? '').toString().trim();
    const parts = arg.split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();

    // Access without holding and without paying, for the people who are owed
    // it: a launch partner, somebody who found a real bug, the crew. It expires
    // on its own, and the holder path underneath it is untouched.
    if (sub === 'grant' || sub === 'ungrant') {
      if (!isAdmin(userId)) return;
      if (sub === 'ungrant') {
        await ctx.reply(revokeAccessGrant('wallet', parts[1] ?? '')
          ? `${parts[1]}: grant removed. holding and payments are unaffected.`
          : 'no grant on that wallet');
        return;
      }
      const days = Number((parts[2] ?? '').replace(/d$/i, ''));
      const res = grantAccess('wallet', parts[1] ?? '', days, userId, 'admin');
      if (!res.ok) {
        await ctx.reply(res.reason === 'subject'
          ? '/premium grant <wallet> <days>'
          : `days has to be a number from 1 to ${MAX_GRANT_DAYS}`);
        return;
      }
      await ctx.reply(`${res.grant.subject}: premium ${res.extended ? 'extended' : 'granted'} `
        + `until ${new Date(res.grant.expiresAt * 1000).toISOString().slice(0, 10)}`);
      return;
    }

    if (sub === 'status') {
      const wallet = linkedWallet(userId);
      if (!wallet) {
        await ctx.reply('no wallet linked. /holder link, then /premium status');
        return;
      }
      const e = await entitlement(wallet);
      const lines = [entitlementLine(e)];
      if (isAdmin(userId)) {
        const live = liveGrants('wallet');
        lines.push('', live.length
          ? `${live.length} wallet grant${live.length === 1 ? '' : 's'} live, soonest ${new Date(live[0]!.expiresAt * 1000).toISOString().slice(0, 10)}`
          : 'no wallet grants live');
      }
      await ctx.reply(lines.join('\n'));
      return;
    }

    if (/^0x[0-9a-fA-F]{64}$/.test(arg)) {
      const res = await creditPayment(arg);
      if (res.ok) {
        await ctx.reply(`premium until ${new Date(res.until).toISOString().slice(0, 10)}`);
        return;
      }
      await ctx.reply(
        res.reason === 'unlinked' ? 'that payment came from a wallet no account has linked. /holder link first'
        : res.reason === 'already_used' ? 'that payment has already been credited'
        : res.reason === 'too_little' ? `that was less than ${Number(PREMIUM_PRICE_WEI) / 1e18} ETH`
        : res.reason === 'wrong_recipient' ? 'that payment did not go to the premium address'
        : res.reason === 'not_found' ? 'no transaction with that hash'
        : res.reason === 'unconfigured' ? 'paid premium is not configured on this bot yet'
        : 'that transaction could not be read. try again',
      );
      return;
    }

    const to = premiumPayAddress();
    if (!to) { await ctx.reply('paid premium is not configured on this bot yet'); return; }
    if (!linkedWallet(userId)) {
      await ctx.reply('link the wallet you will pay from first: /holder link');
      return;
    }
    expectPayment(userId);
    await ctx.reply([
      `send ${Number(PREMIUM_PRICE_WEI) / 1e18} ETH to ${to} on Robinhood Chain from your linked wallet.`,
      `${PREMIUM_DAYS} days start when it lands.`,
      '',
      'send me the transaction hash and it is credited immediately: /premium <tx hash>',
    ].join('\n'));
  });

  bot.command('grant', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const parts = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    const target = Number(parts[0]?.replace(/^@/, ''));
    const m = /^(\d+)d$/.exec(parts[1] ?? '');
    if (!Number.isFinite(target) || target <= 0 || !m) {
      await ctx.reply('/grant <telegram user id> 30d   ·   /grant <id> revoke');
      return;
    }
    const g = grant(target, 'premium', Number(m[1]), 'admin');
    await ctx.reply(`${target}: premium until ${new Date(g.expiresAt).toISOString().slice(0, 10)}`);
  });

  bot.command('revoke', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const target = Number((ctx.match ?? '').toString().trim().replace(/^@/, ''));
    if (!Number.isFinite(target) || target <= 0) { await ctx.reply('/revoke <telegram user id>'); return; }
    await ctx.reply(revokeGrant(target) ? `${target}: grant revoked` : `${target}: no grant`);
  });

  // -------------------------------------------------------------------- desk

  /**
   * A DESK holder's one group licence.
   *
   * One per holder, enforced by a unique index rather than by counting here:
   * the whole point is that DESK buys one group, and "how many have you
   * licensed" is a question the database should not need to be asked twice.
   */
  bot.command('license', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const lparts = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    const lsub = lparts[0]?.toLowerCase();

    // A licence an admin hands to a group, with a date it lapses. The bought
    // licence in `licences` is untouched: this is checked alongside it, and a
    // group that holds one keeps it when the grant runs out.
    if (lsub === 'grant' || lsub === 'ungrant') {
      if (!isAdmin(userId)) return;
      const target = lparts[1] ?? (ctx.chat?.id !== undefined ? String(ctx.chat.id) : '');
      if (lsub === 'ungrant') {
        await ctx.reply(revokeAccessGrant('chat', target)
          ? `${target}: licence grant removed`
          : 'no licence grant on that chat');
        return;
      }
      const days = Number((lparts[2] ?? '').replace(/d$/i, ''));
      const res = grantAccess('chat', target, days, userId, 'admin');
      if (!res.ok) {
        await ctx.reply(res.reason === 'subject'
          ? '/license grant <chat id> <days>'
          : `days has to be a number from 1 to ${MAX_GRANT_DAYS}`);
        return;
      }
      await ctx.reply(`${res.grant.subject}: licensed ${res.extended ? 'for longer, ' : ''}`
        + `until ${new Date(res.grant.expiresAt * 1000).toISOString().slice(0, 10)}`);
      return;
    }

    if (lsub === 'status') {
      const chatId = ctx.chat?.id;
      const here = chatId === undefined ? null : groupLicensed(chatId);
      const g = chatId === undefined ? null : activeGrant('chat', String(chatId));
      const lines = ctx.chat?.type === 'private'
        ? ['/license status in the group you want to check']
        : [here?.licensed
            ? (here.via === 'holder' ? 'licensed by a holder' : grantLine(g)!)
            : 'not licensed'];
      if (isAdmin(userId)) {
        const live = liveGrants('chat');
        lines.push('', live.length
          ? `${live.length} licence grant${live.length === 1 ? '' : 's'} live, soonest ${new Date(live[0]!.expiresAt * 1000).toISOString().slice(0, 10)}`
          : 'no licence grants live');
      }
      await ctx.reply(lines.join('\n'));
      return;
    }

    if (ctx.chat?.type === 'private') {
      const row = db.prepare('SELECT chat_id FROM licences WHERE user_id = ?').get(userId) as { chat_id: number } | undefined;
      await ctx.reply(row ? 'your licence is active in one group' : 'run /license in the group you want to license');
      return;
    }
    const t = await tierLine(userId);
    if (!atLeast(t.tier, 'desk')) {
      await replyEphemeral(ctx, t.note ?? `a group licence is desk: ${thresholds().desk.toLocaleString()} $VITALS held.`, {});
      return;
    }
    const chatId = ctx.chat!.id;
    const held = db.prepare('SELECT user_id FROM licences WHERE chat_id = ?').get(chatId) as { user_id: number } | undefined;
    if (held && held.user_id !== userId) {
      await replyEphemeral(ctx, 'this group is already licensed.', {});
      return;
    }
    try {
      db.prepare(
        `INSERT INTO licences (chat_id, user_id, granted_at) VALUES (?,?,?)
         ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, granted_at = excluded.granted_at`,
      ).run(chatId, userId, Math.floor(Date.now() / 1000));
    } catch (err) {
      // The unique index on user_id: this holder has already licensed a group.
      console.warn('[license] refused:', String((err as Error)?.message ?? err).slice(0, 100));
      await replyEphemeral(ctx, 'you have already licensed a group. one licence per holder.', {});
      return;
    }
    await ctx.reply('licensed. premium commands are open to this group.');
  });

  bot.command('export', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined || ctx.chat?.type !== 'private') return;
    const t = await tierLine(userId);
    if (!atLeast(t.tier, 'desk')) {
      await ctx.reply(t.note ?? `/export is desk: ${thresholds().desk.toLocaleString()} $VITALS held.`);
      return;
    }
    const rows = db.prepare(
      `SELECT token, symbol, deployer, pair_token, block_number, launched_at,
              snipe_exemption_count, creator_tax_bps
         FROM launches ORDER BY block_number DESC LIMIT 20000`,
    ).all() as any[];
    if (!rows.length) { await ctx.reply('the index is empty'); return; }
    const csv = [
      'token,symbol,deployer,pair_token,block_number,launched_at,snipe_exemptions,creator_tax_bps',
      ...rows.map((r) => [
        r.token, JSON.stringify(r.symbol ?? ''), r.deployer, r.pair_token, r.block_number,
        r.launched_at,
        // NULL is undetermined, not zero, and a CSV that writes 0 here turns
        // "we could not decode it" into "there were none".
        r.snipe_exemption_count === null ? '' : r.snipe_exemption_count,
        r.creator_tax_bps === null ? '' : r.creator_tax_bps,
      ].join(',')),
    ].join('\n');
    await ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), `vitals-index-${rows.length}.csv`));
  });

  // ------------------------------------------------------------ ready / tge
  bot.command('ready', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const raw = (ctx.match ?? '').toString().trim();
    const inGroup = ctx.chat?.type !== 'private';
    // Telegram attributes an anonymous admin's message to GroupAnonymousBot, and
    // posting anonymously is the default for admins in most crypto groups. An
    // is_bot early return therefore exempted precisely the people most likely to
    // type `/ready add 0x… label` in the wrong window.
    const anonAdmin = userId === GROUP_ANONYMOUS_BOT_ID;
    if (ctx.from?.is_bot && !anonAdmin) return;

    // A wallet pasted in a group is deleted before anyone reads it, and nothing
    // is posted in its place: an address in the channel is exactly what
    // registering privately exists to avoid.
    //
    // Detection is deliberately looser than registration. normaliseWallet is a
    // REGISTRATION validator: it rejects a 0X prefix, a flipped letter that
    // breaks EIP-55, and anything with punctuation around it. Used as the
    // detector it let all of those through, and the miss then fell into the
    // totals branch so the bot replied in the group directly beneath the
    // surviving address. A wrong checksum is still a perfectly readable
    // address. Anything shaped like one goes.
    if (inGroup && LOOSE_ADDRESS.test(raw)) {
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
      // Minutes-old accounts are ignored in silence HERE, where answering makes
      // the group a place where saying /ready gets a reaction. In a DM it only
      // made the bot look dead to somebody who joined from a campaign link and
      // registered straight away.
      if (joinedTooRecently(userId) || anonAdmin) return;
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
        if (!rows.length) { await ctx.reply('no wallets registered'); return; }
        // Telegram rejects anything over 4096 characters, and the rejection was
        // swallowed by bot.catch -- so the register stopped being readable at
        // around forty wallets, silently, right as it started to matter.
        for (const chunk of chunkText(csv, 3900)) await ctx.reply(chunk);
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
      // No premium head start here. The 24 h early access belongs to a launch
      // ROOM, and rooms do not exist yet; wiring it to this gate instead would
      // open self-registration in the main group, which is admin-only by
      // decision rather than by accident.
      await ctx.reply('registration is handled by the team right now. ask an admin to add you');
      return;
    }

    const res = await registerMember(userId, parts[0]!, { inviteLink: inviteOf(userId) });
    if (!res.ok) {
      await ctx.reply(
        res.reason === 'claimed' ? 'a member already registered that wallet'
        : res.reason === 'malformed' ? 'that is not an address'
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

  /**
   * The bot's own membership, recorded.
   *
   * This update was already being requested for the launch guard and then
   * dropped on the floor, so "groups the bot is in" had no source. One row per
   * chat with the last status Telegram reported; a status of left or kicked is
   * as much a fact as one of member, and is the reason the count can go down.
   */
  bot.on('my_chat_member', async (ctx) => {
    const u = ctx.myChatMember;
    const status = u.new_chat_member.status as BotChatStatus;
    recordBotChat(u.chat.id, u.chat.type, 'title' in u.chat ? u.chat.title ?? null : null, status, u.date);

    // One message, the first time it is made an admin of a group, and then
    // nothing until it is asked something.
    if (u.chat.type === 'private') return;
    if (!shouldOnboard(u.chat.id, u.old_chat_member.status, status)) return;
    // Marked before the send: a retry that posts a second introduction into
    // somebody's room is worse than one that never posts a first.
    markOnboarded(u.chat.id);
    try {
      await ctx.api.sendMessage(u.chat.id, onboardingText(u.chat.id), {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.warn(`[onboard] could not post in ${u.chat.id}: ${String((err as Error)?.message ?? err).slice(0, 90)}`);
    }
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
    // A channel post carries no sender at all. Acted on, it would write the
    // channel's id into ready_chat and redirect every scheduled post there.
    if (!ctx.from || ctx.from.is_bot) return;
    if (ctx.chat?.type === 'channel') return;
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
      if (!addr) { await ctx.reply('/launch watch 0xDEPLOYER [delay seconds]'); return; }
      const chatId = ctx.chat?.id;
      if (chatId === undefined) { await ctx.reply('run this in the chat that should get the CA'); return; }
      // The delay is this chat's own. One room takes the CA the moment the
      // opening tax window closes; another takes it a few seconds later, so
      // neither is reading the other's screenshot.
      const delay = parts[2] === undefined ? 0 : Number(String(parts[2]).replace(/s$/i, ''));
      const added = addWatcher(chatId, delay, ctx.from?.id ?? null);
      if (!added.ok) {
        await ctx.reply(`the delay is seconds, 0 to ${MAX_WATCH_DELAY_SECONDS}`);
        return;
      }
      setSetting('launch_deployer', addr);
      const all = watchers();
      await ctx.reply([
        `watching ${addr.slice(0, 10)}… for its next launch.`,
        added.watcher.delaySeconds === 0
          ? 'this chat gets the CA as soon as it lands, posted and pinned.'
          : `this chat gets the CA ${added.watcher.delaySeconds}s after it lands, posted and pinned.`,
        `${all.length} chat${all.length === 1 ? '' : 's'} watching. /launch status lists them.`,
      ].join('\n'));
      return;
    }

    if (sub === 'unwatch') {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      await ctx.reply(removeWatcher(chatId)
        ? 'this chat will not get the CA. the others are unchanged.'
        : 'this chat was not watching.');
      return;
    }

    if (sub === 'set') {
      const res = parseLaunchTime(rest, Date.now());
      if (!res.ok) { await ctx.reply(res.reason); return; }
      const previous = getLaunchPlan();
      // A landed launch leaves launch_ca, the self-scan marks and the guard's
      // strike ledger behind. Stacking a new plan on top of them produced a
      // completely dead launch: the countdown never posts because a CA is
      // already set, the CA never posts because one is already claimed, and
      // members carry strikes from the launch before.
      retireLandedLaunch();
      setSetting('launch_at', String(Math.floor(res.at / 1000)));
      // A moved launch starts its countdown over. Keeping the ledger meant
      // every offset already consumed against the old time was dead for the
      // new one, so postponing by a day silently cancelled T-2d through
      // T-10min.
      resetCountdownMarks();
      const lines = [launchTimeLine(res.at)];

      // And the pinned post still showed the old time. If the new time is
      // further out than the first countdown offset, nothing is due for days,
      // so the group's one pinned message would sit there counting down to an
      // instant that has already passed. Take it down and say so, once.
      if (previous && previous.at !== res.at) {
        const chat = launchChat();
        if (chat !== null) {
          await retirePin(ctx.api, chat, 'countdown_pinned');
          try {
            await ctx.api.sendMessage(chat, `the launch has moved. ${launchTimeLine(res.at)}`);
          } catch (err) {
            console.warn('[launch] could not announce the new time:', String((err as Error)?.message ?? err).slice(0, 120));
          }
        }
      }

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
      lines.push('');
      lines.push(...watchersText());
      await ctx.reply(clamp(lines.join('\n'), TELEGRAM_MAX_MESSAGE));
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
      '/launch watch 0xDEPLOYER [delay seconds], in each chat that should get the CA',
      '/launch unwatch, in a chat that should not',
      '/launch status',
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
    // /stats tax: the creator-tax distribution and, per bracket, what traded
    // on the curve. Several aggregate queries, so it sits behind the same
    // flood cap as /stats itself and is not a second free way in.
    const sub = (ctx.match ?? '').toString().trim().toLowerCase();
    if (sub === 'tax') {
      await ctx.reply(clamp(taxStatsText(), TELEGRAM_MAX_MESSAGE));
      return;
    }
    await ctx.reply(statsText());
  });

  // ---------------------------------------------------------------- scout

  /**
   * /scout: graduated launches of the last week that exempted nobody beyond
   * the deployer, opened small, have holders, and gave socials.
   *
   * Admin and DM only. It is a list of launches to look at, not a list of
   * launches to buy: the criteria are the four facts named in the second line
   * of the message, and a launch that clears all four has cleared exactly
   * those and nothing else. The CSV carries the deployer address; the message
   * does not, so the same text can be posted into the crew chat unchanged.
   *
   * /scout serial: deployers with three or more launches and at least one
   * graduated. A count, stated as a count.
   */
  bot.command('scout', async (ctx) => {
    if (!isAdmin(ctx.from?.id) || ctx.chat?.type !== 'private') return;
    const sub = (ctx.match ?? '').toString().trim().toLowerCase();
    if (sub === 'serial') {
      await ctx.reply(clamp(scoutSerialMessage(scoutSerial()), TELEGRAM_MAX_MESSAGE));
      return;
    }
    const r = await scout();
    await ctx.reply(clamp(scoutMessage(r), TELEGRAM_MAX_MESSAGE));
    if (r.rows.length) {
      await ctx.replyWithDocument(new InputFile(Buffer.from(scoutCsv(r), 'utf8'), `vitals-scout-${r.rows.length}.csv`));
    }
  });

  /**
   * Where one wallet stood in one launch.
   *
   * Open to everyone, because the wallet is one the person typed rather than
   * one the bot knows about them. In a group it is still printed short: a full
   * address on screen in a room is a full address on screen in a room, however
   * it got there.
   */
  /**
   * The bot on itself. Admin only, and DM only: it names the armed launch and
   * the size of the watch list, neither of which belongs in a room.
   */
  bot.command('status', async (ctx) => {
    if (!isAdmin(ctx.from?.id) || ctx.chat?.type !== 'private') return;
    const sub = (ctx.match ?? '').toString().trim().toLowerCase();
    if (sub === 'reset') {
      resetWatchdog();
      await ctx.reply('watchdog cooldowns cleared. the next alert of each kind goes out immediately.');
      return;
    }
    await ctx.reply(clamp(statusText(statusReport()), TELEGRAM_MAX_MESSAGE));
  });

  /**
   * The re-decode, driven from a DM.
   *
   * The same work as the decode command on the box, turned inside the bot so
   * it can be started and watched without a shell on the server. Resumable by
   * construction: it selects the rows that still need reading, so stopping and
   * starting again continues from the rows rather than from a cursor.
   */
  bot.command('decode', async (ctx) => {
    if (!isAdmin(ctx.from?.id) || ctx.chat?.type !== 'private') return;
    const sub = (ctx.match ?? '').toString().trim().toLowerCase();

    if (sub === 'start') {
      const r = startDecodeRun();
      if (r.ok) {
        await ctx.reply([
          r.resumed
            ? 'resumed the run that was already going. the count and the clock carry over.'
            : 'started.',
          `${r.pending.toLocaleString()} rows to read from the curve's own events.`,
          '',
          'reads go below anything interactive in the limiter, so scans stay first.',
          '/decode status for where it is, /decode stop to halt it.',
        ].join('\n'));
        return;
      }
      await ctx.reply(r.reason === 'already-running'
        ? 'already running. /decode status'
        : 'nothing pending. every launch this build can decode has been read.');
      return;
    }

    if (sub === 'stop') {
      await ctx.reply(stopDecodeRun()
        ? 'stopping after the batch it is in. the rows already read stay read, and /decode start continues from there.'
        : 'not running.');
      return;
    }

    if (sub === 'status' || sub === '') {
      await ctx.reply(clamp(decodeStatusText(), TELEGRAM_MAX_MESSAGE));
      return;
    }

    await ctx.reply('/decode start | status | stop');
  });

  bot.command('position', async (ctx) => {
    const parts = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    const [wallet, token] = parts;
    if (!wallet || !token) {
      await ctx.reply('/position <wallet> <ca>');
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
      await ctx.reply('both have to be addresses. /position <wallet> <ca>');
      return;
    }
    const { row, result } = await buildPosition(token, wallet);
    const full = ctx.chat?.type === 'private';
    await ctx.reply(clamp(positionText(
      { wallet, token, symbol: row?.symbol ?? null }, result, full,
    ), TELEGRAM_MAX_MESSAGE));
  });

  // ----------------------------------------------------------------- seats

  /**
   * The roster. Admin, and DM only wherever a wallet is on screen.
   *
   * /seat list and /seat add echo a wallet, so they refuse to answer in a
   * group at all. /roster is the version built for the room and carries no
   * wallet, which is checked rather than trusted before it is sent.
   */
  bot.command('seat', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const parts = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? '').toLowerCase();
    const isDm = ctx.chat?.type === 'private';
    const at = Math.floor(Date.now() / 1000);
    const by = ctx.from?.id;

    if (sub === 'list' || sub === '') {
      if (!isDm) { await ctx.reply('/seat list shows wallets, so it answers in a DM only. /roster is the version for here'); return; }
      await ctx.reply(clamp(seatTableForAdmin(), TELEGRAM_MAX_MESSAGE));
      return;
    }
    if (sub === 'add') {
      if (!isDm) { await ctx.reply('/seat add carries a wallet, so it is a DM command'); return; }
      const [, handle, tier, wallet] = parts;
      if (!handle || !tier || !wallet) { await ctx.reply('/seat add <handle> <tier> <wallet>'); return; }
      const r = addSeat(handle, tier, wallet, { at, by });
      await ctx.reply(r.ok
        ? `seat ${r.value.seat}: ${r.value.handle} ${r.value.tier}, ${r.value.shares} share${r.value.shares === 1 ? '' : 's'}`
        : r.reason);
      return;
    }
    if (sub === 'note') {
      // DM only, like every seat view that carries a wallet. A note is written
      // about somebody rather than to them.
      if (ctx.chat?.type !== 'private') {
        await ctx.reply('/seat note is a DM. message me directly.');
        return;
      }
      const seatNo = Number(parts[1]);
      if (!Number.isInteger(seatNo) || seatNo <= 0) {
        await ctx.reply('/seat note <seat> <what it is for>');
        return;
      }
      const res = setSeatNote(seatNo, parts.slice(2).join(' '));
      if (!res.ok) {
        await ctx.reply(res.reason === 'no-seat'
          ? `no live seat ${seatNo}. /seat list`
          : `keep it under ${MAX_SEAT_NOTE} characters`);
        return;
      }
      await ctx.reply(res.cleared
        ? `seat ${res.seat}: note cleared`
        : `seat ${res.seat}: ${res.note}\n\nshown in /seat list and nowhere a group can see.`);
      return;
    }

    if (sub === 'tier') {
      const [, handle, tier] = parts;
      if (!handle || !tier) { await ctx.reply('/seat tier <handle> <tier>'); return; }
      const r = setTier(handle, tier, { at, by });
      await ctx.reply(r.ok
        ? `seat ${r.value.seat}: ${r.value.seat.handle ?? handle} ${r.value.from} to ${r.value.seat.tier}, now ${r.value.seat.shares} share${r.value.seat.shares === 1 ? '' : 's'}. recorded`
        : r.reason);
      return;
    }
    if (sub === 'remove') {
      const handle = parts[1];
      if (!handle) { await ctx.reply('/seat remove <handle>'); return; }
      const r = removeSeat(handle, { at, by });
      await ctx.reply(r.ok
        ? `seat ${r.value.seat} freed. ${r.value.handle} kept in the history, and the number goes to the next person added`
        : r.reason);
      return;
    }
    if (sub === 'history') {
      if (!isDm) { await ctx.reply('a DM command'); return; }
      const n = parts[1] ? Number(parts[1]) : undefined;
      const ev = seatHistory(Number.isFinite(n) ? n : undefined);
      if (!ev.length) { await ctx.reply('nothing recorded yet'); return; }
      const d = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
      await ctx.reply(clamp(ev.map((e) => e.event === 'tier'
        ? `${d(e.at)} seat ${e.seat} ${e.handle}: ${e.fromTier} to ${e.toTier}`
        : `${d(e.at)} seat ${e.seat} ${e.handle}: ${e.event}${e.toTier ? ` as ${e.toTier}` : ''}`).join('\n'), TELEGRAM_MAX_MESSAGE));
      return;
    }
    await ctx.reply([
      '/seat add <handle> <tier> <wallet>',
      '/seat list',
      '/seat tier <handle> <tier>',
      '/seat remove <handle>',
      '/seat history [seat]',
      '',
      `T1 ${TIER_SHARES.T1} shares · T2 ${TIER_SHARES.T2} · T3 ${TIER_SHARES.T3}`,
    ].join('\n'));
  });

  /** The room's version: seat, handle, tier. No wallet, ever. */
  bot.command('roster', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const text = publicRoster();
    // Checked, not trusted. This is the one roster view that can reach a group.
    if (containsAddress(text)) {
      console.error('[roster] a wallet reached the public roster; refusing to send');
      await ctx.reply('the roster could not be rendered without a wallet in it, so it was not sent');
      return;
    }
    await ctx.reply(clamp(text, TELEGRAM_MAX_MESSAGE));
  });

  // ---------------------------------------------------------------- ledger

  /**
   * The ledger. The bot computes and records; it never holds a key.
   *
   * Every view that names a wallet is a DM. /ledger post is the one that goes
   * to the room, and what it may contain is checked before it is sent.
   */
  bot.command('ledger', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const parts = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? 'preview').toLowerCase();
    const isDm = ctx.chat?.type === 'private';
    const dmOnly = async () => {
      await ctx.reply('that view names wallets, so it answers in a DM only');
    };

    if (sub === 'preview') {
      if (!isDm) { await dmOnly(); return; }
      const seats = liveSeats();
      if (!seats.length) { await ctx.reply('no seats yet. /seat add <handle> <tier> <wallet>'); return; }
      // An amount typed after the command is a hypothetical, said to be one.
      const typed = parts[1];
      let balance: bigint | null = null;
      let hypothetical = false;
      if (typed !== undefined) {
        if (!/^\d+(\.\d+)?$/.test(typed)) { await ctx.reply('/ledger preview [balance in ETH]'); return; }
        balance = toWeiEth(typed);
        hypothetical = true;
      } else {
        balance = await Ledger.feeWalletBalance();
        if (balance === null) {
          await ctx.reply(Ledger.feeWallet()
            ? 'the fee wallet balance could not be read. try again, or /ledger preview <eth> to check the table against a figure'
            : 'FEE_WALLET is not set. /ledger preview <eth> checks the table against a figure you give');
          return;
        }
      }
      // The receipts say what the payouts cost, and the cost left the wallet
      // with them, so gross income cannot be reconstructed without reading
      // them. Done before the sum, not after it.
      await Ledger.fillPaymentGas();
      const warnings = Ledger.unrecordedRuns().map((r) =>
        `run ${r.id} was previewed and has ${r.payments} payment${r.payments === 1 ? '' : 's'} with no transaction hash. `
        + `if it was paid, record it with /ledger tx ${r.id} <seat>:<hash> ... before the next run, or this one distributes it again.`);
      const run = Ledger.computeRun({ balanceWei: balance, seats, hypothetical });
      // A refused run is not saved: there is no table to pay, and a stored run
      // with no payable rows is something a later /ledger send would offer.
      if (!run.refusal) run.id = Ledger.saveRun(run);
      await ctx.reply(clamp(Ledger.previewText(run, { warnings }), TELEGRAM_MAX_MESSAGE));
      return;
    }

    const runFrom = (i: number) => {
      const id = parts[i] ? Number(parts[i]) : null;
      return id !== null && Number.isFinite(id) ? Ledger.loadRun(id) : Ledger.latestRun();
    };
    /**
     * The same, for the two views that feed the payer.
     *
     * Exploring a figure with /ledger preview <eth> leaves a hypothetical as
     * the latest run, and a csv exported from one carries real wallets beside
     * amounts nobody is owed. So these two never reach for a hypothetical by
     * default. Naming its id still exports it, and the file says what it is.
     */
    const payableRunFrom = (i: number) => {
      const id = parts[i] ? Number(parts[i]) : null;
      return id !== null && Number.isFinite(id) ? Ledger.loadRun(id) : Ledger.latestRealRun();
    };
    /** Why there is no run to hand over, when there are runs. */
    const noRun = (verb: string, cmd: string) => {
      const latest = Ledger.latestRun();
      return latest?.hypothetical
        ? `no run computed from the fee wallet to ${verb}. the latest run, ${latest.id}, was a hypothetical. `
          + `/ledger preview reads the wallet, or /ledger ${cmd} ${latest.id} takes the hypothetical anyway`
        : `no run to ${verb}. /ledger preview first`;
    };

    if (sub === 'csv') {
      if (!isDm) { await dmOnly(); return; }
      const run = payableRunFrom(1);
      if (!run) { await ctx.reply(noRun('export', 'csv')); return; }
      const name = `vitals-ledger-run-${run.id}.csv`;
      await ctx.replyWithDocument(new InputFile(Buffer.from(Ledger.csvText(run), 'utf8'), name));
      return;
    }
    if (sub === 'send') {
      if (!isDm) { await dmOnly(); return; }
      const run = payableRunFrom(1);
      if (!run) { await ctx.reply(noRun('send', 'send')); return; }
      await ctx.reply(clamp(Ledger.sendCommand(run, `vitals-ledger-run-${run.id}.csv`), TELEGRAM_MAX_MESSAGE));
      return;
    }
    if (sub === 'tx') {
      const run = parts[1] ? Ledger.loadRun(Number(parts[1])) : null;
      if (!run) { await ctx.reply('/ledger tx <run> <seat>:<hash> <seat>:<hash> ...'); return; }
      // Keyed by seat or by wallet. The payer only ever sees a wallet, because
      // that is all the CSV carries, so it is resolved back to a seat here
      // rather than asking anybody to look one up.
      const { txs, unmatched } = Ledger.parseTxArgs(run, parts.slice(2));
      if (!txs.length) { await ctx.reply('/ledger tx <run> <seat>:<hash> <seat>:<hash> ...'); return; }
      const r = Ledger.recordTxs(run.id!, txs);
      // Their gas is part of what left the wallet, so it is read now rather
      // than left for the next preview to notice.
      const gas = await Ledger.fillPaymentGas();
      const L = [`run ${run.id}: ${r.recorded} hash${r.recorded === 1 ? '' : 'es'} recorded`];
      if (r.already.length) L.push(`${r.already.length} seat${r.already.length === 1 ? ' already had one' : 's already had one'}, left as they were: ${r.already.map((a) => a.seat).join(', ')}`);
      if (r.unknown.length) L.push(`not in this run: seat ${r.unknown.join(', ')}`);
      if (unmatched.length) L.push(`no seat in this run holds ${unmatched.join(', ')}`);
      if (gas.failed) L.push(`${gas.failed} receipt${gas.failed === 1 ? '' : 's'} could not be read, so that gas is missing from gross income`);
      await ctx.reply(L.join('\n'));
      return;
    }
    if (sub === 'post') {
      // The room reads a post as what it was paid. A run computed against a
      // figure somebody typed is not that, so it is not reached for by default
      // here either, and naming its id is the whole of the decision to post it.
      const run = payableRunFrom(1);
      if (!run) { await ctx.reply(noRun('post', 'post')); return; }
      const text = Ledger.postText(run);
      // The public message is the one place a wallet must never reach, so it
      // is checked for one rather than assumed not to have any.
      if (containsAddress(text)) {
        console.error('[ledger] a wallet reached the public ledger post; refusing to send');
        await ctx.reply('the ledger post could not be rendered without a wallet in it, so it was not sent');
        return;
      }
      const room = launchChat();
      if (room && room !== ctx.chat?.id) {
        await ctx.api.sendMessage(room, clamp(text, TELEGRAM_MAX_MESSAGE));
        await ctx.reply(`posted to the room. run ${run.id}`);
      } else {
        await ctx.reply(clamp(text, TELEGRAM_MAX_MESSAGE));
      }
      return;
    }
    if (sub === 'sweep') {
      if (!isDm) { await dmOnly(); return; }
      const hash = parts[1];
      if (!hash) {
        const all = Ledger.sweeps();
        await ctx.reply(all.length
          ? clamp(['transfers out of the fee wallet, recorded:', ...all.map((w) =>
              `${new Date(w.at * 1000).toISOString().slice(0, 10)}  ${Ledger.eth(w.valueWei)} ETH to ${w.to}  ${w.txHash}`)].join('\n'), TELEGRAM_MAX_MESSAGE)
          : '/ledger sweep <tx hash>   records a transfer out of the fee wallet, after checking it is one');
        return;
      }
      const r = await Ledger.recordSweep(hash, { by: ctx.from?.id });
      await ctx.reply(r.ok
        ? `recorded: ${Ledger.eth(r.sweep.valueWei)} ETH to ${r.sweep.to}, gas ${Ledger.eth(r.sweep.gasWei, 6)} ETH, block ${r.sweep.block}.\n`
          + 'it counts toward gross income, so the room is still owed its share of it.'
        : r.reason);
      return;
    }
    if (sub === 'history') {
      if (!isDm) { await dmOnly(); return; }
      await ctx.reply(clamp(Ledger.historyText(), TELEGRAM_MAX_MESSAGE));
      return;
    }
    await ctx.reply([
      '/ledger preview [eth]   the table, from the fee wallet or a figure you give',
      '/ledger csv [run]       wallet,amount for the payer',
      '/ledger send [run]      the command to run on the machine with the key',
      '/ledger tx <run> <seat>:<hash> ...   record what was sent',
      '/ledger sweep <hash>    record a transfer out of the fee wallet',
      '/ledger post [run]      the public message for the room',
      '/ledger history         every run',
    ].join('\n'));
  });

  // -------------------------------------------------------------- numbers

  /**
   * /numbers: the day's counts as a picture, for the daily post.
   *
   * Admin only. Six counts from the bot's own index and nothing derived from
   * them: no growth figure, no comparison to yesterday, because a number that
   * only ever goes up is a marketing number and these are meant to be checked.
   * The index line on the card says when the counts come from an index that
   * had not finished.
   */
  bot.command('numbers', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return;
    const n = dailyNumbers();
    try {
      const png = renderNumbersPng(n, new Date(), usernameOf(ctx));
      await ctx.replyWithPhoto(new InputFile(png, `vitals-numbers-${n.day}.png`), { caption: numbersText(n) });
    } catch (err) {
      console.error('[numbers] render failed:', err);
      await ctx.reply(numbersText(n));
    }
  });

  // -------------------------------------------------------------- declare

  /**
   * A creator states what the launch will do, before it does it.
   *
   * DM only, and a form rather than one long command: six answers, then the
   * exact text to sign with the wallet that will deploy. The signature is what
   * makes it a declaration instead of a message, and the block it arrives at is
   * what makes it a statement about a launch that has not happened.
   */
  bot.command('declare', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    if (ctx.chat?.type !== 'private') {
      await replyEphemeral(ctx, 'declaring is a DM. message me directly.', {});
      return;
    }
    const parts = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();

    if (sub === 'cancel') {
      clearDraft(userId);
      await ctx.reply('form cleared. /declare to start again');
      return;
    }

    if (sub === 'sign' && parts[1]) {
      const res = await signDraft(userId, parts[1]);
      if (!res.ok) {
        await ctx.reply(
          res.reason === 'no-draft' ? 'no finished form. /declare to start one'
          : res.reason === 'wrong-wallet' ? `that was signed by ${res.detail}, which is not the wallet you named`
          : res.reason === 'bad-signature' ? 'that signature did not recover an address. paste the whole thing'
          : res.reason === 'not-entitled' ? DECLARE_PRICE
          : `could not read the chain to date this: ${res.detail ?? 'unknown'}. try again`,
        );
        return;
      }
      const d = res.declaration;
      await ctx.reply([
        d.freeSlot !== null
          ? `recorded. founding declared launch #${d.freeSlot}`
          : `recorded. declaration ${d.id}`,
        declarationLink(d.id, usernameOf(ctx)),
        '',
        'the badge appears on every scan of a token this wallet launches from here on.',
        'it says a claim exists. it does not soften a single check, and where the',
        'launch differs from what you signed, the card says so.',
      ].join('\n'), { link_preview_options: { is_disabled: true } });
      try {
        await ctx.replyWithPhoto(
          new InputFile(renderDeclarationPng(d), `vitals-declaration-${d.id}.png`),
        );
      } catch (err) {
        console.warn('[declare] card render failed:', String((err as Error)?.message ?? err).slice(0, 160));
      }
      return;
    }

    // What this costs, before the questions rather than after them. The
    // entitlement is checked again at the signature, where it is enforced; this
    // is only so nobody fills a form in to be turned away by it.
    const used = declarationCount();
    const price = used < DECLARE_FREE_UNTIL
      ? `the first ${DECLARE_FREE_UNTIL} declarations are free. this would be #${used + 1}.`
      : DECLARE_PRICE;

    const first = startDraft(userId);
    await ctx.reply([
      `${STEPS.length} questions, one answer per message. the last two may be skipped. `
        + '/declare cancel to stop.',
      price,
      '',
      `1 of ${STEPS.length}. ${first}`,
    ].join('\n'), { link_preview_options: { is_disabled: true } });
  });

  /** Every declaration, newest first, and how the launch that followed went. */
  bot.command('declared', async (ctx) => {
    const rows = recentDeclarations(10);
    if (!rows.length) {
      await ctx.reply('no declarations yet. /declare in a DM to make one');
      return;
    }
    const lines = ['declared launches, newest first', ''];
    for (const d of rows) {
      lines.push(`${d.freeSlot !== null ? `#${d.freeSlot}` : `id ${d.id}`}  ${shortWallet(d.deployer)}`);
      lines.push(`  dev buy ${d.devBuyPct}%, ${d.exemptCount} tax-free, ${d.creatorTaxBps} bps`);
      lines.push(`  ${declarationOutcome(d)}`);
    }
    await ctx.reply(lines.join('\n'), { link_preview_options: { is_disabled: true } });
  });

  /**
   * A call, as a picture somebody can post.
   *
   * Used as a reply to the message that made the call, which is the only thing
   * that identifies WHICH call: the same token can have been called in many
   * groups and this one is about this group's record of it.
   */
  bot.command('card', async (ctx) => {
    const chatId = ctx.chat?.id;
    const replied = ctx.message?.reply_to_message;
    if (chatId === undefined) return;
    if (ctx.chat?.type === 'private') {
      await ctx.reply('reply /card to the message that called it, in the group where it was called.');
      return;
    }
    if (!replied) {
      await replyEphemeral(ctx, 'reply /card to the message that called it', {});
      return;
    }
    const address = addressesIn(replied)[0];
    const call = address ? firstCallOf(chatId, address) : null;
    if (!call || call.mcapQuote === null) {
      await replyEphemeral(ctx, 'no call on record here for that address', {});
      return;
    }
    // The ranking already computes the peak after a call; one row of it is this
    // card, so the two can never disagree about the same number.
    const row = leaderboard(chatId, 3650).find((r) => r.token === call.token && r.userId === call.userId);
    if (!row) {
      await replyEphemeral(ctx, 'nothing has traded since that call yet', {});
      return;
    }
    try {
      await ctx.replyWithPhoto(
        new InputFile(
          renderCallPng({
            symbol: row.symbol, token: row.token, username: row.username,
            calledAt: row.calledAt, mcapQuote: row.mcapQuote, athQuote: row.peakQuote,
            multiple: row.multiple, quote: quoteUnit(), botUsername: usernameOf(ctx),
          }),
          `vitals-call-${row.token.slice(0, 10)}.png`,
        ),
        {
          reply_parameters: { message_id: replied.message_id, allow_sending_without_reply: true },
        },
      );
    } catch (err) {
      console.error('[card] render failed:', err);
      await replyEphemeral(ctx, 'could not render that card', {});
    }
  });

  // ---------------------------------------------------------- leaderboard

  /**
   * Who called what, here, ranked by how far it ran afterwards.
   *
   * Group only: the whole quantity is "first in front of this group", and a DM
   * has one reader. Two windows behind buttons rather than two commands,
   * because the interesting comparison is between them.
   */
  bot.command('leaderboard', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (ctx.chat?.type === 'private') {
      await ctx.reply('the leaderboard is per group. run it in a group.');
      return;
    }
    await ctx.reply(renderLeaderboard(chatId, LEADERBOARD_WINDOWS[0], quoteUnit()), {
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [leaderboardTabs(LEADERBOARD_WINDOWS[0])] },
    });
  });

  bot.callbackQuery(/^lb:/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const days = Number((ctx.callbackQuery?.data ?? '').slice(3));
    if (chatId === undefined || !LEADERBOARD_WINDOWS.includes(days as any)) {
      await ctx.answerCallbackQuery({ text: 'unrecognised window' });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(renderLeaderboard(chatId, days, quoteUnit()), {
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [leaderboardTabs(days)] },
      });
    } catch (err) {
      // Telegram refuses an edit that changes nothing, which is exactly what
      // pressing the tab you are already on does.
      console.warn('[leaderboard] edit refused:', String((err as Error)?.message ?? err).slice(0, 100));
    }
  });

  bot.on('inline_query', handleInline);

  // Only the chat surfaces get the button. An inline result is posted into a
  // chat the bot may not be in, so a photo reply to it has nowhere to go.
  bot.callbackQuery(/^img:/, handleImageButton);

  /**
   * Re-scan on demand, from the button a repeat paste gets.
   *
   * The dedupe window stops a second CARD, not a second look: somebody who
   * wants the current numbers presses this and gets them, which is the whole
   * reason a repeat is answered at all rather than ignored.
   */
  /** The full card, from the button on a group card. */
  bot.callbackQuery(/^fl:/, async (ctx) => {
    const token = normaliseToken((ctx.callbackQuery?.data ?? '').slice(3));
    if (!token) {
      await ctx.answerCallbackQuery({ text: 'unrecognised token', show_alert: false });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'reading…' });
    await handleScan(ctx, token, true);
  });

  /**
   * The holder breakdown, as an alert rather than a message.
   *
   * A group does not need another message for a number one person wanted, and
   * an alert is read by the person who pressed and nobody else. Free: it is the
   * balances the concentration reader already stores.
   */
  bot.callbackQuery(/^hd:/, async (ctx) => {
    const token = normaliseToken((ctx.callbackQuery?.data ?? '').slice(3));
    if (!token) {
      await ctx.answerCallbackQuery({ text: 'unrecognised token', show_alert: false });
      return;
    }
    const row = db.prepare('SELECT curve FROM launches WHERE token = ?').get(token.toLowerCase()) as
      | { curve: string } | undefined;
    const hb = row ? holderBreakdown(token, row.curve) : null;
    if (!hb) {
      await ctx.answerCallbackQuery({
        text: 'holder balances have not been read for this token yet',
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({
      text: [
        `${hb.holders.toLocaleString()} holders`,
        `top 5: ${hb.top.map((v) => `${v.toFixed(1)}%`).join(', ')}`,
        `top 5 together ${hb.top5.toFixed(1)}%, top 10 ${hb.top10.toFixed(1)}%`,
        'the curve and the protocol contracts are not counted as holders',
      ].join('\n'),
      show_alert: true,
    });
  });

  bot.callbackQuery(/^rf:/, async (ctx) => {
    const token = normaliseToken((ctx.callbackQuery?.data ?? '').slice(3));
    if (!token) {
      await ctx.answerCallbackQuery({ text: 'unrecognised token', show_alert: false });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'scanning…' });
    await handleScan(ctx, token);
  });

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
    const userId = ctx.from?.id;

    // An open form takes the message before anything else does. A creator part
    // way through /declare who is asked for the deployer address would
    // otherwise have that address scanned instead of recorded.
    if (userId !== undefined && draftOpen(userId)) {
      const res = answerDraft(userId, text);
      if (res.state === 'rejected') {
        await ctx.reply(`${res.error}.\n\n${res.step + 1} of ${STEPS.length}. ${res.prompt}`);
        return;
      }
      if (res.state === 'asked') {
        await ctx.reply(`${res.step + 1} of ${STEPS.length}. ${res.prompt}`);
        return;
      }
      if (res.state === 'complete') {
        // The docs page is read now, before the text is shown, so the bytes
        // that get hashed are the bytes the person just linked to. A page that
        // does not answer adds no line: signing is not blocked on a web server.
        const pinned = await pinDocsHash(userId);
        const canonical = pinned?.canonical ?? res.canonical;
        await ctx.reply([
          'sign this exact text with the deployer wallet:',
          '',
          canonical,
          '',
          pinned?.hash
            ? 'the docs line is pinned to the page as it is right now. change the page after signing and the card says so.'
            : 'the docs page could not be read, so there is no hash line. the link is signed, its contents are not.',
          '',
          'then send: /declare sign <signature>',
        ].join('\n'), { link_preview_options: { is_disabled: true } });
        return;
      }
    }

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

  /**
   * Exemptions BEYOND the deployer, over the rows the curve's own events
   * settled.
   *
   * Counted only where exemption_source is 'logs'. A count decoded from
   * calldata omits the deployer, so pooling the two would put launches that
   * exempted nobody but the dev into the "beyond the dev" column, which is the
   * one number here anyone would quote.
   */
  const fromLogs = q("SELECT COUNT(*) n FROM launches WHERE exemption_source = 'logs'");
  const beyond = q("SELECT COUNT(*) n FROM launches WHERE exemption_source = 'logs' AND snipe_exemption_count > 1");
  const beyondPct = fromLogs > 0 ? ((beyond / fromLogs) * 100).toFixed(1) : '0.0';
  const beyondCounts = db
    .prepare("SELECT snipe_exemption_count AS c FROM launches WHERE exemption_source = 'logs' AND snipe_exemption_count > 1 ORDER BY c")
    .all() as { c: number }[];
  const medianBeyond = beyondCounts.length >= MIN_BENCHMARK_SAMPLES
    ? (beyondCounts.length % 2
      ? beyondCounts[beyondCounts.length >> 1]!.c
      : (beyondCounts[(beyondCounts.length >> 1) - 1]!.c + beyondCounts[beyondCounts.length >> 1]!.c) / 2)
    : null;
  const declarations = q('SELECT COUNT(*) n FROM launch_declarations');
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
    // "launches with pre-exempted wallets" used to sit here as a share of every
    // decoded row. It counted the exemptions array, so a launch that exempted
    // only its deployer counted as exempting nobody, and the line read 6.8%
    // where the true answer is every launch. It is gone rather than repaired:
    // the split below is the question anybody was asking it.
    `exempting beyond the deployer ${beyond.toLocaleString()} (${beyondPct}% of ${fromLogs.toLocaleString()} read from the curve)`,
    medianBeyond === null
      ? `median count where any went beyond the deployer: not published under ${MIN_BENCHMARK_SAMPLES} observations (n=${beyondCounts.length.toLocaleString()})`
      : `median count where any went beyond the deployer ${medianBeyond} (n=${beyondCounts.length.toLocaleString()})`,
    `declarations recorded ${declarations.toLocaleString()}`,
    holdTimeLine(hold),
    // Whether the comparison on every card is running yet, and on how much. A
    // feature that is silent for want of data should say so where the numbers
    // live rather than just not appear.
    benchmarkCoverageLine(),
    concentrationCoverageLine(),
    `scans served ${scans.toLocaleString()}`,
  ].join('\n');
}

/**
 * Build the bot and fetch its identity, before anything can need it.
 *
 * Split out because the index tail, the launch detector and the alert handlers
 * all reach for liveBot.botInfo, and they were started BEFORE startBot ever ran
 * createBot. Production logged "Bot information unavailable, call await
 * bot.init()" from [launch] and [alerts] for exactly that reason: a launch
 * landing in the first seconds after boot was detected and then dropped.
 *
 * bot.init() is what populates botInfo. bot.start() also calls it, but that is
 * far too late for anything already running.
 */
export async function initBot(token = TELEGRAM_BOT_TOKEN): Promise<Bot> {
  const bot = createBot(token);
  await bot.init();
  return bot;
}

export async function startBot(existing?: Bot): Promise<void> {
  const bot = existing ?? await initBot();
  if (!bot.isInited()) await bot.init();
  const me = bot.botInfo;

  await bot.api.setMyCommands([
    { command: 'scan', description: 'What the chain shows about a pons v2 launch' },
    { command: 'image', description: 'The card as a picture, for sharing' },
    { command: 'legend', description: 'What the markers on a card mean' },
    { command: 'ready', description: 'How many wallets are ready for launch' },
    { command: 'holder', description: 'Link the wallet that holds your $VITALS' },
    { command: 'feed', description: 'Every new launch, in a DM (premium)' },
    { command: 'tiers', description: 'What each $VITALS tier unlocks' },
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

  // Groups known from activity before membership was recorded. Inserted only
  // where no row exists, so a real update is never overwritten by history.
  const seeded = seedBotChatsFromActivity();
  if (seeded) console.log(`[chats] seeded ${seeded} group(s) from activity`);

  startReadyAutoPost(bot.api, me.username);
  startLaunchLoop(bot.api, me.username);
  // The daily scout digest. No CREW_CHAT_ID, no post; the tick still runs so
  // the first-run mark is adopted the day the id is set rather than a day late.
  startScoutLoop(bot.api);
  startFeedLoop(bot.api);
  // Reads whole blocks, so it is inert unless a link challenge or a payment is
  // outstanding. See the comment in inbound.ts.
  startInboundLoop();

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
