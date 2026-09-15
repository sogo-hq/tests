import { keccak256, toHex } from 'viem';
import { toWei, fromWei } from './launchplan.js';

/**
 * The payment plan, and why it is a file.
 *
 * Twenty transfers are twenty chances to crash halfway. What makes that safe
 * is not care, it is arithmetic: every row is given a nonce when the plan is
 * first built, and a resumed run reuses it. A row that already landed cannot
 * be paid twice, because the second attempt carries a nonce the chain has
 * already consumed and is rejected rather than mined.
 *
 * So the plan is written before the first transfer and updated after each one,
 * and a run that is interrupted is resumed from the file rather than
 * recomputed. Nothing here sends anything or reads a key.
 */

export interface PayRow {
  wallet: string;
  /** As written in the CSV, which is the figure the ledger printed. */
  amountEth: string;
  amountWei: bigint;
}

export type PayStatus = 'pending' | 'sent' | 'failed';

export interface PayEntry extends PayRow {
  index: number;
  nonce: number;
  status: PayStatus;
  txHash: string | null;
  error?: string;
}

export interface PayPlan {
  runId: string;
  from: string;
  baseNonce: number;
  entries: PayEntry[];
}

const WALLET = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parse wallet,amount.
 *
 * Strict on purpose. This file decides where money goes, and a row that does
 * not parse is a row nobody can be sure about, so it stops the run rather than
 * being skipped: a skipped row is a person who silently does not get paid.
 */
