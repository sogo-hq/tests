/**
 * Paying for premium.
 *
 * Thirty days start when the payment LANDED, not when the bot noticed it: a
 * holder who paid an hour before the poller got round to the block bought
 * thirty days from the payment, not twenty-nine and a bit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('premium-pay');
const PAY = '0x9999999999999999999999999999999999999999';
process.env.PREMIUM_PAY_ADDRESS = PAY;

const { db } = await import('../dist/db.js');
const { client } = await import('../dist/chain.js');

const acct = privateKeyToAccount('0x' + '22'.repeat(32));
const WALLET = acct.address.toLowerCase();
const HASH = '0x' + 'c'.repeat(64);
const eth = (n) => BigInt(Math.round(n * 1e18));

let txs = new Map();
let blockTime = 1_789_000_000;
client.getTransaction = async ({ hash }) => {
  const t = txs.get(hash);
  if (!t) throw new Error('Transaction could not be found');
  return t.tx;
};
client.getTransactionReceipt = async ({ hash }) => {
  const t = txs.get(hash);
  if (!t) throw new Error('Transaction could not be found');
  return t.receipt;
};
client.getBlock = async () => ({ timestamp: BigInt(blockTime) });
client.readContract = async ({ functionName }) => {
  if (functionName === 'decimals') return 18;
  if (functionName === 'balanceOf') return 0n;
  throw new Error(`unexpected ${functionName}`);
};

const I = await import('../dist/inbound.js');
const T = await import('../dist/tiers.js');
const H = await import('../dist/holder.js');

const payment = (over = {}) => ({
  tx: { to: PAY, from: WALLET, value: eth(0.05), ...over.tx },
  receipt: { status: 'success', blockNumber: 60_000_000, ...over.receipt },
});

const link = async (userId) => {
  const n = H.issueNonce(userId);
  return H.linkBySignature(userId, await acct.signMessage({ message: H.linkMessage(n) }));
};

const reset = () => {
  for (const t of ['premium_payments', 'tier_grants', 'holder_links', 'holder_nonces', 'ready_settings']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  txs = new Map();
  blockTime = 1_789_000_000;
};

test('a payment from a linked wallet grants premium for thirty days', async () => {
  reset();
  await link(7);
  txs.set(HASH, payment());
  const now = Date.now();
  const r = await I.creditPayment(HASH, now);
  assert.equal(r.ok, true);
  assert.equal(r.wallet, WALLET);

  const t = await T.tierOf(7, now);
  assert.equal(t.tier, 'premium');
  assert.equal(t.via, 'grant');
  // Dated from the block, not from now.
  assert.ok(Math.abs(r.until - (blockTime * 1000 + 30 * 86_400_000)) < 1000);
});

test('the month is counted from when it landed, not when it was noticed', async () => {
  reset();
  await link(7);
  txs.set(HASH, payment());
  // The bot reads the block an hour late.
  const noticed = blockTime * 1000 + 3_600_000;
  const r = await I.creditPayment(HASH, noticed);
  assert.ok(r.until > noticed + 29 * 86_400_000 + 3_500_000,
    'an hour of the buyer\'s month must not be eaten by the poller being slow');
});

test('a payment from an unlinked wallet is refused rather than banked', async () => {
  reset();
  txs.set(HASH, payment());
  const r = await I.creditPayment(HASH);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unlinked',
    'without a link the bot has the money and no idea whose month it bought');
  assert.equal(T.grantOf(7), null);
});

test('every other condition is checked too', async () => {
  for (const [reason, over] of [
    ['wrong_recipient', { tx: { to: '0x4444444444444444444444444444444444444444' } }],
    ['too_little', { tx: { value: eth(0.049) } }],
    ['failed', { receipt: { status: 'reverted' } }],
  ]) {
    reset();
    await link(7);
    txs.set(HASH, payment(over));
    const r = await I.creditPayment(HASH);
    assert.equal(r.reason, reason);
    assert.equal(T.grantOf(7), null, `${reason} must not grant`);
  }
});

test('one payment cannot be claimed twice', async () => {
  reset();
  await link(7);
  txs.set(HASH, payment());
  assert.equal((await I.creditPayment(HASH)).ok, true);
  assert.equal((await I.creditPayment(HASH)).reason, 'already_used');
});

test('a hash the node never saw is not_found, an unreadable node is not', async () => {
  reset();
  await link(7);
  assert.equal((await I.creditPayment(HASH)).reason, 'not_found');
  txs.set(HASH, payment());
  const real = client.getTransaction;
  client.getTransaction = async () => { throw new Error('connection reset'); };
  assert.equal((await I.creditPayment(HASH)).reason, 'unreadable');
  client.getTransaction = real;
});

test('the poller is inert unless somebody is waiting', async () => {
  reset();
  let heads = 0;
  client.getBlockNumber = async () => { heads++; return 60_000_000n; };
  assert.deepEqual(await I.pollInbound(), { linked: 0, paid: 0, scanned: 0 });
  assert.equal(heads, 0, 'reading whole blocks at a 0.1s block time is the most expensive thing here');

  I.expectPayment(7);
  await I.pollInbound();
  assert.equal(heads, 1, 'and it runs the moment somebody says they are paying');
});

test('an expected payment expires, so the poller does not run forever', () => {
  reset();
  const now = Date.now();
  I.expectPayment(7, now - 3 * 3_600_000);
  assert.equal(I.paymentExpected(now), false);
  I.expectPayment(7, now);
  assert.equal(I.paymentExpected(now), true);
});

test('an admin grant works without any payment at all', async () => {
  reset();
  const now = Date.now();
  T.grant(9, 'premium', 30, 'admin', now);
  const t = await T.tierOf(9, now);
  assert.equal(t.tier, 'premium');
  assert.equal(t.via, 'grant');
  assert.equal(T.revokeGrant(9), true);
  assert.equal(T.grantOf(9, now), null);
});

test('the pay address falls back to the treasury rather than being unset', () => {
  const saved = process.env.PREMIUM_PAY_ADDRESS;
  delete process.env.PREMIUM_PAY_ADDRESS;
  process.env.TREASURY_ADDRESS = '0x7777777777777777777777777777777777777777';
  assert.equal(I.premiumPayAddress().toLowerCase(), '0x7777777777777777777777777777777777777777');
  process.env.PREMIUM_PAY_ADDRESS = saved;
  assert.equal(I.premiumPayAddress().toLowerCase(), PAY.toLowerCase());
});
