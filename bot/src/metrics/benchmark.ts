import { db } from '../db.js';
import { BLOCKS_PER_MINUTE, WINDOW_30_MIN_BLOCKS } from '../config.js';

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
export const MIN_BENCHMARK_SAMPLES = (() => {
  // Number('abc') is NaN, and `n < NaN` is false -- a typo in the environment
  // would have silently switched the floor off and published a median of two.
  const raw = Number(process.env.MIN_BENCHMARK_SAMPLES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
})();

/** The longest window any traction metric is defined over. */
const MAX_WINDOW_MINUTES = WINDOW_30_MIN_BLOCKS / BLOCKS_PER_MINUTE;

/**
 * The windows a benchmark is ever taken over, in minutes.
 *
 * The comparison used to be measured over the token's EXACT age: a launch
 * scanned at 2m03s was compared over 1,230 blocks and one scanned at 2m08s
 * over 1,280, and because the population filter and the count window both
 * move with that number, two near-identical launches seconds apart printed
 * "index median 2 (n=2,040)", "index median 4 (n=2,023)" and "no index median
 * (n=0)" in turn. Every one of those was arithmetically correct and together
 * they read as noise.
 *
 * So the window is quantised: the largest step at or below the age. Every
 * launch between two and three minutes old is compared over two minutes,
 * against the same population, and gets the same answer. Below the smallest
 * step there is no comparison yet, and the card says from when there will be.
 */
export const BENCHMARK_LADDER_MINUTES: readonly number[] = [0.5, 1, 2, 3, 5, 10, 15, 20, 30];

/** The ladder step for a window, or 0 below the smallest step. */
export function ladderWindow(windowMinutes: number): number {
  let step = 0;
  for (const m of BENCHMARK_LADDER_MINUTES) {
    // A hair of tolerance: 600 blocks is exactly one minute, but a window
    // computed as blocks / 600 can land a float below it.
    if (windowMinutes + 1e-6 >= m) step = m;
  }
  return Math.min(step, MAX_WINDOW_MINUTES);
}

export interface BuyerBenchmark {
  /** The age band this token is in. Describes the token, not the population. */
  bucket: AgeBucket;
  /** Median unique buyers over the same window. Null below the floor. */
  median: number | null;
  /** Launches behind the median. Always reported, so a thin sample is visible. */
  n: number;
  /** The window both sides were measured over, in minutes. */
  windowMinutes: number;
  /**
   * True when the window is the token's whole life so far, which is what lets
   * the card say "at this age". Once a token passes the 30-minute cap the
   * measurement is no longer taken at its age and the card must not claim it is.
   */
  measuredAtAge: boolean;
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
 * The population is launches somebody has scanned, because `indexOneCurve` runs
 * on scan and not on backfill. That is a real and severe bound early in an
 * index's life, and it is self-selected -- these are the launches people asked
 * about. The sample floor and the always-reported `n` exist to make that bound
 * visible rather than to pretend it away.
 */
export function buyerBenchmark(opts: {
  ageSeconds: number;
  windowMinutes: number;
  excludeToken: string;
  /** Unused since coverage became a recorded fact; kept so callers need not change. */
  now?: number;
}): BuyerBenchmark {
  const bucket = bucketFor(opts.ageSeconds);
  // Quantised, so the answer is a function of the ladder step and the index,
  // never of the second the scan happened to land on.
  const windowMinutes = ladderWindow(Math.max(0, opts.windowMinutes));
  const windowBlocks = Math.round(windowMinutes * BLOCKS_PER_MINUTE);

  // "At this age" is true when the token is still inside the cap and the step
  // the benchmark used is the step its own age falls in: the two windows then
  // agree to within one rung of the ladder, which is the resolution the card
  // labels them at.
  const ageMinutes = Math.max(0, opts.ageSeconds) / 60;
  const measuredAtAge = windowMinutes > 0
    && ageMinutes <= MAX_WINDOW_MINUTES + 0.001
    && ladderWindow(ageMinutes) === windowMinutes;

  if (windowBlocks <= 0) return { bucket, median: null, n: 0, windowMinutes, measuredAtAge };

  // The population is launches whose opening window has actually been READ.
  // A launch that was read and had no buys is a real zero and belongs here;
  // selecting on the trades table instead dropped those and biased the median
  // upward, which on a card that exists to say whether a launch is dead is the
  // wrong direction to be wrong in.
  //
  // Coverage is a recorded fact, not an inference. It used to be derived from
  // how old a launch was when it was last scanned, which held only while
  // scanning was the only thing that indexed trades -- the background window
  // indexer now covers launches nobody has scanned, and every one of them would
  // have been invisible to this query.
  //
  // LEFT JOIN, not an inner join on buys: a launch with trades but no buy inside
  // the window is also a real zero.
  const rows = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE
                WHEN t.side = 'buy'
                 AND t.block_number >= l.block_number
                 AND t.block_number <= l.block_number + ?
                THEN t.recipient END) AS buyers
         FROM launches l
         LEFT JOIN trades t ON t.token = l.token
        WHERE l.token <> ?
          AND l.trades_indexed_to IS NOT NULL
          AND l.trades_indexed_to - l.block_number >= ?
        GROUP BY l.token`,
    )
    .all(windowBlocks, opts.excludeToken.toLowerCase(), windowBlocks) as CountRow[];

  const counts = rows.map((r) => r.buyers).sort((a, b) => a - b);
  if (counts.length < MIN_BENCHMARK_SAMPLES) {
    return { bucket, median: null, n: counts.length, windowMinutes, measuredAtAge };
  }
  const mid = counts.length >> 1;
  const median = counts.length % 2 ? counts[mid]! : Math.round((counts[mid - 1]! + counts[mid]!) / 2);
  return { bucket, median, n: counts.length, windowMinutes, measuredAtAge };
}


export interface BucketCoverage {
  bucket: AgeBucket;
  /** Launches whose opening window has been read far enough to answer this bucket. */
  n: number;
  /** The window a launch must cover to count, in minutes. */
  windowMinutes: number;
}

/**
 * How many launches each bucket can currently answer from.
 *
 * A bucket's window is the longest measurement it has to serve: the whole
 * bucket for the two below the thirty-minute cap, and thirty minutes for the
 * three above it, since the buyer count never looks further than that. So one
 * fully indexed launch answers every bucket, and a partially indexed one
 * answers only the short ones -- which is the distinction this reports.
 */
export function benchmarkCoverage(): BucketCoverage[] {
  const stmt = db.prepare(
    `SELECT COUNT(*) AS n FROM launches
      WHERE trades_indexed_to IS NOT NULL
        AND trades_indexed_to - block_number >= ?`,
  );
  return AGE_BUCKETS.map((bucket) => {
    const windowMinutes = Math.min(
      MAX_WINDOW_MINUTES,
      Number.isFinite(bucket.toSeconds) ? bucket.toSeconds / 60 : MAX_WINDOW_MINUTES,
    );
    const n = (stmt.get(Math.round(windowMinutes * BLOCKS_PER_MINUTE)) as { n: number }).n;
    return { bucket, n, windowMinutes };
  });
}

/** The /stats line: live once every bucket clears the floor, and honest before that. */
export function benchmarkCoverageLine(coverage = benchmarkCoverage()): string {
  const lowest = coverage.reduce((min, c) => Math.min(min, c.n), Infinity);
  const n = Number.isFinite(lowest) ? lowest : 0;
  return n >= MIN_BENCHMARK_SAMPLES
    ? `buyer benchmark: live (n=${n.toLocaleString()} per bucket)`
    : `buyer benchmark: not enough data yet (n=${n.toLocaleString()})`;
}