export function parsePayCsv(text: string): { ok: true; rows: PayRow[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const rows: PayRow[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, errors: ['the file is empty'] };
  const start = /^wallet\s*,\s*amount$/i.test(lines[0]!) ? 1 : 0;
  const seen = new Map<string, number>();
  lines.slice(start).forEach((line, i) => {
    const n = i + start + 1;
    const parts = line.split(',').map((x) => x.trim());
    if (parts.length !== 2) { errors.push(`line ${n}: expected wallet,amount`); return; }
    const [wallet, amount] = parts as [string, string];
    if (!WALLET.test(wallet)) { errors.push(`line ${n}: ${wallet} is not a wallet address`); return; }
    if (!/^\d+(\.\d+)?$/.test(amount)) { errors.push(`line ${n}: ${amount} is not an amount`); return; }
    // The same wallet twice in one file is two payments to one person, and
    // whichever way it was meant, it is not what the ledger computed.
    const before = seen.get(wallet.toLowerCase());
    if (before !== undefined) { errors.push(`line ${n}: ${wallet} is already on line ${before}`); return; }
    seen.set(wallet.toLowerCase(), n);
    let wei: bigint;
    try {
      wei = toWei(amount);
    } catch (err) {
      errors.push(`line ${n}: ${(err as Error).message}`);
      return;
    }
    if (wei <= 0n) { errors.push(`line ${n}: ${amount} is not worth sending`); return; }
    rows.push({ wallet, amountEth: amount, amountWei: wei });
  });
  return errors.length ? { ok: false, errors } : { ok: true, rows };
}

export function totalWei(rows: { amountWei: bigint }[]): bigint {
  return rows.reduce((a, r) => a + r.amountWei, 0n);
}

/**
 * Build a plan, or resume one.
 *
 * On a resume the nonces come from the stored plan and are NOT recomputed: the
 * whole guard against paying twice is that a retried row carries the nonce its
 * first attempt used. A stored plan whose rows no longer match the file is
 * refused rather than merged, because a plan that half describes a file is
 * worse than no plan.
 */
export function buildPlan(opts: {
  runId: string;
  from: string;
  rows: PayRow[];
  baseNonce: number;
  stored?: PayPlan | null;
}): { ok: true; plan: PayPlan; resumed: boolean } | { ok: false; reason: string } {
  const { stored } = opts;
  if (stored) {
    if (stored.from.toLowerCase() !== opts.from.toLowerCase()) {
      return { ok: false, reason: `the stored plan was made for ${stored.from}, not ${opts.from}` };
    }
    if (stored.entries.length !== opts.rows.length) {
      return { ok: false, reason: `the stored plan has ${stored.entries.length} rows and the file has ${opts.rows.length}` };
    }
    for (const [i, row] of opts.rows.entries()) {
      const e = stored.entries[i]!;
      if (e.wallet.toLowerCase() !== row.wallet.toLowerCase() || BigInt(e.amountWei) !== row.amountWei) {
        return { ok: false, reason: `row ${i + 1} of the file does not match the stored plan: ${row.wallet} ${row.amountEth}` };
      }
    }
    return { ok: true, plan: { ...stored, entries: stored.entries.map((e) => ({ ...e, amountWei: BigInt(e.amountWei) })) }, resumed: true };
  }
  return {
    ok: true,
    resumed: false,
    plan: {
      runId: opts.runId,
      from: opts.from,
      baseNonce: opts.baseNonce,
      entries: opts.rows.map((r, index) => ({
        ...r, index, nonce: opts.baseNonce + index, status: 'pending' as PayStatus, txHash: null,
      })),
    },
  };
}

/** Rows still to send. A row with a hash is never one of them. */
export function unsent(plan: PayPlan): PayEntry[] {
  return plan.entries.filter((e) => e.status !== 'sent' && !e.txHash);
}

export function sentEntries(plan: PayPlan): PayEntry[] {
  return plan.entries.filter((e) => e.status === 'sent' && e.txHash);
}

/** Serialisable: bigint does not survive JSON. */
export function planToJson(plan: PayPlan): string {
  return JSON.stringify({
    ...plan,
    entries: plan.entries.map((e) => ({ ...e, amountWei: String(e.amountWei) })),
  }, null, 2);
}

export function planFromJson(text: string): PayPlan {
  const raw = JSON.parse(text);
  return { ...raw, entries: raw.entries.map((e: any) => ({ ...e, amountWei: BigInt(e.amountWei) })) };
}

/**
 * The line to paste back into the bot.
 *
 * Keyed by wallet rather than by seat: the CSV a batch sender consumes is
 * wallet and amount, so the wallet is the only identifier the payer has, and
 * the bot resolves it back to a seat inside the run it belongs to.
 */
export function recordCommand(plan: PayPlan): string {
  const sent = sentEntries(plan);
  if (!sent.length) return 'nothing was sent, so there is nothing to record';
  return `/ledger tx ${plan.runId} ${sent.map((e) => `${e.wallet}:${e.txHash}`).join(' ')}`;
}

export { fromWei };

// ------------------------------------------------------------------ burner

/**
 * The most a rehearsal may move, whatever is typed on the command line.
 *
 * A burner run exists to prove the path works, not to move money. A fat
 * finger on the amount should hit this rather than the wallet.
 */
export const BURNER_MAX_TOTAL_WEI = 10n ** 15n; // 0.001 ETH

/** What a burner sends to each of its throwaway recipients by default. */
export const BURNER_DEFAULT_AMOUNT_WEI = 10n ** 12n; // 0.000001 ETH

/**
 * Three throwaway recipients, derived from the burner's own address.
 *
 * Deterministic, so a resumed run targets the same three and the nonce guard
 * has something to be right about. Derived from a PUBLIC address, so these
 * keys are not secret and are not meant to be: they exist so the dust can be
 * swept back afterwards rather than burned, and anyone reading this file can
 * recompute them. Never use one for anything else.
 */
export function burnerRecipientKeys(burnerAddress: string, count = 3): `0x${string}`[] {
  return Array.from({ length: count }, (_, i) =>
    keccak256(toHex(`vitals-burner-recipient:${burnerAddress.toLowerCase()}:${i + 1}`)));
}

/** The CSV a burner run feeds to the very same parser a real run uses. */
export function burnerCsv(recipients: string[], amountWei: bigint): string {
  return ['wallet,amount', ...recipients.map((w) => `${w},${fromWei(amountWei, 18).replace(/0+$/, '0')}`)].join('\n');
}

/** Refuse a rehearsal that is not dust. */
export function checkBurnerTotal(totalWei: bigint): { ok: true } | { ok: false; reason: string } {
  if (totalWei <= 0n) return { ok: false, reason: 'a burner run with nothing in it proves nothing' };
  if (totalWei > BURNER_MAX_TOTAL_WEI) {
    return {
      ok: false,
      reason: `a burner run moves dust: ${fromWei(totalWei)} ETH is over the ${fromWei(BURNER_MAX_TOTAL_WEI)} ETH ceiling`,
    };
  }
  return { ok: true };
}
