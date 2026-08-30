import { db } from './db.js';

/**
 * Alerts on a shape the user chose, not a shape the bot judged.
 *
 * Users asked for alerts on "alpha launches". The bot must not decide what
 * alpha is -- that is a verdict, and a launch the bot called alpha that then
 * goes to zero is a screenshot of this tool making a call it has no business
 * making. So the question is inverted: the user picks a filter over facts that
 * are fixed at creation and readable from the index, and the bot reports when
 * the chain matches it. The filter's name is the whole explanation.
 *
 * Every filter here is a property of the launch itself, decided before anyone
 * traded. Nothing depends on price, volume, or a view about which wallets are
 * clever.
 */

export type FilterKey = 'buyback' | 'clean-deployer' | 'no-exemptions';

export interface FilterDef {
  key: FilterKey;
  /** What the chain has to look like. Stated as a fact, never as a merit. */
  describe: string;
  /**
   * Shown when subscribing, for a filter that matches most launches.
   *
   * A user who subscribes to something that fires on nine launches in ten has
   * signed up for a feed, and finding that out from the feed itself is the
   * worst way to find it out.
   */
  loud?: boolean;
}

export const FILTERS: FilterDef[] = [
  {
    key: 'buyback',
    describe: 'creator locked fees into the five-year buyback',
  },
  {
    key: 'clean-deployer',
    describe: 'deployer has no earlier launch in the index',
  },
  {
    key: 'no-exemptions',
    describe: 'zero wallets pre-exempted from the opening snipe tax',
    loud: true,
  },
];

export function isFilterKey(s: string): s is FilterKey {
  return FILTERS.some((f) => f.key === s);
}

export function filterDef(key: FilterKey): FilterDef {
  return FILTERS.find((f) => f.key === key)!;
}

interface LaunchRow {
  token: string;
  deployer: string;
  block_number: number;
  buyback_enabled: number | null;
  snipe_exemption_count: number | null;
}

/**
 * Which filters this launch matches.
 *
 * A column that was never decoded is not a match. `buyback_enabled` null means
 * the creation transaction has not been read, and reporting that as "no
 * buyback" -- or as a clean deployer -- would be the unread-window mistake in
 * another costume.
 */
export function matchingFilters(token: string): FilterKey[] {
  const row = db
    .prepare(
      `SELECT token, deployer, block_number, buyback_enabled, snipe_exemption_count
         FROM launches WHERE token = ?`,
    )
    .get(token.toLowerCase()) as LaunchRow | undefined;
  if (!row) return [];

  const out: FilterKey[] = [];
  if (row.buyback_enabled === 1) out.push('buyback');
  if (row.snipe_exemption_count === 0) out.push('no-exemptions');

  if (row.deployer) {
    const prior = db
      .prepare(
        `SELECT 1 FROM launches
          WHERE deployer = ? AND block_number < ? LIMIT 1`,
      )
      .get(row.deployer.toLowerCase(), row.block_number);
    if (!prior) out.push('clean-deployer');
  }
  return out;
}

/**
 * Below this many indexed launches in the window, no rate is published.
 *
 * Same floor, and the same reason, as every other published statistic here: a
 * "fires 3 times a day" computed from eleven launches is an anecdote wearing a
 * number's clothes, and this one exists precisely so a user can decide whether
 * to subscribe.
 */
export const MIN_RATE_SAMPLES = 30;

export interface FilterRate {
  key: FilterKey;
  /** Matches per day, or null when the index cannot support a rate. */
  perDay: number | null;
  /** Launches the rate was computed over. */
  n: number;
  days: number;
}

/**
 * How often each filter has fired, per day, over what the index actually holds.
 *
 * Measured over the span of the indexed launches themselves rather than a fixed
 * lookback: the index is not complete, and dividing a partial count by seven
 * days would understate every rate by however much of the week is missing.
 */
export function filterRates(days = 7): FilterRate[] {
  const since = Math.floor(Date.now() / 1000) - days * 86_400;

  // The denominator is the launches where the filter is DECIDABLE, not every
  // launch in the window. Most launches carry a NULL creation -- 42,484 of
  // 44,787 in one snapshot -- and counting an undecoded launch as "does not
  // match" is the unread-window mistake again: it is unknown, not a no.
  //
  // Measured, it is not a small difference. no-exemptions is 4.7% of all
  // launches and 92.1% of decoded ones, and 92% is the number a user needs to
  // hear before subscribing to it.
  const span = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(launched_at) AS lo, MAX(launched_at) AS hi
         FROM launches WHERE launched_at >= ?`,
    )
    .get(since) as { n: number; lo: number | null; hi: number | null };

  const decided = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN buyback_enabled = 1 THEN 1 ELSE 0 END) AS buyback,
              SUM(CASE WHEN snipe_exemption_count = 0 THEN 1 ELSE 0 END) AS noex
         FROM launches
        WHERE launched_at >= ? AND buyback_enabled IS NOT NULL
          AND snipe_exemption_count IS NOT NULL`,
    )
    .get(since) as { n: number; buyback: number | null; noex: number | null };

  // A deployer is clean on the launch that is its first anywhere in the index,
  // not merely its first inside the window -- otherwise a deployer with a long
  // history reads as clean the moment the window moves past it.
  const cleanRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT deployer, MIN(launched_at) AS first_at
           FROM launches WHERE deployer IS NOT NULL GROUP BY deployer
       ) WHERE first_at >= ?`,
    )
    .get(since) as { n: number };

  // Launches per day over the span actually observed. Floored so a burst in one
  // minute cannot divide by nearly zero and report thousands a day.
  const spanDays = Math.max(0.25, ((span.hi ?? 0) - (span.lo ?? 0)) / 86_400);
  const launchesPerDay = span.n / spanDays;

  const rate = (matches: number, denominator: number): number | null =>
    denominator < MIN_RATE_SAMPLES ? null : (matches / denominator) * launchesPerDay;

  return [
    {
      key: 'buyback',
      perDay: rate(decided.buyback ?? 0, decided.n),
      n: decided.n,
      days,
    },
    {
      key: 'clean-deployer',
      // Always decidable: every launch row has a deployer.
      perDay: rate(cleanRow.n, span.n),
      n: span.n,
      days,
    },
    {
      key: 'no-exemptions',
      perDay: rate(decided.noex ?? 0, decided.n),
      n: decided.n,
      days,
    },
  ];
}

/** How a rate reads on /filters. */
export function rateLine(r: FilterRate): string {
  const def = filterDef(r.key);
  if (r.perDay === null) {
    return `${r.key} — ${def.describe}\n  rate unknown (only ${r.n} indexed launches, need ${MIN_RATE_SAMPLES})`;
  }
  const per = r.perDay;
  const howOften =
    per >= 1 ? `~${Math.round(per)} a day` : per > 0 ? `~${(per * 7).toFixed(1)} a week` : 'not seen yet';
  return `${r.key} — ${def.describe}\n  ${howOften}`;
}
