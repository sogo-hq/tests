import { db } from './db.js';
import { MIN_BENCHMARK_SAMPLES } from './metrics/benchmark.js';
import { compactAmount } from './card.js';
import { clamp, MAX_TICKER } from './text.js';

/**
 * Creator tax across the index, and what traded on the curve in each band.
 *
 * Two questions keep coming up in the group: what do creators on this factory
 * usually take, and does a higher cut go with less trading. Neither is answered
 * here. The distribution gives the rate and its reference points (median, p90,
 * both withheld under the sample floor) and the ranking gives the curve volume
 * band by band, with the launches it could not rank counted beside it. The
 * reader draws the line between the two, or does not.
 *
 * Everything is read from the local index. No chain call is made, so nothing
 * here can time out or half-finish; what the index does not hold is reported
 * as undecoded rather than as zero.
 */

export interface TaxBracket {
  key: '0' | '1-2' | '3-5' | '6-10';
  label: string;
  /** Inclusive lower edge, in whole percent after rounding. */
  lo: number;
  /** Inclusive upper edge, in whole percent after rounding. */
  hi: number;
}

/**
 * Bands by the tax rounded to the nearest whole percent.
 *
 * 250 bps is 2.5% and rounds up to 3, so it sits in 3-5 and not in 1-2. A
 * reader comparing the band with the rate a card prints ("creator takes 2.5%")
 * should expect that, and the band labels are deliberately whole numbers so the
 * rounding is visible rather than hidden behind a decimal edge.
 */
export const TAX_BRACKETS: readonly TaxBracket[] = [
  { key: '0', label: '0%', lo: 0, hi: 0 },
  { key: '1-2', label: '1-2%', lo: 1, hi: 2 },
  { key: '3-5', label: '3-5%', lo: 3, hi: 5 },
  { key: '6-10', label: '6-10%', lo: 6, hi: 10 },
];

/**
 * The factory's maxCreatorTaxBps. A bound on the bands, nothing more: it is
 * not read from the chain, and a stored rate above it is a row this module
 * cannot place, not a rate it invents a band for.
 */
const MAX_TAX_BPS = 1000;

/** The band a rate falls in, or null outside what the factory allows. */
export function bracketOf(bps: number): TaxBracket | null {
  if (!Number.isFinite(bps) || bps < 0 || bps > MAX_TAX_BPS) return null;
  const pct = Math.round(bps / 100);
  for (const b of TAX_BRACKETS) if (pct >= b.lo && pct <= b.hi) return b;
  return null;
}

export interface BracketCount {
  key: TaxBracket['key'];
  label: string;
  n: number;
  /** 0..1 of the launches with a known tax, so the four shares sum to one. */
  share: number;
}

export interface TaxDistribution {
  population: 'all' | 'graduated';
  /** Launches whose creator tax is decoded: the observations behind every figure here. */
  n: number;
  /**
   * Launches whose creation transaction has not been decoded (creator_tax_bps
   * IS NULL). Not zero, not in any band, and not in n: an undecoded launch is
   * not an observation of anything.
   */
  unknown: number;
  /** Null below MIN_BENCHMARK_SAMPLES. */
  medianBps: number | null;
  /** Nearest-rank 90th percentile, a rate some launch actually has. Null below the floor. */
  p90Bps: number | null;
  brackets: BracketCount[];
}

/**
 * The creator tax distribution over the index, or over graduated launches only.
 *
 * "Graduated" is phase 2 on the launches row, which the lifecycle indexer sets
 * from the factory's PoolGraduated event. Phase 1 (swept) is not graduated and
 * is not counted as such.
 *
 * The median and p90 share the buyer benchmark's floor, for the same reason:
 * these are the two numbers most likely to be quoted out of context, and a p90
 * of four launches is one launch wearing a percentile.
 */
