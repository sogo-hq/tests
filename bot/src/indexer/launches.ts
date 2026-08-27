import type { Hex } from 'viem';
import { client, pooled, getLogsAdaptive } from '../chain.js';
import { db, getCursor, setCursor, normaliseKey } from '../db.js';
import { fetchLaunchCalldata } from './exemptions.js';
import { BlockTimeEstimator } from '../blocktime.js';
import { bulk } from '../ratelimit.js';
import {
  FACTORY,
  FACTORY_LOG_CHUNK,
  BLOCKS_PER_DAY,
  BACKFILL_DAYS,
} from '../config.js';
import { TokenLaunched, LaunchSwept, PoolGraduated } from '../abi.js';

const CURSOR = 'launches';

const insertLaunch = db.prepare(`
  INSERT INTO launches (
    token, curve, deployer, pair_token, launch_config_id, graduation_threshold,
    block_number, tx_hash, launched_at, name, symbol, name_key, symbol_key,
    snipe_exemption_count, snipe_exemptions, entry_point, creator_tax_bps,
    buyback_enabled, launch_buy_amount, launch_buy_recipient
  ) VALUES (
    @token, @curve, @deployer, @pair_token, @launch_config_id, @graduation_threshold,
    @block_number, @tx_hash, @launched_at, @name, @symbol, @name_key, @symbol_key,
    @snipe_exemption_count, @snipe_exemptions, @entry_point, @creator_tax_bps,
    @buyback_enabled, @launch_buy_amount, @launch_buy_recipient
  )
  ON CONFLICT(token) DO UPDATE SET
    snipe_exemption_count = COALESCE(excluded.snipe_exemption_count, launches.snipe_exemption_count),
    snipe_exemptions      = COALESCE(excluded.snipe_exemptions, launches.snipe_exemptions),
    entry_point           = excluded.entry_point,
    launch_buy_amount     = excluded.launch_buy_amount,
    launch_buy_recipient  = excluded.launch_buy_recipient,
    name                  = COALESCE(excluded.name, launches.name),
    symbol                = COALESCE(excluded.symbol, launches.symbol),
    name_key              = COALESCE(excluded.name_key, launches.name_key),
    symbol_key            = COALESCE(excluded.symbol_key, launches.symbol_key)
`);

const insertMany = db.transaction((rows: any[]) => {
  for (const r of rows) insertLaunch.run(r);
});

export interface IndexResult {
  launches: number;
  fromBlock: bigint;
  toBlock: bigint;
  undecodable: number;
  pendingDecode: number;
}

/**
 * Index TokenLaunched over a block range.
 *
 * Queries are always scoped to the factory address. Topic-only queries with no
 * address filter time out on this RPC above ~20k blocks, whereas address-scoped
 * queries accept ~3.9M-block spans; 500k is a safe chunk well inside that.
 */
export async function indexLaunches(
  fromBlock: bigint,
  toBlock: bigint,
  opts: { decode?: boolean; onProgress?: (done: bigint, total: bigint, found: number) => void } = {},
): Promise<IndexResult> {
  const { decode = false, onProgress } = opts;
  let total = 0;
  let undecodable = 0;
  const span = toBlock - fromBlock;

  // Anchor block times once for the whole range rather than fetching a block per
  // launch; see blocktime.ts for why that is safe here.
  //
  // Primed lazily. The tail poller runs every few seconds and most passes find
  // no launches at all, so priming up front would spend getBlock calls on every
  // empty pass -- a standing cost against the same rate limit interactive scans
  // draw from.
  const times = new BlockTimeEstimator();
  let primed = false;
  const ensurePrimed = async () => {
    if (primed) return;
    await times.prime(fromBlock, toBlock);
    primed = true;
  };

  for (let start = fromBlock; start <= toBlock; start += BigInt(FACTORY_LOG_CHUNK)) {
    const end = start + BigInt(FACTORY_LOG_CHUNK) - 1n > toBlock
      ? toBlock
      : start + BigInt(FACTORY_LOG_CHUNK) - 1n;

    const logs = await getLogsAdaptive({
      address: FACTORY,
      event: TokenLaunched,
      fromBlock: start,
      toBlock: end,
    });

    if (logs.length) {
      await ensurePrimed();
      // Creation-calldata decode is optional: it costs one request per launch
      // against a rate-limited node, so the default pass records launches
      // immediately and leaves exemptions to `decodePending`, which is
      // resumable. /scan decodes on demand for any token not yet covered, so a
      // scan never waits on the backfill.
      const rows = await pooled(logs, 8, async (log) => {
        const calldata = decode
          ? await fetchLaunchCalldata(log.transactionHash as Hex)
          : null;
        const ts = times.at(Number(log.blockNumber)) ?? 0;
        if (calldata && calldata.exemptionCount === null) undecodable++;
        const name = calldata?.name ?? null;
        const symbol = calldata?.symbol ?? null;
        return {
          token: (log.args.token as string).toLowerCase(),
          curve: (log.args.curve as string).toLowerCase(),
          deployer: (log.args.deployer as string).toLowerCase(),
          pair_token: (log.args.pairToken as string).toLowerCase(),
          launch_config_id: Number(log.args.launchConfigId),
          graduation_threshold: String(log.args.graduationThreshold),
          block_number: Number(log.blockNumber),
          tx_hash: log.transactionHash,
          launched_at: ts,
          name,
          symbol,
          name_key: name ? normaliseKey(name) : null,
          symbol_key: symbol ? normaliseKey(symbol) : null,
          snipe_exemption_count: calldata?.exemptionCount ?? null,
          snipe_exemptions: calldata?.exemptions.length ? JSON.stringify(calldata.exemptions) : null,
          entry_point: calldata?.entryPoint ?? null,
          creator_tax_bps: calldata?.creatorTaxBps ?? null,
          buyback_enabled: calldata?.buybackEnabled == null ? null : calldata.buybackEnabled ? 1 : 0,
          launch_buy_amount: calldata?.buyAmount == null ? null : String(calldata.buyAmount),
          launch_buy_recipient: calldata?.buyRecipient ?? null,
        };
      });
      insertMany(rows);
      total += rows.length;
    }

    setCursor(CURSOR, end);
    onProgress?.(end - fromBlock, span, total);
  }

  const pendingDecode = (db
    .prepare('SELECT COUNT(*) AS n FROM launches WHERE snipe_exemption_count IS NULL')
    .get() as { n: number }).n;
  return { launches: total, fromBlock, toBlock, undecodable, pendingDecode };
}

