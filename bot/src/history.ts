import { db } from './db.js';

/**
 * What this token looked like the first time anyone pointed the bot at it.
 *
 * Every scan is already recorded with its token, its timestamp and the market
 * cap at the moment it ran. This surfaces that: somebody scans at 1.2 ETH, the
 * token moves, and the card they forwarded is the receipt.
 *
 * Stated as a fact and nothing more. Not "you found it early", not "good call",
 * no badge for being first -- the number and what it was worth at the time. A
 * first scan says nothing at all, because there is nothing to say yet.
 */
export interface FirstScan {
  /** Market cap in the pair asset when this token was first scanned. */
  mcap: number;
  /** Unix seconds of that first scan. */
  at: number;
  /** Scans since -- every user's, not just this one's. */
  since: number;
}

/**
 * The first recorded scan of a token, if there is one before this scan.
 *
 * `excludeScanId` is the scan being rendered. Without it a token's very first
 * scan would find itself in the table and report "first scanned here at" the
 * cap it is showing in the header a line above.
 */
export function firstScan(token: string, excludeScanId?: number): FirstScan | null {
  const key = token.toLowerCase();

  const first = db
    .prepare(
      `SELECT id, mcap_at_scan AS mcap, scanned_at AS at FROM scans
        WHERE token = ? AND mcap_at_scan IS NOT NULL AND id <> ?
        ORDER BY id ASC LIMIT 1`,
    )
    .get(key, excludeScanId ?? -1) as { id: number; mcap: string | null; at: number } | undefined;
  if (!first) return null;

  const mcap = Number(first.mcap);
  // A cap of zero is what a graduated curve reports, and a card that says
  // "first scanned here at 0" is worse than one that says nothing.
  if (!Number.isFinite(mcap) || mcap <= 0) return null;

  // Counted from scan_events, which records every request including the ones
  // served from cache -- that is what "22 scans" means to a reader. The scans
  // table would undercount, because an early re-scan deliberately reuses one row.
  const since = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM scan_events
        WHERE token = ? AND ts > ? AND outcome IN ('ok','not_found')`,
    )
    .get(key, first.at) as { n: number }).n;

  return { mcap, at: first.at, since };
}
