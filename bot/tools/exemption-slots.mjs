#!/usr/bin/env node
/**
 * Which launch parameter produces which SnipeTaxExempted event.
 *
 * Run when the config-vs-chain diff disagrees about exemptions, or before
 * trusting any figure built on the exemption count. Simulated through
 * eth_simulateV1, which returns logs, so every case is the real factory on the
 * real chain state and nothing is signed or sent.
 *
 *   node tools/exemption-slots.mjs
 *
 * What it established, on 2026-09-16 against VITALSRH1:
 *
 *   The factory exempts FOUR slots, each emitting one event: the transaction
 *   sender, the creatorFeeRecipient, the opening-buy recipient, and every
 *   entry of the exemptions array. Duplicates are emitted, not collapsed, so
 *   the event count is the number of slots filled and the wallet count is the
 *   size of the union. No protocol contract appears: no curve, no router, no
 *   hook, no locker, no factory.
 *
 *   VITALSRH1 emitted 4 events for 2 wallets. The real config, where the
 *   deployer is also the fee recipient and the buy recipient, emits 3 events
 *   for 1 wallet.
 */
import { encodeFunctionData, getAddress } from 'viem';
const { client } = await import('../dist/chain.js');
const { factoryAbi, forwarderAbi } = await import('../dist/abi.js');
const { FACTORY, LAUNCH_FORWARDER, RPC_URL } = await import('../dist/config.js');

const TOPIC = '0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7';
const REAL = getAddress('0x447c8dc55B88C09830E123f9fB3e7C484714ED93');
// Four addresses that cannot be confused with each other or with anything real.
const S = getAddress('0x1111111111111111111111111111111111111111'); // sender
const C = getAddress('0x2222222222222222222222222222222222222222'); // creatorFeeRecipient
const R = getAddress('0x3333333333333333333333333333333333333333'); // recipient
const X = getAddress('0x4444444444444444444444444444444444444444'); // exemptions[0]
const LABEL = { [S.toLowerCase()]: 'S sender', [C.toLowerCase()]: 'C creatorFeeRecipient',
  [R.toLowerCase()]: 'R recipient', [X.toLowerCase()]: 'X exemptions[0]',
  [REAL.toLowerCase()]: 'REAL 0x447c...ED93' };

const launchFee = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'launchFee' });
const DEV_BUY = 10n ** 15n; // 0.001 ETH, the rehearsal size

const rpc = async (method, params) => {
  const r = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

const hex = (n) => '0x' + n.toString(16);

async function run(name, { sender, creatorFeeRecipient, recipient, exemptions, salt }) {
  const params = {
    name: 'probe', symbol: 'PROBE', logo: 'ipfs://probe', description: 'probe',
    socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    creatorFeeRecipient, creatorTaxBps: 400, buybackEnabled: false,
    expectedEconomics: '0xa9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca7',
    salt,
  };
  const data = encodeFunctionData({
    abi: forwarderAbi, functionName: 'launchAndBuy',
    args: [params, 0n, '0x0000000000000000000000000000000000000000', DEV_BUY, 0n, recipient, exemptions],
  });
  const value = launchFee + DEV_BUY;
  const res = await rpc('eth_simulateV1', [{
    blockStateCalls: [{
      stateOverrides: { [sender]: { balance: hex(value + 10n ** 18n) } },
      calls: [{ from: sender, to: LAUNCH_FORWARDER, data, value: hex(value) }],
    }],
    traceTransfers: false,
    validation: false,
  }, 'latest']);

  const call = res[0].calls[0];
  if (call.status !== '0x1') {
    console.log(`\n${name}\n  REVERTED: ${JSON.stringify(call.error ?? call.returnData).slice(0, 140)}`);
    return null;
  }
  const events = (call.logs ?? []).filter((l) => l.topics?.[0] === TOPIC)
    .map((l) => '0x' + l.topics[1].slice(26));
  const distinct = [...new Set(events)];
  console.log(`\n${name}`);
  console.log(`  events   ${events.length}`);
  console.log(`  distinct ${distinct.length}`);
  for (const d of distinct) {
    const n = events.filter((e) => e === d).length;
    console.log(`    ${getAddress(d)}  x${n}  ${LABEL[d] ?? 'UNKNOWN'}`);
  }
  return { events, distinct };
}

const salt = (n) => '0x' + n.toString(16).padStart(64, '0');

await run('1. four distinct slots: sender S, creator C, recipient R, exemptions [X]',
  { sender: S, creatorFeeRecipient: C, recipient: R, exemptions: [X], salt: salt(1) });

await run('2. empty exemptions array, three distinct slots',
  { sender: S, creatorFeeRecipient: C, recipient: R, exemptions: [], salt: salt(2) });

await run('3. the REAL config: deployer = creatorFeeRecipient = recipient, exemptions [REAL]',
  { sender: REAL, creatorFeeRecipient: REAL, recipient: REAL, exemptions: [REAL], salt: salt(3) });

await run('4. the REAL config with an empty exemptions array',
  { sender: REAL, creatorFeeRecipient: REAL, recipient: REAL, exemptions: [], salt: salt(4) });

await run('5. the rehearsal shape: sender S, creator REAL, recipient S, exemptions [S]',
  { sender: S, creatorFeeRecipient: REAL, recipient: S, exemptions: [S], salt: salt(5) });
