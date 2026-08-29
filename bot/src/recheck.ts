import { parseAbiItem, type Address } from 'viem';
import { client, getLogsAdaptive, pooled } from './chain.js';
import { db } from './db.js';
import { readToken } from './reads.js';
import { indexOneCurve } from './indexer/trades.js';
import { recordPeak } from './scan.js';
import {
  BLOCKS_PER_HOUR,
  FACTORY,
  MEME_HOOK,
  FEE_ESCROW,
  BUYBACK_VAULT,
  LAUNCH_LOCKER,
  LAUNCH_FORWARDER,
  NON_HOLDER_ADDRESSES,
} from './config.js';
import { isRateLimit } from './ratelimit.js';

const Transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const ZERO = '0x0000000000000000000000000000000000000000';

/** Protocol-owned addresses that hold balances but are not holders. */
const PROTOCOL = new Set(NON_HOLDER_ADDRESSES);

/**
 * Count holders by replaying Transfer events and summing balances.
 *
 * Derived on-chain rather than read from the explorer: the explorer's token
 * endpoints return 500 for freshly launched tokens, and this is exact --
 * spot-checked against balanceOf() to the wei.
 *
 * The curve itself, the pool manager and other protocol contracts hold large
 * balances and are excluded; counting them would inflate every token by two.
 */
export async function countHolders(
  token: string,
  fromBlock: bigint,
  toBlock: bigint,
  extraExcluded: string[] = [],
): Promise<number> {
  const excluded = new Set([...PROTOCOL, ...extraExcluded.map((a) => a.toLowerCase())]);
  const logs = await getLogsAdaptive({
    address: token as Address,
    event: Transfer,
    fromBlock,
    toBlock,
  });
  const bal = new Map<string, bigint>();
  for (const l of logs) {
    const from = (l.args.from as string).toLowerCase();
    const to = (l.args.to as string).toLowerCase();
    const v = l.args.value as bigint;
    if (from !== ZERO) bal.set(from, (bal.get(from) ?? 0n) - v);
    if (to !== ZERO) bal.set(to, (bal.get(to) ?? 0n) + v);
  }
  let n = 0;
  for (const [addr, v] of bal) if (v > 0n && !excluded.has(addr)) n++;
  return n;
}

export interface RecheckRow {
  id: number;
  scan_id: number;
  token: string;
  offset_hours: number;
  due_at: number;
  /** How many times a transient failure has put this row back in the queue. */
  attempts?: number;
}

/** Run one recheck: record whether the early signal turned into anything. */
export async function runRecheck(row: RecheckRow): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const reads = await readToken(row.token);
    if (!reads) {
      db.prepare(
        `UPDATE rechecks SET completed_at = ?, error = ? WHERE id = ?`,
      ).run(now, 'token no longer resolvable from factory', row.id);
      return;
    }

    const head = await client.getBlockNumber();
    const launch = db
      .prepare('SELECT block_number FROM launches WHERE token = ?')
      .get(row.token) as { block_number: number } | undefined;
    const launchBlock = BigInt(launch?.block_number ?? Number(head) - BLOCKS_PER_HOUR * 24);

    // Bring curve trades up to date so "still trading" reflects reality.
    const since = head - BigInt(BLOCKS_PER_HOUR) > launchBlock ? head - BigInt(BLOCKS_PER_HOUR) : launchBlock;
    await indexOneCurve(reads.curve, row.token, since, head);

    const recent = (db
      .prepare('SELECT COUNT(*) AS n FROM trades WHERE token = ? AND block_number >= ?')
      .get(row.token, Number(since)) as { n: number }).n;

    const tradesSince = (db
      .prepare('SELECT COUNT(*) AS n FROM trades WHERE token = ?')
      .get(row.token) as { n: number }).n;

    const graduated = reads.phase >= 2;
    // A graduated token has left the curve for a pool, so silence on the curve
    // is expected and is not evidence that it stopped trading.
    const stillTrading = graduated || recent > 0;

    const holders = await countHolders(row.token, launchBlock, head, [reads.curve]);

    recordPeak(row.token, reads.mcapInQuote, now);
    const peak = db.prepare('SELECT peak_mcap FROM token_peaks WHERE token = ?').get(row.token) as
      | { peak_mcap: string }
      | undefined;

    db.prepare(`
      UPDATE rechecks SET
        completed_at = ?, still_trading = ?, peak_mcap = ?, current_mcap = ?,
        graduated = ?, holder_count = ?, progress_pct = ?, trades_since = ?, error = NULL
      WHERE id = ?
    `).run(
      now,
      stillTrading ? 1 : 0,
      peak?.peak_mcap ?? String(reads.mcapInQuote),
      String(reads.mcapInQuote),
      graduated ? 1 : 0,
      holders,
      reads.progressPct,
      tradesSince,
      row.id,
    );
  } catch (err: any) {
    const msg = String(err?.shortMessage ?? err?.message ?? err).slice(0, 300);
    // A rate limit measured nothing, so recording it as a completed recheck
    // permanently destroys that scan's observation -- completed_at is never
    // cleared anywhere, and nothing re-arms the row. Rechecks run four at a
    // time against the same node, so a whole batch failing together is the
    // expected shape of a limit, not an edge case. Put it back in the queue.
    if ((isRateLimit(err) || err?.name === 'TimeoutError') && (row.attempts ?? 0) < 5) {
      db.prepare('UPDATE rechecks SET due_at = ?, attempts = attempts + 1, error = ? WHERE id = ?')
        .run(now + 300, msg, row.id);
      return;
    }
    db.prepare('UPDATE rechecks SET completed_at = ?, error = ? WHERE id = ?').run(now, msg, row.id);
  }
}

/** Process every recheck that has come due. */
export async function runDueRechecks(limit = 50): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const due = db
    .prepare(
      `SELECT id, scan_id, token, offset_hours, due_at, attempts FROM rechecks
       WHERE completed_at IS NULL AND due_at <= ? ORDER BY due_at ASC LIMIT ?`,
    )
    .all(now, limit) as RecheckRow[];
  if (!due.length) return 0;
  await pooled(due, 4, (row) => runRecheck(row));
  return due.length;
}

/** Long-running loop for the recheck worker. */
export function startRecheckLoop(intervalMs = 60_000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const n = await runDueRechecks();
      if (n) console.log(`[recheck] processed ${n} due recheck(s)`);
    } catch (err) {
      console.error('[recheck] loop error:', err);
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}
