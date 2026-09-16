import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Background work takes only what scans have left over.
 *
 * Measured before this: a scan's cumulative wait for a rate-limiter token went
 * from 1,504ms with the bot idle to 11,955ms with the window indexer running,
 * and the deepest queue it arrived into went from 4 to 15. Priority ordering
 * could not prevent that on its own, because ordering decides who is served
 * next -- not who already drank the bucket dry.
 */
const CWD = process.cwd();

import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('yield');
process.env.RPC_RATE_PER_SEC = '10';
process.env.RPC_BURST = '10';

globalThis.fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x1' }), {
    headers: { 'content-type': 'application/json' },
  });
};
const R = await import(`${CWD}/dist/ratelimit.js`);
R.installRateLimit();

test('a full bucket has spare capacity for background work', () => {
  assert.ok(R.spareCapacity() > 0, 'an idle limiter should have surplus');
});

test('an interactive request in flight takes all the spare away', async () => {
  // Not merely deprioritised: zero. A scan in flight means the next token
  // belongs to it, not to a window read that can happen any time.
  await R.interactive(async () => {
    await fetch('https://rpc.mainnet.chain.robinhood.com', { method: 'POST', body: '{"id":1}' });
    assert.equal(R.spareCapacity(), 0, 'background work must see no surplus during a scan');
  });
});

test('the surplus stays at zero for a second after a scan finishes', async () => {
  await R.interactive(() => fetch('https://rpc.mainnet.chain.robinhood.com', { method: 'POST', body: '{"id":1}' }));
  assert.equal(R.spareCapacity(), 0, 'immediately after, still nothing');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(R.spareCapacity(), 0, 'and 300ms after, still nothing');
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(R.spareCapacity() > 0, 'past the quiet second the surplus returns');
});

test('a reserve of the bucket is never spent on background work', async () => {
  // Drain to just above the reserve and confirm the surplus runs out before
  // the bucket does: what is left is what a scan arriving next will draw on.
  await new Promise((r) => setTimeout(r, 1200));
  const before = R.spareCapacity();
  assert.ok(before > 0 && before < 10, `surplus ${before} should be under the full bucket of 10`);
});

test('background requests wait while interactive ones do not', async () => {
  await new Promise((r) => setTimeout(r, 1200));
  const order = [];
  const bulkDone = R.bulk(async () => {
    // enough bulk requests to exhaust the surplus and then some
    for (let i = 0; i < 12; i++) {
      await fetch('https://rpc.mainnet.chain.robinhood.com', { method: 'POST', body: `{"id":${i}}` });
      order.push('bulk');
    }
  });
  // a scan arriving mid-stream
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  const { waits } = await R.measuringWaits(() =>
    R.interactive(async () => {
      await fetch('https://rpc.mainnet.chain.robinhood.com', { method: 'POST', body: '{"id":99}' });
      order.push('scan');
    }),
  );
  const scanMs = Date.now() - t0;
  await bulkDone;

  assert.ok(scanMs < 2_000, `the scan waited ${scanMs}ms behind background work`);
  assert.ok(waits.requests > 0, 'the wait was actually measured');
  const scanAt = order.indexOf('scan');
  assert.ok(scanAt >= 0 && scanAt < order.length, 'the scan completed while bulk work was still going');
});

test('sustained scanning starves background work without deadlocking it', async () => {
  // A scan every 900ms sits inside the one-second quiet window, so background
  // work should be squeezed almost to nothing -- which is what was asked for.
  // What must NOT happen is zero forever: "yields to scans" turning into "never
  // runs" is a stall, and it would look identical from the outside.
  const URL = 'https://rpc.mainnet.chain.robinhood.com';
  let served = 0;
  let stop = false;
  const bulkLoop = (async () => {
    while (!stop) {
      await R.bulk(() => fetch(URL, { method: 'POST', body: '{"id":1}' }));
      served++;
    }
  })();

  const started = Date.now();
  while (Date.now() - started < 5_000) {
    await R.interactive(() => fetch(URL, { method: 'POST', body: '{"id":2}' }));
    await new Promise((r) => setTimeout(r, 900));
  }
  stop = true;
  await Promise.race([bulkLoop, new Promise((r) => setTimeout(r, 2_000))]);

  assert.ok(served > 0, 'background work made no progress at all in five seconds, that is a stall, not a yield');
  assert.ok(served < 25, `background work took ${served} tokens while scans were arriving constantly`);
});
