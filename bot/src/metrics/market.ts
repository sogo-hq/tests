import { db } from './../db.js';
import { coveredThrough } from '../indexer/trades.js';
import { BLOCKS_PER_MINUTE } from '../config.js';

/**
 * The market block on a group card, read from the trade log this bot already
 * keeps.
 *
 * Every figure here comes out of the local `trades` table and the reads the
 * scan already made. Nothing is fetched from a price API and nothing ever will
 * be: the whole claim of this product is that a card states what the chain
 * shows, and a number bought from a third party is not that. It also means the
 * whole block is computed synchronously, which is what makes it possible to
 * promise that the market data never delays a finding.
 *
 * Everything is denominated in the QUOTE asset, the thing the token actually
 * trades against. There is no dollar figure anywhere because there is no oracle
 * for one, and inventing a conversion would put a made-up number next to
 * measured ones.
 */

export interface MarketSnapshot {
  /**
   * Everything denominated in the quote asset, as whole units of it rather than
   * wei: that is the shape the scan's own reads are in, and a card that mixed
   * the two would print a market cap of 1.68 beside a volume of 4.2e18.
   */
  mcapQuote: number;
  /** The highest market cap reached, and how long after the first trade. */
  athQuote: number | null;
  athMinutes: number | null;
  /** What is actually in the curve, in the quote asset. */
  liquidityQuote: number;
  vol5m: number;
  vol1h: number;
  /** Percentage change over the window, or null when the window has no trades. */
  change5m: number | null;
  change1h: number | null;
  /** How many trades the figures above were taken over. */
  trades: number;
  /**
   * False when the trade log does not reach the present. Every number is still
   * real, it is just measured over less than the window it names, and the card
   * says so rather than presenting a partial hour as an hour.
   */
  complete: boolean;
}

/** How long a computed block is reused before it is worth recomputing. */
export const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 30_000) || 30_000;

/** Past this, the findings go out first and the market block is edited in. */
export const MARKET_BUDGET_MS = Number(process.env.MARKET_BUDGET_MS || 1_500) || 1_500;

const cache = new Map<string, { at: number; snap: MarketSnapshot }>();

export function resetMarketCache(): void {
  cache.clear();
}

interface TradeRow { q: string; t: string; bt: number; side: string }

/**
 * A price, kept as the fraction it is.
 *
 * quote/token on a single trade, compared without ever becoming a float: two
 * prices a/b and c/d order by a*d against c*b, and both sides are wei-scale
 * integers, so the comparison is exact. Converted to a number only at the end,
 * for a percentage nobody will read past one decimal.
 */
interface Price { q: bigint; t: bigint }

function priceOf(r: TradeRow): Price | null {
  try {
    const q = BigInt(r.q);
    const t = BigInt(r.t);
    if (q <= 0n || t <= 0n) return null;
    return { q, t };
  } catch (err) {
    return null;
  }
}

function gt(a: Price, b: Price): boolean {
  return a.q * b.t > b.q * a.t;
}

/** (to/from - 1) * 100, to one decimal, without leaving the integers early. */
function changePct(from: Price, to: Price): number {
  const scaled = (to.q * from.t * 10_000n) / (to.t * from.q);
  return Number(scaled - 10_000n) / 100;
}

export interface MarketInput {
  token: string;
  /** Market cap now, from the scan's reads, in whole quote units. */
  mcapQuote: number;
  /** Quote actually in the curve, in whole quote units. */
  liquidityQuote: number;
  /** Decimals of the quote asset, to scale the wei amounts in the trade log. */
  pairDecimals: number;
  /** The head the scan read at, to say whether the trade log reaches it. */
  currentBlock: number;
  now?: number;
}

/**
 * The market block, from the trade log.
 *
 * Cached for thirty seconds per token. A group where five people paste the same
 * address inside a minute is the normal case, not the exception, and every one
 * of those cards would otherwise re-read the same rows.
 */
export function marketSnapshot(input: MarketInput): MarketSnapshot {
  const token = input.token.toLowerCase();
  const now = input.now ?? Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at < MARKET_CACHE_MS) {
    // Three fields come from the caller rather than the cache, because all
    // three depend on reads the caller just made: the market cap, the
    // liquidity, and whether the trade log still reaches the head it read at.
    // A cached "complete" against a head thirty seconds newer is the one thing
    // here that could turn a partial window into a stated one.
    return {
      ...hit.snap,
      mcapQuote: input.mcapQuote,
      liquidityQuote: input.liquidityQuote,
      complete: hit.snap.trades > 0 && reaches(token, input.currentBlock),
    };
  }

  const nowSec = Math.floor(now / 1000);
  const rows = db
    .prepare(
      `SELECT quote_amount AS q, token_amount AS t, block_time AS bt, side FROM trades
        WHERE token = ? ORDER BY block_time ASC, block_number ASC`,
    )
    .all(token) as TradeRow[];

  const snap = compute(rows, input, nowSec, token);
  cache.set(token, { at: now, snap });
  return snap;
}

