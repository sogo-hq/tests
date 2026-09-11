import type { Hex } from 'viem';
import { client, pooled, getLogsAdaptive } from '../chain.js';
import { db, getCursor, setCursor, normaliseKey } from '../db.js';
import { recordIndexAdvance, recordIndexFailure, indexHealth, agoWords } from './health.js';
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

/**
 * How many times a launch's creation transaction is worth decoding.
 *
 * The loop retried every undecoded row on every pass, forever, at nought
 * percent success: 11,966 rows re-fetched every fifteen seconds against a
 * rate-limited node that the scan path competes for. These are launches made
 * through contracts this bot has no ABI for -- the long tail, not a transient
 * failure -- so a second attempt is generous and a third is superstition.
 *
 * Two rather than one because a decode CAN fail transiently: an RPC hiccup on
 * the transaction fetch looks exactly like an unknown entry point from here.
 */
const MAX_DECODE_ATTEMPTS = Math.max(1, Number(process.env.MAX_DECODE_ATTEMPTS || 2) || 2);

/** For messages that quote the cap. */
export const MAX_DECODE_ATTEMPTS_LABEL = String(MAX_DECODE_ATTEMPTS);

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
  /** Tokens this pass saw for the first time. Populated by indexNew only. */
  newTokens?: string[];
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
): Promise<{ decoded: number; failed: number; remaining: number; exhausted: number }> {
  const rows = db
    .prepare(
      `SELECT token, tx_hash FROM launches
       WHERE decode_attempts < ?
         AND (snipe_exemption_count IS NULL
           -- also repair rows whose exemption count was decoded while the
           -- creator's opening buy was dropped by the old upsert
           OR (entry_point = 'launchAndBuy' AND launch_buy_amount IS NULL))
       ORDER BY launched_at DESC LIMIT ?`,
    )
    .all(MAX_DECODE_ATTEMPTS, Number.isFinite(limit) ? limit : -1) as { token: string; tx_hash: string }[];

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

  const countAttempt = db.prepare('UPDATE launches SET decode_attempts = decode_attempts + 1 WHERE token = ?');

  let decoded = 0;
  let failed = 0;
  let done = 0;
  await pooled(rows, 8, async (row) => {
    const cd = await bulk(() => fetchLaunchCalldata(row.tx_hash as Hex));
    // Counted whether it worked or not. A row that decodes leaves the queue by
    // having its exemption count filled in; a row that does not is on its way
    // to being resolved as undetermined.
    countAttempt.run(row.token);
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

  const counts = decodeBacklog();
  return { decoded, failed, remaining: counts.pending, exhausted: counts.exhausted };
}

/**
 * How many rows are still worth attempting, and how many have been given up on.
 *
 * `pending` is what the loop will try again. `exhausted` is the long tail:
 * launches made through contracts this bot has no ABI for, which no number of
 * retries turns into a decode. They keep a NULL exemption count, so every check
 * that depends on one still reports undetermined -- being out of the queue is
 * not the same as being answered, and nothing here lets one become the other.
 */
export function decodeBacklog(): { pending: number; exhausted: number } {
  const unresolved = `(snipe_exemption_count IS NULL
      OR (entry_point = 'launchAndBuy' AND launch_buy_amount IS NULL))`;
  const q = (where: string, ...params: unknown[]) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM launches WHERE ${where}`).get(...params) as { n: number }).n;
  return {
    pending: q(`decode_attempts < ? AND ${unresolved}`, MAX_DECODE_ATTEMPTS),
    exhausted: q(`decode_attempts >= ? AND ${unresolved}`, MAX_DECODE_ATTEMPTS),
  };
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

export async function indexNew(opts: { lifecycle?: boolean } = {}) {
  const { lifecycle = true } = opts;
  // cacheTime 0 because viem caches getBlockNumber for its polling interval
  // (4s by default), which is longer than this loop's own interval -- the tail
  // would otherwise act on a head it had already seen.
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const cursor = getCursor(CURSOR);
  if (!cursor) return backfill();
  if (cursor >= head) {
    return { launches: 0, fromBlock: cursor, toBlock: head, undecodable: 0, pendingDecode: 0, newTokens: [] };
  }

  const from = cursor + 1n;
  const to = head - from > BigInt(TAIL_MAX_BLOCKS) ? from + BigInt(TAIL_MAX_BLOCKS) : head;
  if (to < head) {
    console.log(`[index] catching up: ${head - to} block(s) still behind after this pass`);
  }
  // The tail is small, so decode inline -- new launches arrive fully populated.
  // Tokens that were not in the index before this pass. The alert loop reads
  // this rather than polling: the indexer already sees every launch within
  // about three seconds, and a second poller would be a second thing competing
  // for the same rate limit to learn what this one already knows.
  const before = new Set(
    (db.prepare('SELECT token FROM launches WHERE block_number >= ?').all(Number(from)) as { token: string }[])
      .map((r) => r.token),
  );
  const res = await indexLaunches(from, to, { decode: true });
  if (lifecycle) await indexLifecycle(from, to);
  const after = (db
    .prepare('SELECT token FROM launches WHERE block_number >= ? AND block_number <= ?')
    .all(Number(from), Number(to)) as { token: string }[]).map((r) => r.token);
  return { ...res, newTokens: after.filter((t) => !before.has(t)) };
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
  // The terminal line is printed once, not every fifteen seconds forever. It is
  // re-armed when new launches arrive, so a later drain reports its own end.
  let announcedDone = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const res = await decodePending(batch);
      if (res.decoded || res.failed) {
        announcedDone = false;
        console.log(
          `[decode] ${res.decoded} decoded${res.failed ? `, ${res.failed} undetermined` : ''}, ${res.remaining} remaining`,
        );
      }
      if (res.remaining === 0 && !announcedDone) {
        announcedDone = true;
        // Said once, and said plainly: the queue is empty, and this many rows
        // are out of it without having been answered. Nothing downstream treats
        // them as decoded -- they still report undetermined wherever they are
        // read -- so this is the end of the retrying, not the end of the doubt.
        console.log(
          `[decode] 0 pending, ${res.exhausted.toLocaleString()} resolved as undetermined`,
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
export type NewLaunchHandler = (tokens: string[]) => void | Promise<void>;

export function startIndexLoop(intervalMs = 3_000, onNewLaunches?: NewLaunchHandler): NodeJS.Timeout {
  let running = false;
  let tick_n = 0;

  /**
   * Sweep LaunchSwept / PoolGraduated every Nth pass rather than every pass.
   *
   * Those are two more getLogs calls, and at a three-second cadence they were
   * most of the loop's standing cost -- five requests per pass where the launch
   * feed itself needs two. Graduation is not time-critical the way a new launch
   * is: nothing about a scan changes in the thirty seconds it takes to notice
   * one, whereas a launch that is not indexed sends the scan to walk the
   * factory's logs.
   */
  const LIFECYCLE_EVERY = 10;

  const tick = async () => {
    if (running) return; // a slow pass must not overlap the next tick
    running = true;
    try {
      const res = await bulk(() => indexNew({ lifecycle: tick_n % LIFECYCLE_EVERY === 0 }));
      tick_n++;
      // A pass that had been declared broken and then succeeded is worth a line:
      // otherwise the fatal notice is the last thing the log ever says about the
      // index, and a reader has no way to learn it came back.
      const before = indexHealth();
      if (before.fatal) {
        console.error(
          `[index] RECOVERED after ${before.consecutiveFailures}+ consecutive failures` +
            `${before.behindSeconds === null ? '' : `, index was ${agoWords(before.behindSeconds)} behind`}`,
        );
      }
      recordIndexAdvance(BigInt(res.toBlock));
      // Handed to whoever is listening, without awaiting: a slow alert pass
      // must not hold up the next index tick, which is what keeps a fresh
      // launch scannable within three seconds.
      if (res.newTokens?.length && onNewLaunches) {
        void Promise.resolve(onNewLaunches(res.newTokens)).catch((err) =>
          console.error('[alerts] handler failed:', String((err as Error)?.message ?? err).slice(0, 160)),
        );
      }
      if (res.launches > 0) {
        console.log(`[index] +${res.launches} launch${res.launches === 1 ? '' : 'es'} (through block ${res.toBlock})`);
      }
    } catch (err) {
      // Throttling was not enough. This logged every twentieth attempt forever,
      // so attempt 32,000 read like attempt 1 with a bigger number -- a broken
      // component wearing the clothes of a retrying one. Now the same error
      // twenty times says so once, distinctly, and then goes quiet: past that
      // point the count is not information, and the stall is reported where it
      // actually matters, on /stats and in what the card refuses to claim.
      const message = String((err as Error)?.message ?? err);
      const report = recordIndexFailure(message);
      if (report.justCrossed) {
        const h = indexHealth();
        console.error(
          `[index] FATAL: ${report.consecutive} consecutive failures with the same error; ` +
            `the index is not advancing and negatives derived from it are now withheld` +
            `${h.behindSeconds === null ? '' : ` (last advanced ${agoWords(h.behindSeconds)} ago)`}\n` +
            `        ${message.slice(0, 300)}`,
        );
      } else if (!report.fatal) {
        console.error(`[index] poll failed (${report.consecutive} in a row):`, message.slice(0, 200));
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
