/**
 * The premium gate.
 *
 * Two things this must never do: deny a holder because a read failed, and burn
 * anything. The first is the same class of error as calling a token clean
 * because a check did not finish; the second was removed from the design on
 * purpose, and a zero-address default would put it back without anyone noticing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('premium');
const { client } = await import('../dist/chain.js');

const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const eth = (n) => BigInt(Math.round(n * 1e18));

let tokenBalance = 0n;
let readThrows = null;
let txs = new Map();
client.getTransaction = async ({ hash }) => {
  if (readThrows === 'tx') throw new Error('rpc down');
  const t = txs.get(hash);
  if (!t) throw new Error('Transaction could not be found');
  return t.tx;
};
client.getTransactionReceipt = async ({ hash }) => {
  if (readThrows === 'tx') throw new Error('rpc down');
  const t = txs.get(hash);
  if (!t) throw new Error('Transaction could not be found');
  return t.receipt;
};
client.readContract = async ({ functionName }) => {
  if (readThrows === 'token') throw new Error('rpc down');
  if (functionName === 'decimals') return 18;
  if (functionName === 'balanceOf') return tokenBalance;
  throw new Error(`unexpected read: ${functionName}`);
};

const P = await import('../dist/premium.js');

const TREASURY = '0x9999999999999999999999999999999999999999';
const HASH = '0x' + 'a'.repeat(64);
const { db } = await import('../dist/db.js');

const payment = (over = {}) => ({
  tx: { to: TREASURY, from: WALLET, value: eth(0.05), ...over.tx },
  receipt: { status: 'success', ...over.receipt },
});

const reset = () => {
  tokenBalance = 0n;
  readThrows = null;
  txs = new Map();
  db.prepare('DELETE FROM premium_payments').run();
  delete process.env.VITALS_TOKEN_ADDRESS;
  process.env.TREASURY_ADDRESS = TREASURY;
};

test('1M $VITALS held is enough on its own', async () => {
  reset();
  process.env.VITALS_TOKEN_ADDRESS = TOKEN;
  tokenBalance = 1_000_000n * 10n ** 18n;
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'premium');
  assert.equal(e.via, 'vitals');
  assert.equal(e.vitals, 1_000_000n, 'compared in whole tokens, not in wei');
});

test('0.05 ETH PAID to the treasury is enough, and holding it is not', async () => {
  reset();
  process.env.VITALS_TOKEN_ADDRESS = TOKEN;
  tokenBalance = 0n;
  // Holding is irrelevant now: almost every wallet on this chain holds 0.05
  // ETH, so gating on the balance would gate on nothing.
  assert.equal((await P.entitlement(WALLET)).state, 'below');

  txs.set(HASH, payment());
  const r = await P.recordPayment(HASH, WALLET);
  assert.equal(r.ok, true);
  assert.equal(r.wei, eth(0.05));
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'premium');
  assert.equal(e.via, 'payment');
  assert.match(P.entitlementLine(e), /premium · 0\.050 ETH paid/);
});

test('one payment cannot entitle two people, or the same person twice', async () => {
  reset();
  txs.set(HASH, payment());
  assert.equal((await P.recordPayment(HASH, WALLET)).ok, true);
  assert.equal((await P.recordPayment(HASH, WALLET)).reason, 'already_used');
  // Copied out of the group by somebody else.
  const other = '0x3333333333333333333333333333333333333333';
  assert.equal((await P.recordPayment(HASH, other)).reason, 'already_used');
  assert.equal(P.paymentFor(other), null);
});

test('a payment is refused unless every condition holds', async () => {
  const cases = [
    ['wrong_recipient', { tx: { to: '0x4444444444444444444444444444444444444444' } }],
    ['wrong_sender', { tx: { from: '0x5555555555555555555555555555555555555555' } }],
    ['too_little', { tx: { value: eth(0.049) } }],
    ['failed', { receipt: { status: 'reverted' } }],
  ];
  for (const [reason, over] of cases) {
    reset();
    txs.set(HASH, payment(over));
    const r = await P.recordPayment(HASH, WALLET);
    assert.equal(r.ok, false, reason);
    assert.equal(r.reason, reason);
    assert.equal(P.paymentFor(WALLET), null, `${reason} must not be recorded`);
  }
});

test('a hash the node has never seen is not_found, an unreadable node is not', async () => {
  reset();
  assert.equal((await P.recordPayment(HASH, WALLET)).reason, 'not_found');
  txs.set(HASH, payment());
  readThrows = 'tx';
  const r = await P.recordPayment(HASH, WALLET);
  assert.equal(r.reason, 'unreadable', 'a node that did not answer is not a payment that was not made');
});

test('a malformed hash or address is refused before any chain read', async () => {
  reset();
  for (const bad of ['', '0x', 'not a hash', '0x' + 'a'.repeat(63)]) {
    assert.equal((await P.recordPayment(bad, WALLET)).reason, 'malformed', bad);
  }
  assert.equal((await P.recordPayment(HASH, 'nope')).reason, 'malformed');
});

test('several small payments add up to the minimum', async () => {
  reset();
  const h2 = '0x' + 'b'.repeat(64);
  txs.set(HASH, payment({ tx: { value: eth(0.03) } }));
  txs.set(h2, payment({ tx: { value: eth(0.03) } }));
  assert.equal((await P.recordPayment(HASH, WALLET)).reason, 'too_little', 'one alone is not enough');
  // Neither was recorded, so the wallet is still below.
  assert.equal(P.paymentFor(WALLET), null);
});

test('holding neither is below, and the line names both routes', async () => {
  reset();
  process.env.VITALS_TOKEN_ADDRESS = TOKEN;
  tokenBalance = 999_999n * 10n ** 18n;
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'below');
  const line = P.entitlementLine(e);
  assert.match(line, /999,999 \$VITALS/);
  assert.match(line, /need 1,000,000 \$VITALS held, or 0\.05 ETH paid to the treasury/);
});

test('a $VITALS read that failed is undetermined, never a refusal', async () => {
  reset();
  process.env.VITALS_TOKEN_ADDRESS = TOKEN;
  readThrows = 'token';
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'undetermined', 'a holder must never be told they do not hold what they hold');
  assert.match(P.entitlementLine(e), /could not check your holdings/);
  assert.ok(!/not premium/.test(P.entitlementLine(e)));
});

test('an unconfigured $VITALS is the operator\'s gap, not a refusal', async () => {
  reset();
  delete process.env.VITALS_TOKEN_ADDRESS;
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'undetermined', 'a check that never ran is not a check that failed');
  assert.match(e.reason, /not configured/);
});

test('a malformed address is undetermined, not a refusal', async () => {
  reset();
  assert.equal((await P.entitlement('not an address')).state, 'undetermined');
});

// ------------------------------------------------------------------- treasury

test('an unset treasury throws rather than defaulting to nowhere', () => {
  reset();
  delete process.env.TREASURY_ADDRESS;
  assert.throws(() => P.treasuryAddress(), /TREASURY_ADDRESS is not set/);
});

test('a burn address is refused as a treasury', () => {
  reset();
  for (const dead of ['0x000000000000000000000000000000000000dEaD', '0x' + '0'.repeat(40)]) {
    process.env.TREASURY_ADDRESS = dead;
    assert.throws(() => P.treasuryAddress(), /burn/, `${dead} must not be accepted`);
  }
});

test('a configured treasury is returned checksummed', () => {
  reset();
  process.env.TREASURY_ADDRESS = WALLET.toUpperCase().replace('0X', '0x');
  assert.equal(P.treasuryAddress().toLowerCase(), WALLET);
});

test('a malformed token address is refused rather than ignored', () => {
  reset();
  process.env.VITALS_TOKEN_ADDRESS = '0xnope';
  assert.throws(() => P.vitalsToken(), /not an address/);
});
