import { db } from './db.js';
import { checkSponsorText } from './sponsor.js';

/**
 * One line at the very bottom of a card, about the tool's own launch.
 *
 * This is the only line on a card that is about VITALS rather than about the
 * token being scanned, and it is the one place the product could most easily
 * start selling itself inside its own output. So it is constrained the same way
 * the paid line is, and in two extra ways:
 *
 *   It is LAST. Below the paid line, below the footer, below everything. A
 *   reader who stops at the disclaimer has read the whole card.
 *
 *   It EXPIRES. LAUNCH_NOTICE_UNTIL is read at send time, so the line stops
 *   appearing on its own date and nobody has to remember to redeploy. A notice
 *   about a launch that already happened is the kind of thing that sits on a
 *   product for a year.
 *
 * It goes through the same content check the paid line does. Our own line is
 * not exempt from the rule that nothing on a card makes a call: "$VITALS is
 * live: 0x..." is a fact and passes, and anything that reads as advice is
 * dropped and logged rather than quietly rendered.
 */

function configured(): string {
  return (process.env.LAUNCH_NOTICE ?? '').trim();
}

function configuredUntil(): string {
  return (process.env.LAUNCH_NOTICE_UNTIL ?? '').trim();
}

type State =
  | { kind: 'approved'; raw: string; until: string; line: string; expiresAt: number | null }
  | { kind: 'rejected'; raw: string; until: string };

let state: State | null = null;
let version = 0;

/**
 * Whether the current configuration has been reported yet.
 *
 * Reset when the configuration is, so a change is announced again rather than
 * once per process. Keyed on the pair, because "the line is unset" and "the
 * line is unset and a date is set" are different situations and only the second
 * one is somebody having configured half of this.
 */
let announced: string | null = null;

/**
 * The line the last call actually returned, and the version that tracks it.
 *
 * Bumped on what a card WOULD render, not on what is configured, because those
 * are not the same event: the notice also stops rendering when its date passes,
 * and nothing happens then. Comparing the configuration alone would have left
 * every cached card showing an expired notice until its own TTL ran out.
 */
let lastRendered: string | null = null;

/** Which notice the cards currently in the cache were rendered with. */
export function noticeVersion(): number {
  return version;
}

function rendered(line: string | null): string | null {
  if (line !== lastRendered) {
    lastRendered = line;
    version++;
  }
  return line;
}

/**
 * The end of the day named by LAUNCH_NOTICE_UNTIL, in UTC.
 *
 * A date with no time means the whole of that date, which is what somebody
 * writing "2026-09-24" means: the notice about a launch on the 24th should not
 * vanish at midnight as the 24th begins. A full timestamp is taken as written.
 */
