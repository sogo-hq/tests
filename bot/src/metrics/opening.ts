import type { Address } from 'viem';
import { client } from '../chain.js';
import { SnipeTaxCharged, SnipeTaxExempted, CurveBuy } from '../abi.js';
import { bulk } from '../ratelimit.js';

/**
 * What happened in the first three seconds of a launch.
 *
 * Every field here is read from the curve's own logs rather than inferred:
 *
 *  - the exemption list comes from SnipeTaxExempted, one per pre-exempted
 *    wallet, emitted inside the launch transaction. That is a better source
 *    than decoding the creation calldata, which is what leaves exemptions
 *    undetermined whenever a launch arrives through an entry point this build
 *    has no ABI for.
 *  - the opening tax total is the sum of SnipeTaxCharged over the whole curve.
 *    The event is self-terminating: measured at spans of 30, 40, 100, 600 and
 *    20,000 blocks past a launch, every span returned the same events, so no
 *    window arithmetic is needed and there is no off-by-one when a launch lands
 *    late in its second.
 *  - the creator's opening buy is CurveBuy.tokensOut matched on RECIPIENT, not
 *    buyer. On the forwarder path, which is most launches, the buyer is the
 *    forwarder and matching on it would report the creator bought nothing.
 */
export interface OpeningWindow {
  /** Wallets pre-exempted from the opening tax, from the launch transaction. */
  exemptWallets: string[];
  /** Tokens the deployer received in the opening window, and its share of supply. */
  creatorTokens: bigint;
  creatorSharePct: number | null;
  /** The same for every pre-exempted wallet together, the deployer included. */
  exemptTokens: bigint;
  exemptSharePct: number | null;
  /** Opening tax paid, in quote-token wei, and how many wallets paid it. */
  taxWei: bigint;
  taxPayers: number;
  /**
   * False when any read failed. A partial window is never presented as a
   * measurement: a tax total missing half its logs reads as a smaller number,
   * not as an error.
   */
  complete: boolean;
}

export interface OpeningInput {
  curve: string;
  deployer: string;
  totalSupply: bigint;
  fromBlock: bigint;
  toBlock?: bigint;
}

/**
 * How far past the launch block the opening window is read.
 *
 * Bounded rather than left at 'latest'. Blocks are 0.1s here, so 'latest' grows
 * by 600 blocks a minute and a self-scan delayed past about half an hour would
 * exceed the node's log-query limit and time out -- turning a measurement into
 * an undetermined, for no gain. Everything this reads lives in the first
 * seconds: SnipeTaxCharged is self-terminating inside 3 s, and the exemptions
 * and opening buys are emitted in the launch transaction itself. Sixty seconds
 * is generous cover for all of it.
 */
export const OPENING_WINDOW_BLOCKS = 600n;

export async function readOpeningWindow(input: OpeningInput): Promise<OpeningWindow | null> {
  const address = input.curve as Address;
  const fromBlock = input.fromBlock;
  const toBlock = input.toBlock ?? fromBlock + OPENING_WINDOW_BLOCKS;

  try {
    const [exempt, taxes, buys] = await Promise.all([
      bulk(() => client.getLogs({ address, event: SnipeTaxExempted, fromBlock, toBlock })),
      bulk(() => client.getLogs({ address, event: SnipeTaxCharged, fromBlock, toBlock })),
      bulk(() => client.getLogs({ address, event: CurveBuy, fromBlock, toBlock })),
    ]);

    const exemptWallets: string[] = [];
    for (const log of exempt) {
      const w = String((log.args as any).wallet ?? '').toLowerCase();
      if (w && !exemptWallets.includes(w)) exemptWallets.push(w);
    }

    let taxWei = 0n;
    const payers = new Set<string>();
    for (const log of taxes) {
      taxWei += BigInt((log.args as any).amount ?? 0n);
      payers.add(String((log.args as any).payer ?? '').toLowerCase());
    }

    const deployer = input.deployer.toLowerCase();
    const exemptSet = new Set(exemptWallets);
    let creatorTokens = 0n;
    let exemptTokens = 0n;
    for (const log of buys) {
      const recipient = String((log.args as any).recipient ?? '').toLowerCase();
      const out = BigInt((log.args as any).tokensOut ?? 0n);
      if (recipient === deployer) creatorTokens += out;
      if (exemptSet.has(recipient)) exemptTokens += out;
    }

    const pct = (n: bigint): number | null =>
      input.totalSupply > 0n ? Number((n * 1_000_000n) / input.totalSupply) / 10_000 : null;

    return {
      exemptWallets,
      creatorTokens,
      creatorSharePct: pct(creatorTokens),
      exemptTokens,
      exemptSharePct: pct(exemptTokens),
      taxWei,
      taxPayers: payers.size,
      complete: true,
    };
  } catch (err) {
    console.warn('[opening] window unreadable:', String((err as Error)?.message ?? err).slice(0, 160));
    return null;
  }
}

