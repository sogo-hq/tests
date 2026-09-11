import { getSetting, setSetting, clearSettingPrefix } from './ready.js';

/**
 * The launch clock.
 *
 * Everything here is pure arithmetic over a unix timestamp and a timezone, so
 * every offset can be tested against a fake clock rather than waited for. The
 * zone is a name, never an offset: September in Bratislava is CEST (UTC+2) and
 * January is CET (UTC+1), and a hardcoded +1 would announce the launch an hour
 * late for seven months of the year and print the wrong abbreviation all summer.
 */
export const LAUNCH_TZ = process.env.LAUNCH_TZ || 'Europe/Bratislava';

/**
 * A number from the environment, where zero is a real value.
 *
 * `Number(env || 15) || 15` reads naturally and is wrong: zero is falsy, so
 * LAUNCH_WINDOW_START=0 became 15 and, with END=12, produced a window that
 * refused every hour of the day while the refusal text cheerfully quoted
 * "15:00 to 12:00 local only". Every launch time an admin proposed was
 * rejected, with nothing pointing at the setting that did it.
 */
export function envNumber(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} is not a number: ${JSON.stringify(raw.slice(0, 40))}`);
  }
  return n;
}

/** Local hours a launch may start in, inclusive of the first, exclusive of the last. */
export const LAUNCH_WINDOW_START_HOUR = envNumber('LAUNCH_WINDOW_START', 15);
export const LAUNCH_WINDOW_END_HOUR = envNumber('LAUNCH_WINDOW_END', 18);

/** Monday through Thursday. Intl weekdays, where 1 is Monday. */
export const LAUNCH_DAYS = [1, 2, 3, 4];

/** No launch may be scheduled after the end of this local day. */
export const LAUNCH_DEADLINE = process.env.LAUNCH_DEADLINE || '2026-09-25';

/**
 * How far local time runs ahead of UTC at a given instant, in minutes.
 *
 * Derived by formatting the instant in the zone and reading the wall clock
 * back, which is the only way to get this right across a DST transition without
 * shipping a timezone database.
 */
function offsetMinutes(utcMs: number, tz = LAUNCH_TZ): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asIfUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
  return (asIfUtc - utcMs) / 60_000;
}

/**
 * A wall-clock time in the launch zone, as a UTC instant.
 *
 * Two passes: the first offset is measured at the naive instant, which is wrong
 * by an hour if the naive instant falls on the other side of a DST change from
 * the real one. Re-measuring at the corrected instant settles it. The only
 * inputs that stay ambiguous are the hour that repeats in autumn and the hour
 * that does not exist in spring, and neither can occur inside a 15:00 to 18:00
 * window on a Monday to Thursday.
 */
export function zonedToUtcMs(
  y: number, month: number, d: number, hh: number, mm: number, tz = LAUNCH_TZ,
): number {
  const naive = Date.UTC(y, month - 1, d, hh, mm);
  // Intl throws RangeError on an invalid instant, and that escaped through
  // parseLaunchTime and grammY's error boundary, so /launch set answered a
  // misconfigured LAUNCH_DEADLINE with total silence.
  if (!Number.isFinite(naive)) return NaN;
  const first = naive - offsetMinutes(naive, tz) * 60_000;
  return naive - offsetMinutes(first, tz) * 60_000;
}

export interface ZonedParts {
  year: number; month: number; day: number; hour: number; minute: number;
  /** 1 = Monday through 7 = Sunday. */
  weekday: number;
  /** CEST or CET, read from the zone rather than assumed. */
  abbrev: string;
}

/**
 * The zone's short name, or an offset when ICU will not name it.
 *
 * Which locale yields "CEST" rather than "GMT+2" is an ICU data question, not a
 * standards one: en-GB names Central European zones and en-US does not, and
 * neither names America/New_York. So the alphabetic answer is taken when one is
 * offered and a plain UTC offset is used otherwise. "UTC+2" is never wrong,
 * which a guessed "CEST" would be for half the world's zones.
 */
function zoneAbbrev(utcMs: number, tz: string): string {
  for (const locale of ['en-GB', 'en-US']) {
    const v = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(utcMs))
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (/^[A-Za-z]{2,5}$/.test(v)) return v;
  }
  const mins = offsetMinutes(utcMs, tz);
  const sign = mins < 0 ? '-' : '+';
  const a = Math.abs(mins);
  const hh = Math.floor(a / 60);
  const mm = a % 60;
  return `UTC${sign}${hh}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`;
}

export function zonedParts(utcMs: number, tz = LAUNCH_TZ): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const n = (t: string) => Number(v(t));
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    year: n('year'), month: n('month'), day: n('day'),
    hour: n('hour') % 24, minute: n('minute'),
    weekday: days.indexOf(v('weekday')) + 1,
    abbrev: zoneAbbrev(utcMs, tz),
  };
}

export type LaunchTimeResult =
  | { ok: true; at: number }
  | { ok: false; reason: string };

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Parse and validate an admin's launch time.
 *
 * Every refusal names the rule it broke and the value that broke it. An admin
 * setting a launch at the wrong hour needs to know which hour is wrong, not
 * that something was.
 */
export function parseLaunchTime(input: string, now = Date.now(), tz = LAUNCH_TZ): LaunchTimeResult {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!m) return { ok: false, reason: 'could not read that time. use: /launch set 2026-09-22 16:00' };
  const [y, mo, d, hh, mm] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) {
    return { ok: false, reason: 'that is not a real date or time' };
  }

  const at = zonedToUtcMs(y, mo, d, hh, mm, tz);
  if (!Number.isFinite(at)) return { ok: false, reason: `${input.trim()} is not a real date` };
  const p = zonedParts(at, tz);
  // A date like 2026-09-31 rolls over silently, so it is caught by reading the
  // instant back rather than by counting days per month here.
  if (p.year !== y || p.month !== mo || p.day !== d) {
    return { ok: false, reason: `${input.trim()} is not a real date` };
  }
  // An ICU build whose short weekday names do not match the lookup table would
  // give weekday 0, which is in no list and would read as a nameless refusal.
  if (p.weekday < 1 || p.weekday > 7) {
    return { ok: false, reason: 'could not read the day of the week for that date' };
  }
  if (at <= now) return { ok: false, reason: 'that time has already passed' };

  if (!LAUNCH_DAYS.includes(p.weekday)) {
    return {
      ok: false,
      reason: `${DAY_NAMES[p.weekday - 1]} is not a launch day. Monday to Thursday only`,
    };
  }
  if (p.hour < LAUNCH_WINDOW_START_HOUR || p.hour >= LAUNCH_WINDOW_END_HOUR) {
    return {
      ok: false,
      reason: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${p.abbrev} is outside the window. ` +
        `${LAUNCH_WINDOW_START_HOUR}:00 to ${LAUNCH_WINDOW_END_HOUR}:00 local only`,
    };
  }

  const [dy, dm, dd] = LAUNCH_DEADLINE.split('-').map(Number) as [number, number, number];
  if (![dy, dm, dd].every(Number.isFinite)) {
    // The operator's mistake, said out loud rather than thrown into silence.
    return { ok: false, reason: `LAUNCH_DEADLINE is not a date: ${LAUNCH_DEADLINE}. expected YYYY-MM-DD` };
  }
  // The deadline is a whole local day, so the cutoff is the start of the day
  // after it. 2026-09-25 at 17:00 is allowed; 2026-09-26 at any hour is not.
  // Note the two rules are independent and the weekday one usually bites first:
  // 2026-09-25 is a Friday, so the last slot this cutoff actually allows is
  // Thursday the 24th. The refusal says which rule was broken rather than
  // implying the cutoff date is bookable.
  const cutoff = zonedToUtcMs(dy, dm, dd + 1, 0, 0, tz);
  if (!Number.isFinite(cutoff)) {
    return { ok: false, reason: `LAUNCH_DEADLINE is not a date: ${LAUNCH_DEADLINE}. expected YYYY-MM-DD` };
  }
  if (at >= cutoff) {
    return { ok: false, reason: `${input.trim()} is past the ${LAUNCH_DEADLINE} cutoff` };
  }
  return { ok: true, at };
}