function parseUntil(raw: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = Date.parse(`${raw}T23:59:59.999Z`);
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * The line to print, or null.
 *
 * Synchronous and free, like the paid line: this is on the scan path. Unlike
 * the paid line it never needs the chain, because it names our own token and an
 * address in it is checked by the person who typed it, not by a factory read
 * that would keep the line down on the one day it matters.
 */
export function launchNotice(now = Date.now()): string | null {
  const raw = configured();
  const until = configuredUntil();
  if (!raw) {
    // Unset is not a rejection and must not log like one. It is still said
    // once, because this branch being silent is what made an unset line and a
    // working line indistinguishable from outside the process: no notice on any
    // card, nothing in the log, and LAUNCH_NOTICE_UNTIL set on the dashboard
    // making it look configured. Two days went into that.
    announceOff(until);
    state = null;
    return rendered(null);
  }

  if (!state || state.raw !== raw || state.until !== until) {
    const check = checkSponsorText(raw);
    if (!check.ok) {
      state = { kind: 'rejected', raw, until };
      console.warn(`[notice] REJECTED: ${check.reason}\n          line: ${raw.slice(0, 140)}`);
      return rendered(null);
    }
    const expiresAt = until ? parseUntil(until) : null;
    if (until && expiresAt === null) {
      // A date that will not parse is the failure mode this exists to prevent:
      // taken as "no expiry", a typo would leave a stale notice on every card
      // forever, and nobody would find out from the logs of a working bot.
      state = { kind: 'rejected', raw, until };
      console.warn(`[notice] REJECTED: LAUNCH_NOTICE_UNTIL is not a date: ${until.slice(0, 40)}`);
      return rendered(null);
    }
    state = { kind: 'approved', raw, until, line: raw, expiresAt };
    console.log(
      `[notice] accepted${expiresAt === null ? ', no expiry set' : `, until ${new Date(expiresAt).toISOString()}`}: ${raw.slice(0, 140)}`,
    );
  }

  if (state.kind !== 'approved') return rendered(null);
  // Checked on every call, not once: the whole point of an expiry date is that
  // it takes effect without anything happening.
  if (state.expiresAt !== null && now > state.expiresAt) return rendered(null);
  return rendered(state.line);
}

/**
 * Said once per configuration, never per card.
 *
 * launchNotice() is on the scan path, so a plain console call here would put a
 * line in the log for every card the bot renders.
 */
function announceOff(until: string): void {
  const key = `off:${until}`;
  if (announced === key) return;
  announced = key;
  console.warn(
    '[notice] OFF: LAUNCH_NOTICE is not set, so no card carries a launch notice. '
    + (until
      // The exact shape of the failure this exists to name. A date on its own
      // configures nothing, and it is the half an operator sees on a dashboard.
      ? `LAUNCH_NOTICE_UNTIL is ${JSON.stringify(until)}, which does nothing by itself: `
        + 'the line is what turns the notice on and the date only ends it.'
      : 'LAUNCH_NOTICE_UNTIL is not set either.'),
  );
}

export type NoticeReport = 'on' | 'off' | 'rejected' | 'expired';

/**
 * Report what the notice is doing, for the startup log.
 *
 * Every state says something, including the two that used to say nothing:
 *
 *   off       LAUNCH_NOTICE is unset. No card carries a notice.
 *   expired   the line is set and valid and its date has already passed, so it
 *             is accepted and renders nowhere. "accepted" alone in a boot log
 *             above a bot that shows no notice is the second silence here.
 *   rejected  the line failed the content check. Already loud.
 *   on        it is rendering, with the date it stops.
 *
 * Returns the state so a caller can assert on it rather than on a log line.
 */
export function announceLaunchNotice(now = Date.now()): NoticeReport {
  const raw = configured();
  const until = configuredUntil();
  // Resolves the configuration, which logs accepted or REJECTED on a change and
  // OFF when the line is unset.
  const line = launchNotice(now);
  if (!raw) return 'off';
  if (state?.kind !== 'approved') return 'rejected';
  if (line === null) {
    const key = `expired:${raw}:${until}`;
    if (announced !== key) {
      announced = key;
      console.warn(
        `[notice] EXPIRED: the line is set and valid and LAUNCH_NOTICE_UNTIL ${JSON.stringify(until)} `
        + 'has already passed, so no card carries it. move the date or unset the line.',
      );
    }
    return 'expired';
  }
  const key = `on:${raw}:${until}`;
  if (announced !== key) {
    announced = key;
    console.log(
      `[notice] ON${until ? `, until ${until}` : ', with no expiry set'}: ${line.slice(0, 140)}`,
    );
  }
  return 'on';
}

/** For tests, and for an env change to take effect immediately. */
export function resetLaunchNotice(): void {
  state = null;
  lastRendered = null;
  announced = null;
  version++;
}

/**
 * Claim the one-time showing of the current notice for this user.
 *
 * Keyed on the notice ITSELF, not on a timestamp. The line changes once, from
 * a date to an address, and a user who saw the first would never see the
 * second if this only recorded that they had seen "the notice".
 */
export function claimLaunchNotice(userId: number, line: string): boolean {
  const seen = digest(line);
  const row = db
    .prepare('SELECT launch_notice_seen FROM dm_chats WHERE user_id = ?')
    .get(userId) as { launch_notice_seen: string | null } | undefined;
  if (row?.launch_notice_seen === seen) return false;

  // The row may not exist yet: somebody can reach /start before the middleware
  // has recorded a DM for them.
  db.prepare(
    `INSERT INTO dm_chats (user_id, chat_id, seen_at, launch_notice_seen) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET launch_notice_seen = excluded.launch_notice_seen`,
  ).run(userId, 0, Math.floor(Date.now() / 1000), seen);
  return true;
}

/** Short, stable, and not a hash anyone should read anything into. */
function digest(line: string): string {
  let h = 2166136261;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** For tests. */
export function resetLaunchNoticeSeen(userId: number): void {
  db.prepare('UPDATE dm_chats SET launch_notice_seen = NULL WHERE user_id = ?').run(userId);
}