function amount(wei: bigint, decimals: number, dp = 3): string {
  return (Number(wei) / 10 ** decimals).toFixed(dp);
}

/**
 * The opening window as card lines.
 *
 * The exemption count is reported as measured, never as expected. A launch that
 * pre-exempts one wallet and a launch that pre-exempts five look identical
 * until this line, and the second one is the whole reason to look.
 */
export function openingLines(
  w: OpeningWindow | null,
  opts: { pairSymbol: string | null; pairDecimals: number },
): string[] {
  if (!w) return ['opening window: could not be read, undetermined'];
  const sym = opts.pairSymbol ?? 'the pair asset';
  const lines: string[] = [];

  const n = w.exemptWallets.length;
  if (n === 0) {
    lines.push('wallets exempt from the opening tax: none');
  } else if (n === 1) {
    lines.push('wallets exempt from the opening tax: 1, the dev wallet');
  } else {
    const share = w.exemptSharePct === null ? '' : `, together ${w.exemptSharePct.toFixed(2)}% of supply`;
    lines.push(`wallets exempt from the opening tax: ${n}${share}`);
  }

  lines.push(
    w.creatorSharePct === null
      ? 'creator opening buy: supply unknown, undetermined'
      : `creator opening buy: ${w.creatorSharePct.toFixed(2)}% of supply`,
  );

  lines.push(
    w.taxPayers === 0
      ? 'snipers paid nothing: no taxed buys in the opening window'
      : `snipers paid ${amount(w.taxWei, opts.pairDecimals)} ${sym} in tax, across ${w.taxPayers} wallet${w.taxPayers === 1 ? '' : 's'}`,
  );
  return lines;
}

/**
 * The opening tax policy, live from the factory.
 *
 * Measured today at 9,900 bps over 3 seconds, but never compiled in: a
 * hardcoded threshold keeps printing after the chain changes it, and the
 * standing rule here is that nothing is a fact about the chain unless it was
 * read. Cached briefly because it is the same answer for every launch.
 */
let policyCache: { at: number; value: { startBps: number; seconds: number } } | null = null;
const POLICY_TTL_MS = 600_000;

export async function snipeTaxPolicy(now = Date.now()): Promise<{ startBps: number; seconds: number } | null> {
  if (policyCache && now - policyCache.at < POLICY_TTL_MS) return policyCache.value;
  try {
    const { FACTORY } = await import('../config.js');
    const { factoryAbi } = await import('../abi.js');
    const [startBps, seconds] = await Promise.all([
      bulk(() => client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'snipeTaxStartBps' })),
      bulk(() => client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'snipeTaxSeconds' })),
    ]);
    const value = { startBps: Number(startBps), seconds: Number(seconds) };
    policyCache = { at: now, value };
    return value;
  } catch (err) {
    console.warn('[opening] tax policy unreadable:', String((err as Error)?.message ?? err).slice(0, 120));
    return null;
  }
}

/** For tests. */
export function resetPolicyCache(): void { policyCache = null; }
