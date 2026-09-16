import { decodeFunctionData, slice, type Hex } from 'viem';
import { client } from '../chain.js';
import { launchDecodeAbi, SELECTOR, SnipeTaxExempted } from '../abi.js';

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
  /** The wallet the creator fee goes to, from the launch parameters. */
  creatorFeeRecipient: string | null;
  /**
   * Exempt wallets that are none of the creator's three slots.
   *
   * Null when the slots are not all known, because a count that assumed an
   * unknown slot was a stranger would put the creator's own wallet in the
   * column that says somebody else got in tax free.
   */
  thirdPartyExempt: number | null;
  /** 'logs' once the count came from the curve's own events. */
  source: 'logs' | 'calldata' | null;
  /**
   * The socials named in the launch params, as given. Null when the calldata
   * could not be decoded; a field is an empty string when the deployer left it
   * blank, which is a fact about the launch and not a failure to read it.
   */
  socials: LaunchSocials | null;
}

export interface LaunchSocials {
  x: string;
  tg: string;
  web: string;
}

/** The three fields /scout and the CSV care about, trimmed, never invented. */
export function socialsOf(p: any): LaunchSocials | null {
  const so = p?.socials;
  if (!so || typeof so !== 'object') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return { x: str(so.twitter), tg: str(so.telegram), web: str(so.website) };
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
    `[exemptions] cannot decode launch calldata with selector ${selector}, ` +
    `recorded as undetermined, never as clean. ${String((err as Error)?.message ?? err).slice(0, 160)}`,
  );
}

/**
 * The wallets a launch call will exempt, from the call alone.
 *
 * The union, lowercased, in slot order. Duplicates collapse: a config where the
 * sender is also the fee recipient and the buy recipient exempts one wallet and
 * emits three events, which is what VITALSRH1 did.
 */
export function unionOfSlots(opts: {
  sender?: string | null;
  creatorFeeRecipient?: string | null;
  recipient?: string | null;
  exemptions?: readonly string[];
}): string[] {
  const out: string[] = [];
  const add = (a?: string | null) => {
    const v = (a ?? '').trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(v) && !out.includes(v)) out.push(v);
  };
  add(opts.sender);
  add(opts.creatorFeeRecipient);
  add(opts.recipient);
  for (const a of opts.exemptions ?? []) add(a);
  return out;
}

/**
 * Exempt wallets that are none of the creator's own slots.
 *
 * The creator's slots are the wallet that sent the launch, the wallet the fee
 * goes to, and the wallet that received the opening buy. Anything else in the
 * exempt set is somebody the creator named, which is the thing worth counting
 * separately: a launch where the creator's own three wallets are tax free is a
 * different shape from one where eight strangers are.
 *
 * Null when a slot is unknown. Counting an unknown slot as a stranger would
 * put the creator's own wallet in the column that says somebody else got in.
 */
