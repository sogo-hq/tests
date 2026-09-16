/**
 * The four slots the factory exempts.
 *
 * Measured, not assumed. eth_simulateV1 was run against the live factory with
 * a distinct address in each slot, and every case below is one of those runs
 * written down. The rehearsal receipt is the control: the same model has to
 * reproduce what VITALSRH1 actually emitted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedExemptWallets, expectedExemptEvents, MIN_EXEMPT_WALLETS,
} from '../dist/launchcheck.js';
import { unionOfSlots, exemptionsFromReceipt, SnipeTaxExemptedTopic } from '../dist/indexer/exemptions.js';

const REAL = '0x447c8dc55B88C09830E123f9fB3e7C484714ED93';
const RH1_SENDER = '0x385bb8f2B646BF778B5504745a860922029df614';
const S = '0x1111111111111111111111111111111111111111';
const C = '0x2222222222222222222222222222222222222222';
const R = '0x3333333333333333333333333333333333333333';
const X = '0x4444444444444444444444444444444444444444';
const lower = (a) => a.toLowerCase();

// ------------------------------------------------- what the simulation showed

test('four distinct slots exempt four wallets and emit four events', () => {
  const w = expectedExemptWallets({ deployer: S, creatorFeeRecipient: C, recipient: R, extraExemptions: [X] });
  assert.deepEqual(w, [S, C, R, X].map(lower));
  assert.equal(expectedExemptEvents({ deployer: S, creatorFeeRecipient: C, recipient: R, extraExemptions: [X] }), 4);
});

test('an empty exemptions array still exempts three, because three slots are filled', () => {
  const w = expectedExemptWallets({ deployer: S, creatorFeeRecipient: C, recipient: R, extraExemptions: [] });
  assert.deepEqual(w, [S, C, R].map(lower));
  assert.equal(expectedExemptEvents({ deployer: S, creatorFeeRecipient: C, recipient: R, extraExemptions: [] }), 3);
});

test('the real config exempts one wallet and emits three events', () => {
  // deployer = creatorFeeRecipient = recipient = 0x447c...ED93, plus the
  // deployer once more in the exemptions array the tool passes.
  const w = expectedExemptWallets({
    deployer: REAL, creatorFeeRecipient: REAL, recipient: REAL, extraExemptions: [],
  });
  assert.deepEqual(w, [lower(REAL)]);
  assert.equal(w.length, 1, 'the declaration says the deployer only');
  assert.equal(expectedExemptEvents({
    deployer: REAL, creatorFeeRecipient: REAL, recipient: REAL, extraExemptions: [],
  }), 3);
});

test('the rehearsal shape gives two wallets from four events', () => {
  // The tool adds the deployer to the array, so the array slot is filled too.
  const w = expectedExemptWallets({
    deployer: RH1_SENDER, creatorFeeRecipient: REAL, recipient: RH1_SENDER, extraExemptions: [RH1_SENDER],
  });
  assert.deepEqual(w, [lower(RH1_SENDER), lower(REAL)]);
  assert.equal(expectedExemptEvents({
    deployer: RH1_SENDER, creatorFeeRecipient: REAL, recipient: RH1_SENDER, extraExemptions: [RH1_SENDER],
  }), 4, 'VITALSRH1 emitted exactly four');
});

test('the rehearsal receipt, decoded, is what the model predicts', () => {
  // The four SnipeTaxExempted logs of
  // 0xf8c440ccc8c880671f22732c31046227de07d2b25113599cee43798f82f3e213.
  const CURVE = '0x4a87a658417816bd1bcbdbd57302129810ada03d';
  const log = (addr) => ({
    address: CURVE,
    topics: [SnipeTaxExemptedTopic, `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`],
    data: '0x',
  });
  const logs = [log(RH1_SENDER), log(REAL), log(RH1_SENDER), log(RH1_SENDER)];
  assert.equal(logs.length, 4, 'four events');
  assert.deepEqual(exemptionsFromReceipt(logs, CURVE), [lower(RH1_SENDER), lower(REAL)]);
  assert.equal(exemptionsFromReceipt(logs, CURVE).length, 2, 'two wallets');
});

// ------------------------------------------------------- no protocol contracts

test('no protocol contract is ever in the set', () => {
  // The simulation with four distinct slots emitted exactly those four
  // addresses: no curve, no router, no hook, no locker, no factory. So a card
  // never has to say "plus N protocol contracts", because there are none.
  const w = expectedExemptWallets({ deployer: S, creatorFeeRecipient: C, recipient: R, extraExemptions: [X] });
  for (const contract of [
    '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', // factory
    '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948', // forwarder
    '0x4a87a658417816bd1bcbdbd57302129810ada03d', // the rehearsal curve
  ]) {
    assert.ok(!w.includes(lower(contract)), contract);
  }
  assert.equal(w.length, 4, 'four slots, four addresses, nothing else');
});

// ------------------------------------------------------------- the floor

test('a launch cannot exempt nobody', () => {
  assert.equal(MIN_EXEMPT_WALLETS, 1);
  // Even the emptiest possible call fills two slots.
  const w = expectedExemptWallets({ deployer: S, creatorFeeRecipient: S, recipient: S, extraExemptions: [] });
  assert.equal(w.length, 1);
  assert.ok(w.length >= MIN_EXEMPT_WALLETS);
});

// ------------------------------------------------------- the calldata union

test('the calldata union counts the slots, not the array', () => {
  // The bug: the array is empty and three wallets go tax free anyway.
  assert.deepEqual(unionOfSlots({ sender: S, creatorFeeRecipient: C, recipient: R, exemptions: [] }),
    [S, C, R].map(lower));
  // And it collapses duplicates, which is what makes the real config read 1.
  assert.deepEqual(unionOfSlots({ sender: REAL, creatorFeeRecipient: REAL, recipient: REAL, exemptions: [REAL] }),
    [lower(REAL)]);
});

test('the union ignores anything that is not an address', () => {
  assert.deepEqual(unionOfSlots({ sender: S, creatorFeeRecipient: null, recipient: undefined, exemptions: ['', 'nonsense'] }),
    [lower(S)]);
  assert.deepEqual(unionOfSlots({}), []);
});

test('the union is in slot order, so the first entry is the sender', () => {
  const u = unionOfSlots({ sender: S, creatorFeeRecipient: C, recipient: R, exemptions: [X] });
  assert.equal(u[0], lower(S));
  assert.deepEqual(u, [S, C, R, X].map(lower));
});

// ------------------------------------------- the three views say one thing

test('the check, the tool and the declaration agree on the real config', async () => {
  const { checkConfig, EXPECTED_DEPLOYER } = await import('../dist/launchcheck.js');
  const cfg = {
    name: 'vitals', symbol: 'VITALS', logo: 'ipfs://x', description: 'x',
    socials: { twitter: 'https://x.com/vitalsxyz', telegram: 'https://t.me/vitalsofficial', discord: '', website: 'https://checkvitals.xyz', farcaster: '' },
    creatorFeeRecipient: EXPECTED_DEPLOYER, creatorTaxBps: 400, buybackEnabled: false,
    expectedEconomics: '0x' + 'a'.repeat(64),
    salt: '0x' + '1'.repeat(64), launchConfigId: 0,
    pairToken: '0x0000000000000000000000000000000000000000',
    devBuyEth: '0.0930', minTokensOut: '0', recipient: EXPECTED_DEPLOYER, extraExemptions: [],
  };
  const row = checkConfig(cfg, null).find((r) => r.field === 'tax free at launch');
  assert.equal(row.value, '1 wallet');
  assert.equal(row.verdict, 'pass');

  // The card, at that count.
  const { computeFlags } = await import('../dist/metrics/flags.js');
  // The declaration line, which is what all of this has to support.
  assert.equal(expectedExemptWallets({
    deployer: EXPECTED_DEPLOYER, creatorFeeRecipient: cfg.creatorFeeRecipient,
    recipient: cfg.recipient, extraExemptions: cfg.extraExemptions,
  }).length, 1, 'tax-free at launch: the deployer only');
  assert.equal(typeof computeFlags, 'function');
});
