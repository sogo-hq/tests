import { createPublicClient, defineChain, http } from 'viem';
import { RPC_URL, CHAIN_ID } from './config.js';
import { installRateLimit } from './ratelimit.js';

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
const transport = () =>
  http(RPC_URL, { batch: false, retryCount: 3, retryDelay: 300, timeout: 60_000 });

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
 * getLogs with adaptive range splitting.
 *
 * This RPC's log index behaves very differently depending on the filter:
 * an address-scoped query with no topic filter happily returns 1M blocks in
 * under a second, while adding an indexed-argument topic filter can time out on
 * the same range. Rather than hardcode a different constant per call site, halve
 * the range and retry whenever the node reports a timeout.
 */
export async function getLogsAdaptive<T extends Record<string, unknown>>(
  params: T & { fromBlock: bigint; toBlock: bigint },
  minSpan = 2_000n,
): Promise<any[]> {
  const { fromBlock, toBlock } = params;
  try {
    return (await logsClient.getLogs(params as any)) as any[];
  } catch (err: any) {
    const msg = String(err?.details ?? err?.message ?? '');
    const retryable = /timed out|too many|limit|range|exceed/i.test(msg);
    const span = toBlock - fromBlock;
    if (!retryable || span <= minSpan) throw err;
    const mid = fromBlock + span / 2n;
    const [a, b] = await Promise.all([
      getLogsAdaptive({ ...params, fromBlock, toBlock: mid }, minSpan),
      getLogsAdaptive({ ...params, fromBlock: mid + 1n, toBlock }, minSpan),
    ]);
    return [...a, ...b];
  }
}