/**
 * Fill in snipe-tax exemptions for launches recorded without them.
 *
 * Resumable: it simply works through rows where the count is still unknown, so
 * it can be interrupted and restarted, or left running alongside the bot.
 */
export async function decodePending(
  limit = Infinity,
  onProgress?: (done: number, total: number) => void,
): Promise<{ decoded: number; failed: number; remaining: number }> {
  const rows = db
    .prepare(
      `SELECT token, tx_hash FROM launches
       WHERE snipe_exemption_count IS NULL
          -- also repair rows whose exemption count was decoded while the
          -- creator's opening buy was dropped by the old upsert
          OR (entry_point = 'launchAndBuy' AND launch_buy_amount IS NULL)
       ORDER BY launched_at DESC LIMIT ?`,
    )
    .all(Number.isFinite(limit) ? limit : -1) as { token: string; tx_hash: string }[];

  const update = db.prepare(`
    UPDATE launches SET
      snipe_exemption_count = ?, snipe_exemptions = ?, entry_point = ?,
      creator_tax_bps = COALESCE(?, creator_tax_bps),
      buyback_enabled = COALESCE(?, buyback_enabled),
      launch_buy_amount = ?, launch_buy_recipient = ?,
      name = COALESCE(?, name), symbol = COALESCE(?, symbol),
      name_key = COALESCE(?, name_key), symbol_key = COALESCE(?, symbol_key)
    WHERE token = ?
  `);

  let decoded = 0;
  let failed = 0;
  let done = 0;
  await pooled(rows, 8, async (row) => {
    const cd = await bulk(() => fetchLaunchCalldata(row.tx_hash as Hex));
    if (cd.exemptionCount === null) failed++;
    else decoded++;
    update.run(
      cd.exemptionCount,
      cd.exemptions.length ? JSON.stringify(cd.exemptions) : null,
      cd.entryPoint,
      cd.creatorTaxBps,
      cd.buybackEnabled == null ? null : cd.buybackEnabled ? 1 : 0,
      cd.buyAmount == null ? null : String(cd.buyAmount),
      cd.buyRecipient,
      cd.name, cd.symbol,
      cd.name ? normaliseKey(cd.name) : null,
      cd.symbol ? normaliseKey(cd.symbol) : null,
      row.token,
    );
    onProgress?.(++done, rows.length);
  });

  const remaining = (db
    .prepare(`SELECT COUNT(*) AS n FROM launches
              WHERE snipe_exemption_count IS NULL
                 OR (entry_point = 'launchAndBuy' AND launch_buy_amount IS NULL)`)
    .get() as { n: number }).n;
  return { decoded, failed, remaining };
}

/** Index LaunchSwept / PoolGraduated so stored phase reflects graduation. */
export async function indexLifecycle(fromBlock: bigint, toBlock: bigint): Promise<number> {
  let n = 0;
  const setSwept = db.prepare('UPDATE launches SET phase = 1, swept_at = ? WHERE token = ?');
  const setGrad = db.prepare('UPDATE launches SET phase = 2, graduated_at = ? WHERE token = ?');

  for (let start = fromBlock; start <= toBlock; start += BigInt(FACTORY_LOG_CHUNK)) {
    const end = start + BigInt(FACTORY_LOG_CHUNK) - 1n > toBlock
      ? toBlock
      : start + BigInt(FACTORY_LOG_CHUNK) - 1n;

    const [swept, grad] = await Promise.all([
      getLogsAdaptive({ address: FACTORY, event: LaunchSwept, fromBlock: start, toBlock: end }),
      getLogsAdaptive({ address: FACTORY, event: PoolGraduated, fromBlock: start, toBlock: end }),
    ]);

    const apply = db.transaction(() => {
      for (const l of swept) {
        setSwept.run(Number(l.blockNumber), (l.args.token as string).toLowerCase());
        n++;
      }
      for (const l of grad) {
        setGrad.run(Number(l.blockNumber), (l.args.token as string).toLowerCase());
        n++;
      }
    });
    apply();
  }
  return n;
}

