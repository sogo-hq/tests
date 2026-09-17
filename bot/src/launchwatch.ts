import { db } from './db.js';

/**
 * The chats that get the CA when the armed launch lands, and when.
 *
 * One launch, several rooms, each on its own clock. The room running the
 * launch takes it at T+3s, the moment the opening tax window closes. A second
 * room takes it a few seconds later, which is enough that the two are not
 * reading each other's screenshots and little enough that nobody is waiting.
 *
 * Each chat is recorded as posted separately. A send that fails in one room
 * must not stop the others, and must not be retried into a room that already
 * has the message: two posts saying "this is the only CA" is exactly the
 * message that cannot be ambiguous.
 */

/** Long enough for any staggering worth doing, short enough to be a mistake if longer. */
export const MAX_WATCH_DELAY_SECONDS = Number(process.env.MAX_WATCH_DELAY_SECONDS || 600) || 600;

export interface LaunchWatcher {
  chatId: number;
  delaySeconds: number;
  addedBy: number | null;
  addedAt: number;
  postedCa: string | null;
  postedMsg: number | null;
  postedAt: number | null;
}

const row = (r: any): LaunchWatcher => ({
  chatId: r.chat_id,
  delaySeconds: r.delay_seconds,
  addedBy: r.added_by ?? null,
  addedAt: r.added_at,
  postedCa: r.posted_ca ?? null,
  postedMsg: r.posted_msg ?? null,
  postedAt: r.posted_at ?? null,
});

/** Every watching chat, soonest first, then by the order they were added. */
export function watchers(): LaunchWatcher[] {
  return (db
    .prepare('SELECT * FROM launch_watchers ORDER BY delay_seconds, added_at')
    .all() as any[]).map(row);
}

export function watcherFor(chatId: number): LaunchWatcher | null {
  const r = db.prepare('SELECT * FROM launch_watchers WHERE chat_id = ?').get(chatId) as any;
  return r ? row(r) : null;
}

export type AddResult =
  | { ok: true; watcher: LaunchWatcher; changed: boolean }
  | { ok: false; reason: 'delay' };

/**
 * Add a chat, or change its delay.
 *
 * Re-running it in a chat that is already watching sets the delay rather than
 * refusing: the second run is somebody correcting the first.
 */
export function addWatcher(
  chatId: number, delaySeconds: number, addedBy: number | null = null,
  now = Math.floor(Date.now() / 1000),
): AddResult {
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_WATCH_DELAY_SECONDS) {
    return { ok: false, reason: 'delay' };
  }
  const delay = Math.round(delaySeconds);
  const before = watcherFor(chatId);
  db.prepare(
    `INSERT INTO launch_watchers (chat_id, delay_seconds, added_by, added_at)
     VALUES (?,?,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET delay_seconds = excluded.delay_seconds`,
  ).run(chatId, delay, addedBy, now);
  return { ok: true, watcher: watcherFor(chatId)!, changed: !before || before.delaySeconds !== delay };
}

export function removeWatcher(chatId: number): boolean {
  return db.prepare('DELETE FROM launch_watchers WHERE chat_id = ?').run(chatId).changes > 0;
}

/** For a new launch: nothing has been posted to anybody yet. */
export function clearWatcherPosts(): void {
  db.prepare('UPDATE launch_watchers SET posted_ca = NULL, posted_msg = NULL, posted_at = NULL').run();
}

export function markWatcherPosted(
  chatId: number, ca: string, messageId: number, now = Math.floor(Date.now() / 1000),
): void {
  db.prepare('UPDATE launch_watchers SET posted_ca = ?, posted_msg = ?, posted_at = ? WHERE chat_id = ?')
    .run(ca.toLowerCase(), messageId, now, chatId);
}

/**
 * The chats to post in, with the old single-chat setting as a fallback.
 *
 * A deployment that never ran /launch watch in a chat still has one place the
 * launch belongs: the group /ready was run in. It is treated as a watcher at
 * zero delay rather than as nothing, so adding this table changes where the CA
 * goes for nobody who has not asked for it to change.
 *
 * Synthetic, not inserted. The table stays a record of what an operator set up
 * rather than of what the bot inferred, and the per-chat claim is what stops a
 * second post either way.
 */
export function effectiveWatchers(fallbackChatId: number | null): LaunchWatcher[] {
  const configured = watchers();
  if (configured.length || fallbackChatId === null) return configured;
  const existing = watcherFor(fallbackChatId);
  if (existing) return [existing];
  return [{
    chatId: fallbackChatId, delaySeconds: 0, addedBy: null, addedAt: 0,
    postedCa: null, postedMsg: null, postedAt: null,
  }];
}

/**
 * Which chats are due the CA right now.
 *
 * Due means its delay has elapsed since the launch was detected and it has not
 * already been told about this CA. Both halves matter: the first is the
 * stagger, the second is what makes a retry safe.
 */
export function dueWatchers(
  ca: string, detectedAtSec: number, nowSec: number, fallbackChatId: number | null = null,
): LaunchWatcher[] {
  const want = ca.toLowerCase();
  return effectiveWatchers(fallbackChatId)
    .filter((w) => w.postedCa !== want && nowSec >= detectedAtSec + w.delaySeconds);
}

/** Chats still waiting on their delay, for a status line. */
export function pendingWatchers(
  ca: string, detectedAtSec: number, nowSec: number, fallbackChatId: number | null = null,
): LaunchWatcher[] {
  const want = ca.toLowerCase();
  return effectiveWatchers(fallbackChatId)
    .filter((w) => w.postedCa !== want && nowSec < detectedAtSec + w.delaySeconds);
}

/** How the status command lists them. */
export function watchersText(now = Math.floor(Date.now() / 1000)): string[] {
  const all = watchers();
  if (!all.length) return ['no chat is watching yet: run /launch watch in each one.'];
  const out = [`${all.length} chat${all.length === 1 ? '' : 's'} watching:`];
  for (const w of all) {
    const when = w.delaySeconds === 0 ? 'immediately' : `after ${w.delaySeconds}s`;
    const posted = w.postedCa
      ? `posted ${w.postedCa.slice(0, 10)}...${w.postedAt ? ` ${Math.max(0, now - w.postedAt)}s ago` : ''}`
      : 'nothing posted yet';
    out.push(`  ${w.chatId}  ${when.padEnd(14)} ${posted}`);
  }
  return out;
}
