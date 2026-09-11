/**
 * Exemptions read from the curve's own events.
 *
 * Measured on chain 4663 before this was written:
 *  - SnipeTaxExempted(address indexed wallet): the parameter IS indexed, so the
 *    address is topics[1] and data is empty.
 *  - a launch that exempted five wallets emitted six logs, so the list
 *    de-duplicates.
 *  - calldata and logs disagreed on 61 of 64 cross-checked launches, and in
 *    19 of 19 inspected the extra wallet was the DEPLOYER: the curve exempts it
 *    automatically and never says so in the calldata.
 *  - across 160 sampled launches, 74 used a selector this build cannot decode
 *    (0xf955751f, 0x2931861b, 0xe9ae5c53, 0x34fcd5be and others) and all 74
 *    got a definite count from the events.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('exemption-logs');
const E = await import('../dist/indexer/exemptions.js');

const CURVE = '0x88a06c9c7a610ebe15ade18a8287131613bc448a';
const pad = (addr) => `0x${'0'.repeat(24)}${addr.slice(2)}`;
const W = (n) => '0x' + String(n).repeat(40).slice(0, 40);
const log = (wallet, address = CURVE) => ({
  address,
  topics: [E.SnipeTaxExemptedTopic, pad(wallet)],
  data: '0x',
});

test('the topic is the one the chain emits', () => {
  assert.equal(E.SnipeTaxExemptedTopic,
    '0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7');
});

test('wallets come out of topics[1], de-duplicated', () => {
  // Six logs, five wallets, exactly as the measured launch emitted.
  const logs = [log(W(1)), log(W(2)), log(W(3)), log(W(4)), log(W(5)), log(W(1))];
  assert.deepEqual(E.exemptionsFromReceipt(logs, CURVE), [W(1), W(2), W(3), W(4), W(5)]);
});

test('a receipt with no exemption events is a measured zero', () => {
  const other = [{ address: CURVE, topics: ['0xdeadbeef'], data: '0x' }];
  assert.deepEqual(E.exemptionsFromReceipt(other, CURVE), [],
    'the curve emits one per exemption, so none emitted is none granted');
});

test('logs from another contract in the same transaction are ignored', () => {
  const logs = [log(W(1), CURVE), log(W(2), '0x' + 'a'.repeat(40))];
  assert.deepEqual(E.exemptionsFromReceipt(logs, CURVE), [W(1)]);
  // Without a curve to scope to, everything shaped like the event counts:
  // only this launch's curve emits it in this transaction.
  assert.equal(E.exemptionsFromReceipt(logs).length, 2);
});

test('a malformed topic is skipped rather than read as an address', () => {
  const logs = [
    { address: CURVE, topics: [E.SnipeTaxExemptedTopic], data: '0x' },
    { address: CURVE, topics: [E.SnipeTaxExemptedTopic, '0x1234'], data: '0x' },
    log(W(7)),
  ];
  assert.deepEqual(E.exemptionsFromReceipt(logs, CURVE), [W(7)]);
});

test('the count is the number of wallets, not the number of events', () => {
  const logs = Array.from({ length: 32 }, (_, i) => log(W((i % 9) + 1)));
  assert.equal(E.exemptionsFromReceipt(logs, CURVE).length, 9);
});
