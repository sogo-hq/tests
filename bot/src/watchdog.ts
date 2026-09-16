import type { Api } from 'grammy';
import { db, getCursor } from './db.js';
import { getSetting, setSetting } from './ready.js';
import { indexHealth, lastSeenHead, agoWords } from './indexer/health.js';
import { adminIds } from './tge.js';
import { getLaunchPlan } from './launch.js';
import { BLOCK_TIME_SECONDS } from './config.js';

/**
 * The bot watching itself.
 *
 * Everything the scanner says rests on the index being current, and an index
 * that quietly falls behind does not look broken from the outside: every
 * command still answers, in the same words, about a chain it read an hour ago.
 * The rest of the codebase handles that by withholding negatives. This handles
 * it by telling somebody.
 *
 * Three things are worth waking an admin for, and they are the three that the
 * bot cannot report on its own behalf once they happen: the head lag, repeated
 * indexer errors, and a restart.
 */

/** A lag wider than this is worth saying something about. Six seconds of chain. */
export const WATCHDOG_LAG_BLOCKS = Number(process.env.WATCHDOG_LAG_BLOCKS || 60) || 60;

/**
 * How long the lag has to hold before anyone is woken.
 *
 * A single wide pass is normal: one slow eth_getLogs and the cursor is sixty
 * blocks back for three seconds. Two minutes of it is a component that is not
 * keeping up.
 */
export const WATCHDOG_LAG_SECONDS = Number(process.env.WATCHDOG_LAG_SECONDS || 120) || 120;

/** Two failed passes in a row. One is a network. */
export const WATCHDOG_FAILURES = 2;

/** One alert of a kind per ten minutes, however many times it is noticed. */
export const ALERT_COOLDOWN_MS = Number(process.env.WATCHDOG_COOLDOWN_MS || 600_000) || 600_000;

export type AlertKind = 'lag' | 'errors' | 'restart';

/** When this process started, for uptime. */
export const STARTED_AT = Date.now();

const SETTING = {
  lagSince: 'watchdog_lag_since',
  lastAlert: (kind: AlertKind) => `watchdog_alert_${kind}`,
};

/**
 * The cooldown, in the settings table rather than in memory.
 *
 * A restart alert whose rate limit lives in memory is not rate limited at all:
 * the thing it reports is the thing that clears it. A bot in a crash loop
 * would send one DM per crash, which is the worst moment to be flooding the
 * person who has to fix it.
 */
export function alertAllowed(kind: AlertKind, now = Date.now()): boolean {
  const last = Number(getSetting(SETTING.lastAlert(kind)) || 0);
  return !last || now - last >= ALERT_COOLDOWN_MS;
}

export function markAlerted(kind: AlertKind, now = Date.now()): void {
  setSetting(SETTING.lastAlert(kind), String(now));
}

/** For tests, and for an admin who wants the next alert now. */
export function resetWatchdog(): void {
  for (const k of ['lag', 'errors', 'restart'] as AlertKind[]) setSetting(SETTING.lastAlert(k), '');
  setSetting(SETTING.lagSince, '');
}

export interface StatusReport {
  /** The block the launch indexer has read to, or null when it never has. */
  indexerHead: number | null;
  /** The chain head the indexer last saw, or null when none has been recorded. */
  chainHead: number | null;
  /** Null is unknown, which is not the same as caught up. */
  lagBlocks: number | null;
  lagSeconds: number | null;
  stalled: boolean;
  behindSeconds: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** The armed launch, if one is armed. */
  launch: { name: string | null; at: number; deployer: string | null; ca: string | null } | null;
  watches: number;
  seats: number;
  uptimeSeconds: number;
}

export function statusReport(now = Date.now()): StatusReport {
  const cursor = getCursor('launches');
  const indexerHead = cursor === null ? null : Number(cursor);
  const chainHead = lastSeenHead();
  const lagBlocks = indexerHead === null || chainHead === null ? null : Math.max(0, chainHead - indexerHead);
  const health = indexHealth(Math.floor(now / 1000));
  const plan = getLaunchPlan();
  const watches = (db.prepare('SELECT COUNT(*) AS n FROM watches').get() as { n: number }).n;
  const seats = (db.prepare("SELECT COUNT(*) AS n FROM seats WHERE removed_at IS NULL").get() as { n: number }).n;
  return {
    indexerHead,
    chainHead,
    lagBlocks,
    lagSeconds: lagBlocks === null ? null : Math.round(lagBlocks * BLOCK_TIME_SECONDS),
    stalled: health.stalled,
    behindSeconds: health.behindSeconds,
    consecutiveFailures: health.consecutiveFailures,
    lastError: health.lastError,
    launch: plan ? { name: plan.name, at: plan.at, deployer: plan.deployer, ca: plan.ca } : null,
    watches,
    seats,
    uptimeSeconds: Math.floor((now - STARTED_AT) / 1000),
  };
}

