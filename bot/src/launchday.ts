import type { Api } from 'grammy';
import {
  getLaunchPlan, dueCountdown, countdownPost, COUNTDOWN_OFFSETS, launchTimeLine, LAUNCH_TZ,
} from './launch.js';
import { getSetting, setSetting, refreshBalances, totals, normaliseWallet } from './ready.js';
import { totalsBlock } from './tge.js';

/**
 * Launch day, from the countdown through the pinned CA.
 *
 * Kept out of bot.ts because none of it is a command handler: it is scheduled
 * work that happens to send messages, and it needs to be drivable from a test
 * with a fake clock and a stub Api rather than through a grammY Update.
 */

const posted = (key: string): boolean => Boolean(getSetting(`countdown:${key}`));
const markPosted = (key: string, now: number): void =>
  setSetting(`countdown:${key}`, String(Math.floor(now / 1000)));

/** Where launch posts go. The same group the READY block was posted in. */
export function launchChat(): number | null {
  const raw = getSetting('ready_chat');
  const n = Number(raw);
  return raw && Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ preflight

export interface Preflight {
  ok: boolean;
  /** Rights the bot does not hold, in the words an admin would use to grant them. */
  missing: string[];
  /** True when the check itself could not be made. Not the same as a refusal. */
  undetermined: boolean;
  detail?: string;
}

/**
 * What the bot can actually do in this group.
 *
 * Run before a launch is scheduled, because every promise made from here on
 * depends on rights an admin has to grant by hand: pinning the countdown,
 * deleting a fake CA before anyone acts on it, and muting whoever posted it
 * twice. Announcing a guard the bot cannot enforce is worse than not offering
 * one, so this is reported at /launch set rather than discovered at T-0.
 *
 * A check that could not be made is reported as undetermined, never as ready.
 */
export async function preflight(api: Api, chatId: number, botId: number): Promise<Preflight> {
  let me: any;
  try {
    me = await api.getChatMember(chatId, botId);
  } catch (err) {
    return {
      ok: false, missing: [], undetermined: true,
      detail: String((err as Error)?.message ?? err).slice(0, 120),
    };
  }
  if (me.status !== 'administrator') {
    return {
      ok: false, undetermined: false,
      missing: [
        'admin in this group (without it the bot cannot pin, delete or mute, ' +
        'and with privacy mode on it does not even see the messages it would have to delete)',
      ],
    };
  }
  const missing: string[] = [];
  if (!me.can_pin_messages) missing.push('pin messages');
  if (!me.can_delete_messages) missing.push('delete messages');
  if (!me.can_restrict_members) missing.push('restrict members');
  return { ok: missing.length === 0, missing, undetermined: false };
}

export function preflightLine(p: Preflight): string {
  if (p.undetermined) return `could not check the bot's rights in this group: ${p.detail ?? 'unknown'}. nothing is promised until it can be`;
  if (p.ok) return 'rights check: pin, delete and restrict all granted';
  return `rights missing: ${p.missing.join(', ')}. grant them or the guard cannot run`;
}

// ------------------------------------------------------------------ countdown

export interface TickOpts {
  now?: number;
  botUsername?: string;
}

/**
 * One tick of the countdown poster.
 *
 * Idempotent by the same construction as the daily READY post: the decision
 * comes from stored marks and the mark is written only after the send returns,
 * so a crash between the two leaves the post due rather than lost.
 *
 * The new post is pinned and the previous countdown unpinned, so the group
 * always has exactly one launch time at the top of the chat and never two.
 */
export async function countdownTick(api: Api, opts: TickOpts = {}): Promise<string | null> {
  const plan = getLaunchPlan();
  if (!plan) return null;
  const chatId = launchChat();
  if (chatId === null) return null;
  const now = opts.now ?? Date.now();
  const found = dueCountdown(plan.at, now, posted);
  if (!found) return null;

  // Offsets that came due while the bot was down are buried, not posted. Four
  // countdowns arriving at once would say three things that are no longer true.
  for (const stale of found.skipped) markPosted(stale.key, now);

  await refreshBalances(now);
  const block = totalsBlock({
    members: await memberCount(api, chatId),
    now,
    name: plan.name,
    botUsername: opts.botUsername,
  }, totals());

  const sent = await api.sendMessage(chatId, countdownPost(block, plan.at), {
    link_preview_options: { is_disabled: true },
  });
  markPosted(found.due.key, now);

  await repin(api, chatId, sent.message_id, 'countdown_pinned');
  return found.due.key;
}

/**
 * Pin a message and unpin whatever this slot held before it.
 *
 * Unpinning first would leave the group with nothing pinned if the pin then
 * failed, so the new pin goes up first. A pin that fails is logged and the
 * stored id left alone: the next tick tries again rather than silently
 * dropping the only visible launch time.
 */
async function repin(api: Api, chatId: number, messageId: number, slot: string): Promise<void> {
  try {
    await api.pinChatMessage(chatId, messageId, { disable_notification: true });
  } catch (err) {
    console.warn(`[launch] pin failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    return;
  }
  const prev = Number(getSetting(slot) || 0);
  setSetting(slot, String(messageId));
  if (prev && prev !== messageId) {
    try {
      await api.unpinChatMessage(chatId, prev);
    } catch (err) {
      // A message already unpinned or deleted is not a problem worth surfacing.
      console.warn(`[launch] unpin failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
  }
}

async function memberCount(api: Api, chatId: number): Promise<number | null> {
  try {
    return await api.getChatMemberCount(chatId);
  } catch (err) {
    console.warn('[launch] member count unreadable:', String((err as Error)?.message ?? err).slice(0, 120));
    return null;
  }
}

// -------------------------------------------------------------- the fake-CA guard

export type GuardVerdict =
  | { action: 'ignore' }
  | { action: 'warn'; addresses: string[] }
  | { action: 'mute'; addresses: string[] };

/**
 * Should this group message be deleted, and what happens to its sender?
 *
 * Pure, so every branch is testable without a Telegram server. The window is
 * from /launch set until the launch lands, which is exactly the period in which
 * an address posted in this group is either the CA (and the bot posted it) or
 * something a reader should not be pasting into a wallet.
 *
 * The real CA is compared case-insensitively: an address is the same address
 * whatever its checksum casing, and a guard that missed 0xABC because it stored
 * 0xabc would delete the genuine one.
 */
export function guardVerdict(
  text: string,
  opts: { pinnedCa: string | null; isAdmin: boolean; priorOffences: number; active: boolean },
): GuardVerdict {
  if (!opts.active || opts.isAdmin) return { action: 'ignore' };
  const found = [...text.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]);
  if (!found.length) return { action: 'ignore' };
  const ca = opts.pinnedCa?.toLowerCase() ?? null;
  const wrong = found.filter((a) => a.toLowerCase() !== ca);
  if (!wrong.length) return { action: 'ignore' };
  return { action: opts.priorOffences >= 1 ? 'mute' : 'warn', addresses: wrong };
}

/** 24 hours, as Telegram wants it: an absolute unix second. */
export const MUTE_SECONDS = Number(process.env.FAKE_CA_MUTE_SECONDS || 86_400) || 86_400;

/**
 * Every send permission ChatPermissions has, all off.
 *
 * All ten, not just can_send_messages. The implication rule runs one way only:
 * leaving can_send_other_messages true re-grants can_send_messages, and the
 * mute silently does nothing. Bot API 10.3, restrictChatMember, under
 * use_independent_chat_permissions.
 */
const MUTED_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
} as const;

