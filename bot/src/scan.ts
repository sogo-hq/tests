import type { Hex } from 'viem';
import { client, getLogsAdaptive } from './chain.js';
import { interactive, measuringWaits } from './ratelimit.js';
import { db, normaliseKey } from './db.js';
import { readToken, type TokenReads } from './reads.js';
import { indexOneCurve, markWindowIndexed, coveredThrough } from './indexer/trades.js';
import { fetchLaunchCalldata } from './indexer/exemptions.js';
import { computeTraction, type TractionMetrics } from './metrics/traction.js';
import { computeFlags, type FlagResult } from './metrics/flags.js';
import { buyerBenchmark, type BuyerBenchmark } from './metrics/benchmark.js';
import {
  readStoredConcentration,
  refreshConcentration,
  hasStoredBalances,
  type Concentration,
} from './metrics/concentration.js';
import { queueHolderRefresh } from './indexer/windows.js';
import { PhaseTimer, Budget, withDeadline } from './timing.js';
import { firstScan, type FirstScan } from './history.js';
import { readDeployerActivity, type DeployerActivity } from './metrics/deployer.js';

/** The launch time to measure the deployer's first move from. */
function launchedAtExactForDeployer(reads: TokenReads, launch: { launchedAt: number }): number {
  return reads.launchedAt > 0 ? reads.launchedAt : launch.launchedAt;
}
import { SCAN_BUDGET_MS, CONCENTRATION_DEADLINE_MS } from './config.js';
import { isRateLimit } from './ratelimit.js';
import { TokenLaunched } from './abi.js';
import {
  FACTORY,
  FACTORY_LOG_CHUNK,
  BLOCKS_PER_DAY,
  WINDOW_30_MIN_BLOCKS,
  RECHECK_OFFSETS_HOURS,
  LOOKBACK_DAYS,
  EARLY_WINDOW_SECONDS,
  EARLY_DRIFT_MARGIN_SECONDS,
  BLOCK_TIME_SECONDS,
} from './config.js';

/** Facts fixed in the launch transaction, available the instant a token exists. */
export interface CreationFacts {
  entryPoint: string | null;
  /** launchAndBuy only: the creator's own opening buy, in the same transaction. */
  launchBuyAmount: bigint | null;
  launchBuyRecipient: string | null;
  snipeExemptionCount: number | null;
}

export interface ScanResult {
  scanId: number;
  reads: TokenReads;
  traction: TractionMetrics;
  flags: FlagResult;
  /**
   * What the buyer count means next to launches of the same age. A raw count
   * tells a reader nothing about whether a launch is early or already over.
   */
  benchmark: BuyerBenchmark;
  launchBlock: number;
  launchedAt: number;
  ageSeconds: number;
  currentBlock: number;
  creation: CreationFacts;
  /**
   * True when the token is younger than EARLY_WINDOW_SECONDS, so every traction
   * metric on this result is structurally undefined rather than measured. The
   * renderers must not present them.
   */
  isEarly: boolean;
  /**
   * The age threshold that decided isEarly for THIS scan. Not always
   * EARLY_WINDOW_SECONDS: without an exact launch time it is widened by the
   * index's drift margin. Anything reasoning about how long the early card
   * stays true has to use this number, not the constant.
   */
  earlyThresholdSeconds: number;
  /** Per-phase milliseconds, so a slow scan can be explained rather than guessed at. */
  phases: string;
  /** The phase that took longest. */
  slowestPhase: string | null;
  /** True when the scan ran past its budget; the log says which phase ate it. */
  overBudget: boolean;
  /** Milliseconds this scan's requests spent queued for a rate-limiter token. */
  waitMs: number;
  /** Deepest queue any of its requests arrived into. */
  maxQueue: number;
  /** Most background requests queued ahead of one of its requests. */
  bulkAhead: number;
  /** What this token was worth when it was first scanned here. Null on a first scan. */
  firstScan: FirstScan | null;
  /**
   * What the deployer did with its supply. /full only, and null when the
   * transfers could not be read -- which renders as undetermined, not as
   * "unchanged".
   */
  deployerActivity: DeployerActivity | null;
}

