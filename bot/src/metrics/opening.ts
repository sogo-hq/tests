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
   * Whether this window is a measurement at all.
   *
   * False when a read failed -- a tax total missing half its logs reads as a
   * smaller number, not as an error -- and false when the window did not cover
   * the launch it was supposed to. Those look identical from inside: three
   * getLogs calls over the wrong forty blocks succeed and return nothing, and
   * every figure below comes out zero.
   *
   * Measured: reading CHIPPER's window a hundred blocks late returned no
   * exemptions, no tax and a 0.00% creator buy for a launch that exempted nine
   * wallets holding 17.4% of supply. So a zero here is only a zero once
   * something independent says the window was in the right place.
   */
  complete: boolean;
}

export interface OpeningInput {
  curve: string;
  deployer: string;
  totalSupply: bigint;
  fromBlock: bigint;
  toBlock?: bigint;
  /**
   * What the launch receipt independently established, for corroboration.
   *
   * The receipt is decoded from the launch transaction, so it cannot be in the
   * wrong place: if it says this launch exempted N wallets and the window sees
   * none of them, the window is not looking at the launch. Undefined means
   * there is nothing to check against, and the window is then trusted only when
   * its block was read rather than estimated -- which is the caller's business,
   * not this function's.
   */
  expectExemptions?: number | null;

  /**
   * Queue behind background work.
   *
   * Off by default, and that is the point: this read backs a post with a
   * deadline, made five minutes after a launch, which is the exact moment group
   * scan traffic peaks. At bulk priority the limiter refuses a token while any
   * interactive request is queued or was served in the last second, so the
   * flagship post would render "undetermined" precisely when it matters and
   * never when it is being tested.
   */
  background?: boolean;
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

/**
 * How far the CREATOR'S OPENING BUY is read, which is not the same window.
 *
 * SnipeTaxCharged is self-terminating and SnipeTaxExempted is emitted in the
 * launch transaction, so any window at least as wide as the real one gives the
 * same answer for those. CurveBuy is not bounded at all: the curve emits one on
 * every buy for the rest of its life, so reading it over sixty seconds summed a
 * minute of ordinary trading into a number labelled "opening buy". Forty blocks
 * is four seconds, a second of margin past the three the factory charges tax
 * for, which is the window in which being pre-exempted means anything.
 */
export const OPENING_BUY_BLOCKS = 40n;

export async function readOpeningWindow(input: OpeningInput): Promise<OpeningWindow | null> {
  const address = input.curve as Address;
  const fromBlock = input.fromBlock;
  const toBlock = input.toBlock ?? fromBlock + OPENING_WINDOW_BLOCKS;
  const buyTo = input.toBlock ?? fromBlock + OPENING_BUY_BLOCKS;
  const q = <T>(fn: () => Promise<T>): Promise<T> => (input.background ? bulk(fn) : fn());

  try {
    const [exempt, taxes, buys] = await Promise.all([
      q(() => client.getLogs({ address, event: SnipeTaxExempted, fromBlock, toBlock })),
      q(() => client.getLogs({ address, event: SnipeTaxCharged, fromBlock, toBlock })),
      q(() => client.getLogs({ address, event: CurveBuy, fromBlock, toBlock: buyTo })),
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

    /**
     * Did this window actually cover the launch?
     *
     * The one check available from here: the receipt already counted the
     * exemptions, and the curve emits every one of them in the launch
     * transaction, which is the first block of this window. A receipt saying
     * nine and a window seeing zero is not a launch that changed its mind, it
     * is forty blocks read somewhere else.
     */
    const expected = input.expectExemptions;
    const missedTheLaunch = expected !== undefined && expected !== null
      && expected > 0 && exemptWallets.length === 0;
    if (missedTheLaunch) {
      console.warn(
        `[opening] window at ${fromBlock} saw no exemptions where the receipt counted ${expected}; `
        + 'reporting undetermined rather than zero',
      );
    }

    return {
      exemptWallets,
      creatorTokens,
      creatorSharePct: pct(creatorTokens),
      exemptTokens,
      exemptSharePct: pct(exemptTokens),
      taxWei,
      taxPayers: payers.size,
      complete: !missedTheLaunch,
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
  opts: { pairSymbol: string | null; pairDecimals: number; deployer?: string },
): string[] {
  if (!w) return ['opening window: could not be read, undetermined'];
  const sym = opts.pairSymbol ?? 'the pair asset';
  const lines: string[] = [];

  const n = w.exemptWallets.length;
  const share = w.exemptSharePct === null ? '' : `, ${n === 1 ? '' : 'together '}${w.exemptSharePct.toFixed(2)}% of supply`;
  if (n === 0) {
    lines.push('wallets exempt from the opening tax: none');
  } else if (n === 1) {
    // WHICH wallet, checked rather than assumed. "1, the dev wallet" was a
    // claim about who held the exemption that nothing had measured, on a
    // function holding both the list and the deployer. One exemption that is
    // not the deployer's is a more interesting fact than one that is, and it
    // was the only branch that printed no share at all.
    const who = w.exemptWallets[0] === opts.deployer?.toLowerCase() ? 'the deployer' : 'not the deployer';
    lines.push(`wallets exempt from the opening tax: 1, ${who}${share}`);
  } else {
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
    // Not bulk, for the same reason as the window read: this backs the launch
    // post, five minutes after a launch, with every member scanning at once.
    const [startBps, seconds] = await Promise.all([
      client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'snipeTaxStartBps' }),
      client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'snipeTaxSeconds' }),
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
