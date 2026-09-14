import { db } from '../db.js';
import { bulk, isRateLimit, interactivelyBusy, spareCapacity } from '../ratelimit.js';
import { client } from '../chain.js';
import { indexOneCurve, markWindowIndexed } from './trades.js';
import { readConcentration, recordConcentration, excessConcentration, readStoredConcentration, refreshConcentration, hasStoredBalances } from '../metrics/concentration.js';
import { WINDOW_30_MIN_BLOCKS, BLOCKS_PER_MINUTE } from '../config.js';
import { AGE_BUCKETS, MIN_BENCHMARK_SAMPLES } from '../metrics/benchmark.js';
import { MIN_CONCENTRATION_SAMPLES, MIN_HOLDERS_FOR_SHARE, concentrationCoverage } from '../metrics/concentration.js';
import { exemptedHoldTime, MIN_HOLD_SAMPLES } from '../holdtime.js';

/**
 * Fill in the opening trade window of launches nobody has scanned.
 *
 * Trades were only ever indexed as a side effect of somebody scanning a token,
 * which left three shipped features silent on a live index: the buyer
 * benchmark, holder concentration's sample, and the /stats median hold time.
 * Thirteen launches out of eighteen thousand had any trade history at all.
 *
 * This is deliberately not a backfill of everything. It reads the first thirty
 * minutes -- the cap the buyer count already uses, so there is nothing further
 * worth pulling -- for two populations and no others:
 *
 *   1. every launch carrying pre-exempted wallets, because that is exactly the
 *      population the exempted-wallet hold-time median is computed over;
 *   2. the most recent launches, until each age bucket the benchmark uses can
 *      answer from more launches than its floor requires.
 *
 * It runs at bulk priority, like the decode drip, so an interactive scan is
 * always served ahead of it.
 */

/** Launches read per pass. Bounded so a pass is short and interruptible. */
const BATCH = Number(process.env.WINDOW_INDEX_BATCH || 25) || 25;

/**
 * Coverage aimed for per bucket.
 *
 * Above the n<30 floor rather than at it: a population sitting exactly on the
 * threshold drops below it the moment anything is recounted, and a benchmark
 * that flickers in and out of "live" is worse than one that waits. The floor
 * itself is untouched -- this fills the population, it does not lower the bar.
 */
const TARGET_PER_BUCKET = Math.max(
  MIN_BENCHMARK_SAMPLES,
  Number(process.env.WINDOW_INDEX_TARGET || 40) || 40,
);

interface Candidate {
  token: string;
  curve: string;
  block_number: number;
  launched_at: number;
  /** Why it was picked -- and so which of the two reads it still needs. */
  reason: 'exempt' | 'sample' | 'holders';
  trades_indexed_to: number | null;
  holders_read_at: number | null;
}

/**
 * Seconds a launch must have lived before its opening window can be read.
 *
 * A launch younger than the window has not finished happening yet, and reading
 * it would record a partial window as a whole one. Excluded in SQL rather than
 * skipped in the loop: selection orders newest-first, so on a live chain the
 * youngest launches are exactly the ones it picks, and skipping them later
 * meant every pass chose the same unreadable batch and indexed nothing at all.
 */
const MIN_AGE_SECONDS = (WINDOW_30_MIN_BLOCKS / BLOCKS_PER_MINUTE) * 60;

/** Launches whose opening window is not yet read to `windowBlocks`. */
function uncovered(windowBlocks: number, where: string, params: unknown[], limit: number): Candidate[] {
  return db
    .prepare(
      `SELECT token, curve, block_number, launched_at, trades_indexed_to, holders_read_at
         FROM launches
        WHERE (trades_indexed_to IS NULL OR trades_indexed_to - block_number < ?)
          AND launched_at <= ?
          AND ${where}
        ORDER BY launched_at DESC
        LIMIT ?`,
    )
    .all(windowBlocks, Math.floor(Date.now() / 1000) - MIN_AGE_SECONDS, ...params, limit) as Candidate[];
}

