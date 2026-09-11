import { getAddress, isAddress, type Address } from 'viem';
import { client } from './chain.js';
import { erc20Abi } from './abi.js';
import { db } from './db.js';
import { getSetting, setSetting, normaliseWallet } from './ready.js';

/**
 * What holding $VITALS unlocks.
 *
 * Access, not yield. The token is read for a balance and nothing else: no
 * price, no value, no claim about what the balance is worth. A tier is a key,
 * and the only question asked of the chain is whether the key turns.
 */
export type Tier = 'none' | 'watch' | 'premium' | 'desk';

/** Ascending. Index order IS the comparison, so a new tier slots in here. */
export const TIER_ORDER: Tier[] = ['none', 'watch', 'premium', 'desk'];

export function atLeast(have: Tier, want: Tier): boolean {
  return TIER_ORDER.indexOf(have) >= TIER_ORDER.indexOf(want);
}

/** Whole tokens, not wei. The thresholds are statements about the token's units. */
export const DEFAULT_THRESHOLDS: Record<Exclude<Tier, 'none'>, bigint> = {
  watch: 250_000n,
  premium: 1_000_000n,
  desk: 10_000_000n,
};

const THRESHOLD_KEY = (t: Exclude<Tier, 'none'>) => `tier_min_${t}`;

export function thresholds(): Record<Exclude<Tier, 'none'>, bigint> {
  const read = (t: Exclude<Tier, 'none'>): bigint => {
    const raw = getSetting(THRESHOLD_KEY(t));
    if (!raw) return DEFAULT_THRESHOLDS[t];
    try {
      return BigInt(raw);
    } catch (err) {
      // A stored value that will not parse is a corrupted setting, not a reason
      // to deny access: fall back to the shipped default and say so once.
      console.warn(`[tiers] ${THRESHOLD_KEY(t)} is not a number, using the default:`, raw.slice(0, 40));
      return DEFAULT_THRESHOLDS[t];
    }
  };
  return { watch: read('watch'), premium: read('premium'), desk: read('desk') };
}

export type ThresholdResult =
  | { ok: true; tier: Exclude<Tier, 'none'>; from: bigint; to: bigint }
  | { ok: false; reason: 'raise'; current: bigint }
  | { ok: false; reason: 'unknown-tier' | 'not-a-number' };

/**
 * Lower a threshold. Never raise one.
 *
 * A threshold that can go up can take access away from people who bought in
 * order to have it, on an admin's say-so and with no notice. Down is a promise
 * that can be kept; up is one that cannot, so the command refuses rather than
 * asking for confirmation.
 */
export function setThreshold(tier: string, value: string): ThresholdResult {
  if (tier !== 'watch' && tier !== 'premium' && tier !== 'desk') {
    return { ok: false, reason: 'unknown-tier' };
  }
  const cleaned = value.replace(/[_,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) return { ok: false, reason: 'not-a-number' };
  const next = BigInt(cleaned);
  const current = thresholds()[tier];
  if (next > current) return { ok: false, reason: 'raise', current };
  setSetting(THRESHOLD_KEY(tier), next.toString());
  return { ok: true, tier, from: current, to: next };
}

/**
 * The $VITALS contract.
 *
 * Set by an admin after launch rather than compiled in, because it does not
 * exist when this ships. Never resolved from a search or a message: a lookalike
 * here would gate every tier on somebody else's supply.
 */
export function vitalsToken(): Address | null {
  const raw = (getSetting('vitals_token') ?? process.env.VITALS_TOKEN_ADDRESS ?? '').trim();
  if (!raw) return null;
  const norm = normaliseWallet(raw);
  return norm ? getAddress(norm) : null;
}

export function setVitalsToken(input: string): Address | null {
  const norm = normaliseWallet(input);
  if (!norm) return null;
  setSetting('vitals_token', norm);
  balanceCache.clear();
  return getAddress(norm);
}

// ------------------------------------------------------------------ balances

export const BALANCE_TTL_MS = Number(process.env.TIER_BALANCE_TTL_MS || 600_000) || 600_000;

const balanceCache = new Map<string, { at: number; whole: bigint }>();

/** For tests, and for a token change to take effect immediately. */
export function resetBalanceCache(): void {
  balanceCache.clear();
}

/**
 * Whole $VITALS held, or null when the chain could not be read.
 *
 * Cached for ten minutes and consulted on every gated action, so a holder who
 * sells does not keep their tier for longer than that, and a bot serving a
 * thousand members does not read a thousand balances per command.
 *
 * Null is NOT zero. A failed read must never read as "you do not hold enough".
 */
export async function vitalsBalance(wallet: string, now = Date.now()): Promise<bigint | null> {
  const token = vitalsToken();
  if (!token) return null;
  const key = `${token.toLowerCase()}:${wallet.toLowerCase()}`;
  const hit = balanceCache.get(key);
  if (hit && now - hit.at < BALANCE_TTL_MS) return hit.whole;
  try {
    const [raw, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet as Address] }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    const whole = (raw as bigint) / 10n ** BigInt(Number(decimals));
    balanceCache.set(key, { at: now, whole });
    return whole;
  } catch (err) {
    console.warn('[tiers] balance unreadable:', String((err as Error)?.message ?? err).slice(0, 120));
    return null;
  }
}

