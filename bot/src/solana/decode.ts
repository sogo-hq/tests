import { LAUNCHLAB_PROGRAM, isPubkey } from './config.js';

/**
 * What a LaunchLab creation transaction says, and what it does not.
 *
 * The creation and the dev buy are two instructions that may share one
 * transaction, and that sharing is the only thing that makes a dev buy
 * distinguishable from a snipe. A buy in the same TRANSACTION was made by the
 * creator as part of creating; a buy in the same SLOT was made by somebody who
 * saw the creation land. This decoder reports the first and never claims the
 * second: same-slot activity is a separate read against the pool, and whether
 * a same-slot buyer is related to the creator is not readable at all.
 */

/** Anchor discriminators, read off three decoded creation transactions. */
export const INITIALIZE_WITH_TOKEN_2022 = '25be7ede2c9aab11';
export const BUY_EXACT_IN = 'faea0d7bd59c13ec';

/**
 * Account positions in the initialize instruction.
 *
 * Fixed by the program's own layout. Index 3 is the platform config, which is
 * the only thing that names a platform, so it is read positionally rather than
 * searched for: a search would find whichever account happened to look right.
 */
export const IX_CREATOR = 0;
export const IX_PLATFORM_CONFIG = 3;
export const IX_BASE_MINT = 6;
export const IX_QUOTE_MINT = 7;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58 to bytes, or null. Instruction data arrives base58 encoded. */
export function bs58Decode(s: string): Buffer | null {
  if (typeof s !== 'string' || !s.length) return null;
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch === '1') out.unshift(0); else break; }
  return Buffer.from(out);
}

export interface RawInstruction {
  programId: string;
  accounts?: string[];
  data?: string;
}

export interface RawTransaction {
  slot?: number;
  blockTime?: number | null;
  transaction?: {
    signatures?: string[];
    message?: { accountKeys?: unknown[]; instructions?: RawInstruction[] };
  };
  meta?: {
    err?: unknown;
    postTokenBalances?: {
      mint?: string; owner?: string; uiTokenAmount?: { amount?: string; decimals?: number };
    }[];
    logMessages?: string[];
  };
}

export interface DevBuy {
  /** True only when the buy shares the creation transaction. */
  sameTransaction: boolean;
  /** Base units the creator holds after creation, or null when unreadable. */
  amount: bigint | null;
  /** Share of supply, 0 to 100, or null. */
  pctOfSupply: number | null;
}

export interface Creation {
  signature: string | null;
  slot: number | null;
  blockTime: number | null;
  creator: string;
  platformConfig: string;
  baseMint: string;
  quoteMint: string;
  supply: bigint | null;
  decimals: number | null;
  devBuy: DevBuy;
  /** Instruction names the program logged, in order. Evidence, not a claim. */
  logged: string[];
}

export type DecodeResult =
  | { ok: true; value: Creation }
  | { ok: false; reason: string };

function keysOf(message: { accountKeys?: unknown[] } | undefined): string[] {
  return (message?.accountKeys ?? []).map((k) => {
    if (typeof k === 'string') return k;
    const o = k as { pubkey?: unknown };
    return typeof o?.pubkey === 'string' ? o.pubkey : '';
  });
}

/** The LaunchLab instructions of a transaction, with their discriminators. */
function launchlabInstructions(tx: RawTransaction): { ix: RawInstruction; disc: string }[] {
  const out: { ix: RawInstruction; disc: string }[] = [];
  for (const ix of tx.transaction?.message?.instructions ?? []) {
    if (ix.programId !== LAUNCHLAB_PROGRAM) continue;
    const data = bs58Decode(ix.data ?? '');
    if (!data || data.length < 8) continue;
    out.push({ ix, disc: data.subarray(0, 8).toString('hex') });
  }
  return out;
}

