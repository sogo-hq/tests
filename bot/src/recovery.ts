import { db } from './db.js';
import { backfill, startDecodeLoop } from './indexer/launches.js';
import { bulk } from './ratelimit.js';
import { indexCoverage, markRecovering } from './coverage.js';
import { BACKFILL_DAYS } from './config.js';

/**
 * Rebuild the index after a restart.
 *
 * The container has no persistent volume, so every deploy starts from an empty
 * SQLite file. Left alone, the bot comes back up answering scans from ten rows:
 * collisions stop firing, deployer history disappears, and every index-derived
 * check quietly turns into a confident negative.
 *
 * Recovery runs in the background at bulk priority, the same treatment as the
 * decode drip, so an interactive scan always preempts it. The bot answers
 * throughout -- the point is that a scan during recovery gets an honest
 * "undetermined", not that it waits.
 */

/** Consider the index stale enough to rebuild past this age. */
const STALE_AFTER_SECONDS = Number(process.env.RECOVERY_STALE_SECONDS || 6 * 3600);

export interface RecoveryDecision {
  needed: boolean;
  indexed: number;
  decoded: number;
  stalenessSeconds: number | null;
  reason: string;
}

export function assessIndex(): RecoveryDecision {
  const c = indexCoverage();
  if (c.indexed === 0) {
    return { needed: true, indexed: 0, decoded: 0, stalenessSeconds: null, reason: 'index empty' };
  }
  if (c.stalenessSeconds !== null && c.stalenessSeconds > STALE_AFTER_SECONDS) {
    const hours = (c.stalenessSeconds / 3600).toFixed(1);
    return { ...c, needed: true, reason: `index ${hours}h behind the chain` };
  }
  if (!c.trustNegatives.deployerHistory) {
    return { ...c, needed: true, reason: `index has only ${c.indexed.toLocaleString()} launches` };
  }
  return { ...c, needed: false, reason: 'index populated' };
}

/**
 * Decide, log, and start recovery if it is needed. Returns immediately.
 *
 * `markRecovering` covers the backfill only, not the decode that follows it.
 * That is deliberate: the decode loop runs for the life of the process draining
 * whatever is undecoded, so a flag tied to "decode is running" would never clear
 * and every index-derived negative would be suppressed forever. Once the
 * backfill lands, the coverage thresholds in coverage.ts take over and gate each
 * negative on the rows that actually exist behind it -- which is a sharper test
 * than a process-wide flag anyway, since it distinguishes checks that need
 * decoded rows from those that only need indexed ones.
 */
export function startRecovery(): void {
  const decision = assessIndex();

  if (!decision.needed) {
    console.log(`[boot] index has ${decision.decoded.toLocaleString()} decoded launches — skipping recovery`);
    return;
  }

  console.log(`[boot] ${decision.reason} — backfilling, then decoding in background`);
  markRecovering(true);

  void (async () => {
    const started = Date.now();
    try {
      const res = await bulk(() => backfill(BACKFILL_DAYS));
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[boot] backfill complete: ${res.launches.toLocaleString()} launches in ${secs}s`);
      if (res.pendingDecode) {
        console.log(`[boot] ${res.pendingDecode.toLocaleString()} launches pending decode — draining in background`);
      }
    } catch (err) {
      console.error('[boot] backfill failed:', String((err as Error)?.message ?? err).slice(0, 200));
    } finally {
      // Cleared even on failure. Leaving it set would suppress every
      // index-derived negative for the life of the process; the coverage
      // thresholds still withhold negatives the index cannot support.
      markRecovering(false);
      const c = indexCoverage();
      console.log(
        `[boot] recovery finished — ${c.indexed.toLocaleString()} indexed, ${c.decoded.toLocaleString()} decoded; ` +
        `index-derived negatives ${c.trustNegatives.collision ? 'enabled' : 'still withheld until decode catches up'}`,
      );
    }
  })();
}

/** Rows the recovery would touch, for /stats and diagnostics. */
export function recoveryStatus(): { recovering: boolean; indexed: number; decoded: number } {
  const c = indexCoverage();
  return { recovering: c.recovering, indexed: c.indexed, decoded: c.decoded };
}
