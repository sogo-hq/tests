import type { Hex } from 'viem';
import { client, getLogsAdaptive } from './chain.js';
import { interactive } from './ratelimit.js';
import { db, normaliseKey } from './db.js';
import { readToken, type TokenReads } from './reads.js';
import { indexOneCurve } from './indexer/trades.js';
import { fetchLaunchCalldata } from './indexer/exemptions.js';
import { computeTraction, type TractionMetrics } from './metrics/traction.js';
import { computeFlags, type FlagResult } from './metrics/flags.js';
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
}

/** Locate a token's launch, from the index if present, otherwise from the chain. */
async function findLaunch(
  token: string,
  head: bigint,
): Promise<{ block: number; txHash: Hex; launchedAt: number } | null> {
  const row = db
    .prepare('SELECT block_number, tx_hash, launched_at FROM launches WHERE token = ?')
    .get(token.toLowerCase()) as { block_number: number; tx_hash: string; launched_at: number } | undefined;
  if (row) return { block: row.block_number, txHash: row.tx_hash as Hex, launchedAt: row.launched_at };

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
      return { block: Number(l.blockNumber), txHash: l.transactionHash as Hex, launchedAt: Number(blk.timestamp) };
    }
  }
  return null;
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
  return interactive(() => scanTokenInner(token, requestedBy));
}

async function scanTokenInner(token: string, requestedBy?: number): Promise<ScanResult | null> {
  const reads = await readToken(token);
  if (!reads) return null;

  const head = await client.getBlockNumber();
  const launch = await findLaunch(reads.token, head);
  if (!launch) return null;

  await ensureLaunchRow(reads, launch);

  // Index the measurement window. Capped at the 30-minute window even for old
  // tokens, because that is the window every traction metric is defined over.
  const windowEnd = BigInt(Math.min(launch.block + WINDOW_30_MIN_BLOCKS, Number(head)));
  await indexOneCurve(reads.curve, reads.token, BigInt(launch.block), windowEnd);

  const scannedAt = Math.floor(Date.now() / 1000);
  const traction = computeTraction(
    reads.token,
    launch.block,
    Number(head),
    reads.graduationThreshold,
  );
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

  // A negative age, or one wildly out of step with the chain, means this host's
  // clock is wrong rather than the token being new. Clamping to zero would turn
  // that into maximum-confidence "launched 0s ago" for a token that may be hours
  // old and already trading.
  const clockSuspect = wallAgeSeconds < 0 || Math.abs(wallAgeSeconds - chainAgeSeconds) > 120;
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
    launchBlock: launch.block,
    launchedAt: launchedAtExact,
    ageSeconds,
    currentBlock: Number(head),
    creation,
    isEarly,
    earlyThresholdSeconds: earlyThreshold,
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