/** How many launches can already answer a window of this many blocks. */
function coveredCount(windowBlocks: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM launches
          WHERE trades_indexed_to IS NOT NULL AND trades_indexed_to - block_number >= ?`,
      )
      .get(windowBlocks) as { n: number }
  ).n;
}

/**
 * The most launches the sample will ever read.
 *
 * The sample is target-driven, but one of those targets is check 09, whose
 * yield is roughly one usable observation per nine reads -- so a chain where
 * launches rarely reach six holders could pull the sample through every launch
 * in the index chasing a threshold it will never fill. Measured need is around
 * eight hundred launches for forty observations; this is generous against that
 * and, more importantly, finite. Reaching it is reported rather than passed
 * over in silence.
 */
const SAMPLE_CEILING = Math.max(
  TARGET_PER_BUCKET,
  Number(process.env.WINDOW_SAMPLE_CEILING || 2_000) || 2_000,
);

/** Launches whose opening window has been read, at any depth. */
function sampledSoFar(): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM launches WHERE trades_indexed_to IS NOT NULL').get() as { n: number }
  ).n;
}

/**
 * What to read next.
 *
 * Exempted-wallet launches first, and that population is read to completion
 * across passes rather than sampled -- it is the whole basis of a published
 * median. The recent sample only tops up what is short, and stops: there is no
 * value in reading the eighteen-thousandth launch to compute a median of forty.
 */
export function selectTargets(limit = BATCH): Candidate[] {
  const out: Candidate[] = [];

  // Exempted-wallet launches, but only while the median they feed still needs
  // them. Reading all of them was the earlier instruction and it was right when
  // the index held 183; against 69,192 unindexed launches it is days of work
  // for a median that is complete at thirty pairs. The floor is the target --
  // the same n<30 that decides whether the figure is published at all.
  if (exemptedHoldTime().pairs < holdTimeTarget()) {
    const exempt = uncovered(
      WINDOW_30_MIN_BLOCKS,
      'snipe_exemption_count > 0',
      [],
      limit,
    ).map((c) => ({ ...c, reason: 'exempt' as const }));
    out.push(...exempt);
    if (out.length >= limit) return out.slice(0, limit);
  }

  // Buckets below the thirty-minute cap need only their own span read; the ones
  // above it need the full window, because that is all the buyer count uses.
  const shortfall = AGE_BUCKETS.map((b) => {
    const windowMinutes = Math.min(
      WINDOW_30_MIN_BLOCKS / BLOCKS_PER_MINUTE,
      Number.isFinite(b.toSeconds) ? b.toSeconds / 60 : WINDOW_30_MIN_BLOCKS / BLOCKS_PER_MINUTE,
    );
    const windowBlocks = Math.round(windowMinutes * BLOCKS_PER_MINUTE);
    return { windowBlocks, missing: TARGET_PER_BUCKET - coveredCount(windowBlocks) };
  }).filter((s) => s.missing > 0);

  const seen = new Set(out.map((c) => c.token));

  // Check 09 can only be read for launches whose trades are indexed, because
  // that is what says a launch might have six holders at all. So when its
  // threshold is short AND there is nothing left to read for it, the thing that
  // is actually starved is the trade sample -- stopping it at the benchmark's
  // target left check 09 stranded twelve observations short with eighteen
  // thousand launches untouched. Trades are cheap; the holder read is not.
  const sampled = sampledSoFar();
  const concentrationStarved =
    concentrationCoverage() < concentrationTarget() &&
    unreadHolderCandidates() === 0 &&
    sampled < SAMPLE_CEILING;

  if (shortfall.length || concentrationStarved) {
    // The widest window that is short covers every narrower one too, so reading
    // for it fills them all at once rather than picking a different launch per
    // bucket.
    const widest = shortfall.length
      ? shortfall.reduce((a, b) => (b.windowBlocks > a.windowBlocks ? b : a))
      : { windowBlocks: WINDOW_30_MIN_BLOCKS };
    for (const c of uncovered(widest.windowBlocks, '1 = 1', [], limit + seen.size)) {
      if (seen.has(c.token)) continue;
      seen.add(c.token);
      out.push({ ...c, reason: 'sample' });
      if (out.length >= limit) return out;
    }
  }

  // Check 09's threshold has its own population and its own floor, and it is
  // NOT filled by any of the above: concentration comes from the token's
  // Transfer log, not from its trades. Attaching it to trade coverage alone
  // meant the loop went quiet with two observations recorded and thirty needed,
  // and the check would have stayed undetermined forever.
  if (concentrationCoverage() < concentrationTarget()) {
    // Only launches that plausibly HAVE six holders. Read blind, the yield was
    // 6%: thirty-two Transfer logs pulled for two usable observations, because
    // most launches on this chain never reach six holders and the top-five
    // share there is forced by arithmetic and records nothing. The trades this
    // loop already indexed say which launches are worth the read -- distinct
    // buy recipients bounds the pool: a launch nobody bought cannot have six
    // holders. It is only a bound, not a prediction -- measured against known
    // holder counts it runs in both directions, 87 buyers on a token with 190
    // holders and 48 on one with 9, because holders also arrive by transfer and
    // most buyers here sell out. So the busiest launches are read first, since
    // those are the ones most likely to still have six holders, rather than the
    // newest. Measured end to end the yield is about one observation in nine
    // reads either way -- the ordering is a preference, not a fix, and the real
    // saving is the pool, which drops 138 of 257 launches outright.
    const rows = db
      .prepare(
        `SELECT l.token, l.curve, l.block_number, l.launched_at, l.trades_indexed_to, l.holders_read_at
           FROM launches l
          WHERE l.holders_read_at IS NULL
            AND l.trades_indexed_to IS NOT NULL
            AND (SELECT COUNT(DISTINCT t.recipient) FROM trades t
                  WHERE t.token = l.token AND t.side = 'buy') >= ?
          ORDER BY (SELECT COUNT(DISTINCT t.recipient) FROM trades t
                     WHERE t.token = l.token AND t.side = 'buy') DESC,
                   l.launched_at DESC
          LIMIT ?`,
      )
      .all(MIN_HOLDERS_FOR_SHARE, limit + seen.size) as Candidate[];
    for (const c of rows) {
      if (seen.has(c.token)) continue;
      seen.add(c.token);
      out.push({ ...c, reason: 'holders' });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Launches whose trades are indexed, that look big enough to hold six wallets, and are unread. */
function unreadHolderCandidates(): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM launches l
          WHERE l.holders_read_at IS NULL
            AND l.trades_indexed_to IS NOT NULL
            AND (SELECT COUNT(DISTINCT t.recipient) FROM trades t
                  WHERE t.token = l.token AND t.side = 'buy') >= ?`,
      )
      .get(MIN_HOLDERS_FOR_SHARE) as { n: number }
  ).n;
}