/**
 * A read that did not finish is not a fact about the chain.
 *
 * Thrown when the factory says a token exists but its launch could not be
 * placed. Everything downstream of a scan needs the launch block, and returning
 * null for this rendered as "not a pons v2 launch" -- a confident statement
 * about the chain produced by a lookup that never completed, on a token the
 * factory had already confirmed. That is the exact failure this project exists
 * to avoid, and it reached a user.
 */
/**
 * Blocks of slack per second of age when placing a launch from the curve.
 *
 * One percent covers the measured drift several times over without pushing the
 * window start so far back that it stops overlapping the launch.
 */
const CURVE_ESTIMATE_MARGIN = 0.01 / BLOCK_TIME_SECONDS;

export class LaunchLookupIncomplete extends Error {
  constructor(readonly reason: string, readonly durationMs: number) {
    super(`launch lookup incomplete after ${durationMs}ms: ${reason}`);
    this.name = 'LaunchLookupIncomplete';
  }
}

export interface LaunchLocation {
  block: number;
  /** Null when the launch was placed without seeing its transaction. */
  txHash: Hex | null;
  launchedAt: number;
  /** Where it came from, for the log: the index, the factory's logs, or the curve. */
  source: 'index' | 'logs' | 'curve';
  /**
   * How far the block might be out, in blocks. Zero when it was read; the
   * safety margin when it was estimated from the curve's timestamp.
   */
  uncertaintyBlocks: number;
}

/**
 * Locate a token's launch: the index, then the factory's logs, then the curve.
 *
 * The caller has already established that the factory knows this token --
 * readToken reads getLaunchedToken and returns null when `exists` is false --
 * so "absent" is not one of the answers this can give. Either it places the
 * launch or it admits it could not.
 */
async function findLaunch(
  token: string,
  head: bigint,
  reads: TokenReads,
): Promise<LaunchLocation> {
  const started = Date.now();
  const row = db
    .prepare('SELECT block_number, tx_hash, launched_at FROM launches WHERE token = ?')
    .get(token.toLowerCase()) as { block_number: number; tx_hash: string; launched_at: number } | undefined;
  if (row) {
    return {
      block: row.block_number, txHash: row.tx_hash as Hex,
      launchedAt: row.launched_at, source: 'index', uncertaintyBlocks: 0,
    };
  }

  // Not indexed yet -- search back through the factory's own logs. Scoped to the
  // factory address and filtered on the indexed token topic, so this stays fast.
  // Searched newest-first in modest strides: a topic-filtered query is far more
  // expensive on this node than a plain address-scoped one, so the wide spans
  // used by the backfill are not safe here.
  const earliest = head - BigInt(Math.round(LOOKBACK_DAYS * BLOCKS_PER_DAY));
  const stride = BigInt(FACTORY_LOG_CHUNK);
  for (let end = head; end > earliest; end -= stride) {
    const start = end - stride > earliest ? end - stride : earliest;
    const logs = await getLogsAdaptive({
      address: FACTORY,
      event: TokenLaunched,
      args: { token: token as Hex },
      fromBlock: start,
      toBlock: end,
    });
    if (logs.length) {
      const l = logs[0]!;
      const blk = await client.getBlock({ blockNumber: l.blockNumber!, includeTransactions: false });
      return {
        block: Number(l.blockNumber),
        txHash: l.transactionHash as Hex,
        launchedAt: Number(blk.timestamp),
        source: 'logs',
        uncertaintyBlocks: 0,
      };
    }
  }

  // The logs did not have it, and for a launch seconds old that is expected
  // rather than surprising: this node's log index lags its head, so a token can
  // exist in the factory's state before it appears in a getLogs result. The
  // curve knows exactly when it launched, so the block is derived from that
  // instead of giving up -- no second scan, and the reading is already in hand
  // from the same call that proved the token exists.
  if (reads.launchedAt > 0) {
    // Measured against the head block's OWN timestamp, not this host's clock.
    // Deriving from wall time put the block 310 to 618 blocks early across four
    // real launches -- 31 to 62 seconds -- because the node's head lags real
    // time and the error grows with how far behind it is. The chain's own
    // clock has no such skew, and one getBlock on a path this rare is nothing.
    const headBlock = await client.getBlock({ blockNumber: head, includeTransactions: false });
    const elapsed = Math.max(0, Number(headBlock.timestamp) - reads.launchedAt);
    const estimate = Number(head) - elapsed / BLOCK_TIME_SECONDS;
    // Deliberately biased early. Measured against four real launches the
    // estimate lands 275 to 528 blocks before the truth and the error grows
    // with age, because the chain's block time is not exactly the 0.1s this
    // divides by. Erring earlier still is the safe direction: blocks before a
    // launch hold none of its trades, while blocks after it hold the opening
    // minutes, which are the ones that matter most.
    const margin = Math.max(600, elapsed * CURVE_ESTIMATE_MARGIN);
    const block = Math.min(Number(head), Math.max(1, Math.floor(estimate - margin)));
    return {
      block, txHash: null, launchedAt: reads.launchedAt, source: 'curve',
      uncertaintyBlocks: Math.ceil(margin),
    };
  }

  throw new LaunchLookupIncomplete(
    'factory confirms the token but neither its logs nor the curve could place the launch',
    Date.now() - started,
  );
}

