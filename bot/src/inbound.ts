import { getAddress, type Address, type Hex } from 'viem';
import { client } from './chain.js';
import { db } from './db.js';
import { getSetting, setSetting, normaliseWallet } from './ready.js';
import { grant } from './tiers.js';
import {
  outstandingNonces, carriesNonce, verifyAddress, VERIFY_MIN_WEI, linkCommitted,
} from './holder.js';

/**
 * One block scan, two jobs.
 *
 * There is no eth_getLogs for a plain ETH transfer, so both the ownership
 * challenge and the premium payment can only be found by reading whole blocks
 * and filtering by recipient. At a 0.1 s block time that is 600 blocks a
 * minute, so running two of these would double a cost that is already the most
 * expensive thing here. One pass looks for both.
 *
 * It is also inert unless somebody is actually waiting: a challenge
 * outstanding, or a /premium expecting a payment. Idle, it costs one comparison
 * and returns.
 */
export const PREMIUM_DAYS = Number(process.env.PREMIUM_DAYS || 30) || 30;
export const PREMIUM_PRICE_WEI = BigInt(process.env.PREMIUM_PRICE_WEI || 50_000_000_000_000_000n.toString());
export const PAY_WATCH_TTL_MS = Number(process.env.PAY_WATCH_TTL_MS || 7_200_000) || 7_200_000;
export const POLL_MAX_BLOCKS = Number(process.env.INBOUND_POLL_BLOCKS || 300) || 300;

/**
 * Where a premium payment goes.
 *
 * PREMIUM_PAY_ADDRESS if set, and the treasury otherwise: the amendment that
 * removed the burn said payments go to TREASURY_ADDRESS, and naming a second
 * address for the same money should be a choice rather than a requirement.
 */
export function premiumPayAddress(): Address | null {
  const raw = (process.env.PREMIUM_PAY_ADDRESS ?? process.env.TREASURY_ADDRESS ?? '').trim();
  if (!raw) return null;
  const norm = normaliseWallet(raw);
  return norm ? getAddress(norm) : null;
}

/** Somebody said they are paying. Used only to decide whether to scan at all. */
export function expectPayment(userId: number, now = Date.now()): void {
  setSetting(`pay_watch:${userId}`, String(Math.floor(now / 1000)));
}

export function paymentExpected(now = Date.now()): boolean {
  const cutoff = Math.floor((now - PAY_WATCH_TTL_MS) / 1000);
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ready_settings WHERE key LIKE 'pay_watch:%' AND CAST(value AS INTEGER) >= ?")
    .get(cutoff) as { n: number };
  return row.n > 0;
}

export function clearPaymentWatch(userId: number): void {
  setSetting(`pay_watch:${userId}`, '');
}

export type PayResult =
  | { ok: true; wallet: string; wei: bigint; until: number }
  | { ok: false; reason: 'malformed' | 'not_found' | 'failed' | 'wrong_recipient' | 'unlinked' | 'too_little' | 'already_used' | 'unreadable' | 'unconfigured'; detail?: string };

/**
 * Credit a payment, from its transaction hash.
 *
 * The thirty days start when the payment LANDED, not when it was noticed: a
 * holder who paid an hour before the bot got round to reading the block has
 * bought thirty days from the payment, not twenty-nine and a bit.
 */