/** Backfill the configured window, resuming from the stored cursor if present. */
export async function backfill(
  days = BACKFILL_DAYS,
  opts: { decode?: boolean; onProgress?: (d: bigint, t: bigint, f: number) => void } = {},
) {
  const head = await client.getBlockNumber();
  const windowStart = head - BigInt(Math.round(days * BLOCKS_PER_DAY));
  const cursor = getCursor(CURSOR);
  const from = cursor && cursor > windowStart ? cursor + 1n : windowStart;
  if (from > head) return { launches: 0, fromBlock: from, toBlock: head, undecodable: 0, pendingDecode: 0 };
  const res = await indexLaunches(from, head, opts);
  await indexLifecycle(from, head);
  return res;
}

/** Index anything new since the cursor. Used by the tail loop. */
/**
 * Largest range a single tail pass will cover.
 *
 * After downtime the cursor can be a long way behind, and catching all of it up
 * in one pass -- decoding a creation transaction per launch -- would block the
 * poller for minutes, which is exactly the responsiveness the loop exists to
 * provide. Bounded instead, so it closes the gap over successive passes while
 * genuinely new launches keep arriving promptly.
 */
const TAIL_MAX_BLOCKS = 30_000; // ~50 minutes

export async function indexNew() {
  // cacheTime 0 because viem caches getBlockNumber for its polling interval
  // (4s by default), which is longer than this loop's own interval -- the tail
  // would otherwise act on a head it had already seen.
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const cursor = getCursor(CURSOR);
  if (!cursor) return backfill();
  if (cursor >= head) return { launches: 0, fromBlock: cursor, toBlock: head, undecodable: 0, pendingDecode: 0 };

  const from = cursor + 1n;
  const to = head - from > BigInt(TAIL_MAX_BLOCKS) ? from + BigInt(TAIL_MAX_BLOCKS) : head;
  if (to < head) {
    console.log(`[index] catching up: ${head - to} block(s) still behind after this pass`);
  }
  // The tail is small, so decode inline -- new launches arrive fully populated.
  const res = await indexLaunches(from, to, { decode: true });
  await indexLifecycle(from, to);
  return res;
}

/**
 * Drip-decode pending launches from inside a long-running process.
 *
 * Request priority is per-process, so running `npm run decode` as a separate
 * process alongside the bot does not yield to interactive scans -- both
 * processes pace independently, the node rate-limits the pair of them, and scans
 * measured 10-25s instead of about 1s. Run inside the bot process the same work
 * is marked bulk and interactive scans preempt it (measured: 79ms mean scan
 * latency against 264 concurrent bulk requests).
 */
export function startDecodeLoop(batch = 200, intervalMs = 15_000): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const res = await decodePending(batch);
      if (res.decoded || res.failed) {
        console.log(
          `[decode] ${res.decoded} decoded${res.failed ? `, ${res.failed} undetermined` : ''}, ${res.remaining} remaining`,
        );
      }
    } catch (err) {
      console.error('[decode] loop error:', err);
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}

/**
 * Keep the index at the chain head from inside a long-running process.
 *
 * Without this, indexNew only ran from the CLI, so a token seconds old was not
 * in the index and every part of a scan that normally reads from it had to be
 * fetched live -- including findLaunch walking back through the factory's logs.
 * The first scan of a fresh launch took close to a minute.
 *
 * Marked bulk, like the decode drip, so an interactive scan always preempts it.
 * A pass that finds nothing is silent: at roughly two launches a minute, logging
 * every empty poll would bury the lines that matter.
 */
export function startIndexLoop(intervalMs = 3_000): NodeJS.Timeout {
  let running = false;
  let consecutiveErrors = 0;

  const tick = async () => {
    if (running) return; // a slow pass must not overlap the next tick
    running = true;
    try {
      const res = await bulk(() => indexNew());
      consecutiveErrors = 0;
      if (res.launches > 0) {
        console.log(`[index] +${res.launches} launch${res.launches === 1 ? '' : 'es'} (through block ${res.toBlock})`);
      }
    } catch (err) {
      // Logged, but throttled: if the RPC is down this fires every few seconds,
      // and a screen of identical stack traces hides everything else.
      consecutiveErrors++;
      if (consecutiveErrors === 1 || consecutiveErrors % 20 === 0) {
        console.error(`[index] poll failed (${consecutiveErrors} in a row):`, String((err as Error)?.message ?? err).slice(0, 200));
      }
    } finally {
      running = false;
    }
  };

  console.log(`[index] tailing the factory every ${(intervalMs / 1000).toFixed(0)}s`);
  void tick();
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return t;
}
