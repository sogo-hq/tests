import { db } from '../db.js';
import { BLOCKS_PER_MINUTE } from '../config.js';

/**
 * What a buyer count means, measured against the launches around it.
 *
 * "5 buyers" is not a fact anyone can act on: a reader has no idea whether that
 * is a fast start or a dead one. The count is only informative next to what
 * launches of the same age normally do, so it is rendered as a comparison --
 * the number and its reference point, never a verdict. Nothing here may say
 * "above average", "strong" or "healthy": the reader draws the conclusion.
 */

export type AgeBucketKey = 'under5m' | 'to30m' | 'to2h' | 'to12h' | 'over12h';

export interface AgeBucket {
  key: AgeBucketKey;
  /** Inclusive lower edge, in seconds. */
  fromSeconds: number;
  /** Exclusive upper edge, in seconds. Infinity for the open-ended bucket. */
  toSeconds: number;
  label: string;
}

export const AGE_BUCKETS: readonly AgeBucket[] = [
  { key: 'under5m', fromSeconds: 0, toSeconds: 300, label: 'under 5m' },
  { key: 'to30m', fromSeconds: 300, toSeconds: 1800, label: '5-30m' },
  { key: 'to2h', fromSeconds: 1800, toSeconds: 7200, label: '30m-2h' },
  { key: 'to12h', fromSeconds: 7200, toSeconds: 43200, label: '2-12h' },
  { key: 'over12h', fromSeconds: 43200, toSeconds: Infinity, label: '12h+' },
];

export function bucketFor(ageSeconds: number): AgeBucket {
  const a = Math.max(0, ageSeconds);
  for (const b of AGE_BUCKETS) if (a >= b.fromSeconds && a < b.toSeconds) return b;
  return AGE_BUCKETS[AGE_BUCKETS.length - 1]!;
}

/**
 * Below this many launches behind a bucket, the median is not published.
 *
 * The same floor /stats uses for the hold time, for the same reason: a median
 * of four launches is an anecdote wearing a statistic's clothes, and this is a
 * number that will be screenshotted out of context.
 */
export const MIN_BENCHMARK_SAMPLES = Number(process.env.MIN_BENCHMARK_SAMPLES || 30);

export interface BuyerBenchmark {
  bucket: AgeBucket;
  /** Median unique buyers over the same window, across the bucket. Null below the floor. */
  median: number | null;
  /** Launches behind the median. Always reported, so a thin bucket is visible. */
  n: number;
  /** The window both sides were measured over, in minutes. */
  windowMinutes: number;
}

interface CountRow {
  buyers: number;
}

/**
 * Median unique buyers for launches given the same amount of time.
 *
 * Both sides are measured over the same elapsed window from their own launch
 * block, so a two-minute-old token is compared against what other launches had
 * done at two minutes -- not against their eventual totals. A launch is only
 * eligible if it actually lived that long; one that is younger than the window
 * has not had the chance and would drag the median down for no reason.
 *
 * The population is launches with indexed trades, which means launches somebody
 * has scanned: `indexOneCurve` runs on scan, not on backfill. That is a real
 * and severe bound early in an index's life, which is exactly what the sample
 * floor and the always-reported `n` exist to make visible.
 */
export function buyerBenchmark(opts: {
  ageSeconds: number;
  windowMinutes: number;
  excludeToken: string;
  now?: number;
}): BuyerBenchmark {
  const bucket = bucketFor(opts.ageSeconds);
  const windowMinutes = Math.max(0, opts.windowMinutes);
  const windowBlocks = Math.round(windowMinutes * BLOCKS_PER_MINUTE);
  const windowSeconds = Math.round(windowMinutes * 60);
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  if (windowBlocks <= 0) return { bucket, median: null, n: 0, windowMinutes };

  // LEFT JOIN, not an inner join on buys: a launch that had trades but no buy
  // inside the window is a real zero and has to stay in the population.
  const rows = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE
                WHEN t.side = 'buy'
                 AND t.block_number >= l.block_number
                 AND t.block_number <= l.block_number + ?
                THEN t.recipient END) AS buyers
         FROM launches l
         JOIN (SELECT DISTINCT token FROM trades) ht ON ht.token = l.token
         LEFT JOIN trades t ON t.token = l.token
        WHERE l.token <> ?
          AND (? - l.launched_at) >= ?
        GROUP BY l.token`,
    )
    .all(windowBlocks, opts.excludeToken.toLowerCase(), now, windowSeconds) as CountRow[];

  const counts = rows.map((r) => r.buyers).sort((a, b) => a - b);
  if (counts.length < MIN_BENCHMARK_SAMPLES) {
    return { bucket, median: null, n: counts.length, windowMinutes };
  }
  const mid = counts.length >> 1;
  const median = counts.length % 2 ? counts[mid]! : Math.round((counts[mid - 1]! + counts[mid]!) / 2);
  return { bucket, median, n: counts.length, windowMinutes };
}
