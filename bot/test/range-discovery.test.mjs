/**
 * The indexer must fit the provider, not the other way round.
 *
 * Measured against real providers: Alchemy free serves a 10-block eth_getLogs
 * range, Goldsky 10,000, the public node ~3.9M. The code assumed 500,000
 * (FACTORY_LOG_CHUNK) and, when refused, halved the range in parallel with a
 * floor of 2,000 blocks.
 *
 * Three things then went wrong together, and only all three explain 32,000
 * consecutive failures over 31 hours:
 *
 *   1. The floor was on RECURSION DEPTH, not on the provider. The narrowest
 *      query it would ever attempt was (what the caller asked for) / 2^k --
 *      1,954 blocks from a 500,000 chunk, 1,125 from an 18,000 window. A
 *      provider capping at 10 was unreachable by construction.
 *
 *   2. The steady-state tail asks for about thirty blocks, which is ALREADY
 *      under the floor. So the poll threw after one request, never split, never
 *      discovered anything, and never reached setCursor.
 *
 *   3. With no cursor written, indexNew falls back to backfill() -- seven days,
 *      6,048,000 blocks -- and asked for it again on the very next tick. The
 *      container has no persistent volume, so a deploy starts in exactly this
 *      state.
 *
 * These assert the fix from both ends: the ceiling is found and remembered, and
 * a fresh database against a capped provider makes progress instead of looping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const ADDR = `0x${'11'.repeat(20)}`;

/** A provider that refuses any range wider than `cap`, and counts requests. */
function cappedProvider(cap, message = 'getLogs request exceeded max allowed range') {
  const state = { calls: 0, spans: [], widestServed: 0 };
  const saved = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const reply = (v) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...v }),
      { headers: { 'content-type': 'application/json' } });
    if (body.method === 'eth_blockNumber') return reply({ result: '0x3172240' });
    if (body.method !== 'eth_getLogs') return reply({ result: '0x' });
    state.calls++;
    const p = body.params[0];
    const span = Number(BigInt(p.toBlock) - BigInt(p.fromBlock)) + 1;
    state.spans.push(span);
    if (span > cap) return reply({ error: { code: -32000, message } });
    state.widestServed = Math.max(state.widestServed, span);
    return reply({ result: [] });
  };
  state.restore = () => { globalThis.fetch = saved; };
  return state;
}

test('a 10-block ceiling is reachable at all', async () => {
  // The old splitter could not get here: from a 30-block ask it threw
  // immediately because 30 was already under its 2,000 floor.
  const { getLogsAdaptive } = await import('../dist/chain.js');
  const { learnedMaxSpan, resetProviderLimits } = await import('../dist/providerlimits.js');
  resetProviderLimits();
  const p = cappedProvider(10);
  try {
    const out = await getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 30n });
    assert.deepEqual(out, [], 'the read completed');
    assert.ok(p.widestServed > 0 && p.widestServed <= 10,
      `nothing within the provider's cap was ever served (widest ${p.widestServed})`);
    assert.ok(learnedMaxSpan() !== null && learnedMaxSpan() <= 10n,
      `ceiling not learned: ${learnedMaxSpan()}`);
  } finally { p.restore(); resetProviderLimits(); }
});

test('the ceiling is discovered once, then reused', async () => {
  const { getLogsAdaptive } = await import('../dist/chain.js');
  const { resetProviderLimits } = await import('../dist/providerlimits.js');
  const { bulk } = await import('../dist/ratelimit.js');
  resetProviderLimits();
  const p = cappedProvider(10_000);
  try {
    const before = p.calls;
    // Indexer work runs under bulk(); a 500,000-block read is deliberately
    // refused at interactive priority, which is asserted separately below.
    await bulk(() => getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 500_000n }));
    const discovery = p.calls - before;

    const mid = p.calls;
    await getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 5_000n });
    const afterLearning = p.calls - mid;

    assert.equal(afterLearning, 1,
      `a 5,000-block read cost ${afterLearning} requests after the ceiling was known; it should be one`);
    assert.ok(discovery > afterLearning, 'discovery should be the expensive one, not every call');
  } finally { p.restore(); resetProviderLimits(); }
});

test('the learned ceiling survives a restart and is keyed to the endpoint', async () => {
  const { getLogsAdaptive } = await import('../dist/chain.js');
  const { learnedMaxSpan, resetProviderLimits } = await import('../dist/providerlimits.js');
  const { db } = await import('../dist/db.js');
  const { bulk } = await import('../dist/ratelimit.js');
  resetProviderLimits();
  const p = cappedProvider(10_000);
  try {
    await bulk(() => getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 500_000n }));
    const learned = learnedMaxSpan();
    assert.ok(learned !== null, 'nothing was written down');

    const row = db.prepare('SELECT endpoint, max_span FROM provider_limits').get();
    assert.ok(row, 'the ceiling must be persisted, or discovery repeats on every restart');
    assert.equal(BigInt(row.max_span), learned);
    // Keyed by endpoint so switching providers re-discovers instead of
    // inheriting a number that was true somewhere else.
    assert.match(row.endpoint, /^https?:\/\//);
    // And no API key in it: this file gets copied around.
    assert.doesNotMatch(row.endpoint, /\/v2\/|key|token/i);
  } finally { p.restore(); resetProviderLimits(); }
});