/**
 * Decode a creation transaction.
 *
 * Refuses rather than guesses. A transaction that failed on chain, or that
 * carries no initialize instruction, or whose positional accounts are not
 * pubkeys, produces a reason: every one of those would otherwise yield a
 * Creation full of plausible-looking strings, and a platform read out of the
 * wrong account index is the single worst thing this path could get wrong.
 */
export function decodeCreation(tx: RawTransaction): DecodeResult {
  if (tx?.meta?.err) return { ok: false, reason: 'the transaction failed on chain' };
  const message = tx?.transaction?.message;
  if (!message) return { ok: false, reason: 'no transaction message' };

  const instructions = launchlabInstructions(tx);
  const init = instructions.find((i) => i.disc === INITIALIZE_WITH_TOKEN_2022);
  if (!init) return { ok: false, reason: 'no launchlab initialize instruction in this transaction' };

  const accounts = init.ix.accounts ?? [];
  if (accounts.length <= IX_QUOTE_MINT) {
    return { ok: false, reason: `the initialize instruction carries ${accounts.length} accounts` };
  }
  const creator = accounts[IX_CREATOR]!;
  const platformConfig = accounts[IX_PLATFORM_CONFIG]!;
  const baseMint = accounts[IX_BASE_MINT]!;
  const quoteMint = accounts[IX_QUOTE_MINT]!;
  for (const [what, key] of [['creator', creator], ['platform config', platformConfig],
    ['base mint', baseMint], ['quote mint', quoteMint]] as const) {
    if (!isPubkey(key)) return { ok: false, reason: `the ${what} is not a pubkey` };
  }

  const balances = tx.meta?.postTokenBalances ?? [];
  const ofMint = balances.filter((b) => b.mint === baseMint);
  const decimals = ofMint.find((b) => typeof b.uiTokenAmount?.decimals === 'number')
    ?.uiTokenAmount?.decimals ?? null;
  // Supply is the sum of what exists after creation, which for a launch is the
  // pool plus whatever the creator took. Null rather than zero when no balance
  // row could be read: a supply of zero is a claim about the token.
  const supply = ofMint.length
    ? ofMint.reduce((a, b) => a + BigInt(b.uiTokenAmount?.amount ?? '0'), 0n)
    : null;

  const bought = instructions.some((i) => i.disc === BUY_EXACT_IN);
  const creatorHeld = ofMint
    .filter((b) => b.owner === creator)
    .reduce((a, b) => a + BigInt(b.uiTokenAmount?.amount ?? '0'), 0n);
  const amount = ofMint.length ? creatorHeld : null;
  const pct = amount !== null && supply !== null && supply > 0n
    // Four decimal places, in integer arithmetic, so a 1,000,000,000 supply
    // does not go through a float on its way to a percentage.
    ? Number((amount * 1_000_000n) / supply) / 10_000
    : null;

  return {
    ok: true,
    value: {
      signature: tx.transaction?.signatures?.[0] ?? null,
      slot: typeof tx.slot === 'number' ? tx.slot : null,
      blockTime: typeof tx.blockTime === 'number' ? tx.blockTime : null,
      creator, platformConfig, baseMint, quoteMint,
      supply, decimals,
      devBuy: { sameTransaction: bought, amount, pctOfSupply: pct },
      logged: (tx.meta?.logMessages ?? [])
        .filter((l) => l.startsWith('Program log: Instruction: '))
        .map((l) => l.replace('Program log: Instruction: ', '')),
    },
  };
}

/**
 * The dev buy line.
 *
 * Says which transaction it was in, because that is the whole distinction
 * between a dev buy and a snipe, and a percentage with no such qualifier
 * invites the reader to supply the wrong one.
 */
export function devBuyLine(c: Creation): string {
  if (c.devBuy.pctOfSupply === null) {
    return 'dev buy: the creation transaction carried no balance to read it from, undetermined';
  }
  if (!c.devBuy.sameTransaction && c.devBuy.pctOfSupply === 0) {
    return 'dev buy: none in the creation transaction';
  }
  return `dev buy: ${c.devBuy.pctOfSupply}% of supply, in the creation transaction`;
}
