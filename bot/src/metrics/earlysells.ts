import { db } from '../db.js';
import { POOL_MANAGER, WINDOW_30_MIN_BLOCKS } from '../config.js';

/**
 * What became of the wallets that bought in the opening window.
 *
 * The population is the opening window's buyers -- the same set the snipe
 * exemption flag cares about. The question is what they did afterwards, and
 * "afterwards" is the whole life of the token, not the window.
 *
 * That distinction is the entire point of this metric, and it is why it cannot
 * be computed from the trades table. That table holds the opening window and
 * nothing else -- measured on a graduated launch, `trades_indexed_to` sat
 * exactly at launch+30min with zero sells beyond it -- so "has since sold",
 * asked of it, silently collapses into "sold inside the window", which is the
 * round-tripper count under a different name. The card carried both lines
 * showing the same two numbers.
 *
 * So it is computed from the whole-life Transfer walk the holder reading
 * already does. A sale is a transfer to the curve (on the bonding curve) or to
 * the pool manager (after graduation); both are disposals into the market
 * rather than wallet-to-wallet moves, and both are visible in that walk.
 */
export interface EarlySells {
  /** Buyers in the opening window. */
  cohort: number;
  /** How many of them have sent tokens back to the curve or the pool since. */
  sold: number;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export function earlySellsFrom(
  logs: readonly { args: { from: unknown; to: unknown; value: unknown }; blockNumber: unknown }[],
  token: string,
  curve: string,
  launchBlock: number,
): EarlySells | null {
  // The cohort comes from the indexed window. No window, no cohort, and the
  // ratio is undetermined rather than "0 of 0".
  const covered = db
    .prepare('SELECT trades_indexed_to FROM launches WHERE token = ?')
    .get(token.toLowerCase()) as { trades_indexed_to: number | null } | undefined;
  if (!covered || covered.trades_indexed_to === null) return null;
  if (covered.trades_indexed_to < launchBlock + WINDOW_30_MIN_BLOCKS) return null;

  const cohort = new Set(
    (db
      .prepare(
        `SELECT DISTINCT recipient FROM trades
          WHERE token = ? AND side = 'buy'
            AND block_number >= ? AND block_number <= ?`,
      )
      .all(token.toLowerCase(), launchBlock, launchBlock + WINDOW_30_MIN_BLOCKS) as {
      recipient: string;
    }[]).map((r) => r.recipient.toLowerCase()),
  );
  if (!cohort.size) return null;

  const sinks = new Set([curve.toLowerCase(), POOL_MANAGER.toLowerCase()]);
  const sold = new Set<string>();
  for (const l of logs) {
    const from = String(l.args.from).toLowerCase();
    if (from === ZERO || !cohort.has(from)) continue;
    if (sinks.has(String(l.args.to).toLowerCase())) sold.add(from);
  }

  return { cohort: cohort.size, sold: sold.size };
}
