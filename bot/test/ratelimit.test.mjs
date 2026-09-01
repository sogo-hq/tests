/**
 * The 429 ladder must stay inside the transport timeout it runs under.
 *
 * This wrapper sleeps *inside* the fetch viem is awaiting, so viem's timeout
 * covers the whole retry ladder rather than one attempt. When the ladder
 * outlived the timeout, viem aborted first and the limit reached the user as a
 * TimeoutError -- classified as "scan failed, try again" on a token that was
 * perfectly fine. That is the exact false report the class exists to prevent,
 * so it is asserted end to end through a real viem client rather than by
 * throwing RpcRateLimited directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, http } from 'viem';
import { RPC_URL } from '../dist/config.js';

// Static imports are hoisted, so chain.js would install the real wrapper before
// the stub below could be put in place and the stub would then clobber it.
// Install over the stub first, then load the modules that expect it.
let hits = 0;
let retryAfterHeader = null;
globalThis.fetch = async () => {
  hits++;
  const headers = { 'content-type': 'application/json' };
  if (retryAfterHeader !== null) headers['retry-after'] = String(retryAfterHeader);
  return new Response('{}', { status: 429, headers });
};
// A small budget keeps the suite fast; the default's relationship to the
// transport timeout is asserted separately below.
process.env.RPC_429_BUDGET_MS = '3000';
const { installRateLimit, isRateLimit, BUDGET_MS } = await import('../dist/ratelimit.js');
installRateLimit();
const { rateLimitFrom } = await import('../dist/service.js');
const { TRANSPORT_TIMEOUT_MS } = await import('../dist/chain.js');

const chain = {
  id: 4663,
  name: 'test',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

// The production transport, minus viem's own retries so one ladder is measured.
const clientWith = (timeout) =>
  createPublicClient({ chain, transport: http(RPC_URL, { batch: false, retryCount: 0, retryDelay: 300, timeout }) });

async function limitOf(timeout) {
  hits = 0;
  const started = Date.now();
  try {
    await clientWith(timeout).getBlockNumber();
    return { classified: null, elapsed: Date.now() - started, hits };
  } catch (err) {
    return { classified: rateLimitFrom(err), isLimit: isRateLimit(err), elapsed: Date.now() - started, hits, name: err?.name };
  }
}

// The invariant the whole class depends on: the ladder must not be able to
// outlive the timeout it runs inside, or viem aborts first and relabels the
// limit a fault. 1+2+4+8+16+30 = 61s is what the unbounded ladder sums to.
test('the backoff budget fits inside the transport timeout', () => {
  assert.ok(BUDGET_MS < TRANSPORT_TIMEOUT_MS,
    `429 backoff budget ${BUDGET_MS}ms must be under the ${TRANSPORT_TIMEOUT_MS}ms transport timeout`);
});

// retry-after: 60 is what this node actually sends ("limit will reset in 60
// seconds"). One wait already exceeds the budget, so the wrapper must give up
// while the answer is still its own to give.
test('a retry-after longer than the budget is reported as a limit, not a timeout', async () => {
  retryAfterHeader = 60;
  const r = await limitOf(20_000);
  assert.equal(r.isLimit, true, `not classified as a limit: ${r.name}`);
  assert.equal(r.classified, 60, `rateLimitFrom returned ${r.classified}`);
  assert.ok(r.elapsed < 5_000, `gave up after ${r.elapsed}ms; it must not sit out the wait`);
});

// With no header the ladder is exponential. It must stop at the budget.
test('the exponential ladder stops at the budget rather than outliving the timeout', async () => {
  retryAfterHeader = null;
  const r = await limitOf(20_000);
  assert.equal(r.isLimit, true, `not classified as a limit: ${r.name}`);
  assert.ok(r.classified !== null, 'a limit must be classifiable from the thrown error');
  assert.ok(r.elapsed < BUDGET_MS + 2_000, `waited ${r.elapsed}ms, past the ${BUDGET_MS}ms budget`);
});

// A short timeout aborts mid-sleep. The reason we stopped is still the limit.
test('an abort during the backoff is still reported as a limit', async () => {
  retryAfterHeader = 2;
  const r = await limitOf(800);
  assert.equal(r.isLimit, true, `abort surfaced as ${r.name}, which reads to the user as "scan failed"`);
  assert.equal(r.classified, 2);
});


/**
 * getLogsAdaptive halves its range and retries when a query is refused for
 * being too big. It classified errors by substring, and "rate limited" contains
 * "limit" -- so a 429 was read as a range problem and the two halves were
 * issued IN PARALLEL, turning one refusal into up to sixteen simultaneous
 * requests to a node that had already said no, each burning its own backoff.
 * This is on every getLogs path in the product, not just the background loop.
 */