/**
 * Pairs the exempted-wallet median needs before it is worth publishing, which
 * is also the point at which reading more launches for it stops buying
 * anything. Headroom above the floor for the same reason the buckets have it:
 * a population resting exactly on the threshold falls under it on any recount.
 */
function holdTimeTarget(): number {
  return Math.max(MIN_HOLD_SAMPLES, Number(process.env.WINDOW_INDEX_TARGET || 40) || 40);
}

/** Observations aimed for, above check 09's floor for the same reason as above. */
function concentrationTarget(): number {
  return Math.max(MIN_CONCENTRATION_SAMPLES, Number(process.env.WINDOW_INDEX_TARGET || 40) || 40);
}

export interface WindowPass {
  attempted: number;
  indexed: number;
  trades: number;
  failed: number;
  exempt: number;
  sample: number;
  /** Holder-distribution observations recorded, for check 09's threshold. */
  concentration: number;
  /** The node said no and the pass gave up rather than argue with it. */
  rateLimited: boolean;
  /** The limiter had nothing spare, so the pass did not start. */
  yielded: boolean;
}

/** Read one batch of opening windows. */
export async function indexWindows(limit = BATCH): Promise<WindowPass> {
  // Sized by what the limiter can spare, not by a fixed number. A pass of
  // twenty-five queued twenty-five background requests whatever else was
  // happening; measured, that took a scan's cumulative queue wait from 1.5s to
  // 12s. Spare capacity is zero whenever a scan is in flight or was served in
  // the last second, so a busy bot indexes nothing at all -- which is the
  // intended behaviour, not a degradation.
  const spare = spareCapacity();
  if (spare <= 0) {
    return {
      attempted: 0, indexed: 0, trades: 0, failed: 0, exempt: 0, sample: 0,
      concentration: 0, rateLimited: false, yielded: true,
    };
  }
  const targets = selectTargets(Math.max(1, Math.min(limit, spare)));
  const pass: WindowPass = {
    attempted: targets.length, indexed: 0, trades: 0, failed: 0, exempt: 0, sample: 0,
    concentration: 0, rateLimited: false, yielded: false,
  };
  if (!targets.length) return pass;

  const head = Number(await bulk(() => client.getBlockNumber()));

  for (const t of targets) {
    // A launch younger than the window has not finished happening yet. Reading
    // it now would record a partial window as though it were the whole one, so
    // it is left for a later pass.
    // Re-checked per launch: a scan arriving mid-pass should stop the pass, not
    // wait behind the twenty-four launches still queued in front of it.
    if (spareCapacity() <= 0) { pass.yielded = true; break; }
    const windowEnd = t.block_number + WINDOW_30_MIN_BLOCKS;
    if (windowEnd > head) continue;
    try {
      const needsTrades = (t.trades_indexed_to ?? -1) - t.block_number < WINDOW_30_MIN_BLOCKS;
      if (needsTrades) {
        const n = await bulk(() => indexOneCurve(t.curve, t.token, BigInt(t.block_number), BigInt(windowEnd)));
        markWindowIndexed(t.token, t.block_number, windowEnd);
        pass.indexed++;
        pass.trades += n;
        if (t.reason === 'exempt') pass.exempt++;
        else pass.sample++;
      }

      // Check 09's threshold is a percentile of recorded holder distributions,
      // and those are recorded on scan -- which is the same drought this loop
      // exists to end, but a different source: concentration comes from the
      // token's Transfer log, not from trades, so indexing trades alone would
      // have left that check undetermined forever. Measured over the token's
      // life to date rather than the opening window, because what the threshold
      // compares is how supply is distributed now.
      //
      // Best-effort: a launch whose Transfer log will not read still counts as a
      // window read. The trades are the primary purpose here.
      if (t.holders_read_at === null) {
        try {
          // Through the same incremental path as the refresher, so this read
          // stores its balances too and every later read of the token is a
          // delta rather than another whole-life scan.
          const c = (await bulk(() =>
            refreshConcentration(t.token, t.curve, BigInt(t.block_number), BigInt(head), () => !interactivelyBusy()),
          )).concentration;
          // Marked as read whatever came back. Most launches on this chain have
          // fewer than six holders, where the top-five share is forced and
          // records nothing -- without this the loop would pick the same
          // launches every pass, forever, and never reach one that counts.
          db.prepare('UPDATE launches SET holders_read_at = ? WHERE token = ?')
            .run(Math.floor(Date.now() / 1000), t.token.toLowerCase());
          // excessConcentration is what decides whether the observation is
          // recordable at all, so asking it directly beats counting the table
          // twice per launch to find out.
          // refreshConcentration stores the reading itself; this only counts
          // the ones that are usable observations for the threshold.
          if (excessConcentration(c) !== null) pass.concentration++;
        } catch (err) {
          if (isRateLimit(err)) throw err;   // handled once, below
          console.warn(`[windows] ${t.token} holder read failed:`, String((err as any)?.shortMessage ?? (err as Error)?.message ?? err).slice(0, 100));
        }
      }
    } catch (err) {
      // A limit is not this launch's problem and the next launch will hit it
      // too. Grinding on would spend the 429 backoff budget once per launch --
      // a full batch is twenty minutes of a pass arguing with a node that has
      // already said no. Abandon the pass; the next tick picks up where this
      // one stopped, and the interactive traffic this yields to is the whole
      // reason the loop is bulk in the first place.
      if (isRateLimit(err)) {
        pass.rateLimited = true;
        console.warn(`[windows] rate limited after ${pass.indexed} windows; pausing until the next pass`);
        break;
      }
      // One unreadable launch must not stop the pass; the row keeps its
      // unmarked state and comes back around next time.
      pass.failed++;
      console.warn(`[windows] ${t.token} unreadable:`, String((err as any)?.shortMessage ?? (err as Error)?.message ?? err).slice(0, 120));
    }
  }
  return pass;
}

