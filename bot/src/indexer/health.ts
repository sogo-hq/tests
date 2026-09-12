import { db } from '../db.js';

/**
 * Whether the index is doing its job, and saying so when it is not.
 *
 * The index failed 32,000 consecutive times with the same error for over a day.
 * Nothing escalated and nothing stopped: the loop logged every twentieth
 * attempt, so the line at attempt 32,000 read exactly like the line at attempt
 * 1 but with a bigger number. Meanwhile every scan was answered from an index a
 * day stale, and answered with the same confidence as one answered from a
 * current index.
 *
 * A component that cannot do its job must not look like one that is merely
 * retrying. Two separate obligations follow, and they are separate on purpose:
 *
 *   To the operator -- say it once, distinctly, and then stop counting. A
 *   number that keeps rising is not new information; it is the same fact
 *   restated, and it buries whatever else is in the log.
 *
 *   To the user -- withhold the negatives that depend on the index being
 *   current. This is the unread-window rule again: a check that could not run
 *   is undetermined, never "nothing found".
 */

/**
 * How far behind the index may fall before its negatives stop being trusted.
 *
 * The launch cursor advances on every successful pass, so on a healthy bot this
 * is seconds old regardless of whether the chain is busy. Five minutes is far
 * outside normal operation and well inside "a user is being told something
 * false".
 */
export const STALL_AFTER_SECONDS = Number(process.env.INDEX_STALL_SECONDS || 300) || 300;

/**
 * Consecutive identical failures before the loop declares itself broken.
 *
 * Identical is the point: a changing error is a system still discovering
 * things, and each new one is worth a line. The same string twenty times is one
 * fact.
 */
export const FATAL_AFTER = Number(process.env.INDEX_FATAL_AFTER || 20) || 20;

interface FailureState {
  consecutive: number;
  message: string | null;
  /** True once the run has been declared fatal, so it is announced only once. */
  announced: boolean;
}

const state: FailureState = { consecutive: 0, message: null, announced: false };

export interface FailureReport {
  consecutive: number;
  /** True while this run of identical failures is at or past the threshold. */
  fatal: boolean;
  /** True on the single pass that crosses it -- the one that gets the line. */
  justCrossed: boolean;
}

/**
 * Record one failed pass.
 *
 * A different message starts a new run: it is new information, and collapsing
 * it into the old count would hide a system that changed its mind about how it
 * is broken.
 *
 * Once fatal, the counter STOPS. It is not merely that the log is throttled --
 * the number itself stops being maintained, because "32,000 in a row" and "20
 * in a row" describe the same broken component and only one of them tempts a
 * reader into thinking the number means something.
 */
export function recordIndexFailure(message: string): FailureReport {
  const msg = message.slice(0, 200);
  if (state.message !== msg) {
    state.message = msg;
    state.consecutive = 1;
    state.announced = false;
    return { consecutive: 1, fatal: false, justCrossed: false };
  }

  if (state.announced) return { consecutive: state.consecutive, fatal: true, justCrossed: false };

  state.consecutive++;
  if (state.consecutive >= FATAL_AFTER) {
    state.announced = true;
    return { consecutive: state.consecutive, fatal: true, justCrossed: true };
  }
  return { consecutive: state.consecutive, fatal: false, justCrossed: false };
}

/**
 * The cursor name under which a completed pass is stamped.
 *
 * Separate from the 'launches' cursor on purpose. That one records how far the
 * index has READ, and it only moves when there are new blocks to read -- so on
 * a chain producing nothing it stops moving while the index is working
 * perfectly, and using it for stall detection would report a healthy bot as
 * broken. This one records that a pass COMPLETED, which is the actual question.
 */
export const HEALTH_CURSOR = 'launches_ok';

/**
 * The chain head as of the last successful pass.
 *
 * Separate from HEALTH_CURSOR, which records the block the pass REACHED. The
 * two are the same only when the index is caught up, and the gap between them
 * is the thing "is the index current" actually depends on: a tail pass covers
 * at most TAIL_MAX_BLOCKS, so after downtime the index advances on every pass,
 * never looks stalled, and is still days behind the chain.
 */
export const HEAD_CURSOR = 'launches_head';

/**
 * A pass succeeded: the run of failures, whatever it was, is over.
 *
 * `head` is the block the pass reached, stored alongside the time so the two
 * facts -- when it last worked, and where it had got to -- stay together.
 */
export function recordIndexAdvance(reached?: bigint, head?: bigint): void {
  state.consecutive = 0;
  state.message = null;
  state.announced = false;
  const at = Math.floor(Date.now() / 1000);
  const write = db.prepare(
    `INSERT INTO cursors (name, block_number, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET block_number = excluded.block_number,
                                     updated_at = excluded.updated_at`,
  );
  write.run(HEALTH_CURSOR, Number(reached ?? 0n), at);
  // Only when the caller saw one. An absent head is not a head of zero, and
  // writing one would read as "the chain has not started".
  if (head !== undefined) write.run(HEAD_CURSOR, Number(head), at);
}

/**
 * The chain head as of the last successful pass, or null if never recorded.
 *
 * Null is not zero and not "caught up": it means this index has no idea how far
 * the chain has moved, which is a question the caller has to answer for itself.
 */
export function lastSeenHead(): number | null {
  const row = db
    .prepare('SELECT block_number FROM cursors WHERE name = ?')
    .get(HEAD_CURSOR) as { block_number: number } | undefined;
  return row?.block_number ?? null;
}

export interface IndexHealth {
  /** When the launch cursor last moved, or null if it never has. */
  lastAdvanceAt: number | null;
  /** Seconds since then, or null when the index has never run. */
  behindSeconds: number | null;
  stalled: boolean;
  consecutiveFailures: number;
  fatal: boolean;
  lastError: string | null;
}

/**
 * The index's health, from the cursor rather than from memory.
 *
 * Written after every successful pass, so it survives a restart -- a bot that
 * has been failing since before it was restarted still reports the truth.
 *
 * Deliberately NOT the newest launch's timestamp: on a quiet chain that is old
 * while the index is perfectly current, and during an outage it is old for the
 * wrong reason, and it cannot tell those apart.
 *
 * Deliberately NOT the 'launches' read cursor either, for a smaller version of
 * the same mistake: that one only moves when there are new blocks, so a chain
 * producing none would show as a stalled index rather than an idle chain.
 */
export function indexHealth(now = Math.floor(Date.now() / 1000)): IndexHealth {
  const row = db
    .prepare('SELECT updated_at FROM cursors WHERE name = ?')
    .get(HEALTH_CURSOR) as { updated_at: number } | undefined;

  const lastAdvanceAt = row?.updated_at ?? null;
  const behindSeconds = lastAdvanceAt === null ? null : Math.max(0, now - lastAdvanceAt);

  return {
    lastAdvanceAt,
    behindSeconds,
    // Never having advanced counts as stalled: a fresh database that has not
    // indexed anything cannot support a negative either.
    stalled: behindSeconds === null || behindSeconds > STALL_AFTER_SECONDS,
    consecutiveFailures: state.consecutive,
    fatal: state.announced,
    lastError: state.message,
  };
}

/** For tests, which need a clean counter between cases. */
export function resetIndexHealth(): void {
  state.consecutive = 0;
  state.message = null;
  state.announced = false;
}

/** How long ago, in words, for the operator-facing line. */
export function agoWords(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}
