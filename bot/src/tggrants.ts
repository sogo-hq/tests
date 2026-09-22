import { db } from './db.js';

/**
 * Premium for a Telegram account, with no wallet and nothing on chain.
 *
 * The existing routes both go through an address: hold 1,000,000 $VITALS, or
 * take a wallet grant. Neither reaches somebody who has not linked a wallet
 * and is not going to, which is most of a room of KOLs. This one is keyed on
 * the user id and nothing else.
 *
 * It grants the person, not the room. A grant applies wherever that account
 * invokes a premium feature, in a DM or in a group, and it never makes the
 * group premium for anybody else. Licensing a group stays /license.
 *
 * Expiry is a comparison, never a cleanup job, the same as access_grants: a
 * row past its date is absent from every read here whether or not anything
 * pruned it, so a bot that was off for a month does not wake up owing access
 * it stopped owing.
 */

/** The longest one command can hand out. Same ceiling as a wallet grant. */
export const MAX_TG_GRANT_DAYS = 3650;

/** How long before the end the ending-soon DM goes out. */
export const REMINDER_DAYS = 3;

/** A grantmany that would be a paste accident rather than a room. */
export const MAX_GRANT_BATCH = 500;

export interface TgGrant {
  userId: number;
  expiresAt: number;
  note: string | null;
  grantedBy: number | null;
  createdAt: number;
  updatedAt: number;
}

const nowSec = () => Math.floor(Date.now() / 1000);

