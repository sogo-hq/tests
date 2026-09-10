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

process.env.DB_PATH = process.env.DB_PATH || `/tmp/vitals-premium-${process.pid}.db`;
const { client } = await import('../dist/chain.js');

const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const eth = (n) => BigInt(Math.round(n * 1e18));

let ethBalance = 0n;
let tokenBalance = 0n;
let readThrows = null;
client.getBalance = async () => {
  if (readThrows === 'eth') throw new Error('rpc down');
  return ethBalance;
};
client.readContract = async ({ functionName }) => {
  if (readThrows === 'token') throw new Error('rpc down');
  if (functionName === 'decimals') return 18;
  if (functionName === 'balanceOf') return tokenBalance;
  throw new Error(`unexpected read: ${functionName}`);
};

const P = await import('../dist/premium.js');

const reset = () => {
  ethBalance = 0n;
  tokenBalance = 0n;
  readThrows = null;
  delete process.env.VITALS_TOKEN_ADDRESS;
  delete process.env.TREASURY_ADDRESS;
};

test('0.05 ETH is enough on its own', async () => {
  reset();
  ethBalance = eth(0.05);
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'premium');
  assert.equal(e.via, 'eth');
});

test('1M $VITALS is enough on its own', async () => {
  reset();
  process.env.VITALS_TOKEN_ADDRESS = TOKEN;
  ethBalance = eth(0.001);
  tokenBalance = 1_000_000n * 10n ** 18n;
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'premium');
  assert.equal(e.via, 'vitals');
  assert.equal(e.vitals, 1_000_000n, 'compared in whole tokens, not in wei');
});

test('holding neither is below, and the line names both thresholds', async () => {
  reset();
  process.env.VITALS_TOKEN_ADDRESS = TOKEN;
  ethBalance = eth(0.004);
  tokenBalance = 999_999n * 10n ** 18n;
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'below');
  const line = P.entitlementLine(e);
  assert.match(line, /999,999 \$VITALS/);
  assert.match(line, /need 1,000,000 \$VITALS or 0\.05 ETH/);
});

test('a read that failed is undetermined, never a refusal', async () => {
  reset();
  readThrows = 'eth';
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'undetermined', 'a holder must never be told they do not hold what they hold');
  assert.match(P.entitlementLine(e), /could not check your holdings/);
  assert.ok(!/not premium/.test(P.entitlementLine(e)));
});

test('a $VITALS read that failed is undetermined too', async () => {
  reset();
  process.env.VITALS_TOKEN_ADDRESS = TOKEN;
  ethBalance = eth(0.001);
  readThrows = 'token';
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'undetermined');
});

test('with no token configured the ETH answer still stands', async () => {
  reset();
  ethBalance = eth(0.001);
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'below', 'a real measurement, not an unconfigured one');
  assert.equal(e.vitals, null);
});

test('ETH is checked before the token, so an unset token never blocks a holder', async () => {
  reset();
  ethBalance = eth(1);
  const e = await P.entitlement(WALLET);
  assert.equal(e.state, 'premium');
  assert.equal(e.via, 'eth');
});

test('a malformed address is undetermined, not a refusal', async () => {
  reset();
  assert.equal((await P.entitlement('not an address')).state, 'undetermined');
});

// ------------------------------------------------------------------- treasury

test('an unset treasury throws rather than defaulting to nowhere', () => {
  reset();
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
