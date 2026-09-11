import type { Api } from 'grammy';
import { GROUP_HANDLE } from './card.js';

/**
 * The DM gate.
 *
 * Commands in a DM are for members of the announcement channel. Groups and
 * inline are never gated and never will be: somebody reading a card in a group
 * did not choose this bot, and an inline result appears in a chat the bot is
 * not even in. Gating either would make the tool useless in the two places it
 * is most useful and would turn every card into an advert for joining.
 *
 * The check is the channel's own membership list, asked through Telegram, and
 * it is cached: a per-command lookup would put a network call in front of every
 * DM anyone sends, and the answer changes rarely.
 */

/** The channel a DM user is asked to be in. */
export function gateChannel(): string {
  return process.env.GATE_CHANNEL || `@${GROUP_HANDLE}`;
}

/** Off unless a channel is set AND the gate is switched on. */
export function gateActive(): boolean {
  return (process.env.START_GATE ?? '').toLowerCase() === 'on';
}

export const MEMBERSHIP_TTL_MS = Number(process.env.MEMBERSHIP_TTL_MS || 600_000) || 600_000;

type Verdict = 'member' | 'absent' | 'unknown';

const cache = new Map<number, { at: number; verdict: Verdict }>();

export function resetMembership(): void {
  cache.clear();
}

/**
 * Is this user in the channel?
 *
 * 'unknown' is its own answer and is never treated as 'absent'. The bot may not
 * be an admin of the channel, the channel may be unreachable, Telegram may be
 * having a minute: none of those is evidence that a person is not a member, and
 * locking somebody out of a tool because a lookup failed is the wrong way to be
 * wrong.
 */
export async function membershipOf(
  api: Api, userId: number, now = Date.now(),
): Promise<Verdict> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < MEMBERSHIP_TTL_MS) return hit.verdict;

  let verdict: Verdict;
  try {
    const m = await api.getChatMember(gateChannel(), userId);
    verdict = m.status === 'left' || m.status === 'kicked' ? 'absent' : 'member';
  } catch (err) {
    console.warn('[gate] membership unreadable:', String((err as Error)?.message ?? err).slice(0, 140));
    verdict = 'unknown';
  }
  // An unknown is cached briefly too, so a channel the bot cannot read does not
  // cost a lookup on every message; a member is cached for the full window.
  cache.set(userId, { at: verdict === 'unknown' ? now - MEMBERSHIP_TTL_MS + 30_000 : now, verdict });
  return verdict;
}

/** Cleared the moment somebody joins, so the gate lifts without a wait. */
export function markJoined(userId: number): void {
  cache.delete(userId);
}

export function joinMessage(): string {
  return [
    `vitals is open to members of ${gateChannel()}.`,
    '',
    'join, then send /start again. every change lands there first, and it is',
    'where a launch is announced before it is anywhere else.',
    '',
    'scanning in a group and inline results are not gated: paste an address in',
    'any group the bot is in, or type @vitalscheck_bot <address> anywhere.',
  ].join('\n');
}

export function joinButton(): { text: string; url: string }[][] {
  const handle = gateChannel().replace(/^@/, '');
  return [[{ text: `Join ${gateChannel()}`, url: `https://t.me/${handle}` }]];
}