test('a rate limit is not mistaken for a range that is too wide', async () => {
  retryAfterHeader = 30;
  hits = 0;
  const { getLogsAdaptive } = await import('../dist/chain.js');
  const started = Date.now();
  await assert.rejects(
    () => getLogsAdaptive({
      address: '0x' + '11'.repeat(20),
      fromBlock: 1n,
      toBlock: 40_000n,   // wide enough for four levels of halving
    }),
    (err) => isRateLimit(err),
    'the limit must propagate, not be retried as a range problem',
  );
  // One refusal, not a fan-out. Halving to the 2,000-block floor from 40,000 is
  // five levels, so amplification would show as dozens of attempts.
  assert.ok(hits <= 8, `one refusal became ${hits} requests in ${Date.now() - started}ms`);
});


/**
 * The other half of that fix: excluding rate limits must not disable the
 * splitting getLogsAdaptive exists to do. This node really does refuse wide
 * ranges, and that refusal still has to be answered by narrowing.
 */
test('a range that is genuinely too wide is still split', async () => {
  let calls = 0;
  let widest = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.method !== 'eth_getLogs') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }),
        { headers: { 'content-type': 'application/json' } });
    }
    calls++;
    const span = Number(BigInt(body.params[0].toBlock)) - Number(BigInt(body.params[0].fromBlock));
    if (span > 5_000) {
      widest = Math.max(widest, span);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id,
        error: { code: -32000, message: 'query exceeds max block range' } }),
        { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [] }),
      { headers: { 'content-type': 'application/json' } });
  };
  try {
    const { getLogsAdaptive } = await import('../dist/chain.js');
    const out = await getLogsAdaptive({ address: '0x' + '11'.repeat(20), fromBlock: 1n, toBlock: 40_000n });
    assert.deepEqual(out, [], 'it completed by narrowing rather than throwing');
    // More than one request is the property: it narrowed until the provider
    // served it. The exact count belonged to the old parallel-halving version,
    // which revisited every leaf; discovery-then-walk gets there in fewer.
    assert.ok(calls > 1, `only ${calls} request — it did not narrow at all`);
  } finally {
    globalThis.fetch = saved;
  }
});

/**
 * A burst of refusals is one signal, and the user must not serve its sentence.
 *
 * A whole-life Transfer read is 43 getLogs calls and the node refused seven of
 * them within a few seconds. Each refusal multiplied a shared rate by 0.6, so
 * 10/s became the 1/s floor, and the next scan -- 17 reads -- took 16.8s
 * against a 5s budget. The scan had done nothing wrong; it inherited a penalty
 * that background work had earned.
 *
 * Two properties hold it shut: a burst cuts once, and the floor stays high
 * enough that a scan's reads still fit in its budget.
 */
test('a burst of 429s cuts the rate once, and never below the serving floor', async () => {
  const { effectiveRate } = await import('../dist/ratelimit.js');
  retryAfterHeader = null;

  const before = effectiveRate();
  // Several ladders back to back is the shape of a heavy read being refused
  // over and over: many more than the seven that collapsed it in production.
  for (let i = 0; i < 6; i++) await limitOf(2_000);
  const after = effectiveRate();

  assert.ok(after < before, `rate did not respond to refusals at all: ${before} -> ${after}`);
  assert.ok(
    after >= before * 0.5,
    `rate fell to ${after}/s from ${before}/s. Below half, a scan's reads no ` +
      `longer fit its budget and the user pays for background work's refusals.`,
  );
});

/**
 * A scan's own 429 must not stop the indexer.
 *
 * Standing background work down whenever the node refuses anything is the
 * obvious rule and the wrong one. Scans on this node trip 429s by themselves --
 * two in a single cold scan, measured -- so a 30-second stand-down per refusal
 * means a busy bot never indexes, and the buyer benchmark and the exempted
 * median never reach the 30 observations they refuse to report below.
 *
 * Only work that was itself refused pays.
 */
test('an interactive 429 cuts the rate without pausing background work', async () => {
  const { spareCapacity, bulk } = await import('../dist/ratelimit.js');
  retryAfterHeader = null;

  // Refused while interactive: the indexer must still be allowed to work.
  await limitOf(2_000);
  await new Promise((r) => setTimeout(r, 1_100)); // clear the quiet window
  assert.ok(
    spareCapacity() > 0,
    'a scan tripping a 429 stood the indexer down; on a busy bot that is never indexing again',
  );

  // Refused while bulk: that is the case which yields.
  await bulk(() => limitOf(2_000));
  await new Promise((r) => setTimeout(r, 1_100));
  assert.equal(
    spareCapacity(), 0,
    'background work kept its allowance after its own request was refused',
  );
});
