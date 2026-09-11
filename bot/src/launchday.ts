import type { Api } from 'grammy';
import {
  getLaunchPlan, dueCountdown, countdownPost, COUNTDOWN_OFFSETS, launchTimeLine, LAUNCH_TZ,
  envNumber,
} from './launch.js';
import { getSetting, setSetting, refreshBalances, totals, normaliseWallet } from './ready.js';
import { db } from './db.js';
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
  // Once the CA is out, the countdown is over whatever the clock says. A launch
  // that lands early otherwise kept posting "anything before that is fake"
  // underneath the bot's own pinned CA, and re-pinned itself on top of it.
  if (plan.ca) return null;
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
export async function repin(api: Api, chatId: number, messageId: number, slot: string): Promise<void> {
  try {
    await api.pinChatMessage(chatId, messageId, { disable_notification: true });
  } catch (err) {
    console.warn(`[launch] pin failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    return;
  }
  const prev = Number(getSetting(slot) || 0);
  const stale = Number(getSetting(`${slot}_stale`) || 0);
  setSetting(slot, String(messageId));

  // Both the one we are replacing and any earlier one whose unpin did not take.
  // Overwriting the stored id before attempting the unpin dropped the only
  // reference to it, so a single transient 502 left a message pinned for good.
  let unresolved = 0;
  for (const id of [prev, stale]) {
    if (!id || id === messageId) continue;
    try {
      await api.unpinChatMessage(chatId, id);
    } catch (err) {
      // A message already unpinned or deleted is not worth surfacing; a
      // transient failure is worth retrying on the next pin.
      console.warn(`[launch] unpin failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
      unresolved = id;
    }
  }
  setSetting(`${slot}_stale`, unresolved ? String(unresolved) : '');
}

/**
 * Take down whatever this slot has pinned, and forget it.
 *
 * Used when a pinned post stops being true rather than being replaced: a
 * countdown to a time the launch no longer happens at is worse than no pin.
 */
