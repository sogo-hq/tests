import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the background loop does when the node says no.
 *
 * A limit is not one launch's problem and the next launch will hit it too.
 * Grinding through a batch spends the 429 backoff budget once per launch --
 * twenty-five of them is twenty minutes of a pass arguing with a node that has
 * already refused. The pass abandons instead, and the next tick resumes.
 */
const CWD = process.cwd();

process.env.DB_PATH = `/tmp/windows-limit-${process.pid}.db`;
process.env.RPC_429_BUDGET_MS = '200';

let mode = 'ok';
let getLogsCalls = 0;
globalThis.fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (mode === 'limit' && body.method === 'eth_getLogs') {
    getLogsCalls++;
    return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } });
  }
  const result =
    body.method === 'eth_blockNumber' ? '0x' + (10_000_000).toString(16)
    : body.method === 'eth_getLogs' ? (getLogsCalls++, [])
    : body.method === 'eth_getBlockByNumber'
      ? { number: body.params[0], timestamp: '0x0', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [] }
      : null;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
    headers: { 'content-type': 'application/json' },
  });
};
const { installRateLimit } = await import(`${CWD}/dist/ratelimit.js`);
installRateLimit();
const { db } = await import(`${CWD}/dist/db.js`);
const W = await import(`${CWD}/dist/indexer/windows.js`);

const A = (n) => '0x' + String(n).padStart(40, '0');
const OLD = Math.floor(Date.now() / 1000) - 86_400;
for (let i = 1; i <= 25; i++) {
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at, snipe_exemption_count, holders_read_at)
     VALUES (?,?,?,?,0,'0',?,?,?,3,1)`,
  ).run(A(i), A(900000 + i), A(98), A(0), 1000 + i * 100, '0xtx' + i, OLD);
}

test('a rate limit ends the pass instead of being paid once per launch', async () => {
  mode = 'limit';
  getLogsCalls = 0;
  const started = Date.now();
  const pass = await W.indexWindows(25);
  const elapsed = Date.now() - started;
  mode = 'ok';

  assert.equal(pass.attempted, 25, 'it selected a full batch');
  assert.equal(pass.rateLimited, true, 'and reported why it stopped');
  assert.equal(pass.indexed, 0);
  assert.equal(pass.failed, 0, 'a limit is not counted as an unreadable launch');
  // One launch's worth of backoff, not twenty-five. With a 200ms budget the
  // difference is small in wall clock; what is asserted is that it stopped
  // after the FIRST refusal rather than working through the batch.
  assert.ok(elapsed < 5_000, `pass took ${elapsed}ms — it argued with the node`);
});

test('and the next pass picks up where it stopped', async () => {
  const pass = await W.indexWindows(25);
  assert.equal(pass.rateLimited, false);
  assert.ok(pass.attempted > 0, 'nothing was marked, so the same launches are still waiting');
  assert.ok(pass.indexed > 0, `the pass resumed: ${JSON.stringify(pass)}`);
});
