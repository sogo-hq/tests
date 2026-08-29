import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The head this node reports is not always a block it can serve yet.
 *
 * At a tenth of a second per block, getBlockNumber() routinely returns a number
 * whose body a following getBlock() cannot find -- the two calls need not land
 * on the same node, and even one node writes the number before the body. It
 * surfaced as BlockNotFoundError killing a backfill outright, on a chain where
 * the block exists a moment later.
 */
const CWD = process.cwd();

async function primeWith(behaviour) {
  // Stub the transport before chain.js is loaded, so the client built from it
  // is the stubbed one.
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.method !== 'eth_getBlockByNumber') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const n = Number(BigInt(body.params[0]));
    calls.push(n);
    const answer = behaviour(n, calls.length);
    return new Response(
      JSON.stringify(
        answer === null
          ? { jsonrpc: '2.0', id: body.id, result: null }
          : { jsonrpc: '2.0', id: body.id, result: { number: body.params[0], timestamp: '0x' + answer.toString(16), hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [] } },
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const { BlockTimeEstimator } = await import(`${CWD}/dist/blocktime.js?v=${Math.random()}`);
  const est = new BlockTimeEstimator(100_000);
  await est.prime(1_000_000n, 1_000_100n);
  return { est, calls };
}

test('a head that is not there yet is retried, not fatal', async () => {
  // the first look at the head returns null; the second finds it
  let headLooks = 0;
  const { est } = await primeWith((n) => {
    if (n === 1_000_100) {
      headLooks++;
      return headLooks === 1 ? null : 1_700_000_010;
    }
    return 1_700_000_000;
  });
  assert.equal(est.at(1_000_000), 1_700_000_000, 'the estimator primed rather than throwing');
  assert.ok(headLooks >= 2, 'the head was looked for more than once');
});

test('a head that never lands falls back to an earlier block', async () => {
  // the top two blocks are never servable; one block back is a hundredth of a
  // second of interpolation error, which no window this bot measures can feel
  const { est, calls } = await primeWith((n) => (n >= 1_000_099 ? null : 1_700_000_000));
  assert.ok(est.at(1_000_000) !== null, 'priming still produced usable anchors');
  assert.ok(Math.min(...calls) < 1_000_099, `never stepped back: looked at ${[...new Set(calls)].join(',')}`);
});

test('an error that is not a missing block still propagates', async () => {
  await assert.rejects(
    () => primeWith((n) => { if (n === 1_000_100) throw new Error('boom'); return 1_700_000_000; }),
    'a real transport fault must not be swallowed as a missing block',
  );
});
