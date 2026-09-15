/**
 * The bonding curve, as the contract computes it.
 *
 * A launch that buys its own supply has to know, before it signs, how much of
 * the supply that buy takes. Estimating it is not good enough: the number goes
 * in front of a human as the last thing they see before a real transaction, and
 * a percentage that is "about right" is the kind of number nobody checks twice.
 *
 * So the model is derived from the contract's own state and then CALIBRATED
 * against a transaction that already happened, and the launch tool refuses to
 * run if the calibration misses. What is modelled:
 *
 *   qNet      = quoteIn, less the curve fee and the creator tax, each floored
 *               on its own as the contract floors them
 *   tokensOut = tokenReserve * qNet / (quoteReserve + qNet)
 *
 * which is the constant product x*y=k solved for the output, against a quote
 * reserve that starts at the config's phantomQuote and a token reserve that
 * starts at the whole supply. Measured against every ETH-pair launch buy in the
 * index, 40 of 40, this reproduces the amount the curve actually paid out to
 * the wei, with no error term at all.
 *
 * Two things it is NOT:
 *
 *   It is the FIRST buy on a curve. Later buys move the reserves, and a caller
 *   that wants one of those passes the reserves it read.
 *
 *   It is the ETH pair. phantomQuote is denominated in the pair asset, and a
 *   launch against some other token has a different one: measured, an SPCX pair
 *   behaved as though its phantom were 28.9 rather than 1.68, and the ETH
 *   figure would have been wrong by a factor of seventeen. The tool refuses a
 *   non-ETH pair rather than apply this to it.
 */

/** A launch config as the factory reports it. */
export interface CurveConfig {
  supply: bigint;
  phantomQuote: bigint;
  curveFeeBps: bigint;
}

export interface BuyQuote {
  /** What the curve pays out, in token wei. */
  tokensOut: bigint;
  /** The curve's cut, in quote wei. */
  curveFee: bigint;
  /** The creator's cut, in quote wei. Paid to creatorFeeRecipient, not to the curve. */
  creatorTax: bigint;
  /** What actually reaches the curve after both. */
  quoteNet: bigint;
  /** Share of the whole supply this buy takes, 0-100. */
  supplyPct: number;
}

/**
 * What a buy of `quoteIn` returns on a curve at these reserves.
 *
 * Both cuts are taken off the input before the curve sees it, and each is
 * floored on its own: taking them together and flooring once is off by a wei
 * often enough to matter to a comparison against a real receipt.
 */
export function quoteBuy(opts: {
  quoteReserve: bigint;
  tokenReserve: bigint;
  curveFeeBps: bigint;
  creatorTaxBps: bigint;
  quoteIn: bigint;
  /** Denominator for the share, when it differs from the token reserve. */
  supply?: bigint;
}): BuyQuote {
  const curveFee = (opts.quoteIn * opts.curveFeeBps) / 10_000n;
  const creatorTax = (opts.quoteIn * opts.creatorTaxBps) / 10_000n;
  const quoteNet = opts.quoteIn - curveFee - creatorTax;
  const tokensOut = quoteNet <= 0n
    ? 0n
    : (opts.tokenReserve * quoteNet) / (opts.quoteReserve + quoteNet);
  const supply = opts.supply ?? opts.tokenReserve;
  // Resolution matters here. At a divisor of 1e6 the share is only good to
  // 0.0001%, which is a thousand tokens on a supply of a billion, and the
  // inverse below then returns an amount whose true share is a thousand tokens
  // past the target it was asked for. 1e12 puts the granularity at 1e-10%,
  // well inside a double for any supply this chain mints.
  const supplyPct = supply > 0n
    ? Number((tokensOut * 1_000_000_000_000n) / supply) / 10_000_000_000
    : 0;
  return { tokensOut, curveFee, creatorTax, quoteNet, supplyPct };
}

/** The opening buy: the reserves are the config's starting values. */
export function quoteLaunchBuy(cfg: CurveConfig, creatorTaxBps: bigint, quoteIn: bigint): BuyQuote {
  return quoteBuy({
    quoteReserve: cfg.phantomQuote,
    tokenReserve: cfg.supply,
    curveFeeBps: cfg.curveFeeBps,
    creatorTaxBps,
    quoteIn,
    supply: cfg.supply,
  });
}

