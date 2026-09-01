import { createPublicClient, defineChain, http } from 'viem';
import { RPC_URL, CHAIN_ID } from './config.js';
import { learnedMaxSpan, recordServedSpan, recordRefusedSpan } from './providerlimits.js';
import { installRateLimit, isRateLimit, currentPriority } from './ratelimit.js';

// Installed before any client is constructed so every RPC request is paced.
installRateLimit();

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

/**
 * JSON-RPC batching is deliberately OFF.
 *
 * This node accepts batch requests but silently drops entries from them under
 * load: a 32-request batch comes back short, and viem -- unable to match a
 * response to its request -- throws "Cannot read properties of undefined". It
 * reproduces at batch sizes well under any documented limit and is not a
 * response-size problem (launch calldata averages 1.3KB, peaking at 2.1KB).
 *
 * It fails loudly rather than returning wrong data, but the whole point of this
 * indexer is decoding every launch transaction, so a transport that
 * intermittently drops requests is not worth the roughly three minutes it saves
 * across a full seven-day backfill. Throughput is recovered with request
 * concurrency instead, which the node handles fine.
 */
/** Exported so the 429 backoff budget can be asserted to fit inside it. */
export const TRANSPORT_TIMEOUT_MS = 60_000;

const transport = () =>
  http(RPC_URL, { batch: false, retryCount: 3, retryDelay: 300, timeout: TRANSPORT_TIMEOUT_MS });

export const client = createPublicClient({ chain: robinhoodChain, transport: transport() });

/** Separate client for eth_getLogs, whose latency is far more variable. */
export const logsClient = createPublicClient({ chain: robinhoodChain, transport: transport() });

/** Run promise-returning tasks with bounded concurrency. */
export async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * How a provider's refusal should be read.
 *
 * A RANGE REFUSAL is a standing fact: it will not serve this many blocks, today
 * or ever, and is worth writing down. A TIMEOUT or a response-size complaint is
 * a fact about this moment -- how loaded the node is, how many logs this
 * particular range happens to hold. Both mean "ask for less"; only the first
 * means "and remember it". Recording a timeout would turn one slow minute into
 * a permanently cramped ceiling, and this chain's public node says "log query
 * timed out" under load on ranges it serves happily when idle.
 */
function classifyLogsError(err: any): { narrowable: boolean; rangeRefusal: boolean } {
  const msg = String(err?.details ?? err?.message ?? '');
  // Checked against the wordings actually in use: the public node's "query
  // exceeds max block range", both of Alchemy's ("up to a 10 block range",
  // "Log response size exceeded"), Goldsky's "exceeded max allowed range", and
  // Infura's "query returned more than 10000 results".
  const rangeRefusal =
    /\brange\b/i.test(msg) ||
    /\bexceed(s|ed)?\b/i.test(msg) ||
    /more than [\d,]+ results?/i.test(msg) ||
    /\btoo many\b/i.test(msg);
  const narrowable = rangeRefusal || /timed out|limit|response size/i.test(msg);
  return { narrowable, rangeRefusal };
}

/**
 * How many pieces one getLogs may become, by priority.
 *
 * A cramped provider turns a wide range into a great many narrow requests, and
 * that is the correct trade for the indexer: it costs time nobody is watching
 * and the index stays alive. It is the wrong trade for a scan. Before this,
 * findLaunch could walk 8.6M blocks in strides of 500,000 and, at a 10,000-block
 * ceiling, that is 2,286 requests inside a five-second budget -- roughly four
 * minutes at the limiter's ten a second, at interactive priority, draining the
 * bucket the indexer and every other scan share.
 *
 * So an interactive read gives up early and honestly. "Couldn't read the chain
 * for this one" is a true answer; a card four minutes late is not an answer.
 */
const MAX_PIECES: Record<string, number> = {
  interactive: Number(process.env.MAX_LOG_PIECES_INTERACTIVE || 64) || 64,
  bulk: Number(process.env.MAX_LOG_PIECES_BULK || 100_000) || 100_000,
};

/** Thrown when a range cannot be read within the caller's request budget. */
export class LogRangeTooWide extends Error {
  constructor(readonly pieces: number, readonly limit: number) {
    super(`range needs ${pieces} requests at this provider's limit, over the ${limit} allowed here`);
    this.name = 'LogRangeTooWide';
  }
}

/** One request, with no narrowing of its own. */
async function once<T extends Record<string, unknown>>(
  params: T & { fromBlock: bigint; toBlock: bigint },
): Promise<any[]> {
  return (await logsClient.getLogs(params as any)) as any[];
}

/**
 * Find the widest span this provider will serve, by probing ONE slice.
 *
 * Probing a single leading slice and halving it is about sixteen sequential
 * requests from 500,000 down to 10. The obvious alternative -- halve the range
 * and recurse into both halves -- reaches the same width but visits every leaf
 * on the way, so it does not stop when the answer is known: it completes the
 * whole range at leaf width. Measured, that hung for minutes at a 10-block cap
 * on a range this code asks for routinely. Discovery and execution have to be
 * separate things, and this is the discovery half.
 */