export function tierForBalance(whole: bigint): Tier {
  const t = thresholds();
  if (whole >= t.desk) return 'desk';
  if (whole >= t.premium) return 'premium';
  if (whole >= t.watch) return 'watch';
  return 'none';
}

// -------------------------------------------------------------------- grants

export interface Grant {
  tier: Tier;
  expiresAt: number;
  source: 'payment' | 'admin';
}

export function grantOf(userId: number, now = Date.now()): Grant | null {
  const row = db
    .prepare('SELECT tier, expires_at, source FROM tier_grants WHERE user_id = ?')
    .get(userId) as { tier: string; expires_at: number; source: 'payment' | 'admin' } | undefined;
  if (!row) return null;
  if (row.expires_at * 1000 <= now) return null;
  return { tier: row.tier as Tier, expiresAt: row.expires_at * 1000, source: row.source };
}

/**
 * Grant a tier until a date.
 *
 * Extends rather than replaces when the holder already has time left: somebody
 * who pays twice in a month has bought two months, and overwriting would take
 * the first one back.
 */
export function grant(
  userId: number, tier: Tier, days: number, source: 'payment' | 'admin', from = Date.now(),
): Grant {
  const existing = grantOf(userId, from);
  const base = existing && existing.tier === tier ? existing.expiresAt : from;
  const expiresAt = base + days * 86_400_000;
  db.prepare(
    `INSERT INTO tier_grants (user_id, tier, expires_at, source, granted_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, expires_at = excluded.expires_at,
       source = excluded.source, granted_at = excluded.granted_at`,
  ).run(userId, tier, Math.floor(expiresAt / 1000), source, Math.floor(from / 1000));
  return { tier, expiresAt, source };
}

export function revokeGrant(userId: number): boolean {
  return db.prepare('DELETE FROM tier_grants WHERE user_id = ?').run(userId).changes > 0;
}

// ---------------------------------------------------------------- resolution

export type TierResolution =
  | { state: 'ok'; tier: Tier; via: 'balance' | 'grant'; balance: bigint | null; grantUntil: number | null }
  /** No proven wallet. Not a refusal: nobody has been measured yet. */
  | { state: 'unlinked' }
  /** The chain could not be read, or no token is configured. Never a denial. */
  | { state: 'undetermined'; reason: string };

/**
 * The tier this Telegram user actually has, right now.
 *
 * A grant and a balance are both real routes, so the higher of the two wins:
 * somebody who paid for PREMIUM and then bought 10M tokens is DESK, and
 * somebody whose tokens fell below PREMIUM keeps the month they paid for.
 */
export async function tierOf(userId: number, now = Date.now()): Promise<TierResolution> {
  const g = grantOf(userId, now);
  const wallet = linkedWallet(userId);

  if (!wallet) {
    return g
      ? { state: 'ok', tier: g.tier, via: 'grant', balance: null, grantUntil: g.expiresAt }
      : { state: 'unlinked' };
  }
  if (!vitalsToken()) {
    return g
      ? { state: 'ok', tier: g.tier, via: 'grant', balance: null, grantUntil: g.expiresAt }
      : { state: 'undetermined', reason: '$VITALS is not configured on this bot yet' };
  }
  const whole = await vitalsBalance(wallet, now);
  if (whole === null) {
    return g
      ? { state: 'ok', tier: g.tier, via: 'grant', balance: null, grantUntil: g.expiresAt }
      : { state: 'undetermined', reason: 'your balance could not be read' };
  }
  const held = tierForBalance(whole);
  if (g && TIER_ORDER.indexOf(g.tier) > TIER_ORDER.indexOf(held)) {
    return { state: 'ok', tier: g.tier, via: 'grant', balance: whole, grantUntil: g.expiresAt };
  }
  return { state: 'ok', tier: held, via: 'balance', balance: whole, grantUntil: g?.expiresAt ?? null };
}

/** The wallet this user has PROVEN they control. */
export function linkedWallet(userId: number): string | null {
  const row = db.prepare('SELECT wallet FROM holder_links WHERE user_id = ?').get(userId) as
    | { wallet: string } | undefined;
  return row?.wallet ?? null;
}

export function holderOfWallet(wallet: string): number | null {
  const row = db.prepare('SELECT user_id FROM holder_links WHERE wallet = ?').get(wallet.toLowerCase()) as
    | { user_id: number } | undefined;
  return row?.user_id ?? null;
}
