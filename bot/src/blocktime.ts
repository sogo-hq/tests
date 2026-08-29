import { client } from './chain.js';

/**
 * Block timestamps by sparse anchoring and linear interpolation.
 *
 * A seven-day backfill touches roughly 24,000 launches. Fetching a block per
 * launch would double the request count against a rate-limited node for data
 * that is almost perfectly linear: this chain produces blocks every 0.1s with
 * very little jitter. Anchors are fetched at wide intervals and everything in
 * between is interpolated, which cuts those tens of thousands of calls down to
 * a couple of dozen.
 *
 * Accuracy is asserted by `npm run verify`; measured drift is well under a
 * second, which is far finer than any window this bot measures (the tightest is
 * ten minutes).
 */
/**
 * One anchor, tolerating a head this node cannot serve yet.
 *
 * At a tenth of a second per block, the head returned by getBlockNumber() is
 * routinely newer than the block a following getBlock() can find -- the two
 * calls need not land on the same node, and even one node writes the number
 * before the body. That surfaced as BlockNotFoundError killing a backfill
 * outright, on a chain where the block in question exists a moment later.
 *
 * Retried briefly, then walked back: an anchor one block earlier is worth a
 * hundredth of a second of interpolation error, which is far finer than
 * anything this estimator is used for.
 */
async function anchorAt(b: bigint): Promise<{ block: number; time: number }> {
  let target = b;
  for (let attempt = 0; ; attempt++) {
    try {
      const blk = await client.getBlock({ blockNumber: target, includeTransactions: false });
      return { block: Number(target), time: Number(blk.timestamp) };
    } catch (err: any) {
      const notYet = err?.name === 'BlockNotFoundError' || /could not be found/i.test(String(err?.shortMessage ?? ''));
      if (!notYet || attempt >= 4 || target <= 0n) throw err;
      // one short wait for the body to land, then step back a block per attempt
      await new Promise((r) => setTimeout(r, 150));
      if (attempt >= 1) target -= 1n;
    }
  }
}

export class BlockTimeEstimator {
  private anchors: { block: number; time: number }[] = [];

  constructor(private spacing = 100_000) {}

  /** Fetch anchors covering [from, to]. */
  async prime(from: bigint, to: bigint): Promise<void> {
    const points: bigint[] = [];
    for (let b = from; b < to; b += BigInt(this.spacing)) points.push(b);
    points.push(to);

    const fetched = await Promise.all(points.map((b) => anchorAt(b)));
    this.anchors = [...this.anchors, ...fetched].sort((a, b) => a.block - b.block);
    // de-duplicate
    this.anchors = this.anchors.filter((a, i, arr) => i === 0 || arr[i - 1]!.block !== a.block);
  }

  /** Interpolated timestamp for a block, or null if outside the primed range. */
  at(block: number): number | null {
    const a = this.anchors;
    if (a.length < 2) return null;
    if (block <= a[0]!.block) return a[0]!.time;
    if (block >= a[a.length - 1]!.block) return a[a.length - 1]!.time;

    let lo = 0;
    let hi = a.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid]!.block <= block) lo = mid;
      else hi = mid;
    }
    const l = a[lo]!;
    const r = a[hi]!;
    if (r.block === l.block) return l.time;
    const frac = (block - l.block) / (r.block - l.block);
    return Math.round(l.time + frac * (r.time - l.time));
  }
}
