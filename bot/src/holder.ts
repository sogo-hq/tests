import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from 'viem';
import { client } from './chain.js';
import { db } from './db.js';
import { getSetting, setSetting, normaliseWallet } from './ready.js';
import { holderOfWallet, resetBalanceCache } from './tiers.js';

/**
 * Proving a Telegram user controls a wallet.
 *
 * Required before any tier is granted, including for wallets an admin already
 * added through /ready add. Those two records answer different questions: the
 * ready register says who the team believes is ready, which is a statement
 * about the launch, while this one is a key. Granting access on somebody else's
 * say-so would mean the tier is held by whoever the admin typed, not by whoever
 * holds the tokens.
 */
export const NONCE_TTL_MS = Number(process.env.HOLDER_NONCE_TTL_MS || 900_000) || 900_000;

/** The exact string the wallet signs. Anything else recovers a different address. */
export function linkMessage(nonce: string): string {
  return `vitals holder link ${nonce}`;
}

export function issueNonce(userId: number, now = Date.now()): string {
  const nonce = randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO holder_nonces (user_id, nonce, issued_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET nonce = excluded.nonce, issued_at = excluded.issued_at`,
  ).run(userId, nonce, Math.floor(now / 1000));
  return nonce;
}

export function nonceOf(userId: number, now = Date.now()): string | null {
  const row = db.prepare('SELECT nonce, issued_at FROM holder_nonces WHERE user_id = ?').get(userId) as
    | { nonce: string; issued_at: number } | undefined;
  if (!row) return null;
  if (now - row.issued_at * 1000 > NONCE_TTL_MS) return null;
  return row.nonce;
}

export function clearNonce(userId: number): void {
  db.prepare('DELETE FROM holder_nonces WHERE user_id = ?').run(userId);
}

/** Is anybody mid-link? The transfer poller is inert unless somebody is. */
export function outstandingNonces(now = Date.now()): { userId: number; nonce: string }[] {
  const cutoff = Math.floor((now - NONCE_TTL_MS) / 1000);
  return (db
    .prepare('SELECT user_id, nonce FROM holder_nonces WHERE issued_at >= ?')
    .all(cutoff) as { user_id: number; nonce: string }[])
    .map((r) => ({ userId: r.user_id, nonce: r.nonce }));
}

export type LinkResult =
  | { ok: true; wallet: string; method: 'signature' | 'transfer' }
  | { ok: false; reason: 'no-nonce' | 'malformed' | 'unreadable' | 'taken'; detail?: string };

/**
 * Link a wallet from a signature over the challenge.
 *
 * The address is RECOVERED from the signature rather than supplied alongside
 * it. Asked for separately, a user could paste any address with any valid
 * signature over the same message and the pair would verify against itself.
 */
export async function linkBySignature(
  userId: number, signature: string, now = Date.now(),
): Promise<LinkResult> {
  const nonce = nonceOf(userId, now);
  if (!nonce) return { ok: false, reason: 'no-nonce' };
  const sig = signature.trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return { ok: false, reason: 'malformed' };

  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message: linkMessage(nonce), signature: sig as Hex });
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: String((err as Error)?.message ?? err).slice(0, 80) };
  }
  return commit(userId, recovered.toLowerCase(), 'signature', now);
}

/**
 * Link from a transfer that carries the challenge in its calldata.
 *
 * The fallback for a custodial wallet that cannot sign a message. The nonce has
 * to be in the calldata because the amount alone proves nothing: anybody can
 * send 0.0001 ETH, and without the challenge the first such transfer would link
 * whichever user happened to be waiting.
 */
export const VERIFY_MIN_WEI = BigInt(process.env.HOLDER_VERIFY_WEI || 100_000_000_000_000n.toString());

export function verifyAddress(): Address | null {
  const raw = (process.env.VERIFY_ADDRESS ?? getSetting('verify_address') ?? '').trim();
  if (!raw) return null;
  const norm = normaliseWallet(raw);
  return norm ? getAddress(norm) : null;
}

export async function linkByTxHash(userId: number, txHash: string, now = Date.now()): Promise<LinkResult> {
  const nonce = nonceOf(userId, now);
  if (!nonce) return { ok: false, reason: 'no-nonce' };
  const to = verifyAddress();
  if (!to) return { ok: false, reason: 'unreadable', detail: 'VERIFY_ADDRESS is not set on this bot' };
  const hash = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return { ok: false, reason: 'malformed' };

  let tx: any;
  let receipt: any;
  try {
    [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: hash as Hex }),
      client.getTransactionReceipt({ hash: hash as Hex }),
    ]);
  } catch (err) {
    return { ok: false, reason: 'unreadable', detail: String((err as Error)?.message ?? err).slice(0, 80) };
  }
  if (!tx || !receipt || receipt.status !== 'success') return { ok: false, reason: 'malformed', detail: 'that transaction did not succeed' };
  if (String(tx.to ?? '').toLowerCase() !== to.toLowerCase()) {
    return { ok: false, reason: 'malformed', detail: 'that transaction did not go to the verify address' };
  }
  if (BigInt(tx.value ?? 0n) < VERIFY_MIN_WEI) return { ok: false, reason: 'malformed', detail: 'that transaction was for less than the verify amount' };
  if (!carriesNonce(String(tx.input ?? '0x'), nonce)) {
    return { ok: false, reason: 'malformed', detail: 'that transaction does not carry your code' };
  }
  return commit(userId, String(tx.from).toLowerCase(), 'transfer', now);
}

/**
 * Does this calldata contain the challenge?
 *
 * Accepts the nonce as raw hex or as UTF-8 bytes, because a wallet's "data"
 * field is typed by a human and both spellings are what people actually send.
 */
export function carriesNonce(input: string, nonce: string): boolean {
  const hex = input.toLowerCase();
  if (hex.includes(nonce.toLowerCase())) return true;
  const asUtf8 = Buffer.from(nonce, 'utf8').toString('hex').toLowerCase();
  return hex.includes(asUtf8);
}

/** The write half of a link, shared with the inbound transfer poller. */
export function linkCommitted(
  userId: number, wallet: string, method: 'signature' | 'transfer', now: number,
): boolean {
  return commit(userId, wallet, method, now).ok;
}

function commit(userId: number, wallet: string, method: 'signature' | 'transfer', now: number): LinkResult {
  if (!isAddress(wallet, { strict: false })) return { ok: false, reason: 'malformed' };
  // One wallet, one holder. Without this, one whale's balance grants a tier to
  // everybody who can produce a signature for it, which is everybody the whale
  // has ever signed for.
  const owner = holderOfWallet(wallet);
  if (owner !== null && owner !== userId) return { ok: false, reason: 'taken' };

  db.prepare(
    `INSERT INTO holder_links (user_id, wallet, method, linked_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET wallet = excluded.wallet, method = excluded.method,
       linked_at = excluded.linked_at`,
  ).run(userId, wallet, method, Math.floor(now / 1000));
  clearNonce(userId);
  resetBalanceCache();
  return { ok: true, wallet, method };
}

export function unlink(userId: number): boolean {
  return db.prepare('DELETE FROM holder_links WHERE user_id = ?').run(userId).changes > 0;
}
