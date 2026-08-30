import { db } from '../db.js';
import {
  BLOCKS_PER_MINUTE,
  WINDOW_10_MIN_BLOCKS,
  WINDOW_30_MIN_BLOCKS,
  LAUNCH_FORWARDER,
} from '../config.js';

export type TractionLabel = 'undetermined' | 'none' | 'weak' | 'building' | 'strong';

/**
 * Everything read out of the opening trade window.
 *
 * Reached only through `TractionMetrics.window`, which is null when that window
 * was never indexed. That indirection is the point. These were flat fields, and
 * an unindexed window and an empty one both produced zero -- so a graduated
 * launch whose window had not been read rendered "no buyers yet" on a token
 * that had crossed 4.2 ETH. Nothing was wrong with the renderer; it was handed
 * a zero and had no way to ask whether anyone had looked.
 *
 * Now there is no number to hand it. The compiler makes every reader open the
 * window first, and a window that was not read cannot be opened.
 */
export interface WindowMetrics {
  uniqueBuyers30m: number;
  uniqueBuyers10m: number;
  /** uniqueBuyers30m / uniqueBuyers10m. null when there were no buyers at +10m. */
  buyerGrowthRatio: number | null;

  buyTxCount: number;
  sellTxCount: number;
  /** buyTx / sellTx. null when there were no sells. */
  buySellRatio: number | null;

  medianBuySize: bigint;
  meanBuySize: bigint;

  progressPct: number;
  progressAt10m: number;
  progressAt30m: number;
  peakProgressPct: number;
  progressVelocityPer10m: number;

  /** Buys routed through the launch forwarder -- the creator's own opening buy. */
  forwarderBuys: number;
  /** Distinct recipients that both bought and sold inside the window. */
  roundTrippers: number;
  /**
   * Buyers in the opening window -- the cohort itself.
   *
   * What became of them afterwards is NOT here. It was, briefly, as
   * `earlyBuyersSold`, computed as "appears in any sell row for this token".
   * That reads as whole-life but is not: the trades table holds the opening
   * window and nothing else, so it silently equalled `roundTrippers` and the
   * card printed the same two numbers on two lines. It lives in
   * metrics/earlysells.ts now, computed from the whole-life Transfer walk that
   * can actually see it.
   */
  earlyBuyers: number;

  totalBuyVolume: bigint;
  totalSellVolume: bigint;
}

export interface TractionMetrics {
  /** Blocks actually observed. Shorter than 30 min for a young token. */
  windowBlocks: number;
  windowMinutes: number;
  /** True when the token is younger than 30 min, so the window is truncated. */
  windowTruncated: boolean;

  /**
   * The measurements, or null when the opening window has not been indexed.
   *
   * Null is not "nothing happened". It is "nobody has looked", and every figure
   * derived from the window -- buyers, sells, round-trippers, growth, the
   * benchmark comparison -- is undetermined until it is not null.
   */
  window: WindowMetrics | null;

  label: TractionLabel;
}

interface TradeRow {
  side: 'buy' | 'sell';
  trader: string;
  recipient: string;
  quote_amount: string;
  fee: string;
  creator_tax: string;
  block_number: number;
}