/** `launch: 2026-09-22 16:00 CEST`, with the abbreviation read from the zone. */
export function launchTimeLine(at: number, tz = LAUNCH_TZ): string {
  const p = zonedParts(at, tz);
  const two = (n: number) => String(n).padStart(2, '0');
  return `launch: ${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)} ${p.abbrev}`;
}

/**
 * The second fixed line on every countdown post.
 *
 * Fixed on purpose. It is the sentence that has to be identical every time so
 * that a fake posted five minutes early does not read like one more variation
 * on a theme the group has been seeing all week.
 */
export const CA_NOTICE = 'CA lands here 3 s after launch. anything before that is fake.';

export interface CountdownOffset {
  /** Seconds before launch. */
  seconds: number;
  /** The key this post is recorded under, so it fires exactly once. */
  key: string;
  label: string;
}

export const COUNTDOWN_OFFSETS: CountdownOffset[] = [
  { key: 'T-5d', seconds: 5 * 86_400, label: '5 days' },
  { key: 'T-4d', seconds: 4 * 86_400, label: '4 days' },
  { key: 'T-3d', seconds: 3 * 86_400, label: '3 days' },
  { key: 'T-2d', seconds: 2 * 86_400, label: '2 days' },
  { key: 'T-24h', seconds: 24 * 3_600, label: '24 hours' },
  { key: 'T-12h', seconds: 12 * 3_600, label: '12 hours' },
  { key: 'T-6h', seconds: 6 * 3_600, label: '6 hours' },
  { key: 'T-1h', seconds: 3_600, label: '1 hour' },
  { key: 'T-10min', seconds: 600, label: '10 minutes' },
];

