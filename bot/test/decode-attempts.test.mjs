import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The decode loop retried every undecoded row on every pass, forever, at nought
 * percent success — 11,966 rows re-fetched every fifteen seconds against a
 * rate-limited node the scan path competes for. Sampling sixty of them found
 * eight distinct unknown selectors and one that is constructor bytecode rather
 * than a call at all, so this is a long tail of launch contracts with no ABI
 * here, not a transient failure a retry resolves.
 *
 * What is pinned here is that giving up on the retry is NOT giving an answer:
 * an exhausted row keeps a NULL exemption count, so every check that reads one
 * still reports undetermined, and the collision negative still refuses to be
 * asserted from it.
 */
const CWD = process.cwd();

function inTempDb(body, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-decode-'));
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
      // Every launch transaction decodes to an unknown selector, which is what
      // the real backlog looks like. Stubbed at the transport so the real
      // decoder, the real attempt accounting and the real queries all run.
      globalThis.fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const result =
          body.method === 'eth_getTransactionByHash'
            ? { hash: body.params[0], input: '0x4b9cadc3', from: '0x' + '11'.repeat(20),
                to: '0x' + '22'.repeat(20), value: '0x0', nonce: '0x0', gas: '0x0',
                gasPrice: '0x0', blockHash: '0x' + '33'.repeat(32), blockNumber: '0x1',
                transactionIndex: '0x0', r: '0x1', s: '0x1', v: '0x1', type: '0x0' }
            : null;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
          headers: { 'content-type': 'application/json' },
        });
      };
      const { db } = await import('${CWD}/dist/db.js');
      const L = await import('${CWD}/dist/indexer/launches.js');
      const { indexCoverage } = await import('${CWD}/dist/coverage.js');
      const A = (n) => '0x' + String(n).padStart(40, '0');
      const launch = (n, opts = {}) => db.prepare(
        \`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
            graduation_threshold, block_number, tx_hash, launched_at, snipe_exemption_count)
          VALUES (?,?,?,?,0,'0',?,?,?,?)\`
      ).run(A(n), A(900000 + n), A(98), A(0), 1000 + n, '0x' + String(n).padStart(64, '0'),
            1_000_000 - n, opts.count ?? null);
      ${body}
    `], {
      cwd: CWD,
      // The transport is a stub, so client-side pacing only makes the suite
      // slow: 2,400 stubbed fetches at ten a second is four minutes of nothing.
      env: { ...process.env, DB_PATH: join(dir, 'd.db'), RPC_RATE_PER_SEC: '100000', RPC_BURST: '100000', ...env },
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a row that cannot be decoded is attempted twice and then left alone', async () => {
  const out = inTempDb(`
    for (let i = 1; i <= 5; i++) launch(i);
    const passes = [];
    for (let p = 0; p < 4; p++) {
      const r = await L.decodePending(10);
      passes.push({ decoded: r.decoded, failed: r.failed, pending: r.remaining, exhausted: r.exhausted });
    }
    console.log(JSON.stringify(passes));
  `);
  const passes = JSON.parse(out);
  assert.deepEqual(passes[0], { decoded: 0, failed: 5, pending: 5, exhausted: 0 }, 'first attempt');
  assert.deepEqual(passes[1], { decoded: 0, failed: 5, pending: 0, exhausted: 5 }, 'second attempt exhausts them');
  assert.deepEqual(passes[2], { decoded: 0, failed: 0, pending: 0, exhausted: 5 }, 'third pass does no work at all');
  assert.deepEqual(passes[3], { decoded: 0, failed: 0, pending: 0, exhausted: 5 }, 'and neither does the fourth');
});

test('an exhausted row is out of the queue, not answered', async () => {
  const out = inTempDb(`
    for (let i = 1; i <= 3; i++) launch(i);
    await L.decodePending(10);
    await L.decodePending(10);
    const rows = db.prepare('SELECT snipe_exemption_count c, decode_attempts a FROM launches').all();
    console.log(JSON.stringify({ rows, backlog: L.decodeBacklog() }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.backlog.pending, 0);
  assert.equal(r.backlog.exhausted, 3);
  for (const row of r.rows) {
    assert.equal(row.c, null, 'the exemption count stays NULL — undetermined, never a clean zero');
    assert.equal(row.a, 2);
  }
});

test('exhausted rows never unlock an index-derived negative', async () => {
  // The collision check refuses to say "no match" until enough DECODED rows
  // exist. Rows given up on must not count toward that, or giving up on the
  // retry would quietly convert undetermined into clean — the one failure mode
  // this product exists to avoid.
  const out = inTempDb(`
    for (let i = 1; i <= 60; i++) launch(i);
    await L.decodePending(200);
    await L.decodePending(200);
    const cov = indexCoverage();
    console.log(JSON.stringify({
      indexed: cov.indexed, decoded: cov.decoded,
      collision: cov.trustNegatives.collision, backlog: L.decodeBacklog(),
    }));
  `, { MIN_INDEX_ROWS_FOR_NEGATIVE: '50' });
  const r = JSON.parse(out);
  assert.equal(r.indexed, 60, 'the rows are indexed, and past the threshold for a negative');
  assert.equal(r.backlog.exhausted, 60, 'and all of them are out of the decode queue');
  assert.equal(r.decoded, 0, 'but none of them is decoded');
  assert.equal(r.collision, false, 'so the collision negative is still refused');
});

test('a row that decodes leaves the queue without needing the cap', async () => {
  const out = inTempDb(`
    for (let i = 1; i <= 3; i++) launch(i, { count: 0 });   // already decoded
    launch(9);                                              // not
    const r = await L.decodePending(10);
    console.log(JSON.stringify({ attempted: r.failed + r.decoded, backlog: L.decodeBacklog() }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.attempted, 1, 'only the undecoded row is attempted');
  assert.equal(r.backlog.pending, 1, 'it has one attempt left');
});

test('the cap is configurable, and at least one', async () => {
  const out = inTempDb(`
    for (let i = 1; i <= 4; i++) launch(i);
    const first = await L.decodePending(10);
    const second = await L.decodePending(10);
    console.log(JSON.stringify({ first: first.failed, second: second.failed, backlog: L.decodeBacklog() }));
  `, { MAX_DECODE_ATTEMPTS: '1' });
  const r = JSON.parse(out);
  assert.equal(r.first, 4);
  assert.equal(r.second, 0, 'with a cap of one, a single failure is terminal');
  assert.equal(r.backlog.exhausted, 4);
});
