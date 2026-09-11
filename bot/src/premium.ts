import { getAddress, isAddress, type Address } from 'viem';
import { client } from './chain.js';
import { erc20Abi } from './abi.js';
import { bulk } from './ratelimit.js';
import { BURN_ADDRESS } from './config.js';
import { db } from './db.js';
import { normaliseWallet } from './ready.js';

/**
 * Who may use a paid feature, and where what they pay ends up.
 *
 * Two ways in, either one is enough: HOLD 1,000,000 $VITALS, or PAY 0.05 ETH.
 * The second is a payment, not a balance: holding 0.05 ETH is something almost
 * every wallet on this chain does, and gating a paid feature on it would mean
 * gating it on nothing.
 *
 * There is no bot-held wallet and no private key anywhere in this codebase, so
 * payment is made directly to the treasury and proved with a transaction hash
 * the bot verifies against chain. "Tokens paid to the bot go to
 * TREASURY_ADDRESS" is satisfied by there being no intermediate step to go
 * wrong. No burn.
 * Anything paid to the bot goes to the treasury -- which is why the treasury
 * address is refused rather than defaulted when it is not configured. A default
 * of the zero address is not a safe fallback here, it is a burn by another
 * name, and the amendment that removed the burn removed it on purpose.
 */
export const PREMIUM_MIN_VITALS = BigInt(process.env.PREMIUM_MIN_VITALS || 1_000_000);
export const PREMIUM_MIN_ETH = Number(process.env.PREMIUM_MIN_ETH || 0.05) || 0.05;
export const PREMIUM_MIN_WEI = BigInt(Math.round(PREMIUM_MIN_ETH * 1e18));

/**
 * The $VITALS contract, from the environment.
 *
 * Not compiled in, and never resolved from a search, a registry or a message:
 * a lookalike token address here would gate the feature on somebody else's
 * supply. Unset means the token half of the test cannot run, which is reported
 * as undetermined rather than as a refusal.
 */
export function vitalsToken(): Address | null {
  const raw = (process.env.VITALS_TOKEN_ADDRESS ?? '').trim();
  if (!raw) return null;
  if (!isAddress(raw.toLowerCase(), { strict: false })) {
    throw new Error(`VITALS_TOKEN_ADDRESS is not an address: ${JSON.stringify(raw.slice(0, 60))}`);
  }
  return getAddress(raw.toLowerCase());
}

/**
 * Where payments go.
 *
 * Throws when unset or when it names a burn address. The caller must not have a
 * way to accidentally send tokens nowhere: "no burn" is a product decision, and
 * the only place it can be enforced for certain is before the transfer.
 */
export function treasuryAddress(): Address {
  const raw = (process.env.TREASURY_ADDRESS ?? '').trim();
  if (!raw) {
    throw new Error('TREASURY_ADDRESS is not set: payments have nowhere to go, and must not be burned');
  }
  if (!isAddress(raw.toLowerCase(), { strict: false })) {
    throw new Error(`TREASURY_ADDRESS is not an address: ${JSON.stringify(raw.slice(0, 60))}`);
  }
  const addr = getAddress(raw.toLowerCase());
  if (addr.toLowerCase() === BURN_ADDRESS.toLowerCase() || /^0x0{40}$/i.test(addr)) {
    throw new Error('TREASURY_ADDRESS is a burn address: this feature does not burn');
  }
  return addr;
}

/**
 * CALLER'S OBLIGATION: bind the address to the person before trusting this.
 *
 * entitlement() answers a question about an ADDRESS, and an address is public.
 * Nothing here proves the caller controls it, so a call site that takes an
 * address from a chat message and grants on the answer grants to anyone who can
 * name a wallet holding enough, which is public information. The payment route
 * closes this on its own -- a payment has to come FROM the wallet -- but the
 * holding route does not, and needs a signed message or an already-bound
 * registration behind it.
 */
export type Entitlement =
  | { state: 'premium'; via: 'vitals' | 'payment'; vitals: bigint | null; wei: bigint | null }
  | { state: 'below'; vitals: bigint | null; wei: bigint }
  /**
   * The chain could not be read. NOT a refusal.
   *
   * A failed balance read that returned "below" would tell a holder they do not
   * hold what they hold, which is the same class of error as reporting a token
   * clean because a check did not finish. The caller says so and offers a
   * retry; it does not deny the feature on data it never saw.
   */
  | { state: 'undetermined'; reason: string };

async function tokenBalance(token: Address, wallet: Address): Promise<bigint> {
  const [raw, decimals] = await Promise.all([
    bulk(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })),
    bulk(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })),
  ]);
  // Compared in whole tokens: the threshold is "1M $VITALS", which is a
  // statement about the token's own units, not about 1e18.
  return (raw as bigint) / 10n ** BigInt(Number(decimals));
}

/**
 * Is this wallet entitled to a paid feature?
 *
 * ETH is checked first because it needs no contract and no configuration, so a
 * holder who qualifies that way is never told the feature is unavailable
 * because the operator has not set VITALS_TOKEN_ADDRESS yet.
 */
