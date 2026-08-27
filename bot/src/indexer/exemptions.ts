import { decodeFunctionData, slice, type Hex } from 'viem';
import { client } from '../chain.js';
import { launchDecodeAbi, SELECTOR } from '../abi.js';

export interface LaunchCalldata {
  /**
   * Number of wallets pre-exempted from the opening snipe tax.
   * `null` means the creation transaction could not be decoded. That is NOT the
   * same as zero and must never be rendered as "clean".
   */
  exemptionCount: number | null;
  exemptions: string[];
  entryPoint: string;
  name: string | null;
  symbol: string | null;
  creatorTaxBps: number | null;
  buybackEnabled: boolean | null;
  /** launchAndBuy only: the creator's opening buy, in the same transaction. */
  buyAmount: bigint | null;
  buyRecipient: string | null;
}

/**
 * Selectors already reported as undecodable.
 *
 * A decode failure is handled -- the count becomes null and the card says
 * "undetermined" rather than "clean" -- but it is still worth surfacing once
 * per selector. A new launch entry point appearing on chain is exactly the
 * event that would quietly blind the highest-value flag, and it would otherwise
 * show up only as a slow drift in the undetermined count.
 */
const reportedSelectors = new Set<string>();

function reportUndecodable(selector: string, err: unknown): void {
  if (reportedSelectors.has(selector)) return;
  reportedSelectors.add(selector);
  console.warn(
    `[exemptions] cannot decode launch calldata with selector ${selector} — ` +
    `recorded as undetermined, never as clean. ${String((err as Error)?.message ?? err).slice(0, 160)}`,
  );
}

const UNKNOWN: LaunchCalldata = {
  exemptionCount: null,
  exemptions: [],
  entryPoint: 'unknown',
  name: null,
  symbol: null,
  creatorTaxBps: null,
  buybackEnabled: null,
  buyAmount: null,
  buyRecipient: null,
};

/**
 * Decode a launch transaction's calldata to recover the snipe-tax exemption list.
 *
 * The exemption array is fixed at creation, capped at 32, and is exposed by no
 * view function anywhere in the protocol -- the creation transaction is the only
 * place it exists. Four entry points can carry it:
 *
 *   factory.launchToken(params, id, pair, address[])          0xa72101af
 *   factory.launchToken(params, id, pair)                     0xf35abbcf  (no array: structurally 0)
 *   factory.launchTokenFor(params, id, pair, deployer, addr[])0xd6a0eef5
 *   forwarder.launchAndBuy(params, id, pair, amt, min, to, addr[]) 0xf85f8e41
 *
 * launchAndBuy is by far the most common (71% of observed launches) and is the
 * one that matters most: it launches and buys in a single transaction, so a
 * non-zero exemption list there is the creator opening a position across wallets
 * that skip the opening tax.
 */
export function decodeLaunchCalldata(input: Hex): LaunchCalldata {
  if (!input || input.length < 10) return UNKNOWN;

  let selector: Hex;
  try {
    selector = slice(input, 0, 4);
  } catch (err) {
    // Calldata too short to carry a selector; nothing to decode.
    reportUndecodable('<malformed>', err);
    return UNKNOWN;
  }

  // The plain 3-arg overload has no exemption array at all, so the count is a
  // genuine, structural zero rather than an unknown.
  if (selector === SELECTOR.launchTokenPlain) {
    try {
      const d = decodeFunctionData({ abi: launchDecodeAbi, data: input });
      const p = d.args![0] as any;
      return {
        exemptionCount: 0,
        exemptions: [],
        entryPoint: 'launchToken',
        name: p.name ?? null,
        symbol: p.symbol ?? null,
        creatorTaxBps: Number(p.creatorTaxBps),
        buybackEnabled: Boolean(p.buybackEnabled),
        buyAmount: null,
        buyRecipient: null,
      };
    } catch (err) {
      reportUndecodable(selector, err);
      return { ...UNKNOWN, entryPoint: 'launchToken' };
    }
  }

  try {
    const d = decodeFunctionData({ abi: launchDecodeAbi, data: input });
    const args = d.args as readonly unknown[];
    const p = args[0] as any;

    let exemptions: readonly string[] = [];
    let buyAmount: bigint | null = null;
    let buyRecipient: string | null = null;

    switch (d.functionName) {
      case 'launchToken':
        exemptions = (args[3] as string[]) ?? [];
        break;
      case 'launchTokenFor':
        exemptions = (args[4] as string[]) ?? [];
        break;
      case 'launchAndBuy':
        exemptions = (args[6] as string[]) ?? [];
        buyAmount = args[3] as bigint;
        buyRecipient = args[5] as string;
        break;
      default:
        return UNKNOWN;
    }

    return {
      exemptionCount: exemptions.length,
      exemptions: exemptions.map((a) => a.toLowerCase()),
      entryPoint: d.functionName,
      name: p?.name ?? null,
      symbol: p?.symbol ?? null,
      creatorTaxBps: p?.creatorTaxBps != null ? Number(p.creatorTaxBps) : null,
      buybackEnabled: p?.buybackEnabled != null ? Boolean(p.buybackEnabled) : null,
      buyAmount,
      buyRecipient,
    };
  } catch (err) {
    reportUndecodable(selector, err);
    return UNKNOWN;
  }
}

/** Fetch a launch transaction and decode it. */
export async function fetchLaunchCalldata(txHash: Hex): Promise<LaunchCalldata> {
  try {
    const tx = await client.getTransaction({ hash: txHash });
    return decodeLaunchCalldata(tx.input);
  } catch (err) {
    // The transaction could not be fetched at all. Recorded as undetermined,
    // which the card reports as such -- never as a clean zero.
    console.warn(`[exemptions] could not fetch launch tx ${txHash}:`, String((err as Error)?.message ?? err).slice(0, 160));
    return UNKNOWN;
  }
}
