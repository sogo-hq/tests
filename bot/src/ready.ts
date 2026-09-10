import { getAddress, isAddress, type Address } from 'viem';
import { db } from './db.js';
import { client } from './chain.js';
import { bulk } from './ratelimit.js';

/**
 * Who is ready for launch, and how much they hold.
 *
 * The public output is a total and nothing else. No wallet, no label, no user
 * id ever reaches a group message -- that is asserted in tests for every
 * group-facing command, because it is the promise that makes registering safe
 * and it is one careless template away from being broken.
 *
 * Balances are re-read from chain before every post rather than trusted from
 * the last one: a wallet that has been drained is not ready, and the number
 * going down is the point rather than an embarrassment.
 */

/** Minimum balance for a wallet to count. */
export const READY_MIN_ETH = Number(process.env.READY_MIN_ETH || 0.05) || 0.05;
export const READY_MIN_WEI = BigInt(Math.round(READY_MIN_ETH * 1e18));

/** One registration per user per this long. */
export const REGISTER_COOLDOWN_MS = Number(process.env.READY_COOLDOWN_MS || 600_000) || 600_000;

/** A user must have been in the group this long before /ready does anything. */
export const MIN_MEMBERSHIP_MS = Number(process.env.READY_MIN_MEMBERSHIP_MS || 600_000) || 600_000;

export type ReadySource = 'member' | 'external';

export interface ReadyRow {
  wallet: string;
  userId: number | null;
  label: string | null;
  source: ReadySource;
  balanceWei: bigint;
  inviteLink: string | null;
  firstSeen: number;
  lastChecked: number;
}

// ------------------------------------------------------------------ settings

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO ready_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM ready_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function getNumber(key: string, fallback: number): number {
  const v = getSetting(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Self-registration is OFF until an admin opens it.
 *
 * Default closed on purpose: before launch the list is curated by people who
 * know who is actually ready, and an open form is a spam surface with a wallet
 * address in it.
 */
export function selfRegistrationOpen(): boolean {
  return getSetting('ready_open') === 'on';
}

// ---------------------------------------------------------------- addresses

export type AddressProblem = 'malformed' | 'contract';

/**
 * Normalise a pasted address, accepting the shapes people actually send.
 *
 * Checksummed, all-lowercase and all-uppercase all mean the same address, and
 * only the first survives viem's strict check -- so the case is flattened
 * before validating and the canonical lowercase form is what gets stored.
 */
export function normaliseWallet(input: string): string | null {
  const raw = input.trim();
  const m = /^0[xX]([0-9a-fA-F]{40})$/.exec(raw);
  if (!m) return null;
  const body = m[1]!;
  const lower = `0x${body.toLowerCase()}`;
  if (!isAddress(lower, { strict: false })) return null;

  // A body that is entirely one case carries no checksum information: people
  // paste from a keyboard, a QR reader, or a block explorer that shouts. Accept
  // it as typed and lowercase it.
  const uniform = body === body.toLowerCase() || body === body.toUpperCase();
  if (uniform) return lower;

  // Mixed case IS a checksum, so verify it rather than discarding it. This is
  // the only free typo check registration gets: a wallet with one character
  // wrong is a wallet whose ETH the group is counting and nobody holds.
  // No try needed: getAddress only throws on a shape isAddress already rejected.
  return getAddress(lower) === raw ? lower : null;
}


/** A wallet must be an account, not a contract. */
export async function isContract(wallet: string): Promise<boolean> {
  const code = await bulk(() => client.getCode({ address: wallet as Address }));
  return Boolean(code && code !== '0x');
}

export async function balanceOf(wallet: string): Promise<bigint> {
  return bulk(() => client.getBalance({ address: wallet as Address }));
}

// ------------------------------------------------------------- registration

export type RegisterResult =
  | { ok: true; wallet: string; balanceWei: bigint; replaced: boolean }
  | { ok: false; reason: 'malformed' }
  | { ok: false; reason: 'contract' }
  | { ok: false; reason: 'low'; balanceWei: bigint }
  | { ok: false; reason: 'cooldown'; retryInMs: number }
  | { ok: false; reason: 'closed' };

const lastRegistration = new Map<number, number>();

/**
 * Register a member's own wallet.
 *
 * The member record wins over an external one for the same address: an admin
 * adding somebody in advance should not stop that person registering, and two
 * rows for one wallet would count it twice.
 */
export async function registerMember(
  userId: number,
  input: string,
  opts: { inviteLink?: string | null; now?: number } = {},
): Promise<RegisterResult> {
  const now = opts.now ?? Date.now();
  const last = lastRegistration.get(userId);
  if (last !== undefined && now - last < REGISTER_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', retryInMs: REGISTER_COOLDOWN_MS - (now - last) };
  }

  const wallet = normaliseWallet(input);
  if (!wallet) return { ok: false, reason: 'malformed' };
  if (await isContract(wallet)) return { ok: false, reason: 'contract' };

  const balanceWei = await balanceOf(wallet);
  if (balanceWei < READY_MIN_WEI) return { ok: false, reason: 'low', balanceWei };

  const seconds = Math.floor(now / 1000);
  const replaced = claimWallet(wallet, userId, opts.inviteLink ?? null, balanceWei, seconds);
  lastRegistration.set(userId, now);
  return { ok: true, wallet, balanceWei, replaced };
}

/**
 * Write the member's claim, removing anything else that held this wallet or
 * this user.
 *
 * Returns whether it replaced something, so the reply can say so.
 */
function claimWallet(
  wallet: string,
  userId: number,
  inviteLink: string | null,
  balanceWei: bigint,
  seconds: number,
): boolean {
  const priorForUser = db
    .prepare('SELECT wallet FROM ready_wallets WHERE user_id = ?')
    .get(userId) as { wallet: string } | undefined;
  const priorForWallet = db
    .prepare('SELECT wallet, source FROM ready_wallets WHERE wallet = ?')
    .get(wallet) as { wallet: string; source: ReadySource } | undefined;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM ready_wallets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM ready_wallets WHERE wallet = ?').run(wallet);
    db.prepare(
      `INSERT INTO ready_wallets (wallet, user_id, label, source, balance_wei, invite_link, first_seen, last_checked)
       VALUES (?,?,NULL,'member',?,?,?,?)`,
    ).run(wallet, userId, balanceWei.toString(), inviteLink, seconds, seconds);
  });
  tx();
  return Boolean(priorForUser) || priorForWallet?.source === 'external';
}

