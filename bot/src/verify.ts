import { getAddress } from 'viem';
import { client, getLogsAdaptive } from './chain.js';
import { factoryAbi, buybackVaultAbi, TokenLaunched } from './abi.js';
import {
  RPC_URL, EXPLORER_URL, CHAIN_ID, CHAIN_ID_HEX,
  FACTORY, MEME_HOOK, FEE_ESCROW, BUYBACK_VAULT, LAUNCH_LOCKER, LAUNCH_FORWARDER,
} from './config.js';

type Check = { name: string; ok: boolean; detail: string; advisory?: boolean };

/**
 * Re-assert every fact the bot depends on, against the live chain.
 *
 * Worth running before trusting a deployment: the addresses in the original
 * brief did not all match the chain, and this is what caught it.
 */
export async function verify(): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, advisory = false) =>
    checks.push({ name, ok, detail, advisory });

  // a) explorer reachable
  try {
    const t0 = Date.now();
    const res = await fetch(`${EXPLORER_URL}/api/v2/stats`);
    const j: any = await res.json();
    add(
      'explorer /api/v2/stats',
      res.ok,
      `HTTP ${res.status} in ${Date.now() - t0}ms, ${j?.total_blocks ?? '?'} blocks indexed`,
      true,
    );
  } catch (e: any) {
    add('explorer /api/v2/stats', false, String(e?.message ?? e), true);
  }

  // b) chain id
  try {
    const id = await client.getChainId();
    add('eth_chainId', id === CHAIN_ID, `${id} (0x${id.toString(16)}), expected ${CHAIN_ID} (${CHAIN_ID_HEX})`);
  } catch (e: any) {
    add('eth_chainId', false, String(e?.message ?? e));
  }

  // factory has code
  try {
    const code = await client.getCode({ address: FACTORY });
    const size = code ? (code.length - 2) / 2 : 0;
    add('factory has code', size > 0, `${FACTORY} -> ${size} bytes`);
  } catch (e: any) {
    add('factory has code', false, String(e?.message ?? e));
  }

  // every address cross-checked against the factory's own getters
  const expected: [string, 'memeHook' | 'locker' | 'buybackVault' | 'feeEscrow' | 'launchForwarder', string][] = [
    ['meme hook', 'memeHook', MEME_HOOK],
    ['launch locker', 'locker', LAUNCH_LOCKER],
    ['buyback vault', 'buybackVault', BUYBACK_VAULT],
    ['fee escrow', 'feeEscrow', FEE_ESCROW],
    ['launch forwarder', 'launchForwarder', LAUNCH_FORWARDER],
  ];
  for (const [label, fn, want] of expected) {
    try {
      const got = (await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: fn })) as string;
      const ok = getAddress(got) === getAddress(want);
      add(`${label} == factory.${fn}()`, ok, ok ? got : `chain says ${got}, config says ${want}`);
    } catch (e: any) {
      add(`${label} == factory.${fn}()`, false, String(e?.shortMessage ?? e?.message ?? e));
    }
  }

  // the vault agrees on which factory it belongs to -- this is the check that
  // originally exposed the wrong factory address
  try {
    const f = (await client.readContract({ address: BUYBACK_VAULT, abi: buybackVaultAbi, functionName: 'factory' })) as string;
    const ok = getAddress(f) === getAddress(FACTORY);
    add('buybackVault.factory() == factory', ok, ok ? f : `vault says ${f}, config says ${FACTORY}`);
  } catch (e: any) {
    add('buybackVault.factory() == factory', false, String(e?.shortMessage ?? e?.message ?? e));
  }

  // 5-year vest, as the buyback signal claims
  try {
    const d = (await client.readContract({ address: BUYBACK_VAULT, abi: buybackVaultAbi, functionName: 'VESTING_DURATION' })) as bigint;
    const years = Number(d) / (365 * 24 * 3600);
    add('vault VESTING_DURATION ~5y', Math.abs(years - 5) < 0.05, `${d}s = ${years.toFixed(2)} years`);
  } catch (e: any) {
    add('vault VESTING_DURATION ~5y', false, String(e?.shortMessage ?? e?.message ?? e));
  }

  // c) TokenLaunched readable
  try {
    const head = await client.getBlockNumber();
    const t0 = Date.now();
    const logs = await getLogsAdaptive({ address: FACTORY, event: TokenLaunched, fromBlock: head - 1000n, toBlock: head });
    add('eth_getLogs TokenLaunched (1000 blocks)', true, `${logs.length} launches in ${Date.now() - t0}ms`);

    // d) getLaunchedToken against a token we just saw launch
    if (logs.length) {
      const token = logs[logs.length - 1].args.token as `0x${string}`;
      const info: any = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getLaunchedToken', args: [token] });
      add('getLaunchedToken(known token)', Boolean(info?.exists), `${token} exists=${info?.exists} phase=${info?.phase} curve=${info?.curve}`);
    } else {
      add('getLaunchedToken(known token)', false, 'no launches in the last 1000 blocks to test against');
    }
  } catch (e: any) {
    add('eth_getLogs TokenLaunched (1000 blocks)', false, String(e?.shortMessage ?? e?.message ?? e));
  }

  // The explorer is advisory only: it is flaky (intermittent 500s) and no hot
  // path depends on it. Every scan-critical fact comes from the RPC.
  return { checks, ok: checks.every((c) => c.ok || c.advisory) };
}

export async function printVerify(): Promise<boolean> {
  console.log(`RPC      ${RPC_URL}`);
  console.log(`Explorer ${EXPLORER_URL}\n`);
  const { checks, ok } = await verify();
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const tag = c.ok ? 'PASS' : c.advisory ? 'WARN' : 'FAIL';
    console.log(`  ${tag}  ${c.name.padEnd(w)}  ${c.detail}`);
  }
  const warned = checks.filter((c) => !c.ok && c.advisory).length;
  if (ok) {
    console.log(`\nAll scan-critical checks passed${warned ? ` (${warned} advisory warning${warned === 1 ? '' : 's'} — explorer only, no hot path depends on it)` : ''}.`);
  } else {
    console.log('\nSOME CHECKS FAILED — do not trust scans until resolved.');
  }
  return ok;
}