export function taxDistribution(population: 'all' | 'graduated'): TaxDistribution {
  const where = population === 'graduated' ? 'WHERE phase = 2' : '';
  const rows = db
    .prepare(`SELECT creator_tax_bps AS bps FROM launches ${where}`)
    .all() as { bps: number | null }[];

  const known: number[] = [];
  let unknown = 0;
  for (const r of rows) {
    if (r.bps === null) unknown++;
    else known.push(r.bps);
  }
  known.sort((a, b) => a - b);
  const n = known.length;

  const counts = new Map<TaxBracket['key'], number>(TAX_BRACKETS.map((b) => [b.key, 0]));
  for (const bps of known) {
    // A rate the factory does not allow lands in no band. It stays in n, since
    // it is a decoded observation, and the shares then sum to just under one;
    // on this factory that cannot happen, and if it does the gap is the truth.
    const b = bracketOf(bps);
    if (b) counts.set(b.key, counts.get(b.key)! + 1);
  }
  const brackets: BracketCount[] = TAX_BRACKETS.map((b) => {
    const c = counts.get(b.key)!;
    return { key: b.key, label: b.label, n: c, share: n ? c / n : 0 };
  });

  if (n < MIN_BENCHMARK_SAMPLES) {
    return { population, n, unknown, medianBps: null, p90Bps: null, brackets };
  }
  const mid = n >> 1;
  const medianBps = n % 2 ? known[mid]! : (known[mid - 1]! + known[mid]!) / 2;
  // Nearest rank, as the concentration threshold is taken: the smallest
  // observed value with at least 90% of the sample at or below it. No
  // interpolation, so the published p90 is a rate some launch actually set.
  const rank = Math.max(1, Math.ceil(0.9 * n));
  const p90Bps = known[rank - 1]!;
  return { population, n, unknown, medianBps, p90Bps, brackets };
}

/** The zero address as pair_token means the launch is paired against native ETH. */
const ZERO = '0x0000000000000000000000000000000000000000';
const SEVEN_DAYS = 7 * 86400;
const WEI_PER_ETH = 1e18;

export interface VolumeRow {
  token: string;
  symbol: string | null;
  taxBps: number;
  /** Curve volume over the window, both sides, in whole ETH. */
  vol7dQuote: number;
  /** Curve trades inside the window, both sides. */
  trades: number;
  /**
   * As the lifecycle indexer stored it: the block the PoolGraduated event
   * landed in. Zero when the row is phase 2 without a recorded graduation,
   * which is a row this module reports rather than repairs.
   */
  graduatedAt: number;
}

/**
 * Graduated launches in one tax band, ranked by what traded on their curve in
 * the last seven days.
 *
 * The bot indexes CurveBuy and CurveSell and nothing else. Once a launch
 * graduates, its trading moves to the pool, and pool swaps are not indexed
 * anywhere in this codebase. So this is CURVE volume: for a launch that
 * graduated eight days ago it is zero by construction, and for one that
 * graduated yesterday it is the run-up and nothing after. The text this feeds
 * says so on every ranking, and the last line of the message says it again.
 *
 * quote_amount is wei of the pair token, and a sum over two different pair
 * tokens is not a number. Only launches paired against native ETH are ranked;
 * the graduated launches in the band on any other pair are counted and
 * returned as `excludedNonEth`, so the caller can say how many the ranking
 * left out rather than let the list read as complete.
 *
 * The sum is taken as REAL in SQLite. Wei values of the size a curve sees fit
 * in a double to fifteen significant digits, which is far finer than the
 * three decimals the text prints.
 */
