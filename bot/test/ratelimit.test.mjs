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