/** Remaining work, for the log line. */
/**
 * Whether the sample has stopped because it ran out of room rather than because
 * it was satisfied. Worth saying out loud: check 09 stays undetermined and the
 * reason is not obvious from any other number.
 */
export function sampleCeilingReached(): boolean {
  return (
    concentrationCoverage() < concentrationTarget() &&
    unreadHolderCandidates() === 0 &&
    sampledSoFar() >= SAMPLE_CEILING
  );
}

/**
 * Graduated launches whose curve life is not read to its end.
 *
 * The opening-window sample reads the first thirty minutes of a launch, which
 * is what every card figure is defined over. A curve that graduated traded
 * for hours, and /stats tax ranks graduated launches by what traded on the
 * curve: over the first thirty minutes that ranking would be an accident of
 * which launches were sampled. So the curve life of a graduated launch is
 * read to the block it was swept at, newest first, a few per pass, at the
 * same bulk priority as everything else here. The sweep is where curve trades
 * stop, so a launch read to it is read in full and stays so.
 */
const GRADUATED_PER_PASS = Number(process.env.WINDOW_GRADUATED_BATCH || 3) || 3;

interface GraduatedCandidate {
  token: string;
  curve: string;
  block_number: number;
  trades_indexed_to: number | null;
  curve_end: number;
}