export function topGraduatedByCurveVolume(
  key: TaxBracket['key'],
  now = Math.floor(Date.now() / 1000),
  limit = 10,
): { rows: VolumeRow[]; excludedNonEth: number } {
  const since = now - SEVEN_DAYS;
  // LEFT JOIN, so a graduated launch with no trade in the window is still a
  // row: it is the thing the non-ETH count has to see, and it is dropped from
  // the ranking below on its own zero rather than by never being read.
  const rows = db
    .prepare(
      `SELECT l.token AS token,
              l.symbol AS symbol,
              l.creator_tax_bps AS bps,
              l.pair_token AS pair,
              COALESCE(l.graduated_at, 0) AS graduatedAt,
              COALESCE(SUM(CAST(t.quote_amount AS REAL)), 0) AS vol,
              COUNT(t.tx_hash) AS trades
         FROM launches l
         LEFT JOIN trades t ON t.token = l.token AND t.block_time >= ?
        WHERE l.phase = 2
          AND l.creator_tax_bps IS NOT NULL
        GROUP BY l.token`,
    )
    .all(since) as {
      token: string; symbol: string | null; bps: number; pair: string;
      graduatedAt: number; vol: number; trades: number;
    }[];

  let excludedNonEth = 0;
  const ranked: VolumeRow[] = [];
  for (const r of rows) {
    if (bracketOf(r.bps)?.key !== key) continue;
    if (String(r.pair).toLowerCase() !== ZERO) {
      excludedNonEth++;
      continue;
    }
    // No trade inside the window is no observation, not a zero worth listing.
    if (r.trades === 0) continue;
    ranked.push({
      token: r.token,
      symbol: r.symbol,
      taxBps: r.bps,
      vol7dQuote: r.vol / WEI_PER_ETH,
      trades: r.trades,
      graduatedAt: r.graduatedAt,
    });
  }
  // Volume first, trade count as the tie-break, token last so two launches
  // that tie on both come out in the same order every time the message is
  // built.
  ranked.sort((a, b) =>
    b.vol7dQuote - a.vol7dQuote || b.trades - a.trades || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  return { rows: ranked.slice(0, Math.max(0, limit)), excludedNonEth };
}

/**
 * The line every message ends on. Exported so the caller that posts the text
 * can check it survived whatever clamping happened on the way out.
 */
export const POOL_TRADES_NOTE =
  'pool trades after graduation are not indexed, so volume is what traded on the curve';

/** A percentage, whole when it is whole and to one decimal when not: 40 -> "40", 33.33 -> "33.3". */
function pct(x: number): string {
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Basis points as a percentage, trimmed: 100 -> "1", 250 -> "2.5". */
function pctOfBps(bps: number): string {
  return pct(bps / 100);
}

const CONTROL_RE = /[ -]/g;

/**
 * The ticker as the default card prints it, or the token shortened when the
 * launch never gave one. The symbol comes from launch calldata and is capped by
 * nothing on chain, so it is clamped and stripped of control characters and
 * angle brackets here, where it enters a message.
 */
function ticker(r: VolumeRow): string {
  const s = r.symbol ? r.symbol.replace(CONTROL_RE, ' ').replace(/[<>]/g, '').trim() : '';
  if (s) return `$${clamp(s, MAX_TICKER).toUpperCase()}`;
  return `${r.token.slice(0, 6)}…${r.token.slice(-4)}`;
}

function distributionLines(d: TaxDistribution): string[] {
  const who = d.population === 'all' ? 'all launches' : 'graduated launches';
  return [
    `creator tax, ${who} (n=${d.n.toLocaleString()}, ${d.unknown.toLocaleString()} undecoded)`,
    '  ' + d.brackets.map((b) => `${b.label} ${b.n.toLocaleString()} (${pct(b.share * 100)}%)`).join(' · '),
    d.medianBps === null || d.p90Bps === null
      ? `  median and p90 not published under ${MIN_BENCHMARK_SAMPLES} observations (n=${d.n.toLocaleString()})`
      : `  median ${pctOfBps(d.medianBps)}% · p90 ${pctOfBps(d.p90Bps)}%`,
  ];
}

/**
 * The whole message: both distributions, then one ranking per band, then the
 * line that says what the rankings are made of.
 *
 * Every ranking heading names the window and the pair filter, because a line
 * reading "$ABC 12 ETH" with nothing around it would be screenshotted as the
 * token's volume, and it is the token's CURVE volume, which for a graduated
 * launch is the part of its life that is over.
 */
export function taxStatsText(now = Math.floor(Date.now() / 1000)): string {
  const lines: string[] = [
    ...distributionLines(taxDistribution('all')),
    ...distributionLines(taxDistribution('graduated')),
  ];

  for (const b of TAX_BRACKETS) {
    const { rows, excludedNonEth } = topGraduatedByCurveVolume(b.key, now);
    if (rows.length) {
      lines.push(`top by curve volume, last 7d, ETH pairs, ${b.label} tax:`);
      for (const r of rows) {
        lines.push(
          `  ${ticker(r)} · ${compactAmount(r.vol7dQuote)} ETH · ` +
          `${r.trades.toLocaleString()} trade${r.trades === 1 ? '' : 's'}`,
        );
      }
    } else {
      lines.push(`top by curve volume, ${b.label} tax: none traded on the curve in 7d`);
    }
    // Printed in both states: "none traded" with two launches on a WETH pair
    // left out of the count would be a claim about launches the ranking never
    // looked at.
    if (excludedNonEth > 0) {
      lines.push(
        `  ${excludedNonEth.toLocaleString()} graduated launch${excludedNonEth === 1 ? '' : 'es'} ` +
        'on other pairs not ranked',
      );
    }
  }

  lines.push(POOL_TRADES_NOTE);
  return lines.join('\n');
}
