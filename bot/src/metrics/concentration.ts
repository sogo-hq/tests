import { parseAbiItem, type Address } from 'viem';
import { getLogsAdaptive } from '../chain.js';
import { db } from '../db.js';
import { NON_HOLDER_ADDRESSES } from '../config.js';

/**
 * Holder concentration: how much of the circulating supply the top five wallets
 * hold, read from the token's Transfer log.
 *
 * The raw share is not comparable across tokens, and using it as though it were
 * produced findings that were exactly backwards. With H holders the top five
 * hold at least 5/H of the supply whatever anyone does: at six holders that is
 * 83.3% before anyone has concentrated anything, and at two hundred holders it
 * is 2.5%. A threshold taken over raw shares therefore raised a flag on a
 * six-holder token distributed as evenly as six wallets physically can be,
 * while a twenty-holder token whose top five held 96% came back clean, because
 * the forced shares of tiny launches had dragged the percentile to 99.
 *
 * So the quantity judged is how far the distribution has moved from the most
 * even one its holder count allows, toward the top five holding everything:
 *
 *   floor  = 100 * min(5, holders) / holders     the share equal wallets force
 *   excess = (share - floor) / (100 - floor)     0 = as even as possible, 1 = all
 *
 * That is scale-free, so one distribution covers every holder count and there
 * are no bands to fill separately. The threshold is a percentile of the excess
 * values the index has actually recorded -- never a number chosen here -- and
 * the share, the floor, the threshold and the sample are all printed in /full so
 * the rule can be audited rather than trusted.
 */

const Transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Contracts that hold supply on the protocol's behalf, never as a holder, plus
 * the burn sink. Shared with the holder count so the two can never disagree
 * about what circulating supply is.
 */
const PROTOCOL_EXCLUDED = new Set<string>(NON_HOLDER_ADDRESSES);

/**
 * At five holders or fewer the top five ARE the holders: the floor is 100%, the
 * excess is 0/0, and there is nothing to measure. This is arithmetic, not a
 * tuned parameter.
 */
export const MIN_HOLDERS_FOR_SHARE = 6;

/**
 * A validated positive number from the environment.
 *
 * Number('abc') is NaN and every comparison against NaN is false, so a typo here
 * would have switched a sample floor off in silence and published a threshold
 * drawn from two observations.
 */
function positiveOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Below this many recorded observations, no threshold is published. */
export const MIN_CONCENTRATION_SAMPLES = Math.floor(
  positiveOr(process.env.MIN_CONCENTRATION_SAMPLES, 30),
);

/** The percentile of the observed distribution at which the flag is raised. */
export const CONCENTRATION_PERCENTILE = Math.min(
  100,
  positiveOr(process.env.CONCENTRATION_PERCENTILE, 90),
);

export interface Concentration {
  /** Top five wallets as a share of circulating supply, 0-100. */
  top5Share: number;
  /** Wallets with a positive balance, excluding the curve and the protocol. */
  holders: number;
  /** Circulating supply the share was taken over, excluding the curve. */
  circulating: bigint;
}

/** The top-five share that perfectly even wallets are forced to, 0-100. */
export function arithmeticFloor(holders: number): number {
  if (holders <= 0) return 100;
  return (100 * Math.min(5, holders)) / holders;
}

/**
 * How far this distribution has moved from the most even one its holder count
 * allows, toward the top five holding everything. 0-1, or null when the holder
 * count is too low for the question to mean anything.
 */
export function excessConcentration(c: Concentration): number | null {
  if (c.holders < MIN_HOLDERS_FOR_SHARE) return null;
  const floor = arithmeticFloor(c.holders);
  if (floor >= 100) return null;
  const e = (c.top5Share - floor) / (100 - floor);
  // A share can land a hair under the floor through rounding in the bigint
  // division; that is still "as even as it gets", not negative concentration.
  return Math.min(1, Math.max(0, e));
}