/** Make sure this token has a row in `launches`, decoding its creation tx. */
async function ensureLaunchRow(
  reads: TokenReads,
  launch: { block: number; txHash: Hex; launchedAt: number },
): Promise<void> {
  const existing = db
    .prepare('SELECT snipe_exemption_count FROM launches WHERE token = ?')
    .get(reads.token.toLowerCase()) as { snipe_exemption_count: number | null } | undefined;
  if (existing && existing.snipe_exemption_count !== null) return;

  const cd = await fetchLaunchCalldata(launch.txHash);
  const name = cd.name ?? reads.name;
  const symbol = cd.symbol ?? reads.symbol;
  db.prepare(`
    INSERT INTO launches (
      token, curve, deployer, pair_token, launch_config_id, graduation_threshold,
      block_number, tx_hash, launched_at, name, symbol, name_key, symbol_key,
      snipe_exemption_count, snipe_exemptions, entry_point, creator_tax_bps,
      buyback_enabled, launch_buy_amount, launch_buy_recipient, phase
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET
      snipe_exemption_count = COALESCE(excluded.snipe_exemption_count, launches.snipe_exemption_count),
      snipe_exemptions      = COALESCE(excluded.snipe_exemptions, launches.snipe_exemptions),
      entry_point           = excluded.entry_point,
      -- These come from the same decode as entry_point and snipe_exemption_count.
      -- Omitting them left a row whose exemption count says "decoded" while the
      -- creator's opening buy stays NULL, which the card then reports as a
      -- confident "creator opening buy: none".
      launch_buy_amount     = excluded.launch_buy_amount,
      launch_buy_recipient  = excluded.launch_buy_recipient,
      name = COALESCE(excluded.name, launches.name),
      symbol = COALESCE(excluded.symbol, launches.symbol),
      name_key = COALESCE(excluded.name_key, launches.name_key),
      symbol_key = COALESCE(excluded.symbol_key, launches.symbol_key),
      phase = excluded.phase
  `).run(
    reads.token.toLowerCase(), reads.curve.toLowerCase(), reads.deployer.toLowerCase(),
    reads.pairToken.toLowerCase(), 0, String(reads.graduationThreshold),
    launch.block, launch.txHash, launch.launchedAt, name, symbol,
    name ? normaliseKey(name) : null, symbol ? normaliseKey(symbol) : null,
    cd.exemptionCount, cd.exemptions.length ? JSON.stringify(cd.exemptions) : null,
    cd.entryPoint, cd.creatorTaxBps ?? reads.creatorTaxBps,
    (cd.buybackEnabled ?? reads.buybackEnabled) ? 1 : 0,
    cd.buyAmount === null ? null : String(cd.buyAmount), cd.buyRecipient, reads.phase,
  );
}

export async function scanToken(token: string, requestedBy?: number): Promise<ScanResult | null> {
  // Wrapped so every scan carries what it spent waiting for the rate limiter,
  // and how much of the queue it arrived behind was background work. Users
  // reporting "slow" is not evidence of contention; this is.
  const { value, waits } = await measuringWaits(() => interactive(() => scanTokenInner(token, requestedBy)));
  if (value) {
    value.waitMs = waits.waitMs;
    value.maxQueue = waits.maxQueue;
    value.bulkAhead = waits.bulkAhead;
  }
  return value;
}

