import { Bot, type Context } from 'grammy';
import type { InlineQueryResult } from 'grammy/types';
import { performScan, normaliseToken, looksLikeTxHash, inlineCacheSeconds, SCAN_FAILED, type ScanSource, type ScanOutcome } from './service.js';
import { scanCache, startCacheReporter } from './cache.js';
import { userQuota, floodQuota, scanSemaphore, startQuotaSweeper, formatRetry } from './quota.js';
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

/** The identity the limiters should key on for this update. */
function quotaIdentity(ctx: Context): number | undefined {
  const uid = ctx.from?.id;
  if (uid === undefined || uid === GROUP_ANONYMOUS_BOT_ID) return ctx.chat?.id ?? uid;
  return uid;
}

const EXAMPLE = '0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67';

const HELP = [
  '<b>VITALS</b> — pons v2 launch scanner, Robinhood Chain',
  '',
  'Send <code>/scan &lt;token address&gt;</code> for a card of what the chain shows.',
  '',
  'Works three ways, same card on each:',
  '  • <b>DM</b> — <code>/scan &lt;address&gt;</code>, or just paste an address',
  '  • <b>Groups</b> — <code>/scan &lt;address&gt;</code>',
  `  • <b>Inline</b> — type <code>@BOTNAME &lt;address&gt;</code> in any chat`,
  '',
  '<code>/full &lt;address&gt;</code> adds the technical detail behind every line.',
  '<code>/stats</code> shows what has been indexed.',
  '',
  'The card leads with concerns — the things fixed at creation, which are',
  'readable the second a token exists — and puts the counts underneath. There',
  'is no grade and no score. The absence of a raised flag is not an all-clear:',
  'the card says how many checks ran and how many could not be determined.',
  '',
  `<i>${DISCLAIMER}</i>`,
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

  const token = normaliseToken(raw);
  if (!token) {
    const hint = looksLikeTxHash(raw)
      ? 'That is a transaction hash, not a token address.\n'
      : '';
    await ctx.reply(
      `${hint}Send a pons v2 token address:\n/scan ${EXAMPLE}`,
      { ...replyOpts },
    );
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
    console.error(`[scan] unexpected failure for ${token} (${source}):`, err);
    outcome = { kind: 'error', message: SCAN_FAILED };
  }

  await deliver(ctx, notice, messageFor(outcome, full), replyOpts, full);
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
    const isTx = looksLikeTxHash(q);
    await answerShared([
      article(
        isTx ? 'invalid-tx' : 'invalid',
        isTx ? 'That is a transaction hash' : 'Not a token address',
        'Expected 0x followed by 40 hex characters',
        [
          'VITALS — pons v2 launch scanner',
          isTx
            ? 'That is a transaction hash, not a token address. Expected 0x followed by 40 hex characters, e.g.'
            : 'That is not a token address. Expected 0x followed by 40 hex characters, e.g.',
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
      parse_mode: 'HTML',
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
        await ctx.reply(`⏳ rate limited, try again in ${formatRetry(d.retryAfterSec)}`);
        return;
      }
    }
    await ctx.reply(statsText());
  });

  bot.on('inline_query', handleInline);

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
 * Median time an exempted wallet held before selling.
 *
 * Per wallet, per token: first sell minus first buy. Wallets that never sold are
 * excluded rather than counted as infinite -- they are still holding, which is
 * not the same measurement.
 *
 * Bounded by what has actually been indexed: trades are only indexed for tokens
 * someone scanned, so this is a sample of scanned launches, and the sample size
 * is reported alongside it rather than implied.
 */
function exemptedHoldTime(): { medianSeconds: number | null; samples: number } {
  const rows = db
    .prepare(
      `SELECT l.token AS token, l.snipe_exemptions AS ex FROM launches l
       WHERE l.snipe_exemption_count > 0 AND l.snipe_exemptions IS NOT NULL
         AND EXISTS (SELECT 1 FROM trades t WHERE t.token = l.token)
       LIMIT 500`,
    )
    .all() as { token: string; ex: string }[];

  const holds: number[] = [];
  const tradeStmt = db.prepare(
    `SELECT side, trader, recipient, block_time FROM trades WHERE token = ? ORDER BY block_number`,
  );

  for (const row of rows) {
    let exempt: string[];
    try {
      exempt = (JSON.parse(row.ex) as string[]).map((a) => a.toLowerCase());
    } catch (err) {
      console.warn(`[stats] unparseable snipe_exemptions for ${row.token}:`, String((err as Error)?.message ?? err).slice(0, 80));
      continue;
    }
    if (!exempt.length) continue;
    const set = new Set(exempt);
    const trades = tradeStmt.all(row.token) as
      { side: string; trader: string; recipient: string; block_time: number }[];

    const firstBuy = new Map<string, number>();
    for (const t of trades) {
      if (!t.block_time) continue;
      if (t.side === 'buy' && set.has(t.recipient) && !firstBuy.has(t.recipient)) {
        firstBuy.set(t.recipient, t.block_time);
      } else if (t.side === 'sell' && set.has(t.trader)) {
        const bought = firstBuy.get(t.trader);
        if (bought !== undefined && t.block_time >= bought) {
          holds.push(t.block_time - bought);
          firstBuy.delete(t.trader); // first round trip only
        }
      }
    }
  }

  if (!holds.length) return { medianSeconds: null, samples: 0 };
  holds.sort((a, b) => a - b);
  const mid = holds.length >> 1;
  const median = holds.length % 2 ? holds[mid]! : Math.round((holds[mid - 1]! + holds[mid]!) / 2);
  return { medianSeconds: median, samples: holds.length };
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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
    hold.medianSeconds === null
      ? 'median hold time of exempted wallets no data yet'
      : `median hold time of exempted wallets ${humanDuration(hold.medianSeconds)} (n=${hold.samples.toLocaleString()})`,
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

  await bot.start({ allowed_updates: ['message', 'inline_query'] });
}
