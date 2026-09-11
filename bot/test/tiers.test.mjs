/**
 * Tiers and ownership.
 *
 * Two rules carry the weight here. A threshold can only ever go down, because
 * one that can go up takes away access people bought in order to have. And a
 * balance that could not be read is undetermined, never "you do not hold
 * enough": the second is a claim about somebody's wallet made from nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('tiers');
const { db } = await import('../dist/db.js');
const { client } = await import('../dist/chain.js');

const TOKEN = '0x2222222222222222222222222222222222222222';
let balances = new Map();
let readThrows = false;
client.readContract = async ({ functionName, args }) => {
  if (readThrows) throw new Error('rpc down');
  if (functionName === 'decimals') return 18;
  if (functionName === 'balanceOf') return (balances.get(String(args[0]).toLowerCase()) ?? 0n) * 10n ** 18n;
  throw new Error(`unexpected ${functionName}`);
};

const T = await import('../dist/tiers.js');
const H = await import('../dist/holder.js');
const R = await import('../dist/ready.js');

const acct = privateKeyToAccount('0x' + '11'.repeat(32));
const WALLET = acct.address.toLowerCase();

const reset = () => {
  db.prepare('DELETE FROM ready_settings').run();
  db.prepare('DELETE FROM holder_links').run();
  db.prepare('DELETE FROM holder_nonces').run();
  db.prepare('DELETE FROM tier_grants').run();
  balances = new Map();
  readThrows = false;
  T.resetBalanceCache();
  T.setVitalsToken(TOKEN);
};

// ------------------------------------------------------------------ 3.1 tiers

test('the default thresholds are the ones the spec names', () => {
  reset();
  assert.deepEqual(T.thresholds(), { watch: 250_000n, premium: 1_000_000n, desk: 10_000_000n });
});

test('a balance resolves to the right tier at every boundary', () => {
  reset();
  const at = (n) => T.tierForBalance(BigInt(n));
  assert.equal(at(0), 'none');
  assert.equal(at(249_999), 'none');
  assert.equal(at(250_000), 'watch');
  assert.equal(at(999_999), 'watch');
  assert.equal(at(1_000_000), 'premium');
  assert.equal(at(9_999_999), 'premium');
  assert.equal(at(10_000_000), 'desk');
  assert.equal(at(50_000_000), 'desk');
});

test('a threshold can be lowered and never raised', () => {
  reset();
  const down = T.setThreshold('premium', '800000');
  assert.equal(down.ok, true);
  assert.equal(down.from, 1_000_000n);
  assert.equal(down.to, 800_000n);
  assert.equal(T.thresholds().premium, 800_000n);

  const up = T.setThreshold('premium', '900000');
  assert.equal(up.ok, false);
  assert.equal(up.reason, 'raise', 'a threshold that can go up takes away access people bought');
  assert.equal(up.current, 800_000n);
  assert.equal(T.thresholds().premium, 800_000n, 'and it did not move');

  // Back to the same value is not a raise.
  assert.equal(T.setThreshold('premium', '800000').ok, true);
});

test('thresholds accept the way people write big numbers', () => {
  reset();
  assert.equal(T.setThreshold('watch', '200,000').ok, true);
  assert.equal(T.thresholds().watch, 200_000n);
  assert.equal(T.setThreshold('watch', '100_000').ok, true);
  assert.equal(T.thresholds().watch, 100_000n);
  assert.equal(T.setThreshold('watch', 'lots').reason, 'not-a-number');
  assert.equal(T.setThreshold('nope', '1').reason, 'unknown-tier');
});

test('the balance is cached for ten minutes and re-read after', async () => {
  reset();
  let calls = 0;
  const real = client.readContract;
  client.readContract = async (a) => { calls++; return real(a); };
  balances.set(WALLET, 500_000n);
  const t0 = Date.now();
  assert.equal(await T.vitalsBalance(WALLET, t0), 500_000n);
  const first = calls;
  assert.equal(await T.vitalsBalance(WALLET, t0 + 60_000), 500_000n);
  assert.equal(calls, first, 'inside the window, no chain read');
  balances.set(WALLET, 2_000_000n);
  assert.equal(await T.vitalsBalance(WALLET, t0 + 11 * 60_000), 2_000_000n, 'and it re-reads after');
  client.readContract = real;
});

test('a balance that could not be read is null, never zero', async () => {
  reset();
  readThrows = true;
  assert.equal(await T.vitalsBalance(WALLET), null);
  assert.notEqual(await T.vitalsBalance(WALLET), 0n);
});

test('changing the token clears the cached balances', async () => {
  reset();
  balances.set(WALLET, 5_000_000n);
  assert.equal(await T.vitalsBalance(WALLET), 5_000_000n);
  T.setVitalsToken('0x3333333333333333333333333333333333333333');
  balances.set(WALLET, 1n);
  assert.equal(await T.vitalsBalance(WALLET), 1n, 'a new token is a new balance, not the old cache');
});

// ------------------------------------------------------------ 3.2 ownership

test('a wallet is linked by recovering the signer, not by being named', async () => {
  reset();
  const nonce = H.issueNonce(7);
  const sig = await acct.signMessage({ message: H.linkMessage(nonce) });
  const res = await H.linkBySignature(7, sig);
  assert.equal(res.ok, true);
  assert.equal(res.wallet, WALLET);
  assert.equal(res.method, 'signature');
  assert.equal(T.linkedWallet(7), WALLET);
});

test('a signature over a different challenge does not link this user', async () => {
  reset();
  H.issueNonce(7);
  // Signed for somebody else's nonce, or an old one.
  const sig = await acct.signMessage({ message: H.linkMessage('deadbeefdeadbeef') });
  const res = await H.linkBySignature(7, sig);
  // It recovers SOME address, just not one the user controls for this nonce.
  assert.notEqual(res.ok && res.wallet, WALLET);
});

test('the challenge expires, and a new one retires the old', async () => {
  reset();
  const nonce = H.issueNonce(7, Date.now() - 20 * 60_000);
  assert.equal(H.nonceOf(7), null, 'fifteen minutes and it is gone');
  const sig = await acct.signMessage({ message: H.linkMessage(nonce) });
  assert.equal((await H.linkBySignature(7, sig)).reason, 'no-nonce');

  const fresh = H.issueNonce(7);
  assert.notEqual(fresh, nonce);
  assert.equal(H.nonceOf(7), fresh);
});

test('a malformed signature is refused before any recovery', async () => {
  reset();
  H.issueNonce(7);
  for (const bad of ['', '0x', 'not a signature', '0x' + 'a'.repeat(129)]) {
    assert.equal((await H.linkBySignature(7, bad)).reason, 'malformed', bad);
  }
});

test('one wallet cannot be linked by two people', async () => {
  reset();
  const n1 = H.issueNonce(7);
  await H.linkBySignature(7, await acct.signMessage({ message: H.linkMessage(n1) }));
  const n2 = H.issueNonce(8);
  const res = await H.linkBySignature(8, await acct.signMessage({ message: H.linkMessage(n2) }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'taken', "one whale's balance must not grant a tier to everybody who can show a signature for it");
  assert.equal(T.linkedWallet(8), null);
});

test('relinking the same wallet to the same user is fine', async () => {
  reset();
  const n1 = H.issueNonce(7);
  await H.linkBySignature(7, await acct.signMessage({ message: H.linkMessage(n1) }));
  const n2 = H.issueNonce(7);
  assert.equal((await H.linkBySignature(7, await acct.signMessage({ message: H.linkMessage(n2) }))).ok, true);
});

test('the transfer fallback needs the challenge in the calldata, not just the amount', () => {
  const nonce = 'a1b2c3d4e5f60718';
  assert.equal(H.carriesNonce(`0x${nonce}`, nonce), true, 'raw hex');
  assert.equal(H.carriesNonce('0x' + Buffer.from(nonce, 'utf8').toString('hex'), nonce), true, 'utf-8 bytes');
  assert.equal(H.carriesNonce('0x', nonce), false, 'anybody can send 0.0001 ETH');
  assert.equal(H.carriesNonce('0xdeadbeef', nonce), false);
});

// --------------------------------------------------------------- resolution

const link = async (userId) => {
  const n = H.issueNonce(userId);
  return H.linkBySignature(userId, await acct.signMessage({ message: H.linkMessage(n) }));
};

test('an unlinked user has no tier, and that is not a refusal', async () => {
  reset();
  balances.set(WALLET, 50_000_000n);
  const r = await T.tierOf(7);
  assert.equal(r.state, 'unlinked', 'holding is not enough: ownership has to be proven');
});

test('a linked holder gets the tier their balance earns', async () => {
  reset();
  await link(7);
  for (const [held, want] of [[0n, 'none'], [250_000n, 'watch'], [1_000_000n, 'premium'], [10_000_000n, 'desk']]) {
    balances.set(WALLET, held);
    T.resetBalanceCache();
    const r = await T.tierOf(7);
    assert.equal(r.state, 'ok');
    assert.equal(r.tier, want, `${held} should be ${want}`);
    assert.equal(r.via, 'balance');
  }
});

test('a wallet an admin added through /ready add confers nothing on its own', async () => {
  reset();
  balances.set(WALLET, 50_000_000n);
  // The ready register answers a different question: who the team believes is
  // ready. A tier is a key.
  const { client: c } = await import('../dist/chain.js');
  c.getCode = async () => '0x';
  c.getBalance = async () => 10n ** 18n;
  await R.addExternal(WALLET, 'a whale we know');
  const r = await T.tierOf(7);
  assert.equal(r.state, 'unlinked');
});

test('a balance that could not be read is undetermined, not tier none', async () => {
  reset();
  await link(7);
  readThrows = true;
  T.resetBalanceCache();
  const r = await T.tierOf(7);
  assert.equal(r.state, 'undetermined');
  assert.match(r.reason, /could not be read/);
});

test('an unconfigured token is undetermined too', async () => {
  reset();
  await link(7);
  R.setSetting('vitals_token', '');
  delete process.env.VITALS_TOKEN_ADDRESS;
  const r = await T.tierOf(7);
  assert.equal(r.state, 'undetermined');
  assert.match(r.reason, /not configured/);
});

// ------------------------------------------------------------------- grants

test('a grant confers a tier without a balance, and expires', async () => {
  reset();
  const t0 = Date.now();
  T.grant(9, 'premium', 30, 'payment', t0);
  let r = await T.tierOf(9, t0);
  assert.equal(r.tier, 'premium');
  assert.equal(r.via, 'grant');
  assert.ok(Math.abs(r.grantUntil - (t0 + 30 * 86_400_000)) < 1000);

  r = await T.tierOf(9, t0 + 29 * 86_400_000);
  assert.equal(r.tier, 'premium', 'still inside the month');
  r = await T.tierOf(9, t0 + 31 * 86_400_000);
  assert.equal(r.state, 'unlinked', 'and gone after it, with no wallet linked');
});

test('paying twice buys two months rather than resetting the clock', () => {
  reset();
  const t0 = Date.now();
  T.grant(9, 'premium', 30, 'payment', t0);
  const second = T.grant(9, 'premium', 30, 'payment', t0 + 5 * 86_400_000);
  assert.ok(Math.abs(second.expiresAt - (t0 + 60 * 86_400_000)) < 1000,
    'the first month is not taken back by the second payment');
});

test('the higher of balance and grant wins, in both directions', async () => {
  reset();
  await link(7);
  const t0 = Date.now();

  // Paid for premium, then bought DESK worth of tokens.
  T.grant(7, 'premium', 30, 'payment', t0);
  balances.set(WALLET, 10_000_000n);
  T.resetBalanceCache();
  let r = await T.tierOf(7, t0);
  assert.equal(r.tier, 'desk');
  assert.equal(r.via, 'balance');

  // Sold down below premium, but the month is paid for.
  balances.set(WALLET, 300_000n);
  T.resetBalanceCache();
  r = await T.tierOf(7, t0);
  assert.equal(r.tier, 'premium');
  assert.equal(r.via, 'grant');
});

test('a downgrade is silent: the tier simply changes', async () => {
  reset();
  await link(7);
  balances.set(WALLET, 1_000_000n);
  assert.equal((await T.tierOf(7)).tier, 'premium');
  balances.set(WALLET, 10n);
  T.resetBalanceCache();
  assert.equal((await T.tierOf(7)).tier, 'none', 'no announcement, no message, just the next answer');
});

test('atLeast orders the tiers', () => {
  assert.equal(T.atLeast('desk', 'premium'), true);
  assert.equal(T.atLeast('premium', 'premium'), true);
  assert.equal(T.atLeast('watch', 'premium'), false);
  assert.equal(T.atLeast('none', 'watch'), false);
});