async function discoverMaxSpan<T extends Record<string, unknown>>(
  params: T & { fromBlock: bigint; toBlock: bigint },
  refusedAt: bigint,
  /**
   * Whether what we found is a fact about the PROVIDER worth keeping.
   *
   * False when the descent was triggered by a timeout or a response-size
   * complaint: those depend on load and on how many logs this particular range
   * happens to hold, so the width that worked once says nothing about the
   * provider's standing limit. Narrow now, remember nothing.
   */
  learn: boolean,
): Promise<bigint> {
  const { fromBlock, toBlock } = params;
  let span = refusedAt / 2n;
  while (span >= 1n) {
    const end = fromBlock + span - 1n > toBlock ? toBlock : fromBlock + span - 1n;
    try {
      await once({ ...params, fromBlock, toBlock: end });
      if (learn) recordServedSpan(span);
      return span;
    } catch (err: any) {
      if (isRateLimit(err)) throw err;
      const { narrowable, rangeRefusal } = classifyLogsError(err);
      if (!narrowable) throw err;
      if (rangeRefusal) recordRefusedSpan(span);
      if (span === 1n) throw err;
      span = span / 2n;
    }
  }
  throw new Error('provider refused a single-block getLogs range');
}

/**
 * getLogs, sized to what the provider will actually serve.
 *
 * The ceiling is discovered once, written down, and then every range is walked
 * in pieces of that size. It used to be rediscovered on every call, by halving
 * in parallel, with a floor of 2,000 blocks -- and that combination is what
 * stopped the index for 31 hours:
 *
 *   The floor was a limit on RECURSION DEPTH, not on the provider. The narrowest
 *   query it would ever attempt was (whatever the caller asked for) / 2^k, which
 *   is a different number at every call site: 1,954 blocks from a 500,000 chunk,
 *   1,125 from an 18,000 window. None of them is 2,000, and none of them is
 *   reachable by a provider capping ranges at 10.
 *
 *   Worse, the steady-state tail asks for about thirty blocks. Thirty is already
 *   under the floor, so on a capped provider the poll threw after ONE request,
 *   never split, never discovered anything, and never reached setCursor. With no
 *   cursor written, indexNew fell back to backfill() and asked for seven days
 *   again on the next tick. Every three seconds. 32,000 times.
 *
 * So there is no floor now. A provider that will not serve one block is broken
 * in a way no floor rescues, and any floor above the real cap makes that
 * provider permanently unusable -- which is exactly what 2,000 did.
 */
export async function getLogsAdaptive<T extends Record<string, unknown>>(
  params: T & { fromBlock: bigint; toBlock: bigint },
): Promise<any[]> {
  const { fromBlock, toBlock } = params;
  if (toBlock < fromBlock) return [];
  const total = toBlock - fromBlock + 1n;

  let cap = learnedMaxSpan();
  if (cap === null || total <= cap) {
    try {
      return await once(params);
    } catch (err: any) {
      // A rate limit is not a range problem, and narrowing makes it worse: the
      // pieces are more requests to a node that has already said no, each
      // burning its own backoff. Classified first, propagated untouched.
      if (isRateLimit(err)) throw err;
      const { narrowable, rangeRefusal } = classifyLogsError(err);
      if (!narrowable || total <= 1n) throw err;
      if (rangeRefusal) recordRefusedSpan(total);
      cap = await discoverMaxSpan(params, total, rangeRefusal);
    }
  }

  // Execution: walk the range in pieces the provider has actually served. A
  // tighter provider costs more requests here, which is the correct way to
  // degrade -- the alternative was costing the index entirely.
  // Refuse up front rather than discovering it 2,000 requests in.
  const limit = MAX_PIECES[currentPriority()] ?? MAX_PIECES.interactive!;
  const pieces = Number((total + cap - 1n) / cap);
  if (pieces > limit) throw new LogRangeTooWide(pieces, limit);

  const out: any[] = [];
  // Narrowed by the loop below if a piece turns out to be too wide, so it is a
  // mutable bigint rather than the possibly-null lookup.
  let width: bigint = cap;
  for (let start = fromBlock; start <= toBlock; start += width) {
    const end: bigint = start + width - 1n > toBlock ? toBlock : start + width - 1n;
    try {
      out.push(...(await once({ ...params, fromBlock: start, toBlock: end })));
    } catch (err: any) {
      if (isRateLimit(err)) throw err;
      const { narrowable, rangeRefusal } = classifyLogsError(err);
      if (!narrowable) throw err;
      // This piece was too wide after all -- a busier stretch of chain, or a
      // ceiling that has moved. Find the new one and carry on from here rather
      // than failing the whole walk.
      if (rangeRefusal) recordRefusedSpan(end - start + 1n);
      const narrower: bigint = await discoverMaxSpan(
        { ...params, fromBlock: start, toBlock: end }, end - start + 1n, rangeRefusal,
      );
      for (let s = start; s <= end; s += narrower) {
        const e = s + narrower - 1n > end ? end : s + narrower - 1n;
        out.push(...(await once({ ...params, fromBlock: s, toBlock: e })));
      }
      width = narrower;
    }
  }
  return out;
}
