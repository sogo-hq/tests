import { getLogsAdaptive } from '../chain.js';
import { db } from '../db.js';
import { CurveBuy, CurveSell } from '../abi.js';
import { CURVE_LOG_CHUNK, CURVE_BATCH_SIZE } from '../config.js';
import { BlockTimeEstimator } from '../blocktime.js';

const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO trades (
    tx_hash, log_index, token, curve, side, trader, recipient,
    quote_amount, token_amount, fee, creator_tax, block_number, block_time
  ) VALUES (
    @tx_hash, @log_index, @token, @curve, @side, @trader, @recipient,
    @quote_amount, @token_amount, @fee, @creator_tax, @block_number, @block_time
  )
`);
const insertMany = db.transaction((rows: any[]) => {
  for (const r of rows) insertTrade.run(r);
});

/**
 * Block times come from the sparse interpolator, not one getBlock per block.
 *
 * A busy token's opening window holds several hundred trades across nearly as
 * many distinct blocks; fetching each one turned a scan into 400+ paced requests
 * and roughly 25 seconds. Every traction window is defined in block numbers, so
 * timestamps here are only for display and for the "still trading" check, where
 * the interpolator's sub-second error is irrelevant.
 */
async function blockTimes(from: bigint, to: bigint): Promise<BlockTimeEstimator> {
  const est = new BlockTimeEstimator(50_000);
  await est.prime(from, to);
  return est;
}

/**
 * Index CurveBuy / CurveSell for a set of curves over a block range.
 *
 * Queries are always address-scoped. An unfiltered topic-only query times out on
 * this RPC above ~20k blocks, so curves are batched (<=150 addresses) and the
 * range is chunked at 20k blocks.
 *
 * `tokensOut` / `tokensIn` are read from the event, never assumed from the
 * amount a trader requested. On a buy, snipe tax is folded into `fee`; creator
 * tax arrives separately as `creatorTax`.
 */
export async function indexTrades(
  curveToToken: Map<string, string>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<number> {
  const curves = [...curveToToken.keys()];
  if (!curves.length) return 0;
  let count = 0;

  for (let i = 0; i < curves.length; i += CURVE_BATCH_SIZE) {
    const batch = curves.slice(i, i + CURVE_BATCH_SIZE) as `0x${string}`[];

    for (let start = fromBlock; start <= toBlock; start += BigInt(CURVE_LOG_CHUNK)) {
      const end = start + BigInt(CURVE_LOG_CHUNK) - 1n > toBlock
        ? toBlock
        : start + BigInt(CURVE_LOG_CHUNK) - 1n;

      const [buys, sells] = await Promise.all([
        getLogsAdaptive({ address: batch, event: CurveBuy, fromBlock: start, toBlock: end }),
        getLogsAdaptive({ address: batch, event: CurveSell, fromBlock: start, toBlock: end }),
      ]);
      if (!buys.length && !sells.length) continue;

      const times = await blockTimes(start, end);
      const rows: any[] = [];

      for (const l of buys) {
        const curve = l.address.toLowerCase();
        rows.push({
          tx_hash: l.transactionHash,
          log_index: l.logIndex,
          token: curveToToken.get(curve) ?? '',
          curve,
          side: 'buy',
          trader: (l.args.buyer as string).toLowerCase(),
          recipient: (l.args.recipient as string).toLowerCase(),
          quote_amount: String(l.args.quoteIn),
          token_amount: String(l.args.tokensOut),
          fee: String(l.args.fee),
          creator_tax: String(l.args.creatorTax),
          block_number: Number(l.blockNumber),
          block_time: times.at(Number(l.blockNumber)) ?? 0,
        });
      }
      for (const l of sells) {
        const curve = l.address.toLowerCase();
        rows.push({
          tx_hash: l.transactionHash,
          log_index: l.logIndex,
          token: curveToToken.get(curve) ?? '',
          curve,
          side: 'sell',
          trader: (l.args.seller as string).toLowerCase(),
          recipient: (l.args.recipient as string).toLowerCase(),
          quote_amount: String(l.args.quoteOut),
          token_amount: String(l.args.tokensIn),
          fee: String(l.args.fee),
          creator_tax: String(l.args.creatorTax),
          block_number: Number(l.blockNumber),
          block_time: times.at(Number(l.blockNumber)) ?? 0,
        });
      }

      insertMany(rows);
      count += rows.length;
    }
  }
  return count;
}

/** Index one token's curve -- the /scan hot path. */
/**
 * Record how far a launch's own trade history has been read.
 *
 * Only ever advances, and only from the launch block: a recheck indexes a much
 * later range and establishes nothing about the opening window, so it must not
 * touch this. What the benchmark asks of a launch is whether its FIRST N
 * minutes were read, which is a different question from whether anything about
 * it was read at all.
 */
export function markWindowIndexed(token: string, launchBlock: number, indexedTo: number): void {
  if (indexedTo < launchBlock) return;
  db.prepare(
    `UPDATE launches
        SET trades_indexed_to = MAX(COALESCE(trades_indexed_to, 0), ?)
      WHERE token = ?`,
  ).run(indexedTo, token.toLowerCase());
}

export async function indexOneCurve(
  curve: string,
  token: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<number> {
  return indexTrades(new Map([[curve.toLowerCase(), token.toLowerCase()]]), fromBlock, toBlock);
}