export type AddExternalResult =
  | { ok: true; wallet: string; balanceWei: bigint }
  | { ok: false; reason: 'malformed' | 'contract' | 'claimed' }
  | { ok: false; reason: 'low'; balanceWei: bigint };

/** An admin adding somebody who is ready but not in the group. */
export async function addExternal(
  input: string,
  label: string,
  now = Date.now(),
): Promise<AddExternalResult> {
  const wallet = normaliseWallet(input);
  if (!wallet) return { ok: false, reason: 'malformed' };

  const existing = db
    .prepare('SELECT source FROM ready_wallets WHERE wallet = ?')
    .get(wallet) as { source: ReadySource } | undefined;
  // A member's own claim outranks an admin's note about them.
  if (existing?.source === 'member') return { ok: false, reason: 'claimed' };

  if (await isContract(wallet)) return { ok: false, reason: 'contract' };
  const balanceWei = await balanceOf(wallet);
  if (balanceWei < READY_MIN_WEI) return { ok: false, reason: 'low', balanceWei };

  const seconds = Math.floor(now / 1000);
  db.prepare(
    `INSERT INTO ready_wallets (wallet, user_id, label, source, balance_wei, invite_link, first_seen, last_checked)
     VALUES (?,NULL,?,'external',?,NULL,?,?)
     ON CONFLICT(wallet) DO UPDATE SET label = excluded.label,
       balance_wei = excluded.balance_wei, last_checked = excluded.last_checked`,
  ).run(wallet, label.slice(0, 60), balanceWei.toString(), seconds, seconds);
  return { ok: true, wallet, balanceWei };
}

export function removeExternal(input: string): boolean {
  const wallet = normaliseWallet(input);
  if (!wallet) return false;
  return (
    db.prepare("DELETE FROM ready_wallets WHERE wallet = ? AND source = 'external'").run(wallet)
      .changes > 0
  );
}

export function statusOf(userId: number): ReadyRow | null {
  const row = db
    .prepare('SELECT * FROM ready_wallets WHERE user_id = ?')
    .get(userId) as any;
  return row ? toRow(row) : null;
}