export async function creditPayment(txHash: string, now = Date.now()): Promise<PayResult> {
  const to = premiumPayAddress();
  if (!to) return { ok: false, reason: 'unconfigured' };
  const hash = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return { ok: false, reason: 'malformed' };
  if (db.prepare('SELECT tx_hash FROM premium_payments WHERE tx_hash = ?').get(hash)) {
    return { ok: false, reason: 'already_used' };
  }

  let tx: any;
  let receipt: any;
  try {
    [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: hash as Hex }),
      client.getTransactionReceipt({ hash: hash as Hex }),
    ]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    return /not found|could not be found/i.test(msg)
      ? { ok: false, reason: 'not_found' }
      : { ok: false, reason: 'unreadable', detail: msg.slice(0, 100) };
  }
  if (!tx || !receipt) return { ok: false, reason: 'not_found' };
  if (receipt.status !== 'success') return { ok: false, reason: 'failed' };
  if (String(tx.to ?? '').toLowerCase() !== to.toLowerCase()) return { ok: false, reason: 'wrong_recipient' };
  const wei = BigInt(tx.value ?? 0n);
  if (wei < PREMIUM_PRICE_WEI) return { ok: false, reason: 'too_little' };

  const from = String(tx.from).toLowerCase();
  const row = db.prepare('SELECT user_id FROM holder_links WHERE wallet = ?').get(from) as
    | { user_id: number } | undefined;
  // "From your linked wallet" is what ties a payment to a Telegram account.
  // Without it the bot would have money and no idea whose month it bought.
  if (!row) return { ok: false, reason: 'unlinked' };

  let landedAt = now;
  try {
    const block = await client.getBlock({ blockNumber: BigInt(receipt.blockNumber) });
    landedAt = Number(block.timestamp) * 1000;
  } catch (err) {
    console.warn('[inbound] block time unreadable, dating the grant from now:', String((err as Error)?.message ?? err).slice(0, 80));
  }

  db.prepare('INSERT OR IGNORE INTO premium_payments (tx_hash, wallet, wei, paid_at) VALUES (?,?,?,?)')
    .run(hash, from, wei.toString(), Math.floor(landedAt / 1000));
  const g = grant(row.user_id, 'premium', PREMIUM_DAYS, 'payment', landedAt);
  clearPaymentWatch(row.user_id);
  return { ok: true, wallet: from, wei, until: g.expiresAt };
}

export interface InboundResult { linked: number; paid: number; scanned: number }

export async function pollInbound(now = Date.now()): Promise<InboundResult> {
  const out: InboundResult = { linked: 0, paid: 0, scanned: 0 };
  const nonces = outstandingNonces(now);
  const wantPayments = paymentExpected(now);
  if (!nonces.length && !wantPayments) return out;

  const verify = verifyAddress();
  const pay = premiumPayAddress();
  if (!verify && !pay) return out;

  let head: bigint;
  try {
    head = await client.getBlockNumber({ cacheTime: 0 });
  } catch (err) {
    console.warn('[inbound] head unreadable:', String((err as Error)?.message ?? err).slice(0, 100));
    return out;
  }
  const stored = BigInt(getSetting('inbound_poll_block') || '0');
  // A cold cursor starts at the head: nothing can have been paid before the
  // bot was asked to watch for it.
  const from = stored > 0n ? stored + 1n : head;
  if (from > head) return out;
  const to = head - from >= BigInt(POLL_MAX_BLOCKS) ? from + BigInt(POLL_MAX_BLOCKS) - 1n : head;

  try {
    for (let b = from; b <= to; b++) {
      const block = await client.getBlock({ blockNumber: b, includeTransactions: true });
      out.scanned++;
      for (const tx of block.transactions as any[]) {
        const dest = String(tx.to ?? '').toLowerCase();
        const value = BigInt(tx.value ?? 0n);

        if (verify && dest === verify.toLowerCase() && value >= VERIFY_MIN_WEI) {
          const match = nonces.find((n) => carriesNonce(String(tx.input ?? '0x'), n.nonce));
          if (match && linkCommitted(match.userId, String(tx.from).toLowerCase(), 'transfer', now)) out.linked++;
        }
        if (pay && dest === pay.toLowerCase() && value >= PREMIUM_PRICE_WEI) {
          const res = await creditPayment(String(tx.hash), now);
          if (res.ok) out.paid++;
        }
      }
    }
  } catch (err) {
    console.warn('[inbound] poll failed:', String((err as Error)?.message ?? err).slice(0, 120));
    return out;
  }
  setSetting('inbound_poll_block', to.toString());
  return out;
}

export function startInboundLoop(intervalMs = 15_000): NodeJS.Timeout {
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    void pollInbound()
      .catch((err) => console.warn('[inbound] tick failed:', String((err as Error)?.message ?? err).slice(0, 140)))
      .finally(() => { running = false; });
  }, intervalMs);
  t.unref?.();
  return t;
}