const rowToGrant = (r: any): TgGrant => ({
  userId: r.user_id, expiresAt: r.expires_at, note: r.note ?? null,
  grantedBy: r.granted_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * A Telegram user id.
 *
 * Accepts the shapes an admin actually pastes: a bare number, one behind
 * "tg:", and one somebody typed an @ in front of. Anything else is reported
 * rather than coerced, because a mistyped id is a grant to a stranger.
 */
export function parseUserId(raw: string): number | null {
  const s = String(raw ?? '').trim().replace(/^tg:/i, '').replace(/^@/, '');
  if (!/^\d{1,19}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** True when the argument names a user id rather than a wallet. */
export function isTgSubject(raw: string): boolean {
  return /^tg:/i.test(String(raw ?? '').trim());
}

export interface ParsedIds {
  ids: number[];
  /** Kept in the order they were typed, so the reply can name them. */
  invalid: string[];
  /** Ids that appeared more than once. Counted, not granted twice. */
  duplicates: number;
}

/**
 * The ids out of a pasted block.
 *
 * Newlines, commas, spaces and semicolons all separate, because a list copied
 * out of a spreadsheet, a chat message and a notes app arrive in three
 * different shapes and an admin pasting eighty ids should not have to reformat
 * them. Order is kept and duplicates are dropped rather than granted twice.
 */
export function parseUserIds(text: string): ParsedIds {
  const ids: number[] = [];
  const invalid: string[] = [];
  const seen = new Set<number>();
  let duplicates = 0;
  for (const tok of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const id = parseUserId(tok);
    if (id === null) { invalid.push(tok.slice(0, 32)); continue; }
    if (seen.has(id)) { duplicates++; continue; }
    seen.add(id);
    ids.push(id);
  }
  return { ids, invalid, duplicates };
}

export type GrantOutcome = 'added' | 'extended' | 'unchanged';

export interface GrantResult {
  grant: TgGrant;
  outcome: GrantOutcome;
  /** What it was before, for the audit line. Null when there was nothing. */
  previousExpiry: number | null;
}

/**
 * Grant, or extend to whichever is later.
 *
 * max(current expiry, now + days), never current + days. Running the same
 * grantmany twice is a thing that happens on a launch day, by a second admin
 * or by the same one who is not sure the first went through, and adding would
 * quietly hand out two months for one decision. It also never shortens: a KOL
 * who already has ninety days does not lose them to a thirty day batch.
 */
export function grantTg(
  userId: number,
  days: number,
  opts: { note?: string | null; by?: number | null; at?: number } = {},
): { ok: true; result: GrantResult } | { ok: false; reason: 'user' | 'days' } {
  if (!Number.isSafeInteger(userId) || userId <= 0) return { ok: false, reason: 'user' };
  if (!Number.isFinite(days) || days <= 0 || days > MAX_TG_GRANT_DAYS) return { ok: false, reason: 'days' };

  const at = opts.at ?? nowSec();
  const note = opts.note?.trim() ? opts.note.trim().slice(0, 200) : null;
  const existing = rawGrant(userId);
  const live = existing && existing.expiresAt > at ? existing : null;
  const fresh = at + Math.round(days * 86_400);
  const expiresAt = live ? Math.max(live.expiresAt, fresh) : fresh;

  db.prepare(
    `INSERT INTO premium_tg_grants (user_id, expires_at, note, granted_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       expires_at = excluded.expires_at,
       note = COALESCE(excluded.note, premium_tg_grants.note),
       granted_by = excluded.granted_by,
       updated_at = excluded.updated_at`,
  ).run(userId, expiresAt, note, opts.by ?? null, existing?.createdAt ?? at, at);

  const grant = rawGrant(userId)!;
  const outcome: GrantOutcome = !live ? 'added' : expiresAt > live.expiresAt ? 'extended' : 'unchanged';
  return { ok: true, result: { grant, outcome, previousExpiry: live?.expiresAt ?? null } };
}

/** Take it back. Returns what was removed, so the audit line has the old date. */
export function ungrantTg(userId: number): TgGrant | null {
  const before = rawGrant(userId);
  if (!before) return null;
  db.prepare('DELETE FROM premium_tg_grants WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM premium_tg_reminders WHERE user_id = ?').run(userId);
  return before;
}

/** The row as stored, expired or not. Internal: reads that decide access use activeTgGrant. */
function rawGrant(userId: number): TgGrant | null {
  const r = db.prepare('SELECT * FROM premium_tg_grants WHERE user_id = ?').get(userId);
  return r ? rowToGrant(r) : null;
}

/** The grant if it is live right now, else null. Expired rows never surface. */
export function activeTgGrant(userId: number, at = nowSec()): TgGrant | null {
  const r = db
    .prepare('SELECT * FROM premium_tg_grants WHERE user_id = ? AND expires_at > ?')
    .get(userId, at);
  return r ? rowToGrant(r) : null;
}

/** Every live grant, soonest to expire first. */
export function liveTgGrants(at = nowSec()): TgGrant[] {
  return (db
    .prepare('SELECT * FROM premium_tg_grants WHERE expires_at > ? ORDER BY expires_at, user_id')
    .all(at) as any[]).map(rowToGrant);
}

export function daysLeft(expiresAt: number, at = nowSec()): number {
  return Math.max(0, Math.ceil((expiresAt - at) / 86_400));
}

/** UTC, to the day. Every date this bot prints is a UTC date. */
export function dayStamp(expiresAt: number): string {
  return new Date(expiresAt * 1000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ the DMs

/** Sent once, when the grant lands. No token, because that is the point of it. */
export function grantDmText(expiresAt: number): string {
  return `vitals premium active until ${dayStamp(expiresAt)} UTC. no token needed.`;
}

/** Sent once, three days out. It names both ways to keep it. */
export function endingDmText(expiresAt: number): string {
  return `premium ends ${dayStamp(expiresAt)}. hold 1M $VITALS to keep it, or ask sirius.`;
}

/**
 * Grants inside the reminder window that have not been told yet.
 *
 * Keyed on the expiry it was sent about, so a grant that is extended arms the
 * reminder again for the new date and one that is not is never told twice.
 */
export function remindersDue(at = nowSec()): TgGrant[] {
  const until = at + REMINDER_DAYS * 86_400;
  return (db
    .prepare(
      `SELECT g.* FROM premium_tg_grants g
        WHERE g.expires_at > ? AND g.expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM premium_tg_reminders r
             WHERE r.user_id = g.user_id AND r.expires_at = g.expires_at)
        ORDER BY g.expires_at, g.user_id`,
    )
    .all(at, until) as any[]).map(rowToGrant);
}

/**
 * Record that the reminder went out.
 *
 * Written whether the DM landed or not. A person who has blocked the bot
 * cannot be told, and retrying them every pass for three days is the reminder
 * becoming a loop against somebody who already said no.
 */
export function markReminded(userId: number, expiresAt: number, at = nowSec()): boolean {
  return db
    .prepare('INSERT OR IGNORE INTO premium_tg_reminders (user_id, expires_at, sent_at) VALUES (?,?,?)')
    .run(userId, expiresAt, at).changes > 0;
}

// ---------------------------------------------------------------- the audit

/**
 * One line per change, to the process log.
 *
 * Old and new expiry both, because "extended" without the two dates does not
 * say whether anything happened. This is the only record of who handed out
 * what: the table keeps the current state and the log keeps the decisions.
 */
export function auditLine(
  action: 'grant' | 'extend' | 'ungrant' | 'unchanged',
  opts: { admin: number | null; target: number; oldExpiry: number | null; newExpiry: number | null; note?: string | null },
): string {
  const d = (t: number | null) => (t === null ? 'none' : `${dayStamp(t)} (${t})`);
  return `[premium] ${action} admin=${opts.admin ?? 'unknown'} target=${opts.target} `
    + `old=${d(opts.oldExpiry)} new=${d(opts.newExpiry)}`
    + (opts.note ? ` note=${JSON.stringify(opts.note)}` : '');
}

export function audit(
  action: 'grant' | 'extend' | 'ungrant' | 'unchanged',
  opts: { admin: number | null; target: number; oldExpiry: number | null; newExpiry: number | null; note?: string | null },
): void {
  console.log(auditLine(action, opts));
}

// -------------------------------------------------------- the reminder pass

export interface ReminderSend { userId: number; expiresAt: number; text: string }

/**
 * One pass of the ending-soon DM.
 *
 * Marked as sent whether the DM landed or not, so a person who has blocked
 * the bot is not retried every pass for three days. Silent at expiry itself:
 * the access stops and nothing is said, because a message on the day it ends
 * is an upsell rather than a warning.
 */
export async function runReminderPass(
  send: (userId: number, text: string) => Promise<unknown>,
  at = nowSec(),
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const g of remindersDue(at)) {
    try {
      await send(g.userId, endingDmText(g.expiresAt));
      sent++;
    } catch (err) {
      failed++;
      console.log(`[premium] could not remind ${g.userId}: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
    markReminded(g.userId, g.expiresAt, at);
  }
  if (sent || failed) console.log(`[premium] ending-soon: ${sent} sent, ${failed} could not be reached`);
  return { sent, failed };
}

/** Hourly is often enough for a three day window, and cheap. */
export function startReminderLoop(
  send: (userId: number, text: string) => Promise<unknown>,
  intervalMs = 3_600_000,
): NodeJS.Timeout {
  const t = setInterval(() => {
    void runReminderPass(send).catch((err) => console.warn('[premium] reminder pass failed:', err));
  }, intervalMs);
  t.unref?.();
  return t;
}