function median(values: bigint[]): bigint {
  if (!values.length) return 0n;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

/**
 * Net quote held by the curve after a trade, as the protocol computes it.
 *
 * Validated against a live curve: reconstructing this from events reproduced
 * realQuoteReserve() exactly, to the wei, over 66 trades. That makes progress at
 * any historical block exact rather than interpolated.
 */
function netQuoteDelta(t: TradeRow): bigint {
  const q = BigInt(t.quote_amount);
  const f = BigInt(t.fee);
  const c = BigInt(t.creator_tax);
  return t.side === 'buy' ? q - f - c : -(q + f + c);
}

export function computeTraction(
  token: string,
  launchBlock: number,
  currentBlock: number,
  graduationThreshold: bigint,
  /**
   * The block this token's trades are indexed through, from `coveredThrough`.
   *
   * Required, and null when nothing has been read. Without it this function
   * could not tell an empty window from an unread one -- both are zero rows --
   * and it reported the unread one as a fact about the chain.
   */
  coveredThrough: number | null,
): TractionMetrics {
  const windowEnd30 = launchBlock + WINDOW_30_MIN_BLOCKS;
  const windowEnd10 = launchBlock + WINDOW_10_MIN_BLOCKS;
  const observedEnd = Math.min(windowEnd30, currentBlock);
  const windowBlocks = Math.max(0, observedEnd - launchBlock);
  const windowMinutes = windowBlocks / BLOCKS_PER_MINUTE;

  // Coverage has to reach the end of the stretch being measured, not merely
  // exist. A window read halfway and then abandoned reports the buyers of its
  // first half as though they were all of them.
  if (coveredThrough === null || coveredThrough < observedEnd) {
    return {
      windowBlocks,
      windowMinutes,
      windowTruncated: currentBlock < windowEnd30,
      window: null,
      label: 'undetermined',
    };
  }

  const rows = db
    .prepare(
      `SELECT side, trader, recipient, quote_amount, fee, creator_tax, block_number
       FROM trades WHERE token = ? AND block_number >= ? AND block_number <= ?
       ORDER BY block_number, log_index`,
    )
    .all(token.toLowerCase(), launchBlock, observedEnd) as TradeRow[];

  const fwd = LAUNCH_FORWARDER.toLowerCase();
  const buys = rows.filter((r) => r.side === 'buy');
  const sells = rows.filter((r) => r.side === 'sell');

  // Identity for "a buyer" is the recipient, not the transaction sender: a
  // launchAndBuy creator buy is sent by the forwarder contract, so counting
  // senders would credit the forwarder as a buyer on most launches.
  const buyersBy = (list: TradeRow[]) => new Set(list.map((r) => r.recipient));
  const uniq30 = buyersBy(buys);
  const uniq10 = buyersBy(buys.filter((r) => r.block_number <= windowEnd10));

  const sellerSet = new Set(sells.map((r) => r.trader));
  const roundTrippers = [...uniq30].filter((a) => sellerSet.has(a)).length;


  const buySizes = buys.map((r) => BigInt(r.quote_amount));
  const totalBuy = buySizes.reduce((a, b) => a + b, 0n);
  const totalSell = sells.reduce((a, r) => a + BigInt(r.quote_amount), 0n);

  // Exact progress reconstruction.
  const pctOf = (net: bigint) =>
    graduationThreshold > 0n
      ? Number((net * 1_000_000n) / graduationThreshold) / 10_000
      : 0;

  let running = 0n;
  let peak = 0n;
  let at10 = 0n;
  let at30 = 0n;
  for (const r of rows) {
    running += netQuoteDelta(r);
    if (running > peak) peak = running;
    if (r.block_number <= windowEnd10) at10 = running;
    at30 = running;
  }

  const progressAt10m = pctOf(at10);
  const progressAt30m = pctOf(at30);
  const peakProgressPct = pctOf(peak);
  const velocity = windowMinutes > 0 ? progressAt30m / (windowMinutes / 10) : 0;

  const window: WindowMetrics = {
    uniqueBuyers30m: uniq30.size,
    uniqueBuyers10m: uniq10.size,
    buyerGrowthRatio: uniq10.size > 0 ? uniq30.size / uniq10.size : null,
    buyTxCount: buys.length,
    sellTxCount: sells.length,
    buySellRatio: sells.length > 0 ? buys.length / sells.length : null,
    medianBuySize: median(buySizes),
    meanBuySize: buys.length ? totalBuy / BigInt(buys.length) : 0n,
    progressPct: progressAt30m,
    progressAt10m,
    progressAt30m,
    peakProgressPct,
    progressVelocityPer10m: velocity,
    forwarderBuys: buys.filter((r) => r.trader === fwd).length,
    roundTrippers,
    earlyBuyers: uniq30.size,
    totalBuyVolume: totalBuy,
    totalSellVolume: totalSell,
  };

  return {
    windowBlocks,
    windowMinutes,
    windowTruncated: currentBlock < windowEnd30,
    window,
    label: classify(window),
  };
}

/**
 * Bucket the observed traction. This is a description of what already happened
 * in the measured window -- it is not a forecast, and carries no view on what
 * the token will do next.
 */
function classify(m: WindowMetrics): TractionLabel {
  const buyers = m.uniqueBuyers30m;
  if (buyers === 0 || m.buyTxCount === 0) return 'none';

  let score = 0;

  // Breadth of participation.
  if (buyers >= 50) score += 3;
  else if (buyers >= 20) score += 2;
  else if (buyers >= 8) score += 1;

  // Still attracting new buyers in the second half of the window.
  if (m.buyerGrowthRatio !== null && m.buyerGrowthRatio >= 2) score += 2;
  else if (m.buyerGrowthRatio !== null && m.buyerGrowthRatio >= 1.4) score += 1;

  // Buying outweighing selling.
  if (m.buySellRatio === null && m.buyTxCount >= 5) score += 1;
  else if (m.buySellRatio !== null && m.buySellRatio >= 3) score += 2;
  else if (m.buySellRatio !== null && m.buySellRatio >= 1.5) score += 1;
  else if (m.buySellRatio !== null && m.buySellRatio < 0.8) score -= 1;

  // Curve actually filling.
  if (m.progressAt30m >= 25) score += 3;
  else if (m.progressAt30m >= 10) score += 2;
  else if (m.progressAt30m >= 2) score += 1;

  // Many small buys read as organic; few large ones read as staged.
  if (buyers >= 10 && m.medianBuySize > 0n && m.meanBuySize / (m.medianBuySize || 1n) <= 3n) score += 1;

  // Most of the window's buyers already sold back out.
  if (buyers > 0 && m.roundTrippers / buyers > 0.5) score -= 2;

  if (score >= 8) return 'strong';
  if (score >= 5) return 'building';
  if (score >= 2) return 'weak';
  return 'none';
}