/**
 * Read balances from the token's whole Transfer history.
 *
 * Filtered by token address this is cheap even over a long life: a nine-day-old
 * token measured 138 logs across 3.4 million blocks in half a second. Returns
 * null rather than a zero when nothing is circulating, because a confident low
 * number is the one answer this must never produce.
 */
export async function readConcentration(
  token: string,
  curve: string,
  launchBlock: bigint,
  head: bigint,
): Promise<Concentration | null> {
  const excluded = new Set([...PROTOCOL_EXCLUDED, curve.toLowerCase(), token.toLowerCase()]);
  const logs = await getLogsAdaptive({
    address: token as Address,
    event: Transfer,
    fromBlock: launchBlock,
    toBlock: head,
  });

  const bal = new Map<string, bigint>();
  for (const l of logs) {
    const from = String(l.args.from).toLowerCase();
    const to = String(l.args.to).toLowerCase();
    const v = l.args.value as bigint;
    if (from !== ZERO) bal.set(from, (bal.get(from) ?? 0n) - v);
    if (to !== ZERO) bal.set(to, (bal.get(to) ?? 0n) + v);
  }

  const held = [...bal.entries()]
    .filter(([addr, v]) => v > 0n && !excluded.has(addr))
    .map(([, v]) => v)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  const circulating = held.reduce((a, v) => a + v, 0n);
  if (circulating <= 0n) return null;

  const top5 = held.slice(0, 5).reduce((a, v) => a + v, 0n);
  // basis points first, so the division stays in bigint
  const share = Number((top5 * 10_000n) / circulating) / 100;
  return { top5Share: share, holders: held.length, circulating };
}

/** Record an observation so the threshold has a distribution to come from. */
export function recordConcentration(token: string, c: Concentration, at?: number): void {
  const excess = excessConcentration(c);
  if (excess === null) return; // a forced share is not an observation of anything
  db.prepare(
    `INSERT INTO holder_snapshots (token, top5_share, holders, excess, measured_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       top5_share = excluded.top5_share,
       holders = excluded.holders,
       excess = excluded.excess,
       measured_at = excluded.measured_at`,
  ).run(token.toLowerCase(), c.top5Share, c.holders, excess, at ?? Math.floor(Date.now() / 1000));
}

export interface ConcentrationThreshold {
  /** The excess at or above which the flag is raised, 0-1. Null below the floor. */
  threshold: number | null;
  n: number;
  percentile: number;
  /** That same threshold as a top-5 share for THIS holder count, for reporting. */
  thresholdShare: number | null;
}

/**
 * The threshold, taken from what the index has recorded.
 *
 * Nearest-rank percentile: the smallest observed value with at least P% of the
 * sample at or below it. No interpolation, so the published threshold is always
 * an excess some launch actually had.
 */
export function concentrationThreshold(
  holders: number,
  excludeToken?: string,
): ConcentrationThreshold | null {
  if (holders < MIN_HOLDERS_FOR_SHARE) return null;

  const rows = db
    .prepare('SELECT excess AS e FROM holder_snapshots WHERE token <> ? ORDER BY excess ASC')
    .all((excludeToken ?? '').toLowerCase()) as { e: number }[];

  const n = rows.length;
  if (n < MIN_CONCENTRATION_SAMPLES) {
    return { threshold: null, n, percentile: CONCENTRATION_PERCENTILE, thresholdShare: null };
  }

  const rank = Math.max(1, Math.ceil((CONCENTRATION_PERCENTILE / 100) * n));
  const threshold = rows[rank - 1]!.e;
  const floor = arithmeticFloor(holders);
  return {
    threshold,
    n,
    percentile: CONCENTRATION_PERCENTILE,
    // What that excess corresponds to as a share at this holder count, so the
    // reader can compare it with the share on the card without doing algebra.
    thresholdShare: floor + threshold * (100 - floor),
  };
}