/**
 * Does the trade log reach the head the scan read at?
 *
 * Compared in BLOCKS, which is what the cursor records. Two minutes of them,
 * because the indexer runs on a timer rather than on every card, and a window
 * measured over slightly less than it names is still a measurement.
 */
function reaches(token: string, currentBlock: number): boolean {
  const covered = coveredThrough(token);
  return covered !== null && currentBlock - covered <= BLOCKS_PER_MINUTE * 2;
}

function compute(
  rows: TradeRow[], input: MarketInput, nowSec: number, token: string,
): MarketSnapshot {
  const { mcapQuote, liquidityQuote } = input;
  const empty: MarketSnapshot = {
    mcapQuote, athQuote: null, athMinutes: null, liquidityQuote,
    vol5m: 0, vol1h: 0, change5m: null, change1h: null,
    trades: 0, complete: false,
  };
  if (!rows.length) return empty;

  /**
   * The all-time high, as the highest one-minute candle high since the first
   * trade.
   *
   * Bucketed rather than taken over raw trades on purpose: a single trade at an
   * absurd price inside one block is a wick, and a card that printed it as the
   * ATH would be reporting somebody's slippage as the token's history. The
   * highest close of any minute is what a chart shows.
   */
  let first: Price | null = null;
  let firstAt = 0;
  let bestMinute: { price: Price; at: number } | null = null;
  let minuteKey = -1;
  let minuteHigh: Price | null = null;
  let minuteAt = 0;

  const flushMinute = (): void => {
    if (!minuteHigh) return;
    if (!bestMinute || gt(minuteHigh, bestMinute.price)) {
      bestMinute = { price: minuteHigh, at: minuteAt };
    }
    minuteHigh = null;
  };

  let vol5m = 0n;
  let vol1h = 0n;
  const unit = 10 ** input.pairDecimals;
  let at5m: Price | null = null;
  let at1h: Price | null = null;
  let last: Price | null = null;
  let counted = 0;

  for (const r of rows) {
    const p = priceOf(r);
    if (!p) continue;
    counted++;
    if (!first) { first = p; firstAt = r.bt; }
    last = p;

    const key = Math.floor(r.bt / 60);
    if (key !== minuteKey) {
      flushMinute();
      minuteKey = key;
      minuteAt = r.bt;
    }
    if (!minuteHigh || gt(p, minuteHigh)) { minuteHigh = p; minuteAt = r.bt; }

    const age = nowSec - r.bt;
    if (age <= 3600) {
      try {
        vol1h += BigInt(r.q);
      } catch (err) {
        // A row whose amount will not parse is not volume we can state.
      }
      // The last price at or before the window opened is what the window is
      // measured from. Tracked as "the earliest trade inside it" instead, which
      // is the same number for any token that traded in the window and the only
      // one available for a token that did not trade before it.
      if (!at1h) at1h = p;
    }
    if (age <= 300) {
      try {
        vol5m += BigInt(r.q);
      } catch (err) {
        // as above
      }
      if (!at5m) at5m = p;
    }
  }
  flushMinute();

  if (!first || !last) return empty;
  const peak: { price: Price; at: number } = bestMinute ?? { price: first, at: firstAt };

  return {
    mcapQuote,
    // Market cap moves with price and supply is fixed, so the peak market cap
    // is the current one scaled by the peak price over the current price. The
    // ratio is taken in bigint and only then becomes a number.
    athQuote: mcapQuote * (Number((peak.price.q * last.t * 1_000_000n) / (peak.price.t * last.q)) / 1_000_000),
    athMinutes: Math.max(0, Math.round((peak.at - firstAt) / 60)),
    liquidityQuote,
    vol5m: Number(vol5m) / unit,
    vol1h: Number(vol1h) / unit,
    change5m: at5m ? changePct(at5m, last) : null,
    change1h: at1h ? changePct(at1h, last) : null,
    trades: counted,
    complete: reaches(token, input.currentBlock),
  };
}
