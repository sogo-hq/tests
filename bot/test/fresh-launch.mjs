/**
 * A real launch must never be reported as "not a pons v2 launch".
 *
 * A user scanned a genuine pons v2 token seconds after it went live and was
 * told it was not one. The factory had already confirmed the token existed --
 * readToken reads getLaunchedToken before anything else -- and only the lookup
 * for its launch BLOCK had come up empty, because this node's log index lags
 * its head. That null rendered as a confident statement about the chain.
 *
 * Needs network. Run: node test/fresh-launch.mjs
 */
import assert from 'node:assert/strict';
import { performScan, CHAIN_UNREADABLE } from '../dist/service.js';
import { scanCache } from '../dist/cache.js';
import { db } from '../dist/db.js';
import { client, getLogsAdaptive } from '../dist/chain.js';
import { FACTORY } from '../dist/config.js';
import { TokenLaunched } from '../dist/abi.js';

const ok = (m) => console.log(`  PASS  ${m}`);
const NOT_A_LAUNCH = /not a pons v2 launch/i;

// --- find the newest launch the chain has, and make the index forget it ------
const head = await client.getBlockNumber();
let newest = null;
for (let end = head; end > head - 200_000n && !newest; end -= 20_000n) {
  const logs = await getLogsAdaptive({
    address: FACTORY, event: TokenLaunched, fromBlock: end - 20_000n, toBlock: end,
  });
  if (logs.length) newest = logs[logs.length - 1];
}
assert.ok(newest, 'no launch found in the last 200k blocks — cannot run this check');
const token = newest.args.token;
const ageBlocks = Number(head - newest.blockNumber);
console.log(`  subject ${token.slice(0, 12)}… launched ${ageBlocks} blocks ago (~${(ageBlocks * 0.1).toFixed(0)}s)`);

// The state the bug needed: the factory knows it, the index does not.
db.prepare('DELETE FROM launches WHERE token = ?').run(token.toLowerCase());
scanCache.drop(token);

// --- 1. an unindexed launch is never called "not a launch" -------------------
{
  const r = await performScan({ token, source: 'dm', userId: 870001 });
  assert.notEqual(r.kind, 'not_found', 'a real launch was reported as not a launch');
  assert.ok(['ok', 'unreadable'].includes(r.kind), `unexpected kind ${r.kind}`);
  if (r.kind === 'ok') {
    assert.ok(!NOT_A_LAUNCH.test(r.defaultCard), `card claimed it is not a launch:\n${r.defaultCard}`);
    ok(`an unindexed launch renders its card (source placed it, ${r.durationMs}ms)`);
  } else {
    assert.equal(r.message, CHAIN_UNREADABLE);
    ok('an unindexed launch that could not be placed says so honestly');
  }
}

// --- 2. and the two outcomes are different sentences -------------------------
{
  // 20 bytes the factory has genuinely never heard of.
  const fake = '0x' + 'ab'.repeat(20);
  scanCache.drop(fake);
  const r = await performScan({ token: fake, source: 'dm', userId: 870002 });
  assert.equal(r.kind, 'not_found', `an address with no record should be not_found, got ${r.kind}`);
  assert.match(r.defaultCard, NOT_A_LAUNCH, 'a genuine absence still says so plainly');
  ok('an address the factory has no record of still reports "not a pons v2 launch"');
}

// --- 3. the honest message is never the confident one ------------------------
{
  assert.ok(!NOT_A_LAUNCH.test(CHAIN_UNREADABLE), 'the unreadable message must not mention being a launch');
  assert.match(CHAIN_UNREADABLE, /try again/i, 'and it must tell the user what to do');
  ok(`"couldn't read" and "not a launch" are different sentences`);
}

// --- 4. the curve places it when the factory's logs cannot ------------------
// The real scenario, made deterministic. A node's log index can lag its head,
// so a token exists in the factory's state before it appears in a getLogs
// result -- and for an unindexed token older than the lookback window the log
// scan cannot reach it at all. Either way the logs come back empty on a token
// the factory has already confirmed, which is precisely the state that
// rendered "not a pons v2 launch".
{
  db.prepare('DELETE FROM launches WHERE token = ?').run(token.toLowerCase());
  scanCache.drop(token);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.method === 'eth_getLogs') {
      const p = body.params?.[0] ?? {};
      const addr = String(p.address ?? '').toLowerCase();
      if (addr === FACTORY.toLowerCase()) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return realFetch(input, init);
  };

  let r;
  try {
    r = await performScan({ token, source: 'dm', userId: 870003 });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.notEqual(r.kind, 'not_found',
    'with the factory confirming the token and its logs empty, this is the exact bug');
  // Required to be a card, not merely an honest refusal: this same token
  // rendered fine moments ago, so its curve is readable and the fallback has
  // everything it needs. Accepting "unreadable" here would let the fallback be
  // deleted without the suite noticing.
  assert.equal(
    r.kind, 'ok',
    `the curve should have placed this launch without the logs, got ${r.kind}` +
      `${r.kind === 'unreadable' ? ' — the fallback did not fire' : ''}`,
  );
  assert.ok(!NOT_A_LAUNCH.test(r.defaultCard), `card claimed it is not a launch:\n${r.defaultCard}`);
  ok('with the factory logs empty, the curve places the launch and the card renders');
}

console.log('\nAll fresh-launch checks passed.');
process.exit(0);