export function statusText(s: StatusReport): string {
  const L: string[] = ['status'];
  L.push('');
  L.push(`indexer head  ${s.indexerHead === null ? 'never advanced' : s.indexerHead.toLocaleString()}`);
  L.push(`chain head    ${s.chainHead === null ? 'never recorded' : s.chainHead.toLocaleString()}`);
  L.push(s.lagBlocks === null
    ? 'lag           undetermined, one of the two has never been seen'
    : `lag           ${s.lagBlocks.toLocaleString()} block${s.lagBlocks === 1 ? '' : 's'}, about ${s.lagSeconds}s of chain`);
  L.push(`last pass     ${s.behindSeconds === null ? 'never' : `${agoWords(s.behindSeconds)} ago`}${s.stalled ? ', STALLED' : ''}`);
  if (s.consecutiveFailures > 0) {
    L.push(`failures      ${s.consecutiveFailures} in a row`);
    if (s.lastError) L.push(`              ${s.lastError.slice(0, 120)}`);
  }
  L.push('');
  L.push(s.launch
    ? `launch armed  ${s.launch.name ?? 'unnamed'} at ${new Date(s.launch.at).toISOString().replace('T', ' ').slice(0, 16)}`
      + `${s.launch.ca ? `, CA ${s.launch.ca}` : ', no CA yet'}`
    : 'launch armed  none');
  L.push(`watch list    ${s.watches} subscription${s.watches === 1 ? '' : 's'}`);
  L.push(`seats         ${s.seats} live`);
  L.push(`uptime        ${agoWords(s.uptimeSeconds)}`);
  return L.join('\n');
}

/**
 * Has the lag held past the threshold for long enough to say something?
 *
 * The first wide reading starts a clock rather than firing. A lag that clears
 * stops the clock, so a lag that comes and goes never fires and one that
 * stays fires once.
 */
export function noteLag(lagBlocks: number | null, now = Date.now()): { due: boolean; heldSeconds: number } {
  if (lagBlocks === null || lagBlocks <= WATCHDOG_LAG_BLOCKS) {
    setSetting(SETTING.lagSince, '');
    return { due: false, heldSeconds: 0 };
  }
  const since = Number(getSetting(SETTING.lagSince) || 0);
  if (!since) {
    setSetting(SETTING.lagSince, String(now));
    return { due: false, heldSeconds: 0 };
  }
  const held = Math.floor((now - since) / 1000);
  return { due: held >= WATCHDOG_LAG_SECONDS, heldSeconds: held };
}

export function alertText(kind: AlertKind, s: StatusReport, extra: { heldSeconds?: number } = {}): string {
  if (kind === 'lag') {
    return [
      `the index is ${s.lagBlocks?.toLocaleString()} blocks behind the chain`,
      `held for ${agoWords(extra.heldSeconds ?? 0)}, about ${s.lagSeconds}s of chain unread`,
      '',
      'while it is behind, every "nothing found" is withheld rather than answered.',
      '/status for the rest.',
    ].join('\n');
  }
  if (kind === 'errors') {
    return [
      `the indexer has failed ${s.consecutiveFailures} passes in a row`,
      s.lastError ? s.lastError.slice(0, 200) : 'no message was recorded',
      '',
      '/status for the rest.',
    ].join('\n');
  }
  return [
    'the bot restarted',
    s.launch
      ? `a launch is armed: ${s.launch.name ?? 'unnamed'}${s.launch.ca ? `, CA ${s.launch.ca}` : ', no CA yet'}`
      : 'no launch is armed',
    `index ${s.lagBlocks === null ? 'lag undetermined' : `${s.lagBlocks.toLocaleString()} blocks behind`}`,
    '',
    '/status for the rest.',
  ].join('\n');
}

/** DM every admin. A failure to reach one does not stop the others. */
export async function alertAdmins(api: Api, kind: AlertKind, text: string, now = Date.now()): Promise<number> {
  if (!alertAllowed(kind, now)) return 0;
  const ids = adminIds();
  if (!ids.length) return 0;
  // Marked before the sends, not after: a send that throws must not leave the
  // cooldown unset, or the next tick alerts again ten seconds later.
  markAlerted(kind, now);
  let sent = 0;
  for (const id of ids) {
    try {
      await api.sendMessage(id, text, { link_preview_options: { is_disabled: true } });
      sent++;
    } catch (err) {
      console.warn(`[watchdog] could not DM ${id}: ${String((err as Error)?.message ?? err).slice(0, 90)}`);
    }
  }
  return sent;
}

/** One pass. Returns the kinds it alerted on, for the caller's log. */
export async function watchdogTick(api: Api, now = Date.now()): Promise<AlertKind[]> {
  const s = statusReport(now);
  const fired: AlertKind[] = [];

  const lag = noteLag(s.lagBlocks, now);
  if (lag.due && await alertAdmins(api, 'lag', alertText('lag', s, { heldSeconds: lag.heldSeconds }), now)) {
    fired.push('lag');
  }
  if (s.consecutiveFailures >= WATCHDOG_FAILURES
      && await alertAdmins(api, 'errors', alertText('errors', s), now)) {
    fired.push('errors');
  }
  return fired;
}

/** Sent once on startup, rate limited like the rest. */
export async function announceRestart(api: Api, now = Date.now()): Promise<boolean> {
  const s = statusReport(now);
  return (await alertAdmins(api, 'restart', alertText('restart', s), now)) > 0;
}

export function startWatchdog(api: Api, intervalMs = 30_000): NodeJS.Timeout {
  void announceRestart(api).catch((err) => console.warn('[watchdog] restart notice failed:', err));
  const timer = setInterval(() => {
    void watchdogTick(api).catch((err) => console.warn('[watchdog] tick failed:', err));
  }, intervalMs);
  timer.unref?.();
  return timer;
}