/**
 * The ETH an opening buy of a given share of supply needs.
 *
 * The inverse of quoteLaunchBuy, which is not algebraically invertible because
 * both cuts are floored: solving it in closed form and rounding lands a wei or
 * two either side, and a wei on the wrong side of the cap is a refusal nobody
 * can explain. So the closed form seeds a binary search over the real function,
 * and what comes back is the largest input whose share does not exceed the
 * target. Exact, and checkable against the forward direction.
 */
export function quoteInForSupplyPct(cfg: CurveConfig, creatorTaxBps: bigint, targetPct: number): bigint {
  if (targetPct <= 0) return 0n;
  const share = targetPct / 100;
  if (share >= 1) throw new Error('an opening buy cannot take the whole supply');
  // Closed form, ignoring the flooring: qNet = share*P/(1-share), grossed up
  // for the two cuts. Used only to bracket the search.
  const cuts = 10_000n - cfg.curveFeeBps - creatorTaxBps;
  if (cuts <= 0n) throw new Error('the fees take the whole input');
  const seed = (cfg.phantomQuote * BigInt(Math.round(share * 1e12)) * 10_000n)
    / (BigInt(Math.round((1 - share) * 1e12)) * cuts);
  let lo = 0n;
  let hi = seed * 2n + 1n;
  const over = (q: bigint) => quoteLaunchBuy(cfg, creatorTaxBps, q).supplyPct > targetPct;
  while (!over(hi)) hi *= 2n;
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (over(mid)) hi = mid; else lo = mid;
  }
  return lo;
}

/**
 * The transaction the model is checked against.
 *
 * ZZZ's launch, block 54,672,454, tx 0x2121ea24...6029: 0.5 ETH in, no creator
 * tax, and the curve's own CurveBuy event reports what came out. Recorded here
 * as the measured fact it is, so a change to the model that stops reproducing
 * it fails a test rather than a launch.
 */
export interface CalibrationPoint {
  token: string;
  txHash: string;
  quoteIn: bigint;
  creatorTaxBps: bigint;
  tokensOut: bigint;
  supplyPct: number;
}

export const CALIBRATION: CalibrationPoint = {
  token: '0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a',
  txHash: '0x2121ea2495afcd6898eb181a13e59efda25c636100d79e70afe5b784fae76029',
  quoteIn: 500_000_000_000_000_000n,
  creatorTaxBps: 0n,
  tokensOut: 227_586_206_896_551_724_137_931_034n,
  /** 22.7586...% of a supply of 1,000,000,000. */
  supplyPct: 22.7586,
};

/** How far the model may miss the calibration point before it is the wrong model. */
export const CALIBRATION_TOLERANCE_PCT = 1;

export interface Calibration {
  ok: boolean;
  predicted: bigint;
  measured: bigint;
  /** Signed, in percent of the measured value. */
  errorPct: number;
  /** One line, whichever way it went. */
  line: string;
}

/**
 * Does this config reproduce the measured launch?
 *
 * Run against the config read from the chain at the moment of use, so a factory
 * whose economics changed since this was written shows up here as a model that
 * no longer predicts a transaction that is on chain, rather than as a dev buy
 * of the wrong size.
 */
export function calibrate(cfg: CurveConfig, point: CalibrationPoint = CALIBRATION): Calibration {
  const predicted = quoteLaunchBuy(cfg, point.creatorTaxBps, point.quoteIn).tokensOut;
  const measured = point.tokensOut;
  const errorPct = measured === 0n
    ? Number.POSITIVE_INFINITY
    : Number(((predicted - measured) * 100_000_000n) / measured) / 1_000_000;
  const ok = Math.abs(errorPct) <= CALIBRATION_TOLERANCE_PCT;
  const line = ok
    ? `curve calibrated: reproduces ${point.txHash.slice(0, 10)} to ${errorPct === 0 ? 'the wei' : `${Math.abs(errorPct).toFixed(6)}%`}`
    : `curve model does not reproduce ${point.txHash.slice(0, 10)}: predicted ${predicted}, measured ${measured}, off by ${errorPct.toFixed(4)}%`;
  return { ok, predicted, measured, errorPct, line };
}