export async function retirePin(api: Api, chatId: number, slot: string): Promise<void> {
  for (const key of [slot, `${slot}_stale`]) {
    const id = Number(getSetting(key) || 0);
    if (!id) continue;
    try {
      await api.unpinChatMessage(chatId, id);
    } catch (err) {
      console.warn(`[launch] retire unpin failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
    setSetting(key, '');
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

/**
 * Anything shaped like an address, in either prefix case.
 *
 * Written `/0x…/` first, which missed `0X1111…` entirely: not deleted, no
 * offence, no warning. Etherscan and the common Telegram trading bots all
 * render addresses in forms a paste can shout, and the sibling wallet-leak
 * guard in bot.ts already accepted 0X, so the two disagreed about what an
 * address even is.
 */
export const ADDRESS_ANYWHERE = /0[xX][0-9a-fA-F]{40}/g;

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
  const found = [...text.matchAll(ADDRESS_ANYWHERE)].map((m) => m[0]);
  if (!found.length) return { action: 'ignore' };
  const ca = opts.pinnedCa?.toLowerCase() ?? null;
  const wrong = found.filter((a) => a.toLowerCase() !== ca);
  if (!wrong.length) return { action: 'ignore' };
  return { action: opts.priorOffences >= 1 ? 'mute' : 'warn', addresses: wrong };
}

/** 24 hours, as Telegram wants it: an absolute unix second. */
export const MUTE_SECONDS = envNumber('FAKE_CA_MUTE_SECONDS', 86_400);

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
  let running = false;
  const t = setInterval(() => {
    // A tick that posts and pins can outlast the interval, and two of them at
    // once would post the block twice.
    if (running) return;
    running = true;
    void (async () => {
      try {
        await countdownTick(api, { botUsername });
        // Covers the launches the index callback structurally cannot see.
        await reconcileLaunch(api, { botUsername });
        await selfScanTick(api, { botUsername });
      } catch (err) {
        console.warn('[launch] tick failed:', String((err as Error)?.message ?? err).slice(0, 160));
      } finally {
        running = false;
      }
    })();
  }, intervalMs);
  t.unref?.();
  return t;
}

// ------------------------------------------------------- the launch itself

/**
 * The launch the group has been counting down to, once it lands.
 *
 * Attached to the index loop's new-launch callback rather than to the twenty
 * second loop above. The index loop already polls the factory every three
 * seconds with a non-overlap guard, and the deployer it needs is on the
 * TokenLaunched log itself, so matching it is one indexed SQLite read with no
 * extra RPC. The published promise is "CA lands here 3 s after launch", and a
 * twenty second poller cannot keep it.
 *
 * Deliberately NOT routed through buildAlerts: that path defers whenever a user
 * scan is in flight, which during a launch is continuously true, so the one
 * post that must not wait would wait the longest.
 */
export async function launchDetected(api: Api, tokens: string[], opts: TickOpts = {}): Promise<string | null> {
  const plan = getLaunchPlan();
  if (!plan?.deployer || plan.ca) return null;
  const chatId = launchChat();
  if (chatId === null) return null;

  const lower = tokens.map((t) => t.toLowerCase());
  if (!lower.length) return null;
  const row = db
    .prepare(
      `SELECT token FROM launches
        WHERE deployer = ? AND launched_at >= ? AND token IN (${lower.map(() => '?').join(',')})
        ORDER BY block_number DESC LIMIT 1`,
    )
    .get(plan.deployer, matchFrom(plan.at), ...lower) as { token: string } | undefined;
  if (!row) return null;
  return announceLaunch(api, chatId, row.token, plan.name, opts);
}

/**
 * The earliest a launch can be THIS launch.
 *
 * Without a lower bound, anything the watched deployer shipped while the plan
 * was armed was announced as the CA and pinned: a test token four days out, a
 * second project, a redeploy after a failed attempt. The team wallet is a
 * working wallet. An hour of slack covers a launch fired early and nothing
 * else; a delayed launch is still this launch, so there is no upper bound.
 */
export const LAUNCH_MATCH_EARLY_MS = envNumber('LAUNCH_MATCH_EARLY_MS', 3_600_000);

function matchFrom(at: number): number {
  return Math.floor((at - LAUNCH_MATCH_EARLY_MS) / 1000);
}

/**
 * The same detection, from the table rather than from the callback edge.
 *
 * Two ways the callback misses a launch, both real: a cold start runs a
 * backfill whose result carries no newTokens at all, and a token whose row was
 * already created by somebody scanning it lands in the loop's "before" set and
 * never appears as new. Either one would leave the group with no CA while the
 * bot sat there believing it had nothing to do.
 */
export async function reconcileLaunch(api: Api, opts: TickOpts = {}): Promise<string | null> {
  const plan = getLaunchPlan();
  if (!plan?.deployer || plan.ca) return null;
  const chatId = launchChat();
  if (chatId === null) return null;
  // The same window the callback path uses, for the same reason.
  const since = matchFrom(plan.at);
  const row = db
    .prepare(
      `SELECT token FROM launches WHERE deployer = ? AND launched_at >= ?
        ORDER BY block_number DESC LIMIT 1`,
    )
    .get(plan.deployer, since) as { token: string } | undefined;
  if (!row) return null;
  return announceLaunch(api, chatId, row.token, plan.name, opts);
}

/**
 * Post and pin the one CA.
 *
 * Marked AFTER the send, like every other scheduled post here. Written the
 * other way round first, on the theory that committing launch_ca early closed
 * the guard window sooner: but the bot never receives its own messages as
 * updates, so there was no window to close, and a 429 or a 502 on the send then
 * left launch_ca committed with nothing posted, nothing pinned, the fake-CA
 * guard switched off, and no path that ever retried. A transient Telegram
 * error at the busiest second of the launch is exactly when that happens.
 */
async function announceLaunch(
  api: Api, chatId: number, token: string, name: string | null, opts: TickOpts,
): Promise<string> {
  const now = opts.now ?? Date.now();
  const ca = normaliseWallet(token) ?? token.toLowerCase();

  // Claimed synchronously, before the await.
  //
  // Two independent detectors race here: the 3 s index callback and the 20 s
  // reconcile pass. Both read plan.ca, both saw null while the first send was
  // still in flight, and the group got two "this is the only CA" posts for one
  // launch, which is precisely the message that must be unambiguous.
  // better-sqlite3 is synchronous, so this read-and-write cannot interleave.
  if (getSetting('launch_ca_claim') === ca) return ca;
  setSetting('launch_ca_claim', ca);

  const label = name ?? 'the token';
  let sent;
  try {
    sent = await api.sendMessage(
      chatId,
      `${label} is live. CA: ${ca}\nthis is the only CA.`,
      { link_preview_options: { is_disabled: true } },
    );
  } catch (err) {
    // Release the claim so the next tick retries rather than the launch going
    // unannounced because one send hit a 429.
    setSetting('launch_ca_claim', '');
    throw err;
  }
  setSetting('launch_ca', ca);
  setSetting('launch_detected_at', String(Math.floor(now / 1000)));
  await repin(api, chatId, sent.message_id, 'launch_pinned');

  // The countdown pin is a different slot, so it has to be taken down here.
  const countdown = Number(getSetting('countdown_pinned') || 0);
  if (countdown) {
    try {
      await api.unpinChatMessage(chatId, countdown);
      setSetting('countdown_pinned', '');
    } catch (err) {
      console.warn(`[launch] countdown unpin failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
  }
  console.log(`[launch] ${ca} announced and pinned in ${chatId}`);
  return ca;
}

// -------------------------------------------------- the launch, scanned

/** The bot scanning its own launch, and the two posts that come out of it. */
export const SELF_SCAN_HEADER = 'the launch, scanned by its own tool';
export const SELF_SCAN_DELAY_MS = envNumber('SELF_SCAN_DELAY_MS', 300_000);
export const SELF_FULL_DELAY_MS = envNumber('SELF_FULL_DELAY_MS', 900_000);

/**
 * The scan of the launch, five minutes in, and its /full ten minutes after
 * that.
 *
 * Both are marked after the send returns, so a failed post stays due and the
 * next tick retries it rather than the group silently never getting it.
 *
 * The scan runs unlimited: that flag, not a missing quota key, is the only
 * thing that actually skips the limiters. performScan de-duplicates concurrent
 * scans of the same token, so this and the flood of member scans arriving at
 * the same moment cost one scan between them.
 */
export async function selfScanTick(api: Api, opts: TickOpts = {}): Promise<'quick' | 'full' | null> {
  const plan = getLaunchPlan();
  if (!plan?.ca) return null;
  const chatId = launchChat();
  if (chatId === null) return null;
  const detected = Number(getSetting('launch_detected_at') || 0) * 1000;
  if (!detected) return null;
  const now = opts.now ?? Date.now();
  const since = now - detected;

  if (since >= SELF_SCAN_DELAY_MS && !getSetting('launch_scanned')) {
    const { performScan } = await import('./service.js');
    const out = await performScan({
      token: plan.ca, source: 'cli', unlimited: true, botUsername: opts.botUsername,
    });
    if (out.kind !== 'ok') {
      // A scan that did not finish says nothing about the chain, so nothing is
      // posted and the tick tries again.
      console.warn(`[launch] self-scan not ready: ${out.kind}`);
      return null;
    }
    const extra = await openingBlock(plan.ca);
    // The default card carries no parse_mode: it is built to be forwarded.
    await api.sendMessage(chatId, [SELF_SCAN_HEADER, '', out.defaultCard, ...extra].join('\n'), {
      link_preview_options: { is_disabled: true },
    });
    setSetting('launch_scanned', String(Math.floor(now / 1000)));
    return 'quick';
  }

  if (since >= SELF_FULL_DELAY_MS && getSetting('launch_scanned') && !getSetting('launch_fulled')) {
    const { performScan } = await import('./service.js');
    const out = await performScan({
      token: plan.ca, source: 'cli', unlimited: true, botUsername: opts.botUsername,
    });
    if (out.kind !== 'ok') return null;
    // The /full card is HTML, unlike the default one. Its footer links the
    // token, the curve AND the deployer, and the deployer is a wallet: exactly
    // one address may appear in a group message and it is the CA the bot
    // posted. A user asking for /full is one thing; the bot volunteering a
    // deployer wallet into the group is another.
    await api.sendMessage(chatId, redactAddresses(out.fullCard, plan.ca), {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    });
    setSetting('launch_fulled', String(Math.floor(now / 1000)));
    return 'full';
  }
  return null;
}

/**
 * Strip every address but the one allowed, links and all.
 *
 * Applied to a rendered card rather than to its source because the card is
 * shared with the DM and inline surfaces, where the links belong.
 */
export function redactAddresses(html: string, keep: string | null): string {
  const allowed = keep?.toLowerCase() ?? null;
  // Whole anchors first, so a redacted link does not leave dangling markup.
  return html
    .replace(/<a href="[^"]*\/address\/(0x[0-9a-fA-F]{40})"[^>]*>([^<]*)<\/a>/g,
      (whole, addr: string, label: string) => (addr.toLowerCase() === allowed ? whole : label))
    .replace(/0[xX][0-9a-fA-F]{40}/g, (a) => (a.toLowerCase() === allowed ? a : '[address]'));
}

/**
 * The opening-window lines, plus the tax policy the launch actually ran under.
 *
 * Read live rather than hardcoded. 9,900 bps over 3 seconds is what the factory
 * says today, and a value compiled in would keep printing after it changed.
 */
async function openingBlock(token: string): Promise<string[]> {
  const row = db
    .prepare('SELECT curve, deployer, block_number FROM launches WHERE token = ?')
    .get(token.toLowerCase()) as { curve: string; deployer: string; block_number: number } | undefined;
  if (!row) return ['opening window: this launch is not indexed yet, undetermined'];

  const { readOpeningWindow, openingLines, snipeTaxPolicy } = await import('./metrics/opening.js');
  const { readToken } = await import('./reads.js');
  const reads = await readToken(token).catch(() => null);
  if (!reads) return ['opening window: the token could not be read, undetermined'];

  const w = await readOpeningWindow({
    curve: row.curve,
    deployer: row.deployer,
    totalSupply: reads.totalSupply,
    fromBlock: BigInt(row.block_number),
  });
  const policy = await snipeTaxPolicy();
  const lines = ['', ...openingLines(w, {
    pairSymbol: reads.pairSymbol, pairDecimals: reads.pairDecimals, deployer: row.deployer,
  })];
  lines.push(
    policy
      ? `opening tax policy: ${(policy.startBps / 100).toFixed(0)}% for the first ${policy.seconds} s, read from the factory`
      : 'opening tax policy: could not be read, undetermined',
  );
  return lines;
}