async function scanTokenInner(token: string, requestedBy?: number): Promise<ScanResult | null> {
  const timer = new PhaseTimer();
  const budget = new Budget(SCAN_BUDGET_MS);

  const reads = await timer.time('reads', () => readToken(token));
  if (!reads) return null;

  const head = await timer.time('head', () => client.getBlockNumber());
  const launch = await timer.time('findLaunch', () => findLaunch(reads.token, head, reads));
  // Which of the three placed it, so "not a pons v2 launch" versus "could not
  // read" is answerable from the log rather than by guessing. Only the two
  // fallbacks are worth a line: the index is the ordinary case and says nothing.
  if (launch.source !== 'index') {
    console.log(
      `[scan] launch for ${reads.token} placed from ${launch.source} in ${timer.lastMs('findLaunch')}ms` +
        `${launch.source === 'curve' ? ' — the factory knows it but its logs do not yet' : ''}`,
    );
  }

  // Skipped when the launch was placed from the curve rather than seen in a
  // log: there is no creation transaction to decode and the row's tx_hash is
  // NOT NULL. The snipe-exemption check then reports undetermined, which is
  // true -- the creation transaction has not been read.
  if (launch.txHash) await timer.time('launchRow', () => ensureLaunchRow(reads, { ...launch, txHash: launch.txHash! }));

  // Index the measurement window. Capped at the 30-minute window even for old
  // tokens, because that is the window every traction metric is defined over.
  // Widened by the placement's own uncertainty. An estimated launch block sits
  // early by design, so a window measured from it ends early too and clips the
  // tail off the thirty minutes it is meant to cover. Reading further costs one
  // slightly wider query and means the trades are all here for whoever asks
  // next -- including a later scan that places the launch exactly.
  const windowEnd = BigInt(Math.min(
    launch.block + WINDOW_30_MIN_BLOCKS + 2 * launch.uncertaintyBlocks,
    Number(head),
  ));
  // Re-indexing a window that is already complete is pure latency. The first
  // thirty minutes of a launch that is days old is immutable history, and the
  // rows are already here -- yet this re-read them on every scan, 2.6 seconds
  // of a five-second budget spent confirming what the index already said. A
  // token still inside its own window is a different matter: that window is
  // still filling, so it is always re-read.
  const covered = coveredThrough(reads.token);
  const windowComplete = covered !== null && covered >= launch.block + WINDOW_30_MIN_BLOCKS;
  if (windowComplete) {
    timer.record('trades', 0);
  } else {
    await timer.time('trades', () => indexOneCurve(reads.curve, reads.token, BigInt(launch.block), windowEnd));
    // Coverage is only claimed for a launch block that was READ, not estimated.
    // The benchmark compares like for like across launches; a window placed a
    // few hundred blocks out would enter that population as though it had been
    // measured exactly, and quietly skew the median everyone is compared to.
    if (launch.source !== 'curve') markWindowIndexed(reads.token, launch.block, Number(windowEnd));
  }

  const scannedAt = Math.floor(Date.now() / 1000);
  const traction = computeTraction(
    reads.token,
    launch.block,
    Number(head),
    reads.graduationThreshold,
  );

  // ------------------------------------------------------------------ 09
  // Holder concentration, served from the index and never waited on.
  //
  // Reading a token's whole Transfer history costs twenty seconds on a busy
  // launch -- 9,001 logs across four million blocks -- and putting that between
  // a request and a card took scans from 1.1s to 56s. A card that arrives after
  // the decision is worth nothing, and the delay read as the bot being broken
  // rather than slow.
  //
  // So: the stored reading if there is one, which is instant; otherwise a live
  // read bounded by whatever is smaller, its own two-second deadline or what is
  // left of the scan's budget. Losing that race is not a failure -- the check
  // renders undetermined, exactly as it does when the read fails -- and the
  // background refresh means the next scan of this token has an answer waiting.
  let concentration: Concentration | null = readStoredConcentration(reads.token, scannedAt);
  const fromIndex = concentration !== null;
  if (!fromIndex && hasStoredBalances(reads.token)) {
    // Only ever the cheap case. A deadline caps how long the CARD waits, not
    // how long the work runs: a losing read carries on in the background at
    // interactive priority, and a four-million-block one left every scan for
    // the next half minute sitting at eight seconds. So a first read is never
    // started here at all -- the window loop does those on its own schedule --
    // and what runs inline is a delta of a few hundred blocks.
    const allowance = budget.allowanceFor(CONCENTRATION_DEADLINE_MS);
    concentration = await timer.time('concentration', () =>
      withDeadline(
        refreshConcentration(reads.token, reads.curve, BigInt(launch.block), head)
          .then((r) => r.concentration)
          .catch((err: any) => {
            if (isRateLimit(err)) console.warn(`[scan] holder read rate limited for ${reads.token}`);
            return null;
          }),
        allowance,
        null,
      ));
  }
  // Always queue a refresh: a miss needs a first reading, and a hit needs the
  // next one to be current. Deduplicated, bulk priority, off the critical path.
  queueHolderRefresh(reads.token, reads.curve, launch.block);

  // The deployer's own movements. Bounded by the same deadline as the holder
  // read and only attempted when that one was served from the index, so it can
  // never be the reason a card is late -- it appears in /full, which nobody is
  // staring at in the first ten seconds of a launch.
  let deployerActivity: DeployerActivity | null = null;
  if (fromIndex) {
    deployerActivity = await timer.time('deployer', () =>
      withDeadline(
        readDeployerActivity(
          reads.token, reads.deployer, reads.curve,
          BigInt(launch.block), head, launchedAtExactForDeployer(reads, launch), BLOCK_TIME_SECONDS,
        ).catch(() => null),
        budget.allowanceFor(CONCENTRATION_DEADLINE_MS),
        null,
      ));
  }

  const flags = computeFlags({
    token: reads.token,
    deployer: reads.deployer,
    name: reads.name,
    symbol: reads.symbol,
    creatorTaxBps: reads.creatorTaxBps,
    buybackEnabled: reads.buybackEnabled,
    pairToken: reads.pairToken,
    pairSymbol: reads.pairSymbol,
    scannedAt,
    concentration,
  });

  // -------------------------------------------------------------------------
  // Age, and the early-mode decision that hangs off it.
  //
  // Three separate clocks disagree here, and the 180-second boundary is tight
  // enough that each one matters:
  //
  //  1. curve.launchedAt() -- exact, straight from the chain, but it is read
  //     through the optional-read helper and so can come back absent.
  //  2. launches.launched_at -- an interpolated block timestamp, measured to
  //     drift up to about seven seconds. Fine for a seven-day window, not for
  //     a 180-second one.
  //  3. this host's wall clock, which supplies "now" and can be wrong by any
  //     amount at all after a VM resume or before an NTP sync.
  //
  // So: prefer the exact launch time; widen the window by the known drift when
  // only the interpolated one is available; and cross-check the elapsed time
  // against the chain's own block progression, which no host clock can skew.
  // -------------------------------------------------------------------------
  const haveExactLaunchTime = reads.launchedAt > 0;
  const launchedAtExact = haveExactLaunchTime ? reads.launchedAt : launch.launchedAt;

  /** Elapsed time derived purely from block progression -- immune to host clock skew. */
  const chainAgeSeconds = Math.max(0, (Number(head) - launch.block) * BLOCK_TIME_SECONDS);
  const wallAgeSeconds = scannedAt - launchedAtExact;

  // A negative age, or one out of step with the chain NEAR THE BOUNDARY, means
  // this host's clock is wrong rather than the token being new. Clamping to zero
  // would turn that into maximum-confidence "launched 0s ago" for a token that
  // may be hours old and already trading.
  //
  // The comparison is scoped to the regime where it matters. Block time is 0.1s
  // on average but not exactly, so the block-derived estimate drifts from the
  // timestamp by roughly a percent over long spans -- about 23 minutes across a
  // two-day-old token. A flat tolerance therefore fires on essentially every
  // older token, logging a false clock warning and replacing an accurate age
  // with a worse one. Past a few multiples of the early window the exact age is
  // not load-bearing for anything, so the check simply does not apply there.
  const BOUNDARY_REGIME_SECONDS = EARLY_WINDOW_SECONDS * 3;
  const nearBoundary =
    wallAgeSeconds < BOUNDARY_REGIME_SECONDS || chainAgeSeconds < BOUNDARY_REGIME_SECONDS;
  const clockSuspect =
    wallAgeSeconds < 0 ||
    (nearBoundary && Math.abs(wallAgeSeconds - chainAgeSeconds) > 30);
  if (clockSuspect) {
    console.warn(
      `[scan] host clock disagrees with the chain for ${reads.token}: ` +
      `wall age ${wallAgeSeconds}s vs block-derived ${Math.round(chainAgeSeconds)}s — using the chain`,
    );
  }
  const ageSeconds = Math.max(0, Math.round(clockSuspect ? chainAgeSeconds : wallAgeSeconds));

  // Without an exact launch time the window widens by the index's known drift,
  // so a token that might still be inside it is never given a traction verdict.
  const earlyThreshold = haveExactLaunchTime
    ? EARLY_WINDOW_SECONDS
    : EARLY_WINDOW_SECONDS + EARLY_DRIFT_MARGIN_SECONDS;
  const isEarly = ageSeconds < earlyThreshold;

  // Measured over the same window on both sides -- this token's own observed
  // window -- so the comparison is like for like rather than this token at two
  // minutes against everyone else's eventual totals. Computed before the early
  // return so both paths carry it.
  const benchmark = buyerBenchmark({
    ageSeconds,
    windowMinutes: traction.windowMinutes,
    excludeToken: reads.token,
    now: scannedAt,
  });

  const creationRow = db
    .prepare('SELECT entry_point, launch_buy_amount, launch_buy_recipient, snipe_exemption_count FROM launches WHERE token = ?')
    .get(reads.token.toLowerCase()) as
    | { entry_point: string | null; launch_buy_amount: string | null; launch_buy_recipient: string | null; snipe_exemption_count: number | null }
    | undefined;
  const creation: CreationFacts = {
    entryPoint: creationRow?.entry_point ?? null,
    launchBuyAmount: creationRow?.launch_buy_amount ? BigInt(creationRow.launch_buy_amount) : null,
    launchBuyRecipient: creationRow?.launch_buy_recipient ?? null,
    snipeExemptionCount: creationRow?.snipe_exemption_count ?? null,
  };

  /**
   * One early row per token, not one per re-scan.
   *
   * "Re-scan in 2 minutes" invites exactly that, and with a 10s cache a single
   * token can be scanned around eighteen times inside its early window. Each
   * would otherwise append a near-identical all-NULL row and queue four more
   * rechecks -- seventy-two for one token -- polluting the table this product is
   * built on and multiplying background work for no new information.
   *
   * The first early row is kept rather than refreshed: it is the earliest
   * observation, which is the one worth pairing against the outcome. Every
   * individual request is still recorded in scan_events.
   */
  if (isEarly) {
    const existing = db
      .prepare("SELECT id FROM scans WHERE token = ? AND traction = 'early' ORDER BY id ASC LIMIT 1")
      .get(reads.token.toLowerCase()) as { id: number } | undefined;
    if (existing) {
      recordPeak(reads.token.toLowerCase(), reads.mcapInQuote, scannedAt);
      return {
        scanId: existing.id,
        reads,
        traction,
        flags,
        benchmark,
        // Excluding this token's own early row, which is reused rather than
        // appended: without that a re-scan inside the early window would report
        // itself as the first scan.
        firstScan: firstScan(reads.token, existing.id),
        deployerActivity: null,
        launchBlock: launch.block,
        launchedAt: launchedAtExact,
        ageSeconds,
        currentBlock: Number(head),
        creation,
        isEarly,
        earlyThresholdSeconds: earlyThreshold,
        waitMs: 0,
        maxQueue: 0,
        bulkAhead: 0,
        phases: timer.breakdown(),
        slowestPhase: timer.worst ? `${timer.worst.name}=${timer.worst.ms}ms` : null,
        overBudget: budget.blown,
      };
    }
  }

  const info = db.prepare(`
    INSERT INTO scans (
      token, curve, deployer, symbol, name, scanned_at, scanned_block, launched_at,
      age_seconds, requested_by,
      unique_buyers_30m, unique_buyers_10m, buyer_growth_ratio, buy_tx_count,
      sell_tx_count, buy_sell_ratio, median_buy_size, progress_pct,
      progress_velocity_per_10m, traction,
      snipe_exemption_count, creator_tax_bps, creator_tax_median_bps,
      deployer_launches_7d, deployer_median_peak_mcap, deployer_survival_24h,
      name_collision, buyback_enabled, custom_pair, flags_raised, flags_total,
      mcap_at_scan, unique_buyers_at_scan, pair_token, phase,
      real_quote_reserve, graduation_threshold
    ) VALUES (
      ?,?,?,?,?,?,?,?,?,?,
      ?,?,?,?,?,?,?,?,?,?,
      ?,?,?,?,?,?,?,?,?,?,?,
      ?,?,?,?,?,?
    )
  `).run(
    reads.token.toLowerCase(), reads.curve.toLowerCase(), reads.deployer.toLowerCase(),
    // launchedAtExact, not the indexed time: a row whose launched_at and
    // age_seconds are derived from different clocks cannot be reasoned about
    // later, and this table exists to be reasoned about later.
    reads.symbol, reads.name, scannedAt, Number(head), launchedAtExact,
    ageSeconds, requestedBy ?? null,
    // An early scan stores NULL for every traction metric and the label 'early'.
    // Writing zeros here would be worse than useless: this table exists to pair
    // an early signal against a later outcome, and a row claiming "0 buyers,
    // traction none" for a token nobody could have bought yet would train that
    // pairing on a measurement that was never taken.
    ...(isEarly
      ? [null, null, null, null, null, null, null, null, null, 'early']
      : [
          traction.uniqueBuyers30m, traction.uniqueBuyers10m, traction.buyerGrowthRatio,
          traction.buyTxCount, traction.sellTxCount, traction.buySellRatio,
          String(traction.medianBuySize), traction.progressPct,
          traction.progressVelocityPer10m, traction.label,
        ]),
    flags.snipeExemptionCount, reads.creatorTaxBps, flags.creatorTaxMedianBps,
    flags.deployerLaunches7d,
    flags.deployerMedianPeakMcap === null ? null : String(flags.deployerMedianPeakMcap),
    flags.deployerSurvival24h, flags.nameCollision ? 1 : 0,
    reads.buybackEnabled ? 1 : 0, flags.flags.find((f) => f.key === 'custom_pair')?.state === 'raised' ? 1 : 0,
    flags.raised, flags.total,
    String(reads.mcapInQuote), isEarly ? null : traction.uniqueBuyers30m, reads.pairToken.toLowerCase(),
    reads.phase, String(reads.realQuoteReserve), String(reads.graduationThreshold),
  );

  const scanId = Number(info.lastInsertRowid);
  scheduleRechecks(scanId, reads.token.toLowerCase(), scannedAt);
  recordPeak(reads.token.toLowerCase(), reads.mcapInQuote, scannedAt);

  return {
    scanId,
    reads,
    traction,
    flags,
    benchmark,
    // The row for THIS scan was just inserted, so it is excluded: a token's
    // very first scan must find nothing and print nothing.
    firstScan: firstScan(reads.token, scanId),
    deployerActivity,
    launchBlock: launch.block,
    launchedAt: launchedAtExact,
    ageSeconds,
    currentBlock: Number(head),
    creation,
    isEarly,
    earlyThresholdSeconds: earlyThreshold,
    waitMs: 0,
    maxQueue: 0,
    bulkAhead: 0,
    phases: timer.breakdown(),
    slowestPhase: timer.worst ? `${timer.worst.name}=${timer.worst.ms}ms` : null,
    overBudget: budget.blown,
  };
}

/** Queue the +1h / +6h / +24h / +7d outcome rechecks for a scan. */
export function scheduleRechecks(scanId: number, token: string, scannedAt: number): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO rechecks (scan_id, token, offset_hours, due_at) VALUES (?,?,?,?)`,
  );
  const tx = db.transaction(() => {
    for (const h of RECHECK_OFFSETS_HOURS) stmt.run(scanId, token, h, scannedAt + h * 3600);
  });
  tx();
}

export function recordPeak(token: string, mcap: number, at: number): void {
  const row = db.prepare('SELECT peak_mcap FROM token_peaks WHERE token = ?').get(token) as
    | { peak_mcap: string }
    | undefined;
  if (!row || Number(row.peak_mcap) < mcap) {
    db.prepare(
      `INSERT INTO token_peaks (token, peak_mcap, peak_at) VALUES (?,?,?)
       ON CONFLICT(token) DO UPDATE SET peak_mcap = excluded.peak_mcap, peak_at = excluded.peak_at`,
    ).run(token, String(mcap), at);
  }
}
