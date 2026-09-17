import { db } from './db.js';

/**
 * The seats.
 *
 * A seat is a number, a handle, a tier and a wallet. The number is what the
 * room sees and the wallet is what the ledger pays, and those two facts are
 * kept apart on purpose: the public roster carries seat, handle and tier, and
 * never a wallet. Nothing in this module renders a wallet into anything that
 * could be posted to a group.
 *
 * Shares are stored on the row rather than derived from the tier when they are
 * needed. Changing what a tier is worth then changes what people earn from the
 * next run onward and leaves every run already paid exactly as it was paid.
 */

export type Tier = 'T1' | 'T2' | 'T3';

/** What a tier is worth today. Changing these does not rewrite any history. */
export const TIER_SHARES: Record<Tier, number> = { T1: 5, T2: 2, T3: 1 };

export const TIERS: readonly Tier[] = ['T1', 'T2', 'T3'];

export function isTier(s: string): s is Tier {
  return (TIERS as readonly string[]).includes(s.toUpperCase());
}

export interface Seat {
  seat: number;
  handle: string;
  tier: Tier;
  shares: number;
  wallet: string;
  joinedAt: number;
  removedAt: number | null;
  /** What this seat is for, admin only. Never leaves a DM. */
  note: string | null;
}

/** Leading @ dropped, trimmed. The stored form is what was typed, less the @. */
export function normaliseHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim();
}

const HANDLE = /^[A-Za-z0-9_]{2,32}$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;

function rowToSeat(r: any): Seat {
  return {
    seat: r.seat, handle: r.handle, tier: r.tier, shares: r.shares,
    wallet: r.wallet, joinedAt: r.joined_at, removedAt: r.removed_at ?? null,
    note: r.note ?? null,
  };
}

export function liveSeats(): Seat[] {
  return (db.prepare('SELECT * FROM seats WHERE removed_at IS NULL ORDER BY seat').all() as any[]).map(rowToSeat);
}

export function allSeats(): Seat[] {
  return (db.prepare('SELECT * FROM seats ORDER BY seat').all() as any[]).map(rowToSeat);
}

export function seatOf(handle: string): Seat | null {
  const r = db
    .prepare('SELECT * FROM seats WHERE handle_key = ? AND removed_at IS NULL')
    .get(normaliseHandle(handle).toLowerCase());
  return r ? rowToSeat(r) : null;
}

/**
 * The next seat number: the lowest free one, or one past the highest.
 *
 * A removal frees the seat, so the number comes round again rather than the
 * roster growing a gap for every person who ever left. The history is what
 * disambiguates seat 7, and every event carries the handle it happened to.
 */