function toRow(r: any): ReadyRow {
  return {
    wallet: r.wallet,
    userId: r.user_id ?? null,
    label: r.label ?? null,
    source: r.source,
    balanceWei: BigInt(r.balance_wei),
    inviteLink: r.invite_link ?? null,
    firstSeen: r.first_seen,
    lastChecked: r.last_checked,
  };
}

export function allRows(): ReadyRow[] {
  return (db.prepare('SELECT * FROM ready_wallets ORDER BY first_seen ASC').all() as any[]).map(toRow);
}

// ---------------------------------------------------------------- balances

/**
 * Re-read every registered balance, ten at a time.
 *
 * Before every post, because a wallet that has been drained is not ready and
 * the total is the only thing anyone sees. Ten concurrent is the same ceiling
 * the rest of the bot uses against this node.
 */
export async function refreshBalances(now = Date.now()): Promise<void> {
  const rows = allRows();
  const seconds = Math.floor(now / 1000);
  const update = db.prepare('UPDATE ready_wallets SET balance_wei = ?, last_checked = ? WHERE wallet = ?');
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10);
    const balances = await Promise.all(
      batch.map((r) => balanceOf(r.wallet).catch(() => null)),
    );
    balances.forEach((wei, j) => {
      // A read that failed leaves the previous figure alone. Writing zero would
      // drop a funded wallet out of the count because the node hiccuped.
      if (wei !== null) update.run(wei.toString(), seconds, batch[j]!.wallet);
    });
  }
}

export interface Totals {
  /** Wallets at or above the minimum. */
  wallets: number;
  /** How many of those an admin added rather than the holder registering. */
  external: number;
  wei: bigint;
}

export function totals(): Totals {
  let wallets = 0;
  let external = 0;
  let wei = 0n;
  for (const r of allRows()) {
    // Below the minimum drops out. The number can go down, and that is the
    // point of re-reading it.
    if (r.balanceWei < READY_MIN_WEI) continue;
    wallets++;
    if (r.source === 'external') external++;
    wei += r.balanceWei;
  }
  return { wallets, external, wei };
}

/** Record today's totals, so "since yesterday" compares against a real row. */
export function snapshot(now = Date.now()): void {
  const t = totals();
  db.prepare(
    `INSERT INTO ready_snapshots (day, wallets, wei) VALUES (?,?,?)
     ON CONFLICT(day) DO UPDATE SET wallets = excluded.wallets, wei = excluded.wei`,
  ).run(Math.floor(now / 86_400_000), t.wallets, t.wei.toString());
}

/** The most recent snapshot from before today, or null when there is none. */
export function yesterday(now = Date.now()): { wallets: number; wei: bigint } | null {
  const today = Math.floor(now / 86_400_000);
  const row = db
    .prepare('SELECT wallets, wei FROM ready_snapshots WHERE day < ? ORDER BY day DESC LIMIT 1')
    .get(today) as { wallets: number; wei: string } | undefined;
  return row ? { wallets: row.wallets, wei: BigInt(row.wei) } : null;
}

/** For tests. */
export function resetReadyCooldowns(): void {
  lastRegistration.clear();
}

// ------------------------------------------------------- invite attribution

/**
 * Which named invite link brought this member in, and when they arrived.
 *
 * Recorded from chat_member updates because that is the only moment Telegram
 * says it: the link name is on the join event and on nothing afterwards. Kept
 * in ready_settings rather than its own table -- it is two scalars per user and
 * only matters at the moment they register.
 */
export function rememberJoin(userId: number, inviteName: string | null, now = Date.now()): void {
  if (inviteName) setSetting(`invite:${userId}`, inviteName.slice(0, 60));
  setSetting(`joined:${userId}`, String(Math.floor(now / 1000)));
}

export function inviteOf(userId: number): string | null {
  return getSetting(`invite:${userId}`);
}

/**
 * Has this user been in the group long enough to be taken seriously?
 *
 * A join we never saw is treated as long-standing rather than brand new: the
 * bot joins a group that already has members, and refusing every one of them
 * for ten minutes after each restart would be the wrong way round.
 */
export function joinedTooRecently(userId: number, now = Date.now()): boolean {
  const at = getSetting(`joined:${userId}`);
  if (!at) return false;
  return now - Number(at) * 1000 < MIN_MEMBERSHIP_MS;
}
