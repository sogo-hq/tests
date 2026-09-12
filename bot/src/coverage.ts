import { db, getCursor } from './db.js';
import { indexHealth, agoWords, lastSeenHead } from './indexer/health.js';
import { BLOCKS_PER_MINUTE } from './config.js';

/**
 * How much of the index actually exists, and therefore which negatives the card
 * is entitled to assert.
 *
 * The container has no persistent volume, so a redeploy starts from an empty
 * SQLite file. Without this, the first scan after a deploy would report
 * "no match against indexed pons tokens" and "no other launches in the last 7
 * days" -- both perfectly confident, both derived from zero rows. A false
 * all-clear is the single failure mode this whole tool exists to avoid, so an
 * index-derived negative is only stated once there is enough index behind it.
 *
 * Positives are unaffected: a collision found against a partial index is still a
 * real collision. It is only the absence of a match that needs the population.
 */

/** Below this many rows, an index-derived negative is not asserted. */
const MIN_ROWS_FOR_NEGATIVE = Number(process.env.MIN_INDEX_ROWS_FOR_NEGATIVE || 1_000);

/**
 * How far behind the chain head the index may sit and still assert a negative.
 *
 * The time-based stall rule asks "did the index move recently". That is
 * liveness, not coverage, and the two came apart the moment the tail pass was
 * bounded: a pass covers at most 30,000 blocks, so an index restarted after a
 * day of downtime advances every few seconds -- never stalled, perfectly
 * healthy -- while a day of chain sits unread behind it. Every scan in that
 * window was entitled to say "deployer's only launch this week" about seven
 * days it had read six of.
 *
 * Five minutes of chain, matching STALL_AFTER_SECONDS: the same tolerance the
 * time rule allows, measured in the unit that actually bounds what the index
 * has seen.
 */
const MAX_LAG_BLOCKS_FOR_NEGATIVE =
  Number(process.env.MAX_INDEX_LAG_FOR_NEGATIVE || BLOCKS_PER_MINUTE * 5) || BLOCKS_PER_MINUTE * 5;

let recovering = false;

/** Marks the index as knowingly incomplete for the duration of `fn`. */
export function markRecovering(on: boolean): void {
  recovering = on;
}

export function isIndexRecovering(): boolean {
  return recovering;
}

export interface IndexCoverage {
  indexed: number;
  decoded: number;
  /** Seconds since the most recent indexed launch, or null when empty. */
  stalenessSeconds: number | null;
  recovering: boolean;
  /**
   * Whether a "nothing found" answer from each index-backed check is
   * trustworthy. Never true while recovery is running.
   */
  /** True when the index is not advancing. Negatives are withheld while it is. */
  stalled: boolean;
  /** Seconds since the launch cursor last moved, null if it never has. */
  behindSeconds: number | null;
  /**
   * Blocks between the launch cursor and the head last seen, null when no head
   * has ever been recorded. Null is "unknown", not "caught up".
   */
  lagBlocks: number | null;
  /** True when that gap is wide enough that a negative would be unfounded. */
  behindHead: boolean;
  trustNegatives: { collision: boolean; deployerHistory: boolean; taxBaseline: boolean };
}

export function indexCoverage(): IndexCoverage {
  const indexed = (db.prepare('SELECT COUNT(*) AS n FROM launches').get() as { n: number }).n;
  const decoded = (db
    .prepare('SELECT COUNT(*) AS n FROM launches WHERE snipe_exemption_count IS NOT NULL')
    .get() as { n: number }).n;
  const newest = (db.prepare('SELECT MAX(launched_at) AS t FROM launches').get() as { t: number | null }).t;
  const stalenessSeconds = newest ? Math.max(0, Math.floor(Date.now() / 1000) - newest) : null;

  // A stalled index is as unable to support a negative as an empty one, and it
  // is more dangerous: it holds plenty of rows, so every count comes back
  // confidently wrong. The bot answered scans from a day-stale index for a day
  // and sounded exactly as certain as it does when current.
  const health = indexHealth();

  // An index that is advancing but far behind head is the case the time rule
  // cannot see. When no head has ever been recorded there is nothing to compare
  // against, and an unknown gap is left to the time rule rather than guessed at
  // in either direction.
  const head = lastSeenHead();
  const cursor = getCursor('launches');
  const lagBlocks = head === null || cursor === null ? null : Math.max(0, head - Number(cursor));
  const behindHead = lagBlocks !== null && lagBlocks > MAX_LAG_BLOCKS_FOR_NEGATIVE;

  const enough = !recovering && !health.stalled && !behindHead && indexed >= MIN_ROWS_FOR_NEGATIVE;
  return {
    indexed,
    decoded,
    stalenessSeconds,
    recovering,
    stalled: health.stalled,
    behindSeconds: health.behindSeconds,
    lagBlocks,
    behindHead,
    trustNegatives: {
      // Collision matches on name_key/symbol_key, which only decoded rows carry,
      // so this one needs decoded rows rather than merely indexed ones.
      collision: !recovering && !health.stalled && !behindHead && decoded >= MIN_ROWS_FOR_NEGATIVE,
      deployerHistory: enough,
      taxBaseline: enough,
    },
  };
}

/** One line explaining why a negative is being withheld. */
export function coverageReason(c: IndexCoverage): string {
  if (c.recovering) return 'index still rebuilding after a restart';
  if (c.stalled) {
    return c.behindSeconds === null
      ? 'the index has never advanced, so this cannot be ruled out'
      : `index stalled ${agoWords(c.behindSeconds)} ago, so this cannot be ruled out`;
  }
  if (c.behindHead) {
    return `index is ${c.lagBlocks!.toLocaleString()} blocks behind the chain, so this cannot be ruled out`;
  }
  return `index holds ${c.indexed.toLocaleString()} launches, too few to rule this out`;
}
