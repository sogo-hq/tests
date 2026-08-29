import { parseAbiItem, type Address } from 'viem';
import { getLogsAdaptive } from '../chain.js';
import { db } from '../db.js';
import { NON_HOLDER_ADDRESSES } from '../config.js';

/**
 * Holder concentration: what share of circulating supply the top five wallets
 * hold, read from the token's Transfer log.
 *
 * The measurement is only a measurement above a certain holder count. With five
 * holders or fewer the top five hold 100% by arithmetic, not by concentration,
 * and reporting that as a finding would raise a flag on almost every launch on
 * this chain -- 7 of the 10 measurable tokens on the index at the time this was
 * written have six holders or fewer. Below the floor the answer is undetermined,
 * and it says why.
 *
 * The threshold is never a number chosen here. It is a percentile of what the
 * index has actually recorded, taken within a comparable holder count so that a
 * twenty-holder token is not measured against a two-hundred-holder one, and it
 * is reported in /full with its sample size so anyone can audit it.
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
 * Top five of five or fewer is 100% whatever the distribution is, so the ratio
 * carries no information at all until there are more holders than the numerator
 * counts. This is arithmetic, not a tuned parameter.
 */
export const MIN_HOLDERS_FOR_SHARE = 6;

/** Below this many recorded observations in a holder band, no threshold is published. */
export const MIN_CONCENTRATION_SAMPLES = Number(process.env.MIN_CONCENTRATION_SAMPLES || 30);

/** The percentile of the observed distribution at which the flag is raised. */
export const CONCENTRATION_PERCENTILE = Number(process.env.CONCENTRATION_PERCENTILE || 90);

export interface Concentration {
  /** Top five wallets as a share of circulating supply, 0-100. */
  top5Share: number;
  /** Wallets with a positive balance, excluding the curve and the protocol. */
  holders: number;
  /** Circulating supply the share was taken over, excluding the curve. */
  circulating: bigint;
}

/**
 * Holder bands, so a token is compared against tokens with a comparable number
 * of holders. Top-five share falls mechanically as holders rise, so a single
 * pooled threshold would flag every small token and no large one.
 */
export interface HolderBand {
  key: string;
  from: number;
  to: number;
  label: string;
}

export const HOLDER_BANDS: readonly HolderBand[] = [
  { key: '6-20', from: 6, to: 21, label: '6-20 holders' },
  { key: '21-100', from: 21, to: 101, label: '21-100 holders' },
  { key: '101-500', from: 101, to: 501, label: '101-500 holders' },
  { key: '500+', from: 501, to: Infinity, label: '500+ holders' },
];

export function bandFor(holders: number): HolderBand | null {
  if (holders < MIN_HOLDERS_FOR_SHARE) return null;
  for (const b of HOLDER_BANDS) if (holders >= b.from && holders < b.to) return b;
  return HOLDER_BANDS[HOLDER_BANDS.length - 1]!;
}

/**
 * Read balances from the token's whole Transfer history.
 *
 * Filtered by token address, this is cheap even over a long life: a nine-day-old
 * token measured 138 logs across 3.4 million blocks in half a second. Returns
 * null rather than a zero when the read fails, because a confident low number is
 * the one answer this must never produce.
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
  // basis points, then to a percentage, so the division stays in bigint
  const share = Number((top5 * 10_000n) / circulating) / 100;
  return { top5Share: share, holders: held.length, circulating };
}

/** Record an observation so the threshold has a distribution to come from. */
export function recordConcentration(token: string, c: Concentration, at?: number): void {
  const band = bandFor(c.holders);
  if (!band) return; // a forced 100% is not an observation of anything
  db.prepare(
    `INSERT INTO holder_snapshots (token, top5_share, holders, band, measured_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       top5_share = excluded.top5_share,
       holders = excluded.holders,
       band = excluded.band,
       measured_at = excluded.measured_at`,
  ).run(token.toLowerCase(), c.top5Share, c.holders, band.key, at ?? Math.floor(Date.now() / 1000));
}

export interface ConcentrationThreshold {
  band: HolderBand;
  /** The share at or above which the flag is raised. Null below the sample floor. */
  threshold: number | null;
  n: number;
  percentile: number;
}

/**
 * The threshold, taken from what the index has recorded for this holder band.
 *
 * Nearest-rank percentile: the smallest observed value with at least P% of the
 * sample at or below it. No interpolation, so the published threshold is always
 * a share some launch actually had.
 */
export function concentrationThreshold(holders: number, excludeToken?: string): ConcentrationThreshold | null {
  const band = bandFor(holders);
  if (!band) return null;

  const rows = db
    .prepare(
      `SELECT top5_share AS s FROM holder_snapshots
        WHERE band = ? AND token <> ? ORDER BY top5_share ASC`,
    )
    .all(band.key, (excludeToken ?? '').toLowerCase()) as { s: number }[];

  const n = rows.length;
  if (n < MIN_CONCENTRATION_SAMPLES) return { band, threshold: null, n, percentile: CONCENTRATION_PERCENTILE };

  const rank = Math.max(1, Math.ceil((CONCENTRATION_PERCENTILE / 100) * n));
  return { band, threshold: rows[rank - 1]!.s, n, percentile: CONCENTRATION_PERCENTILE };
}