test('a timeout narrows the range but is not recorded as the provider ceiling', async () => {
  // A timeout is a fact about this moment -- how loaded the node is -- not a
  // standing fact about the provider. Recording it would turn one slow minute
  // into a permanently cramped ceiling.
  const { getLogsAdaptive } = await import('../dist/chain.js');
  const { learnedMaxSpan, resetProviderLimits } = await import('../dist/providerlimits.js');
  resetProviderLimits();
  const p = cappedProvider(5_000, 'log query timed out');
  try {
    await getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 40_000n });
    assert.equal(learnedMaxSpan(), null,
      `a timeout was written down as the provider's ceiling (${learnedMaxSpan()})`);
  } finally { p.restore(); resetProviderLimits(); }
});

test('an interactive read gives up rather than issuing thousands of requests', async () => {
  // findLaunch walks 8.6M blocks at interactive priority inside a five-second
  // budget. At a 10,000-block ceiling that is 2,286 requests -- about four
  // minutes at the limiter's ten a second, draining the bucket every other scan
  // shares. "Couldn't read the chain for this one" is a true answer; a card
  // four minutes late is not one.
  const { getLogsAdaptive, LogRangeTooWide } = await import('../dist/chain.js');
  const { resetProviderLimits } = await import('../dist/providerlimits.js');
  const { interactive, bulk } = await import('../dist/ratelimit.js');
  resetProviderLimits();
  const p = cappedProvider(10_000);
  try {
    await getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 20_000n }); // learn it
    const before = p.calls;
    await assert.rejects(
      () => interactive(() => getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 8_640_000n })),
      (err) => err instanceof LogRangeTooWide,
      'an interactive read must refuse a range it cannot serve promptly',
    );
    assert.ok(p.calls - before < 5,
      `it refused only after ${p.calls - before} requests; the refusal must be up front`);

    // Background work makes the opposite trade: more requests, never a dead index.
    const bulkBefore = p.calls;
    await bulk(() => getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 200_000n }));
    assert.ok(p.calls - bulkBefore >= 20,
      'background work should walk the range in pieces rather than refuse it');
  } finally { p.restore(); resetProviderLimits(); }
});

test('a fresh database against a capped provider makes progress instead of looping', async () => {
  // The production failure end to end: no cursor (a deploy has no persistent
  // volume), a provider that caps ranges, and a poll that must not spend
  // forever re-asking for the same seven days.
  const { getLogsAdaptive } = await import('../dist/chain.js');
  const { resetProviderLimits, learnedMaxSpan } = await import('../dist/providerlimits.js');
  const { bulk } = await import('../dist/ratelimit.js');
  resetProviderLimits();
  const p = cappedProvider(10_000);
  try {
    // One catch-up pass of the size indexNew actually asks for (TAIL_MAX_BLOCKS).
    const out = await bulk(() => getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 30_000n }));
    assert.deepEqual(out, [], 'the pass completed, so a cursor can be written');
    assert.ok(learnedMaxSpan() !== null, 'and it learned the ceiling on the way');

    // The second pass is cheap, which is what stops the 3-second tick from
    // becoming a permanent request storm.
    const before = p.calls;
    await bulk(() => getLogsAdaptive({ address: ADDR, fromBlock: 30_001n, toBlock: 60_000n }));
    const second = p.calls - before;
    assert.ok(second <= 5, `the second pass still cost ${second} requests`);
  } finally { p.restore(); resetProviderLimits(); }
});

test('a node that is simply unwell surfaces its own error, not a range verdict', async () => {
  // Caught on the live node during a backend outage: "Post ...:8547/rpc: EOF"
  // on a 125-block range. The descent treated it as a width problem, narrowed
  // all the way to one block, and then threw an invented error saying the
  // provider had refused a single block -- which is both untrue and hides what
  // actually went wrong. A failure that is not about width must not be chased
  // to the bottom, and must arrive at the caller as itself.
  const { getLogsAdaptive } = await import('../dist/chain.js');
  const { resetProviderLimits, learnedMaxSpan } = await import('../dist/providerlimits.js');
  resetProviderLimits();

  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method !== 'eth_getLogs') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x3172240' }),
        { headers: { 'content-type': 'application/json' } });
    }
    calls++;
    // Fails at every width, the way a dead backend does.
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id: body.id,
      error: { code: -32000, message: 'log query timed out' },
    }), { headers: { 'content-type': 'application/json' } });
  };

  try {
    await assert.rejects(
      () => getLogsAdaptive({ address: ADDR, fromBlock: 1n, toBlock: 40_000n }),
      (err) => {
        assert.doesNotMatch(String(err?.message ?? ''), /refused a single-block/,
          'it invented a verdict about the provider instead of reporting the failure');
        return true;
      },
    );
    assert.ok(calls < 12, `it made ${calls} attempts chasing a failure that was never about width`);
    assert.equal(learnedMaxSpan(), null, 'and it learned nothing from a sick node');
  } finally {
    globalThis.fetch = saved;
    resetProviderLimits();
  }
});
