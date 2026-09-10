import { db } from './db.js';

/**
 * What the three markers mean, said once.
 *
 * A first-time user reads a card before they read any documentation, so the
 * card has to be legible on its own -- and the one thing it cannot convey by
 * itself is that a missing marker is not an all-clear. That is the whole
 * distinction this product is built on, and it is invisible unless stated.
 *
 * Five lines. It appears once per user and on request, never repeatedly.
 */
export const LEGEND = [
  '\u{1F6A9} a finding — something the chain shows, stated as a fact',
  '◌ undetermined — the check could not be answered from the data',
  'no marker — that check found nothing',
  'index median — the same measure across every launch indexed, with its n',
  'no finding ≠ clean. vitals reports; you decide.',
].join('\n');

/**
 * Claim the one-time showing for this user.
 *
 * Returns false if they have already been shown it. Recorded before sending, so
 * a crash between the two costs a legend rather than repeating it -- the failure
 * this exists to avoid is a bot that keeps explaining itself.
 */
export function claimLegend(userId: number, now = Math.floor(Date.now() / 1000)): boolean {
  const row = db
    .prepare('SELECT legend_at FROM dm_chats WHERE user_id = ?')
    .get(userId) as { legend_at: number | null } | undefined;
  if (row?.legend_at) return false;

  // The row may not exist yet: somebody can reach a card before the middleware
  // has recorded a DM for them.
  db.prepare(
    `INSERT INTO dm_chats (user_id, chat_id, seen_at, legend_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET legend_at = excluded.legend_at`,
  ).run(userId, 0, now, now);
  return true;
}

/** For tests. */
export function resetLegend(userId: number): void {
  db.prepare('UPDATE dm_chats SET legend_at = NULL WHERE user_id = ?').run(userId);
}