export function thirdPartyExemptCount(opts: {
  exempt: readonly string[];
  sender?: string | null;
  creatorFeeRecipient?: string | null;
  recipient?: string | null;
  /** False for entry points that take no opening buy, so there is no recipient slot. */
  hasBuy?: boolean;
}): number | null {
  const addr = (a?: string | null) => {
    const v = (a ?? '').trim().toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(v) ? v : null;
  };
  const sender = addr(opts.sender);
  const fee = addr(opts.creatorFeeRecipient);
  const recipient = addr(opts.recipient);
  if (!sender || !fee) return null;
  if (opts.hasBuy !== false && !recipient) return null;
  const slots = new Set([sender, fee, ...(recipient ? [recipient] : [])]);
  return opts.exempt.filter((a) => !slots.has(a.trim().toLowerCase())).length;
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
  creatorFeeRecipient: null,
  thirdPartyExempt: null,
  source: null,
  socials: null,
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
export function decodeLaunchCalldata(input: Hex, sender?: string | null): LaunchCalldata {
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
      const union = unionOfSlots({
        sender,
        creatorFeeRecipient: p?.creatorFeeRecipient as string | undefined,
        recipient: null,
        exemptions: [],
      });
      return {
        // Never 0. launchToken names no wallets and the factory still exempts
        // the sender and the creator fee recipient, which is what the receipts
        // show: fourteen of fourteen launches stored as 0 had emitted one.
        exemptionCount: sender ? union.length : null,
        exemptions: union,
        creatorFeeRecipient: (p?.creatorFeeRecipient as string | undefined)?.toLowerCase() ?? null,
        thirdPartyExempt: thirdPartyExemptCount({
          exempt: union, sender, creatorFeeRecipient: p?.creatorFeeRecipient as string | undefined,
          recipient: null, hasBuy: false,
        }),
        entryPoint: 'launchToken',
        name: p.name ?? null,
        symbol: p.symbol ?? null,
        creatorTaxBps: Number(p.creatorTaxBps),
        buybackEnabled: Boolean(p.buybackEnabled),
        buyAmount: null,
        buyRecipient: null,
        source: 'calldata',
        socials: socialsOf(p),
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

    // The array is one of four slots the factory exempts, not the whole set.
    // Measured through eth_simulateV1 with a distinct address in each slot:
    // the sender, the creatorFeeRecipient, the opening-buy recipient and every
    // array entry each emit one SnipeTaxExempted. Counting the array alone
    // reported 0 for 3,168 launches that had each exempted their deployer.
    const union = unionOfSlots({
      sender,
      creatorFeeRecipient: p?.creatorFeeRecipient as string | undefined,
      recipient: buyRecipient,
      exemptions,
    });
    return {
      // Without the sender the union is missing a slot, and a number known to
      // be short is worse than no number: it reads as a measurement.
      exemptionCount: sender ? union.length : null,
      exemptions: union,
      creatorFeeRecipient: (p?.creatorFeeRecipient as string | undefined)?.toLowerCase() ?? null,
      thirdPartyExempt: thirdPartyExemptCount({
        exempt: union, sender, creatorFeeRecipient: p?.creatorFeeRecipient as string | undefined,
        recipient: buyRecipient, hasBuy: d.functionName === 'launchAndBuy',
      }),
      entryPoint: d.functionName,
      name: p?.name ?? null,
      symbol: p?.symbol ?? null,
      creatorTaxBps: p?.creatorTaxBps != null ? Number(p.creatorTaxBps) : null,
      buybackEnabled: p?.buybackEnabled != null ? Boolean(p.buybackEnabled) : null,
      buyAmount,
      buyRecipient,
      source: 'calldata',
      socials: socialsOf(p),
    };
  } catch (err) {
    reportUndecodable(selector, err);
    return UNKNOWN;
  }
}

/** Fetch a launch transaction and decode it. */
/**
 * The exemption list as the contract actually emitted it.
 *
 * The curve emits SnipeTaxExempted(address indexed wallet) once per
 * pre-exempted wallet, inside the launch transaction. Verified on chain: the
 * parameter IS indexed, so the address is topics[1] and the data field is
 * empty, and a launch that exempted five wallets emitted six logs, so the list
 * has to be de-duplicated.
 *
 * This is the PRIMARY source now, and calldata is the cross-check. Decoding
 * calldata requires knowing the entry point's ABI, and 60,537 launches were
 * stuck undetermined behind selectors this build has never seen: third-party
 * routers, aggregators, and plain contract-creation transactions
 * (0xf955751f, 0x34fcd5be, 0xe9ae5c53, 0x60806040 among them). The event does
 * not care how the launch was called.
 */
export function exemptionsFromReceipt(logs: readonly any[], curve?: string): string[] {
  const want = curve?.toLowerCase();
  const out: string[] = [];
  for (const log of logs) {
    if (log?.topics?.[0] !== SnipeTaxExemptedTopic) continue;
    // Scoped to the curve when we know it. Without that scope the filter is
    // still safe -- only this launch's curve emits this event in this
    // transaction -- but being explicit costs nothing.
    if (want && String(log.address ?? '').toLowerCase() !== want) continue;
    const topic = log.topics[1];
    if (typeof topic !== 'string' || topic.length !== 66) continue;
    const wallet = `0x${topic.slice(26)}`.toLowerCase();
    if (!out.includes(wallet)) out.push(wallet);
  }
  return out;
}

/** keccak256("SnipeTaxExempted(address)"), confirmed against live logs. */
export const SnipeTaxExemptedTopic =
  '0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7';

let mismatchReported = 0;

export async function fetchLaunchCalldata(txHash: Hex, curve?: string): Promise<LaunchCalldata> {
  let tx: any = null;
  let receipt: any = null;
  try {
    [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);
  } catch (err) {
    // Neither could be fetched. Recorded as undetermined, which the card
    // reports as such -- never as a clean zero.
    console.warn(`[exemptions] could not fetch launch tx ${txHash}:`, String((err as Error)?.message ?? err).slice(0, 160));
    return UNKNOWN;
  }

  const fromCalldata = tx?.input ? decodeLaunchCalldata(tx.input, tx.from) : UNKNOWN;
  if (!receipt?.logs) return fromCalldata;

  const fromLogs = exemptionsFromReceipt(receipt.logs, curve);

  // The logs are what the contract did; the calldata is what it was asked to
  // do. When both are readable and they disagree, the logs win and the
  // disagreement is worth one line, because it would mean an entry point that
  // rewrites the list between the call and the constructor.
  if (fromCalldata.exemptionCount !== null && fromCalldata.exemptionCount !== fromLogs.length && mismatchReported < 5) {
    mismatchReported++;
    console.warn(
      `[exemptions] ${txHash} calldata says ${fromCalldata.exemptionCount} exemptions, ` +
      `the curve emitted ${fromLogs.length}. using the logs.`,
    );
  }

  // A launch cannot exempt nobody: the sender and the creatorFeeRecipient are
  // exempted whatever the call says, measured on fourteen of fourteen receipts.
  // So zero events is a read that missed them, not a launch that exempted no
  // one, and it is reported as undetermined rather than as a finding of none.
  if (fromLogs.length === 0) {
    console.warn(`[exemptions] ${txHash} emitted no SnipeTaxExempted at all, which the factory cannot do. undetermined.`);
    return { ...fromCalldata, exemptionCount: null, exemptions: [], source: null };
  }

  return {
    ...fromCalldata,
    exemptionCount: fromLogs.length,
    exemptions: fromLogs,
    // Recomputed over what the curve actually emitted, not over what the call
    // asked for. The slots still come from the calldata, because that is the
    // only place they are named.
    thirdPartyExempt: thirdPartyExemptCount({
      exempt: fromLogs,
      sender: tx?.from,
      creatorFeeRecipient: fromCalldata.creatorFeeRecipient,
      recipient: fromCalldata.buyRecipient,
      hasBuy: fromCalldata.entryPoint === 'launchAndBuy',
    }),
    entryPoint: fromCalldata.entryPoint === 'unknown' ? 'logs' : fromCalldata.entryPoint,
    source: 'logs',
  };
}
