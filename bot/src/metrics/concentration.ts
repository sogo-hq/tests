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

/**
 * Blocks per query when the read is being considerate, and the pause between.
 *
 * A token's FIRST reading still has to cover its whole life -- four million
 * blocks on a four-day-old launch -- and issued as one query that is heavy
 * enough to slow the node for everyone: a concurrent scan went from 1.5s to
 * 29.8s. Split small and paced, the same total work stops being a spike. Every
 * reading after the first is a delta of a few hundred blocks and pays none of
 * this.
 */
const REFRESH_CHUNK_BLOCKS = Number(process.env.HOLDER_REFRESH_CHUNK || 100_000) || 100_000;
const REFRESH_PAUSE_MS = Number(process.env.HOLDER_REFRESH_PAUSE_MS ?? 400);
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
  /**
   * Called between chunks when the caller wants the read to be considerate.
   * Absent on the interactive path, where the read is racing a deadline and has
   * no business pausing; supplied by the background refresher, where a scan
   * arriving mid-read matters more than finishing quickly.
   */
  yieldBetweenChunks?: () => Promise<void>,
): Promise<Concentration | null> {
  const excluded = new Set([...PROTOCOL_EXCLUDED, curve.toLowerCase(), token.toLowerCase()]);

  let logs: any[];
  if (yieldBetweenChunks) {
    // Walked in bounded, sequential chunks rather than handed to the adaptive
    // splitter, which fans a wide range into parallel queries -- the very thing
    // that made the node slow for everyone else. Chunked and paced, the same
    // read costs the same total work spread thinly enough to be invisible.
    logs = [];
    for (let from = launchBlock; from <= head; from += BigInt(REFRESH_CHUNK_BLOCKS)) {
      await yieldBetweenChunks();
      const to = from + BigInt(REFRESH_CHUNK_BLOCKS) - 1n > head ? head : from + BigInt(REFRESH_CHUNK_BLOCKS) - 1n;
      logs.push(...(await getLogsAdaptive({ address: token as Address, event: Transfer, fromBlock: from, toBlock: to })));
    }
  } else {
    logs = await getLogsAdaptive({
      address: token as Address,
      event: Transfer,
      fromBlock: launchBlock,
      toBlock: head,
    });
  }

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
  // Nobody holds it outside the curve and the protocol. That is a real reading,
  // not a failed one, and the difference matters: the flag says "too few
  // holders to measure" rather than "could not be read", which is what it would
  // say about a token whose log we never got.
  if (circulating <= 0n) return { top5Share: 0, holders: 0, circulating: 0n };

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


/** How many holder distributions the threshold has behind it. */
export function concentrationCoverage(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM holder_snapshots').get() as { n: number }).n;
}

/**
 * The /stats line for check 09.
 *
 * One pooled figure, because the excess measure is scale-free: a six-holder
 * token and a two-hundred-holder one contribute to the same distribution, so
 * there are no per-band populations to report separately.
 */
export function concentrationCoverageLine(n = concentrationCoverage()): string {
  return n >= MIN_CONCENTRATION_SAMPLES
    ? `holder concentration: live (n=${n.toLocaleString()})`
    : `holder concentration: not enough data yet (n=${n.toLocaleString()})`;
}


export interface StoredConcentration extends Concentration {
  /** When the reading was taken, unix seconds. */
  measuredAt: number;
  /** How long ago, in seconds, relative to the caller's clock. */
  ageSeconds: number;
}

/**
 * The last recorded reading for a token, if there is one.
 *
 * This is what makes the check instant. Reading a token's whole Transfer
 * history costs twenty seconds on a busy launch -- 9,001 logs across four
 * million blocks -- which has no business on the path between a request and a
 * card. The reading is taken in the background instead and served from here.
 */
export function readStoredConcentration(token: string, now?: number): StoredConcentration | null {
  const row = db
    .prepare('SELECT top5_share, holders, measured_at FROM holder_snapshots WHERE token = ?')
    .get(token.toLowerCase()) as { top5_share: number; holders: number; measured_at: number } | undefined;
  if (!row) return null;
  const at = now ?? Math.floor(Date.now() / 1000);
  return {
    top5Share: row.top5_share,
    holders: row.holders,
    // Not stored: the share and the holder count are what the check uses, and
    // circulating supply is only meaningful at the moment it was read.
    circulating: 0n,
    measuredAt: row.measured_at,
    ageSeconds: Math.max(0, at - row.measured_at),
  };
}


/**
 * Balances kept so a refresh reads only what changed.
 *
 * A whole-life Transfer read is 9,001 logs across four million blocks and
 * roughly twenty seconds, and running one while somebody is waiting for a card
 * took a concurrent scan from 1.5s to 20.9s. Doing it every thirty minutes per
 * token is not a background task, it is a recurring outage.
 *
 * So the balance map is stored with the block it was read to, and a refresh
 * reads only the blocks since. The first read still costs what it costs; every
 * one after it is proportional to what actually happened.
 */
interface StoredBalances {
  balances: Map<string, bigint>;
  readToBlock: number;
}

/** Does this token have a balance map to update, or does it need a first read? */
export function hasStoredBalances(token: string): boolean {
  const row = db
    .prepare('SELECT read_to_block FROM holder_snapshots WHERE token = ? AND balances IS NOT NULL')
    .get(token.toLowerCase()) as { read_to_block: number | null } | undefined;
  return row?.read_to_block != null;
}

function loadBalances(token: string): StoredBalances | null {
  const row = db
    .prepare('SELECT balances, read_to_block FROM holder_snapshots WHERE token = ?')
    .get(token.toLowerCase()) as { balances: string | null; read_to_block: number | null } | undefined;
  if (!row?.balances || row.read_to_block === null) return null;
  try {
    const raw = JSON.parse(row.balances) as Record<string, string>;
    const balances = new Map<string, bigint>();
    for (const [addr, v] of Object.entries(raw)) balances.set(addr, BigInt(v));
    return { balances, readToBlock: row.read_to_block };
  } catch (err) {
    // A corrupt blob is not worth a failed refresh: fall back to a full read.
    console.warn(`[holders] unreadable stored balances for ${token.slice(0, 10)}:`, String((err as Error)?.message ?? err).slice(0, 80));
    return null;
  }
}

/** Apply a token's Transfer logs to a balance map. */
function applyTransfers(balances: Map<string, bigint>, logs: any[]): void {
  for (const l of logs) {
    const from = String(l.args.from).toLowerCase();
    const to = String(l.args.to).toLowerCase();
    const v = l.args.value as bigint;
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - v);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + v);
  }
}