/**
 * Which countdown post is due, if any.
 *
 * Returns the CLOSEST unposted offset that has come due, not the earliest. A
 * bot that was down from T-5d to T-2d must not wake up and fire four posts in a
 * row: the group would get a wall of stale countdowns, and the only one that
 * was ever true is the last. The skipped ones are marked as posted by the
 * caller so they never fire late.
 */
export function dueCountdown(
  launchAt: number, now: number, isPosted: (key: string) => boolean,
): { due: CountdownOffset; skipped: CountdownOffset[] } | null {
  const left = launchAt - now;
  if (left <= 0) return null;
  const reached = COUNTDOWN_OFFSETS.filter((o) => left <= o.seconds * 1000 && !isPosted(o.key));
  if (!reached.length) return null;
  // COUNTDOWN_OFFSETS runs furthest-out first, so the closest is last.
  const due = reached[reached.length - 1]!;
  return { due, skipped: reached.slice(0, -1) };
}

/**
 * One countdown post: the live READY block, then the two fixed lines.
 *
 * The block is passed in rather than read here so this stays pure arithmetic
 * and string work, testable against a fake clock with no database and no chain.
 *
 * Exactly the two fixed lines the spec names, plus the declared count when
 * there is one. No "T-2d" label: the absolute time is on the line above it, and
 * a relative label is one more thing that has to be right.
 */
export function countdownPost(block: string, at: number, tz = LAUNCH_TZ): string {
  const lines = [block, launchTimeLine(at, tz), CA_NOTICE];
  const declared = declaredCount();
  if (declared !== null) lines.push(`declared launches so far: ${declared.toLocaleString()}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------- storage

export interface LaunchPlan {
  at: number;
  name: string | null;
  deployer: string | null;
  /** The token address, once the launch has actually landed. */
  ca: string | null;
  /** Message id of the pinned CA post, so the countdown pin can be replaced. */
  pinned: number | null;
}

export function getLaunchPlan(): LaunchPlan | null {
  const at = Number(getSetting('launch_at') || 0);
  if (!at) return null;
  const pinned = Number(getSetting('launch_pinned') || 0);
  return {
    // Stored in seconds by /launch set, as everything else in this table is.
    at: at * 1000,
    // `|| null` rather than `??`: clearing a setting writes an EMPTY STRING
    // rather than deleting the row, and an empty string is not null. Read with
    // `??`, a cancelled-then-rebooked launch left plan.ca as '' and the guard's
    // `plan.ca === null` test went false, switching the guard off at launch
    // time with no CA known: the exact moment a fake is most believed.
    name: getSetting('launch_name') || null,
    deployer: getSetting('launch_deployer') || null,
    ca: getSetting('launch_ca') || null,
    pinned: pinned || null,
  };
}

export function clearLaunchPlan(): void {
  for (const k of [
    'launch_at', 'launch_name', 'launch_deployer', 'launch_ca', 'launch_pinned',
    'launch_scanned', 'launch_fulled', 'launch_detected_at',
    // The pin slots too. Left behind, countdown_pinned would make the first
    // post of the NEXT launch unpin a message from the cancelled one.
    'countdown_pinned', 'countdown_pinned_stale', 'launch_pinned_stale',
  ]) {
    setSetting(k, '');
  }
  resetCountdownMarks();
  // The guard's per-user ledger belongs to the launch it was kept for. Carried
  // over, somebody warned once months ago is muted for 24 hours on their first
  // message of the next launch, with no warning and no idea why.
  clearSettingPrefix('ca_offence:');
  clearSettingPrefix('ca_msg:');
}

/**
 * How many launches have been declared.
 *
 * Section 7 will store these. Until it exists the figure comes from the
 * environment, and an unset variable means the line is omitted rather than
 * printed as zero: "declared launches so far: 0" is a claim, and an unset
 * variable is not a measurement of anything.
 */
/**
 * Forget which countdown posts have gone out.
 *
 * Called when a launch is cancelled AND when its time is changed. A postponed
 * launch that kept its ledger lost every offset already consumed against the
 * old time: move a launch back by a day and T-2d, T-24h and the rest are
 * already marked, so the group gets nothing more and the pinned post still
 * shows the old time.
 */
export function resetCountdownMarks(): void {
  for (const o of COUNTDOWN_OFFSETS) setSetting(`countdown:${o.key}`, '');
}

export function declaredCount(): number | null {
  const raw = (process.env.DECLARED_COUNT ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}