/**
 * A 24 hour mute, with the until_date clamped.
 *
 * "If user is restricted for more than 366 days or less than 30 seconds from
 * the current time, they are considered to be restricted forever." So a clock
 * skew, a stale timestamp, or a misconfigured FAKE_CA_MUTE_SECONDS does not
 * produce a short mute here, it produces a permanent one. The clamp is the
 * difference between a 24 hour timeout and banning someone from the group for
 * good over one pasted address.
 *
 * Supergroups only. restrictChatMember does not work in a basic group, which
 * the preflight reports rather than discovering here.
 */
export async function muteFor24h(api: Api, chatId: number, userId: number, now = Date.now()): Promise<boolean> {
  const nowSec = Math.floor(now / 1000);
  const MIN = 60;                  // comfortably clear of the 30 second cliff
  const MAX = 364 * 86_400;        // and of the 366 day one
  const span = Math.min(MAX, Math.max(MIN, MUTE_SECONDS));
  try {
    await api.restrictChatMember(chatId, userId, MUTED_PERMISSIONS, {
      until_date: nowSec + span,
    });
    return true;
  } catch (err) {
    console.warn(`[launch] mute failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    return false;
  }
}

export const GUARD_WARNING =
  'your message in the group was deleted: it had a contract address in it, and the launch has not happened yet. ' +
  'the only CA will be posted by this bot, pinned, 3 s after launch. post another address and you are muted for 24 h.';

export const GUARD_MUTED =
  'you posted a contract address in the group again before launch. you are muted for 24 h. ' +
  'the only CA is the pinned one.';

/** How many times this user has already been warned, and the record of it. */
export function offencesOf(userId: number): number {
  return Number(getSetting(`ca_offence:${userId}`) || 0);
}

export function recordOffence(userId: number): number {
  const n = offencesOf(userId) + 1;
  setSetting(`ca_offence:${userId}`, String(n));
  return n;
}

/**
 * Has this exact message already been acted on?
 *
 * An edited_message update arrives for the same message id, and the docs warn
 * it "may at times be triggered by changes to message fields that are either
 * unavailable or not actively used by your bot" -- so the same message can
 * surface repeatedly. Without this, editing a message twice would walk a first
 * offender straight to a 24 hour mute for one pasted address.
 */
export function alreadyHandled(chatId: number, messageId: number): boolean {
  return Boolean(getSetting(`ca_msg:${chatId}:${messageId}`));
}

export function markHandled(chatId: number, messageId: number, now = Date.now()): void {
  setSetting(`ca_msg:${chatId}:${messageId}`, String(Math.floor(now / 1000)));
}

/** Is the fake-CA window open? From /launch set until the CA is pinned. */
export function guardActive(now = Date.now()): boolean {
  const plan = getLaunchPlan();
  if (!plan) return false;
  // Stays on after the scheduled time until the CA is actually known: a launch
  // that lands late is exactly when a fake is most likely to be believed.
  return plan.ca === null || now < plan.at;
}

/** The pinned CA, once there is one. */
export function pinnedCa(): string | null {
  const raw = getSetting('launch_ca');
  return raw ? normaliseWallet(raw) : null;
}

export { launchTimeLine, COUNTDOWN_OFFSETS, LAUNCH_TZ };

/**
 * The launch-day loop.
 *
 * Twenty seconds rather than a minute: T-10min is the one countdown post whose
 * lateness would be visible, and a tick that finds nothing due is a single
 * indexed read against a table with a handful of rows.
 */
export function startLaunchLoop(api: Api, botUsername?: string, intervalMs = 20_000): NodeJS.Timeout {
  const t = setInterval(() => {
    void countdownTick(api, { botUsername }).catch((err) => {
      console.warn('[launch] countdown tick failed:', String((err as Error)?.message ?? err).slice(0, 160));
    });
  }, intervalMs);
  t.unref?.();
  return t;
}
