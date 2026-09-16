import { db } from './db.js';
import { normaliseWallet } from './ready.js';

/**
 * Access an admin handed out: no holding, no payment, and a date it stops.
 *
 * Two kinds, one table. A wallet grant opens premium to a wallet the way
 * holding 1,000,000 $VITALS does; a chat grant licenses a group the way a desk
 * holder does. Neither touches the holder path: they are checked first and, if
 * absent or expired, nothing about them is said and the existing tests run
 * exactly as they did.
 *
 * Expiry is a comparison, never a cleanup job. A grant that has passed its date
 * is absent from every read here whether or not anything has pruned it, so a
 * bot that was offline for a month does not wake up handing out access it
 * stopped owing.
 */

export type GrantKind = 'wallet' | 'chat';

/** The longest an admin can hand out in one command. */
export const MAX_GRANT_DAYS = 3650;

export interface Grant {
  kind: GrantKind;
  subject: string;
  expiresAt: number;
  grantedBy: number;
  grantedAt: number;
  note: string | null;
}

const now = () => Math.floor(Date.now() / 1000);

/** The stored form of a subject: wallets lowercase, chats as a plain integer. */
export function normaliseSubject(kind: GrantKind, subject: string): string | null {
  if (kind === 'wallet') {
    const w = normaliseWallet(subject);
    return w ? w.toLowerCase() : null;
  }
  const n = Number(String(subject).trim());
  return Number.isSafeInteger(n) && n !== 0 ? String(n) : null;
}

/**
 * Hand out access, or extend it.
 *
 * Extending adds to whatever is left rather than replacing it, so a second
 * grant to somebody who still has three weeks does not silently take two of
 * them away. From an expired grant the clock starts now.
 */
export function grantAccess(
  kind: GrantKind,
  subject: string,
  days: number,
  grantedBy: number,
  note: string | null = null,
): { ok: true; grant: Grant; extended: boolean } | { ok: false; reason: 'subject' | 'days' } {
  const key = normaliseSubject(kind, subject);
  if (!key) return { ok: false, reason: 'subject' };
  if (!Number.isFinite(days) || days <= 0 || days > MAX_GRANT_DAYS) return { ok: false, reason: 'days' };

  const current = activeGrant(kind, key);
  const from = current ? current.expiresAt : now();
  const expiresAt = from + Math.round(days * 86_400);
  db.prepare(
    `INSERT INTO access_grants (kind, subject, expires_at, granted_by, granted_at, note)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(kind, subject) DO UPDATE SET
       expires_at = excluded.expires_at,
       granted_by = excluded.granted_by,
       granted_at = excluded.granted_at,
       note = excluded.note`,
  ).run(kind, key, expiresAt, grantedBy, now(), note);

  return {
    ok: true,
    extended: current !== null,
    grant: { kind, subject: key, expiresAt, grantedBy, grantedAt: now(), note },
  };
}

/** Take it back. True when there was something to take. */
export function revokeGrant(kind: GrantKind, subject: string): boolean {
  const key = normaliseSubject(kind, subject);
  if (!key) return false;
  return db.prepare('DELETE FROM access_grants WHERE kind = ? AND subject = ?').run(kind, key).changes > 0;
}

/** The grant if it is live right now, else null. Expired rows never surface. */
export function activeGrant(kind: GrantKind, subject: string): Grant | null {
  const key = normaliseSubject(kind, subject);
  if (!key) return null;
  const row = db
    .prepare('SELECT * FROM access_grants WHERE kind = ? AND subject = ? AND expires_at > ?')
    .get(kind, key, now()) as
      | { kind: GrantKind; subject: string; expires_at: number; granted_by: number; granted_at: number; note: string | null }
      | undefined;
  if (!row) return null;
  return {
    kind: row.kind, subject: row.subject, expiresAt: row.expires_at,
    grantedBy: row.granted_by, grantedAt: row.granted_at, note: row.note,
  };
}

/** Every live grant of a kind, soonest to expire first. */
export function liveGrants(kind: GrantKind): Grant[] {
  return (db
    .prepare('SELECT * FROM access_grants WHERE kind = ? AND expires_at > ? ORDER BY expires_at')
    .all(kind, now()) as Array<{
      kind: GrantKind; subject: string; expires_at: number;
      granted_by: number; granted_at: number; note: string | null;
    }>).map((r) => ({
      kind: r.kind, subject: r.subject, expiresAt: r.expires_at,
      grantedBy: r.granted_by, grantedAt: r.granted_at, note: r.note,
    }));
}

/** Whole days left, rounded up: half a day left still reads as a day. */
export function daysLeft(g: Grant, at = Date.now()): number {
  return Math.max(0, Math.ceil((g.expiresAt * 1000 - at) / 86_400_000));
}

/** One line for a status message. */
export function grantLine(g: Grant | null, at = Date.now()): string | null {
  if (!g) return null;
  const d = daysLeft(g, at);
  return `granted by an admin, ${d} day${d === 1 ? '' : 's'} left `
    + `(until ${new Date(g.expiresAt * 1000).toISOString().slice(0, 10)})`;
}

/** Is this group licensed, by purchase or by grant? */
export function groupLicensed(chatId: number): { licensed: boolean; via: 'holder' | 'grant' | null } {
  const held = db.prepare('SELECT user_id FROM licences WHERE chat_id = ?').get(chatId) as { user_id: number } | undefined;
  if (held) return { licensed: true, via: 'holder' };
  if (activeGrant('chat', String(chatId))) return { licensed: true, via: 'grant' };
  return { licensed: false, via: null };
}
