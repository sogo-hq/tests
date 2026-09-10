import { totals, yesterday, getNumber, getSetting, setSetting, READY_MIN_ETH, type Totals } from './ready.js';

/**
 * The public number, and the only thing about registration a group ever sees.
 *
 * Totals only. No wallet, no label, no user id -- asserted in tests for every
 * group-facing command, because this is the promise that makes registering
 * safe and it is one careless template away from being broken.
 */

/** Admins are the only people who may set targets or add wallets. */
export function adminIds(): number[] {
  return (process.env.ADMIN_IDS ?? '')
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function isAdmin(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  const ids = adminIds();
  // An empty ADMIN_IDS grants nothing. A list nobody configured must not mean
  // "everybody is an admin" on a bot that can post to a group.
  return ids.length > 0 && ids.includes(userId);
}

function eth(wei: bigint, dp = 1): string {
  return (Number(wei) / 1e18).toFixed(dp);
}

export interface BlockInput {
  members: number | null;
  now?: number;
  /** Minutes since the figures were read, when serving a cached block. */
  updatedMinutesAgo?: number;
  botUsername?: string;
}

/**
 * The totals block.
 *
 * Targets an admin has not set are omitted rather than shown against a zero:
 * "wallets ready 88 / 0" reads as a target that has been blown past, and no
 * target has been set at all.
 */
export function totalsBlock(input: BlockInput, t: Totals = totals()): string {
  const now = input.now ?? Date.now();
  const target = (key: string) => {
    const v = getNumber(key, 0);
    return v > 0 ? ` / ${v.toLocaleString()}` : '';
  };

  const lines = ['READY FOR LAUNCH'];
  if (input.members !== null) {
    lines.push(`members       ${String(input.members).padStart(5)}${target('gate_members')}`);
  }
  const kols = getNumber('kols', 0);
  if (kols > 0 || getNumber('gate_kols', 0) > 0) {
    lines.push(`kols          ${String(kols).padStart(5)}${target('gate_kols')}`);
  }
  lines.push(
    `wallets ready ${String(t.wallets).padStart(5)}${target('gate_wallets')}` +
      (t.external > 0 ? `   (${t.external} external)` : ''),
  );
  lines.push(`eth ready     ${eth(t.wei).padStart(5)}${target('gate_eth')}`);

  const y = yesterday(now);
  if (y) {
    const dw = t.wallets - y.wallets;
    const de = Number(t.wei - y.wei) / 1e18;
    // Stated in whichever direction it moved. A total that fell is the number
    // doing its job -- a drained wallet is not ready -- and hiding that would
    // make the figure a marketing line rather than a measurement.
    lines.push(
      `${dw >= 0 ? '+' : ''}${dw} wallets · ${de >= 0 ? '+' : ''}${de.toFixed(1)} ETH since yesterday`,
    );
  }

  const bot = input.botUsername ? `@${input.botUsername}` : 'the bot';
  lines.push(
    `count in: DM ${bot} → /ready 0x…  · min ${READY_MIN_ETH} ETH · wallets never shown`,
  );
  if (input.updatedMinutesAgo !== undefined && input.updatedMinutesAgo > 0) {
    lines.push(`updated ${input.updatedMinutesAgo} min ago`);
  }
  return lines.join('\n');
}

/** Has every target an admin set been reached? */
export function gateHit(t: Totals = totals(), members: number | null = null): boolean {
  const targets: [number, number][] = [];
  const add = (key: string, actual: number) => {
    const want = getNumber(key, 0);
    if (want > 0) targets.push([actual, want]);
  };
  if (members !== null) add('gate_members', members);
  add('gate_kols', getNumber('kols', 0));
  add('gate_wallets', t.wallets);
  add('gate_eth', Number(t.wei) / 1e18);
  // No targets set is not a gate that has been hit.
  return targets.length > 0 && targets.every(([actual, want]) => actual >= want);
}

/** The countdown line, when a launch time has been set. */
export function countdownLine(now = Date.now()): string | null {
  const at = getSetting('launch_at');
  if (!at) return null;
  const ts = Number(at);
  if (!Number.isFinite(ts)) return null;
  const left = ts - Math.floor(now / 1000);
  if (left <= 0) return 'launch: now';
  const d = Math.floor(left / 86_400);
  const h = Math.floor((left % 86_400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const parts = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `launch in ${parts}`;
}

// --------------------------------------------------------------- auto-posting

/**
 * When the bot posts the block without being asked.
 *
 * Two triggers, both deliberately dull: once a day at a fixed local time, and
 * on every tenth ready wallet. The second is debounced to once an hour because
 * ten wallets can arrive in a minute during a push, and a group that gets six
 * identical blocks in an hour stops reading any of them.
 */
export type AutoPostReason = 'daily' | 'threshold';

export const DAILY_HOUR = Number(process.env.READY_DAILY_HOUR || 15) || 15;
export const DAILY_TZ = process.env.READY_TZ || 'Europe/Bratislava';
export const THRESHOLD_STEP = Number(process.env.READY_THRESHOLD_STEP || 10) || 10;
export const THRESHOLD_DEBOUNCE_MS = Number(process.env.READY_THRESHOLD_DEBOUNCE_MS || 3_600_000) || 3_600_000;

/**
 * Local calendar day and hour in DAILY_TZ.
 *
 * Via Intl rather than a fixed UTC offset: Bratislava is UTC+1 for five months
 * of the year and UTC+2 for seven, and a hardcoded offset would post at 14:00
 * or 16:00 local for half of every year.
 */
export function localDayHour(now: number, tz = DAILY_TZ): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // 'en-CA' gives 24-hour values, but hour 24 appears for midnight in some ICU
  // builds; normalise it so the daily comparison never sees an impossible hour.
  const hour = Number(get('hour')) % 24;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

/**
 * Should the bot post now, and why?
 *
 * Idempotent by construction: the answer is derived from stored marks, so a
 * restart, a duplicate tick, or two loops running at once cannot produce two
 * posts for the same day or the same ten wallets. Call markAutoPost() only
 * after the post actually went out -- a post that failed to send must remain
 * due.
 */
export function dueAutoPost(now: number, wallets: number): AutoPostReason | null {
  const { day, hour } = localDayHour(now);
  if (hour >= DAILY_HOUR && getSetting('autopost_day') !== day) return 'daily';

  const bucket = Math.floor(wallets / THRESHOLD_STEP);
  const mark = getNumber('autopost_bucket', -1);
  if (mark < 0) {
    // First run: adopt the current bucket rather than announcing a number that
    // was reached before the bot was watching.
    setSetting('autopost_bucket', String(bucket));
    return null;
  }
  if (bucket < mark) {
    // Wallets dropped below a step. Lower the mark silently -- nothing is
    // announced for a fall -- so that climbing back over it counts again.
    setSetting('autopost_bucket', String(bucket));
    return null;
  }
  if (bucket > mark && now - getNumber('autopost_threshold_at', 0) >= THRESHOLD_DEBOUNCE_MS) {
    return 'threshold';
  }
  return null;
}

/** Record that a post went out, so the same trigger does not fire twice. */
export function markAutoPost(reason: AutoPostReason, now: number, wallets: number): void {
  if (reason === 'daily') setSetting('autopost_day', localDayHour(now).day);
  setSetting('autopost_bucket', String(Math.floor(wallets / THRESHOLD_STEP)));
  if (reason === 'threshold') setSetting('autopost_threshold_at', String(now));
}
