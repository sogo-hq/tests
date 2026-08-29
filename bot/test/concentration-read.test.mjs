import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The half of check 09 that touches the chain: rebuilding balances from the
 * token's Transfer log.
 *
 * Stubbed at the transport, so the real getLogsAdaptive, the real decoding and
 * the real exclusion set all run. What is pinned here is who counts as a
 * holder -- the protocol's own contracts hold supply and are not wallets, and
 * the Uniswap v4 PoolManager holding a graduated pool's liquidity was read as
 * the single largest holder on every graduated launch until it was excluded.
 */
const CWD = process.cwd();
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const word = (n) => '0x' + n.toString(16).padStart(64, '0');

async function readWith(transfers, opts = {}) {
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const result =
      body.method === 'eth_getLogs'
        ? transfers.map((t, i) => ({
            address: opts.token ?? TOKEN,
            topics: [TRANSFER, pad(t.from), pad(t.to)],
            data: word(t.value),
            blockNumber: '0x' + (1000 + i).toString(16),
            transactionHash: '0x' + String(i).padStart(64, '0'),
            transactionIndex: '0x0',
            blockHash: '0x' + '11'.repeat(32),
            logIndex: '0x' + i.toString(16),
            removed: false,
          }))
        : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const { readConcentration } = await import(`${CWD}/dist/metrics/concentration.js?v=${Math.random()}`);
  return readConcentration(opts.token ?? TOKEN, opts.curve ?? CURVE, 1000n, 2000n);
}

const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';
const W = (n) => '0x' + String(n).padStart(40, '0');

test('balances are rebuilt from mints and transfers', async () => {
  const c = await readWith([
    { from: ZERO, to: CURVE, value: 1000 },   // mint to the curve
    { from: CURVE, to: W(1), value: 400 },
    { from: CURVE, to: W(2), value: 300 },
    { from: CURVE, to: W(3), value: 200 },
    { from: W(1), to: W(4), value: 100 },     // a wallet-to-wallet move
  ]);
  // holders: W1 300, W2 300, W3 200, W4 100 -> circulating 900
  assert.equal(c.holders, 4);
  assert.equal(c.circulating, 900n);
  assert.equal(c.top5Share, 100, 'four holders means the top five hold all of it');
});

test('the curve is not a holder', async () => {
  const c = await readWith([
    { from: ZERO, to: CURVE, value: 1000 },
    { from: CURVE, to: W(1), value: 100 },
  ]);
  assert.equal(c.holders, 1, 'the 900 still on the curve is not somebody holding');
  assert.equal(c.circulating, 100n);
});

test('the pool is not a holder', async () => {
  const { POOL_MANAGER, LAUNCH_LOCKER, BUYBACK_VAULT, BURN_ADDRESS } = await import(`${CWD}/dist/config.js`);
  const c = await readWith([
    { from: ZERO, to: CURVE, value: 1000 },
    { from: CURVE, to: POOL_MANAGER, value: 500 },  // graduated liquidity
    { from: CURVE, to: LAUNCH_LOCKER, value: 100 },
    { from: CURVE, to: BUYBACK_VAULT, value: 100 },
    { from: CURVE, to: BURN_ADDRESS, value: 100 },  // burned
    { from: CURVE, to: W(1), value: 60 },
    { from: CURVE, to: W(2), value: 40 },
  ]);
  // Counting the pool would report 2 holders + a 500-token whale: 100% top-5
  // over 700 circulating. The honest reading is two wallets over 100.
  assert.equal(c.holders, 2, `protocol addresses were counted: ${c.holders} holders`);
  assert.equal(c.circulating, 100n);
  assert.equal(c.top5Share, 100);
});

test('a wallet that sold everything is not a holder', async () => {
  const c = await readWith([
    { from: ZERO, to: CURVE, value: 1000 },
    { from: CURVE, to: W(1), value: 100 },
    { from: CURVE, to: W(2), value: 100 },
    { from: W(2), to: CURVE, value: 100 },   // fully exited
  ]);
  assert.equal(c.holders, 1, 'a zero balance is not a holder');
  assert.equal(c.circulating, 100n);
});

test('the top five are the five largest, in any arrival order', async () => {
  const c = await readWith([
    { from: ZERO, to: CURVE, value: 10_000 },
    ...[10, 500, 20, 400, 30, 300, 40, 200, 50, 100].map((v, i) => ({ from: CURVE, to: W(10 + i), value: v })),
  ]);
  // ten holders totalling 1650; the five largest are 500+400+300+200+100 = 1500
  assert.equal(c.holders, 10);
  assert.equal(c.circulating, 1650n);
  // basis points in bigint, then divided: 1500*10000/1650 truncates to 9090, so
  // 90.90 rather than 90.909... The truncation is deliberate -- it keeps the
  // division exact until the last step -- and it always rounds toward the less
  // alarming number, which is the right direction for a concerns card.
  assert.equal(c.top5Share, 90.9);
  assert.ok(c.top5Share <= (1500 / 1650) * 100, 'truncation must never overstate concentration');
});

test('nothing circulating is a reading of zero holders, not a failed read', async () => {
  const c = await readWith([{ from: ZERO, to: CURVE, value: 1000 }]);
  assert.notEqual(c, null, 'a successful read that found nobody is not a failure');
  assert.equal(c.holders, 0);
  assert.equal(c.circulating, 0n);
});