function unreadGraduated(limit: number): GraduatedCandidate[] {
  return db
    .prepare(
      `SELECT token, curve, block_number, trades_indexed_to,
              COALESCE(swept_at, graduated_at) AS curve_end
         FROM launches
        WHERE phase = 2
          AND COALESCE(swept_at, graduated_at) IS NOT NULL
          AND (trades_indexed_to IS NULL OR trades_indexed_to < COALESCE(swept_at, graduated_at))
        ORDER BY COALESCE(swept_at, graduated_at) DESC
        LIMIT ?`,
    )
    .all(limit) as GraduatedCandidate[];
}

/** How many graduated launches still lack their full curve life. */
export function graduatedUnreadCount(): number {
  return (db
    .prepare(
      `SELECT COUNT(*) AS n FROM launches
        WHERE phase = 2 AND COALESCE(swept_at, graduated_at) IS NOT NULL
          AND (trades_indexed_to IS NULL OR trades_indexed_to < COALESCE(swept_at, graduated_at))`,
    )
    .get() as { n: number }).n;
}

export interface GraduatedPass { attempted: number; read: number; trades: number; failed: number; yielded: boolean }

/** Read the rest of a few graduated launches' curve lives. */
export async function indexGraduatedCurves(limit = GRADUATED_PER_PASS): Promise<GraduatedPass> {
  const pass: GraduatedPass = { attempted: 0, read: 0, trades: 0, failed: 0, yielded: false };
  if (spareCapacity() <= 0) { pass.yielded = true; return pass; }
  const targets = unreadGraduated(Math.max(1, limit));
  pass.attempted = targets.length;
  if (!targets.length) return pass;
  const head = Number(await bulk(() => client.getBlockNumber()));
  for (const t of targets) {
    if (spareCapacity() <= 0) { pass.yielded = true; break; }
    // Resumes where the opening window left off. Capped at head so a sweep the
    // node has not reached yet is read next time rather than recorded as read.
    const from = Math.max(t.block_number, (t.trades_indexed_to ?? t.block_number - 1) + 1);
    const to = Math.min(t.curve_end, head);
    if (to < from) continue;
    try {
      pass.trades += await bulk(() => indexOneCurve(t.curve, t.token, BigInt(from), BigInt(to)));
      markWindowIndexed(t.token, t.block_number, to);
      pass.read++;
    } catch (err) {
      pass.failed++;
      console.warn(`[windows] curve life of ${t.token} unreadable:`, String((err as Error)?.message ?? err).slice(0, 120));
      if (isRateLimit(err)) break;
    }
  }
  return pass;
}

export function windowBacklog(): { exempt: number; total: number } {
  const q = (where: string) =>
    (db
      .prepare(
        `SELECT COUNT(*) AS n FROM launches
          WHERE (trades_indexed_to IS NULL OR trades_indexed_to - block_number < ?) AND ${where}`,
      )
      .get(WINDOW_30_MIN_BLOCKS) as { n: number }).n;
  return { exempt: q('snipe_exemption_count > 0'), total: q('1 = 1') };
}

/**
 * Long-running drip, paced like the decode loop.
 *
 * Every pass is bounded and every request inside it is bulk, so the loop is
 * invisible to anyone using the bot: a scan issued mid-pass is served first.
 */