/** Top-five share and holder count from a balance map. */
function summarise(balances: Map<string, bigint>, excluded: Set<string>): Concentration {
  const held = [...balances.entries()]
    .filter(([addr, v]) => v > 0n && !excluded.has(addr))
    .map(([, v]) => v)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const circulating = held.reduce((a, v) => a + v, 0n);
  if (circulating <= 0n) return { top5Share: 0, holders: 0, circulating: 0n };
  const top5 = held.slice(0, 5).reduce((a, v) => a + v, 0n);
  return { top5Share: Number((top5 * 10_000n) / circulating) / 100, holders: held.length, circulating };
}

export interface RefreshResult {
  concentration: Concentration;
  /** Blocks actually queried. Small on every read after the first. */
  blocksRead: number;
  incremental: boolean;
  /** False when the read stopped early to stay out of a scan's way. */
  complete: boolean;
}

/**
 * Read a token's holder distribution, reusing what was stored last time.
 *
 * `yieldBetween` is awaited before each chunk so a scan arriving mid-read
 * pauses the work rather than competing with it.
 */
export async function refreshConcentration(
  token: string,
  curve: string,
  launchBlock: bigint,
  head: bigint,
  /**
   * Checked between chunks. Returning false stops the read where it is rather
   * than waiting: waiting up to thirty seconds and then pressing on regardless
   * simply moved the collision later, and took a concurrent scan to 8.5s.
   * Stopping loses nothing, because the balances read so far are stored with
   * the block they are correct as of, and the next attempt resumes there.
   */
  shouldContinue: () => boolean = () => true,
): Promise<RefreshResult> {
  const excluded = new Set([...PROTOCOL_EXCLUDED, curve.toLowerCase(), token.toLowerCase()]);
  const stored = loadBalances(token);

  const from = stored ? BigInt(stored.readToBlock) + 1n : launchBlock;
  const balances = stored ? stored.balances : new Map<string, bigint>();
  const incremental = stored !== null;

  let blocksRead = 0;
  let chunks = 0;
  let readTo = from - 1n;
  let complete = true;
  for (let start = from; start <= head; start += BigInt(REFRESH_CHUNK_BLOCKS)) {
    if (!shouldContinue()) { complete = false; break; }
    // Paced deliberately, not just deprioritised. Priority decides who is served
    // next; it cannot undo the node being busy with a query it has already
    // accepted. Skipped on the first chunk so a small delta stays instant.
    if (chunks > 0 && REFRESH_PAUSE_MS > 0) {
      await new Promise((r) => {
        const t = setTimeout(r, REFRESH_PAUSE_MS);
        (t as any).unref?.();
      });
      if (!shouldContinue()) { complete = false; break; }
    }
    const end = start + BigInt(REFRESH_CHUNK_BLOCKS) - 1n > head ? head : start + BigInt(REFRESH_CHUNK_BLOCKS) - 1n;
    const logs = await getLogsAdaptive({ address: token as Address, event: Transfer, fromBlock: start, toBlock: end });
    applyTransfers(balances, logs);
    blocksRead += Number(end - start) + 1;
    readTo = end;
    chunks++;
  }

  const concentration = summarise(balances, excluded);

  // Zero balances are dropped before storing: they are not holders and keeping
  // them grows the blob without end on a token people trade in and out of.
  const keep: Record<string, string> = {};
  for (const [addr, v] of balances) if (v > 0n) keep[addr] = v.toString();

  const excess = excessConcentration(concentration);
  const now = Math.floor(Date.now() / 1000);

  if (complete) {
    db.prepare(
      `INSERT INTO holder_snapshots (token, top5_share, holders, excess, measured_at, balances, read_to_block)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(token) DO UPDATE SET
         top5_share = excluded.top5_share, holders = excluded.holders,
         excess = excluded.excess, measured_at = excluded.measured_at,
         balances = excluded.balances, read_to_block = excluded.read_to_block`,
    ).run(token.toLowerCase(), concentration.top5Share, concentration.holders, excess ?? 0, now, JSON.stringify(keep), Number(head));
  } else if (chunks > 0) {
    // Partial progress. The balance map is correct as of readTo, so it is kept
    // and the next attempt resumes from there -- but the published share and
    // holder count are NOT touched, because a distribution read up to some
    // block in the middle of a token's life is not the distribution now, and
    // stamping it with the current time would be exactly the quiet lie this
    // product exists not to tell.
    db.prepare(
      `INSERT INTO holder_snapshots (token, top5_share, holders, excess, measured_at, balances, read_to_block)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(token) DO UPDATE SET
         balances = excluded.balances, read_to_block = excluded.read_to_block`,
    ).run(token.toLowerCase(), concentration.top5Share, concentration.holders, excess ?? 0, now, JSON.stringify(keep), Number(readTo));
  }

  return { concentration, blocksRead, incremental, complete };
}