export async function entitlement(wallet: string): Promise<Entitlement> {
  // The same validator registration uses, so a mixed-case address with a broken
  // checksum is refused here too. Accepting it silently measured a stranger's
  // wallet and reported the answer as though it were the caller's.
  const norm = normaliseWallet(wallet);
  if (!norm) return { state: 'undetermined', reason: 'that is not an address' };
  const addr = getAddress(norm);

  // A recorded payment was verified against chain when it was written, so this
  // is a local read and cannot fail for a network reason.
  const paid = paymentFor(addr);
  if (paid !== null) return { state: 'premium', via: 'payment', vitals: null, wei: paid };

  let token: Address | null;
  try {
    token = vitalsToken();
  } catch (err) {
    // A malformed VITALS_TOKEN_ADDRESS is the operator's mistake. Thrown from
    // here it crashed the caller, or -- worse, if the caller guarded -- denied a
    // legitimate 1,000,000 token holder. Both are the failure this file exists
    // to prevent.
    return { state: 'undetermined', reason: String((err as Error)?.message ?? err).slice(0, 100) };
  }
  if (!token) {
    // No token configured: the holding half of the test cannot run at all, and
    // reporting "not premium" would deny a holder on a check that never
    // happened. This is the operator's gap, not the user's.
    return { state: 'undetermined', reason: '$VITALS is not configured on this bot yet' };
  }
  let vitals: bigint;
  try {
    vitals = await tokenBalance(token, addr);
  } catch (err) {
    return { state: 'undetermined', reason: `$VITALS balance unreadable: ${String((err as Error)?.message ?? err).slice(0, 80)}` };
  }
  if (vitals >= PREMIUM_MIN_VITALS) return { state: 'premium', via: 'vitals', vitals, wei: null };
  return { state: 'below', vitals, wei: 0n };
}

/** Total verified payments from this wallet, or null when there are none. */
export function paymentFor(wallet: string): bigint | null {
  const row = db
    .prepare('SELECT SUM(CAST(wei AS INTEGER)) AS total FROM premium_payments WHERE wallet = ?')
    .get(wallet.toLowerCase()) as { total: number | null } | undefined;
  if (!row?.total) return null;
  const total = BigInt(row.total);
  return total >= PREMIUM_MIN_WEI ? total : null;
}

export type PaymentResult =
  | { ok: true; wei: bigint }
  | { ok: false; reason: 'malformed' | 'not_found' | 'failed' | 'wrong_recipient' | 'wrong_sender' | 'too_little' | 'already_used' | 'unreadable'; detail?: string };

/**
 * Verify and record a payment, from its transaction hash.
 *
 * Every condition is checked against chain: that the transaction exists, that
 * it succeeded, that it went to the treasury, that it came from the wallet
 * claiming it, and that it is worth enough. A hash already recorded is refused
 * rather than counted twice, which is what stops one payment entitling a queue
 * of people who copied it out of the group.
 */
export async function recordPayment(
  txHash: string, wallet: string, now = Date.now(),
): Promise<PaymentResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())) return { ok: false, reason: 'malformed' };
  if (!isAddress(wallet.toLowerCase(), { strict: false })) return { ok: false, reason: 'malformed' };
  const hash = txHash.trim().toLowerCase();
  const addr = wallet.toLowerCase();

  const existing = db.prepare('SELECT wallet FROM premium_payments WHERE tx_hash = ?').get(hash) as
    | { wallet: string } | undefined;
  if (existing) return { ok: false, reason: 'already_used' };

  const treasury = treasuryAddress().toLowerCase();
  let tx: any;
  let receipt: any;
  try {
    [tx, receipt] = await Promise.all([
      bulk(() => client.getTransaction({ hash: hash as `0x${string}` })),
      bulk(() => client.getTransactionReceipt({ hash: hash as `0x${string}` })),
    ]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // A hash the node has never seen is a real answer; anything else is not.
    return /not found|could not be found/i.test(msg)
      ? { ok: false, reason: 'not_found' }
      : { ok: false, reason: 'unreadable', detail: msg.slice(0, 100) };
  }
  if (!tx || !receipt) return { ok: false, reason: 'not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'failed' };
  if (String(tx.to ?? '').toLowerCase() !== treasury) return { ok: false, reason: 'wrong_recipient' };
  if (String(tx.from ?? '').toLowerCase() !== addr) return { ok: false, reason: 'wrong_sender' };
  const wei = BigInt(tx.value ?? 0n);
  if (wei < PREMIUM_MIN_WEI) return { ok: false, reason: 'too_little' };

  db.prepare(
    'INSERT OR IGNORE INTO premium_payments (tx_hash, wallet, wei, paid_at) VALUES (?,?,?,?)',
  ).run(hash, addr, wei.toString(), Math.floor(now / 1000));
  return { ok: true, wei };
}

/** What the holder is told. Facts and the thresholds, no upsell. */
export function entitlementLine(e: Entitlement): string {
  if (e.state === 'undetermined') return `could not check your holdings: ${e.reason}. try again`;
  if (e.state === 'premium') {
    return e.via === 'payment'
      ? `premium · ${(Number(e.wei) / 1e18).toFixed(3)} ETH paid`
      : `premium · ${e.vitals!.toLocaleString()} $VITALS held`;
  }
  return `not premium · you hold ${(e.vitals ?? 0n).toLocaleString()} $VITALS · ` +
    `need ${PREMIUM_MIN_VITALS.toLocaleString()} $VITALS held, or ${PREMIUM_MIN_ETH} ETH paid to the treasury`;
}