export function startWindowLoop(intervalMs = 15_000, batch = BATCH): NodeJS.Timeout {
  let running = false;
  let ceilingReported = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const pass = await indexWindows(batch);
      // After the sample, never instead of it: the opening windows are what
      // every card figure is defined over, and the curve lives serve one
      // ranking in /stats tax.
      const grad = await indexGraduatedCurves();
      if (grad.read || grad.failed) {
        console.log(
          `[windows] ${grad.read} graduated curve ${grad.read === 1 ? 'life' : 'lives'} read in full, ` +
            `${grad.trades.toLocaleString()} trades${grad.failed ? `, ${grad.failed} unreadable` : ''}, ` +
            `${graduatedUnreadCount().toLocaleString()} left`,
        );
      }
      if (!pass.attempted && sampleCeilingReached() && !ceilingReported) {
        ceilingReported = true;
        console.log(
          `[windows] sample ceiling of ${SAMPLE_CEILING.toLocaleString()} launches reached with ` +
            `${concentrationCoverage()} of ${concentrationTarget()} holder observations; ` +
            `holder concentration stays undetermined until more launches reach six holders.`,
        );
      }
      if (pass.indexed || pass.failed) {
        const left = windowBacklog();
        const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
        console.log(
          `[windows] ${plural(pass.indexed, 'window')} read (${pass.exempt} exempt, ${pass.sample} sample), ` +
            `${pass.trades.toLocaleString()} trades, ${plural(pass.concentration, 'holder reading')}` +
            `${pass.failed ? `, ${pass.failed} unreadable` : ''}` +
            `${pass.rateLimited ? ', paused on a rate limit' : ''}, ` +
            // "remaining" only means the exempt population, which is read to
            // completion. The rest is a target, not a queue: the sample stops
            // when the buckets and check 09 are satisfied, so the unindexed
            // count is context, not a backlog anyone is working through.
            `${plural(left.exempt, 'exempt launch', 'exempt launches')} left, ` +
            `${left.total.toLocaleString()} unindexed`,
        );
      }
    } catch (err) {
      console.error('[windows] loop error:', err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}


/**
 * Refresh one token's holder reading in the background.
 *
 * Fire and forget, at bulk priority, deduplicated by token. Called after a scan
 * so the NEXT scan of that token serves the check from the index instantly --
 * the reading itself costs twenty seconds on a busy launch and must never be on
 * the path between a request and a card.
 *
 * Deliberately not routed through the window loop's selection: that stops once
 * its coverage targets are met, and a refresh is about one token being current
 * rather than about the population being large enough.
 */
const refreshing = new Set<string>();

/**
 * How long a stored reading is left alone before a refresh is worth its cost.
 *
 * Refreshing on every scan made the NEXT scan of that token ten times slower:
 * 1.5s to 15.7s, with readToken alone taking 11.7s of it. A whole-life Transfer
 * read is 9,001 logs across four million blocks, and while the node is serving
 * that it serves everything else slowly too -- which is server-side contention
 * that no amount of client-side priority can reorder away. So the refresh is
 * rare rather than merely deprioritised.
 */
const REFRESH_TTL_MS = Number(process.env.HOLDER_REFRESH_TTL_MS || 30 * 60_000) || 30 * 60_000;

/** One at a time, process-wide. Two heavy reads at once is the same problem twice. */
let refreshInFlight = 0;

export function queueHolderRefresh(token: string, curve: string, launchBlock: number): void {
  if (process.env.HOLDER_REFRESH_OFF === '1') return;
  const key = token.toLowerCase();
  if (refreshing.has(key) || refreshInFlight > 0) return;

  const stored = readStoredConcentration(token);
  if (stored && stored.ageSeconds * 1000 < REFRESH_TTL_MS) return;

  // A token with no stored balances needs its whole life read -- four million
  // blocks, half a minute, and heavy enough that a concurrent scan felt it
  // however finely it was chunked or paced. That work belongs to the window
  // loop, which runs on its own schedule when nobody is waiting. A scan only
  // ever triggers the cheap case: a delta onto balances that already exist.
  if (!hasStoredBalances(token)) return;

  refreshing.add(key);
  refreshInFlight++;
  void (async () => {
    try {
      const head = await bulk(() => client.getBlockNumber());
      // Wait for the user to be done before starting. Starting immediately after
      // the scan that queued it put a heavy read against the node exactly while
      // the next scan needed it.
      const r = await bulk(() =>
        refreshConcentration(token, curve, BigInt(launchBlock), head, () => !interactivelyBusy()),
      );
      console.log(
        `[holders] ${key.slice(0, 10)} ${r.incremental ? 'updated' : 'first read'}` +
          `${r.complete ? '' : ' (paused for a scan, resumes next time)'}: ` +
          `top 5 hold ${r.concentration.top5Share.toFixed(1)}% of ${r.concentration.holders} holders, ` +
          `${r.blocksRead.toLocaleString()} blocks read`,
      );
      db.prepare('UPDATE launches SET holders_read_at = ? WHERE token = ?')
        .run(Math.floor(Date.now() / 1000), key);
    } catch (err) {
      // Nothing to report to anyone: the card already rendered without it, and
      // the next scan queues another attempt.
      console.warn(`[holders] ${key.slice(0, 10)} refresh failed:`, String((err as any)?.shortMessage ?? (err as Error)?.message ?? err).slice(0, 100));
    } finally {
      refreshing.delete(key);
      refreshInFlight--;
    }
  })();
}

/** In-flight refreshes, for tests and for the /stats line. */
export function refreshesInFlight(): number {
  return refreshing.size;
}