export function nextSeatNumber(): number {
  const taken = new Set(
    (db.prepare('SELECT seat FROM seats WHERE removed_at IS NULL').all() as { seat: number }[]).map((r) => r.seat),
  );
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

const logEvent = db.prepare(
  `INSERT INTO seat_events (seat, handle, event, from_tier, to_tier, wallet, at, by_user)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

export type RosterResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function addSeat(
  rawHandle: string, rawTier: string, rawWallet: string,
  opts: { at?: number; by?: number } = {},
): RosterResult<Seat> {
  const handle = normaliseHandle(rawHandle);
  const tier = rawTier.trim().toUpperCase();
  const wallet = rawWallet.trim();
  if (!HANDLE.test(handle)) return { ok: false, reason: `${JSON.stringify(rawHandle)} is not a handle: letters, digits and underscores, 2 to 32 of them` };
  if (!isTier(tier)) return { ok: false, reason: `${rawTier} is not a tier: T1, T2 or T3` };
  if (!WALLET.test(wallet)) return { ok: false, reason: `${rawWallet} is not a wallet address` };
  const existing = seatOf(handle);
  if (existing) return { ok: false, reason: `${handle} already holds seat ${existing.seat}. /seat tier changes the tier` };
  // A wallet on two seats pays the same person twice from one pool, which is
  // the kind of thing nobody notices in a table of twenty rows.
  const clash = liveSeats().find((s) => s.wallet.toLowerCase() === wallet.toLowerCase());
  if (clash) return { ok: false, reason: `that wallet already holds seat ${clash.seat} (${clash.handle})` };

  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const seat = nextSeatNumber();
  const shares = TIER_SHARES[tier as Tier];
  db.prepare(
    `INSERT INTO seats (seat, handle, handle_key, tier, shares, wallet, joined_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(seat) DO UPDATE SET
       handle = excluded.handle, handle_key = excluded.handle_key, tier = excluded.tier,
       shares = excluded.shares, wallet = excluded.wallet, joined_at = excluded.joined_at,
       removed_at = NULL, note = NULL`,
  ).run(seat, handle, handle.toLowerCase(), tier, shares, wallet, at);
  logEvent.run(seat, handle, 'add', null, tier, wallet, at, opts.by ?? null);
  return { ok: true, value: { seat, handle, tier: tier as Tier, shares, wallet, joinedAt: at, removedAt: null, note: null } };
}

export function setTier(
  rawHandle: string, rawTier: string, opts: { at?: number; by?: number } = {},
): RosterResult<{ seat: Seat; from: Tier }> {
  const handle = normaliseHandle(rawHandle);
  const tier = rawTier.trim().toUpperCase();
  if (!isTier(tier)) return { ok: false, reason: `${rawTier} is not a tier: T1, T2 or T3` };
  const seat = seatOf(handle);
  if (!seat) return { ok: false, reason: `${handle} does not hold a seat` };
  if (seat.tier === tier) return { ok: false, reason: `${handle} is already ${tier}` };

  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const shares = TIER_SHARES[tier as Tier];
  db.prepare('UPDATE seats SET tier = ?, shares = ? WHERE seat = ?').run(tier, shares, seat.seat);
  logEvent.run(seat.seat, handle, 'tier', seat.tier, tier, null, at, opts.by ?? null);
  return { ok: true, value: { seat: { ...seat, tier: tier as Tier, shares }, from: seat.tier } };
}

export function removeSeat(rawHandle: string, opts: { at?: number; by?: number } = {}): RosterResult<Seat> {
  const handle = normaliseHandle(rawHandle);
  const seat = seatOf(handle);
  if (!seat) return { ok: false, reason: `${handle} does not hold a seat` };
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  db.prepare('UPDATE seats SET removed_at = ? WHERE seat = ?').run(at, seat.seat);
  logEvent.run(seat.seat, handle, 'remove', seat.tier, null, null, at, opts.by ?? null);
  return { ok: true, value: { ...seat, removedAt: at } };
}

/** Bounded so the admin table stays a table rather than becoming a document. */
export const MAX_SEAT_NOTE = 120;

export type NoteResult =
  | { ok: true; seat: number; note: string; cleared: boolean }
  | { ok: false; reason: 'no-seat' | 'too-long' };

/**
 * Record what a seat is for.
 *
 * Kept out of every view that can reach a group. A note is written about
 * somebody rather than to them, and the roster the room sees already carries
 * no wallet for the same reason.
 */
export function setSeatNote(seatNumber: number, raw: string): NoteResult {
  const note = raw.trim().replace(/\s+/g, ' ');
  if (note.length > MAX_SEAT_NOTE) return { ok: false, reason: 'too-long' };
  const live = db.prepare('SELECT seat FROM seats WHERE seat = ? AND removed_at IS NULL').get(seatNumber);
  if (!live) return { ok: false, reason: 'no-seat' };
  db.prepare('UPDATE seats SET note = ? WHERE seat = ?').run(note || null, seatNumber);
  return { ok: true, seat: seatNumber, note, cleared: note === '' };
}

export interface SeatEvent {
  seat: number; handle: string; event: 'add' | 'tier' | 'remove';
  fromTier: Tier | null; toTier: Tier | null; at: number;
}

export function seatHistory(seatNumber?: number): SeatEvent[] {
  const rows = seatNumber === undefined
    ? db.prepare('SELECT * FROM seat_events ORDER BY at, id').all()
    : db.prepare('SELECT * FROM seat_events WHERE seat = ? ORDER BY at, id').all(seatNumber);
  return (rows as any[]).map((r) => ({
    seat: r.seat, handle: r.handle, event: r.event,
    fromTier: r.from_tier ?? null, toTier: r.to_tier ?? null, at: r.at,
  }));
}

export function totalShares(seats = liveSeats()): number {
  return seats.reduce((a, s) => a + s.shares, 0);
}

/** Short form of a wallet, for the admin table. Never for a group. */
export function shortWallet(w: string): string {
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * The admin table: every column, wallets included. DM only.
 *
 * The caller is responsible for that. This module cannot see what chat it is
 * being rendered into, so the one function that includes a wallet says so in
 * its name and the public one below has no way to emit one.
 */
export function seatTableForAdmin(seats = liveSeats()): string {
  if (!seats.length) return 'no seats yet. /seat add <handle> <tier> <wallet>';
  const lines = seats.flatMap((s) => {
    const row = `${String(s.seat).padStart(3)}  ${s.handle.padEnd(16)} ${s.tier}  ${String(s.shares).padStart(2)}sh  ${shortWallet(s.wallet)}  ${day(s.joinedAt)}`;
    // On its own line, indented under the seat: a note is a sentence and does
    // not fit a column without truncating the thing it was written to say.
    return s.note ? [row, `     ${s.note}`] : [row];
  });
  const byTier = TIERS.map((t) => `${t} ${seats.filter((s) => s.tier === t).length}`).join(' · ');
  return [
    `seat  handle           tier shares wallet          joined`,
    ...lines,
    '',
    `${seats.length} seat${seats.length === 1 ? '' : 's'} · ${byTier} · ${totalShares(seats)} shares`,
  ].join('\n');
}

/**
 * The public roster: seat, handle, tier.
 *
 * No wallet, no share count, no amount. It is posted into a room, and a table
 * that pairs a handle with an address is a table that says who holds what.
 */
export function publicRoster(seats = liveSeats()): string {
  if (!seats.length) return 'no seats yet';
  const lines = seats.map((s) => `${String(s.seat).padStart(3)}  ${s.handle.padEnd(16)} ${s.tier}`);
  const byTier = TIERS.map((t) => `${t} ${seats.filter((s) => s.tier === t).length}`).join(' · ');
  return ['roster', ...lines, '', `${seats.length} seat${seats.length === 1 ? '' : 's'} · ${byTier}`].join('\n');
}
