import { db } from './db.js';

/**
 * The median time an exempted wallet holds a token before selling it.
 *
 * Lifted out of bot.ts so the background indexer can ask how many pairs the
 * figure still needs without importing the Telegram layer, which would close a
 * cycle through service and scan. bot.ts re-exports it, so nothing that already
 * imported it from there had to change.
 */

/**
 * Below this many observations the median is not published.
 *
 * Thirty is the conventional floor for treating a sample as more than anecdote,
 * and this figure is the one most likely to be quoted out of context. It matters
 * most right after a redeploy: trades are only indexed for tokens someone
 * scanned, so n climbs through 1, 2, 3 as the index warms, and without a floor
 * every one of those values would publish as a median.
 */
export const MIN_HOLD_SAMPLES = Number(process.env.MIN_HOLD_SAMPLES || 30);

export interface HoldTime {
  medianSeconds: number | null;
  /**
   * Exempted-wallet-to-token pairs with at least one sell. One pair contributes
   * at most one observation -- its first round trip -- so this is a count of
   * distinct wallets caught selling, not of sell transactions.
   */
  pairs: number;
}

/**
 * Median time an exempted wallet held a token before selling it.
 *
 * The unit is the (token, exempted wallet) pair: first sell minus first buy, one
 * observation per pair. A wallet that never sold is excluded rather than counted
 * as infinite -- it is still holding, which is a different measurement. A pair
 * whose buy fell outside the indexed window cannot be measured either, since
 * there is no start time to subtract.
 *
 * Restricted to launches whose exemption set was read from the curve's own
 * SnipeTaxExempted events. The filter is the one the "beyond the deployer"
 * line two rows above it in /stats already uses, and it is asserted here
 * rather than left to the state of the index: a figure that is events-only by
 * accident is the exact shape of the 141s number that had to be withdrawn.
 * A row read any other way is excluded even when its list would have been
 * identical, because the point is that the code says where the number came
 * from.
 *
 * Drawn entirely from `trades`, which is only populated for tokens someone
 * scanned. That is the real bound on this figure: on the current index 183
 * launches carry exempted wallets but only a handful have any trade history at
 * all, so the population is far smaller than the launch count suggests. The
 * pair count is always reported beside the median for exactly that reason.
 */
export function exemptedHoldTime(): HoldTime {
  // Only launches that both carry exemptions and have a sell recorded -- a token
  // with no sell can contribute no pair, so there is nothing to scan it for.
  const rows = db
    .prepare(
      `SELECT l.token AS token, l.snipe_exemptions AS ex
       FROM launches l
       WHERE l.exemption_source = 'logs'
         AND l.snipe_exemption_count > 0
         AND l.snipe_exemptions IS NOT NULL
         AND EXISTS (SELECT 1 FROM trades t WHERE t.token = l.token AND t.side = 'sell')`,
    )
    .all() as { token: string; ex: string }[];

  const tradeStmt = db.prepare(
    `SELECT side, trader, recipient, block_time FROM trades
     WHERE token = ? ORDER BY block_number, log_index`,
  );

  const holds: number[] = [];

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

    // first buy per exempted wallet, consumed by that wallet's first sell
    const openedAt = new Map<string, number>();
    for (const t of trades) {
      if (!t.block_time) continue;
      if (t.side === 'buy') {
        // the recipient is who ends up holding, which is the wallet the
        // exemption was granted to
        if (set.has(t.recipient) && !openedAt.has(t.recipient)) {
          openedAt.set(t.recipient, t.block_time);
        }
      } else if (set.has(t.trader)) {
        const opened = openedAt.get(t.trader);
        if (opened !== undefined && t.block_time >= opened) {
          holds.push(t.block_time - opened);
          openedAt.delete(t.trader); // one observation per pair
        }
      }
    }
  }

  if (!holds.length) return { medianSeconds: null, pairs: 0 };
  holds.sort((a, b) => a - b);
  const mid = holds.length >> 1;
  const median = holds.length % 2 ? holds[mid]! : Math.round((holds[mid - 1]! + holds[mid]!) / 2);
  return { medianSeconds: median, pairs: holds.length };
}

/**
 * The /stats line, floor applied, saying where the number came from.
 *
 * The source is printed beside the figure rather than left to a footnote. A
 * median hold time is the single most quotable number this tool produces, and
 * the one that went out wrong, so the line has to survive being screenshotted
 * on its own.
 */
export const HOLD_TIME_SOURCE = "read from the curve's own events";

export function holdTimeLine(hold: HoldTime): string {
  if (hold.pairs < MIN_HOLD_SAMPLES) {
    return `median hold time of exempted wallets not published under ${MIN_HOLD_SAMPLES} observations`
      + ` (n=${hold.pairs.toLocaleString()}, ${HOLD_TIME_SOURCE})`;
  }
  return `median hold time of exempted wallets ${humanDuration(hold.medianSeconds!)}`
    + ` (n=${hold.pairs.toLocaleString()}, ${HOLD_TIME_SOURCE})`;
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

