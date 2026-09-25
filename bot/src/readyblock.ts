import { db } from './db.js';

/**
 * Whether one group gets the READY block at all.
 *
 * The block has one destination, `ready_chat`, and that setting also carries the
 * countdown, the fake-CA guard, the self-scan cards and the cancel notice. So
 * "stop the block in this group" could previously only be done by moving
 * `ready_chat` somewhere else, which moved the guard with it: on launch day that
 * is the difference between a fake address being deleted in the room the real CA
 * lands in and being left up.
 *
 * This is the per-chat switch instead. It suppresses the block and nothing else.
 * Where the launch posts go stays a separate decision, made by an admin posting
 * a block deliberately, and the two no longer have to be traded against each
 * other.
 *
 * Shaped after autoscan, deliberately: same table, same explicit-setting-wins
 * rule, same admin-only surface. A second mechanism for "is this group opted
 * into a thing" would be a second place to look when a group goes quiet.
 */

const KEY = 'ready_block';

/**
 * Is the block muted here?
 *
 * Unset means on, which is the opposite default from autoscan and right for the
 * opposite reason. Autoscan is the bot volunteering into a group's conversation,
 * so it stays off until asked. The block is only ever posted where an admin
 * posted one or where an admin ran /launch, so it is already asked for.
 */
export function readyBlockMuted(chatId: number): boolean {
  const row = db
    .prepare('SELECT value FROM group_settings WHERE chat_id = ? AND key = ?')
    .get(chatId, KEY) as { value: string } | undefined;
  return row?.value === 'off';
}

export function setReadyBlockMuted(chatId: number, muted: boolean, setBy?: number): void {
  db.prepare(
    `INSERT INTO group_settings (chat_id, key, value, set_by, set_at) VALUES (?,?,?,?,?)
     ON CONFLICT(chat_id, key) DO UPDATE SET
       value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`,
  ).run(chatId, KEY, muted ? 'off' : 'on', setBy ?? null, Math.floor(Date.now() / 1000));
}

/** Who set it and when, for the settings line and for /launch status. */
export function readyBlockSetting(chatId: number):
  { muted: boolean; setAt: number | null; byDefault: boolean } {
  const row = db
    .prepare('SELECT value, set_at FROM group_settings WHERE chat_id = ? AND key = ?')
    .get(chatId, KEY) as { value: string; set_at: number } | undefined;
  if (!row) return { muted: false, setAt: null, byDefault: true };
  return { muted: row.value === 'off', setAt: row.set_at ?? null, byDefault: false };
}

export type MuteRequest = { ok: true } | { ok: false; reason: string };

/**
 * May the block be muted here right now?
 *
 * Refused while a launch is armed, and the reason is not caution. A countdown
 * post embeds the same totals block and goes to `ready_chat` on its own
 * schedule, pinned. Muting mid-countdown therefore produces a group with no
 * daily block and a pinned block at the top of the chat, which is a state nobody
 * asked for and which reads as the switch not working.
 *
 * Unmuting is always allowed: it only ever adds posts, so it cannot create that
 * half-quiet state.
 */
export function canMute(armedLaunch: string | null): MuteRequest {
  if (!armedLaunch) return { ok: true };
  return {
    ok: false,
    reason: `a launch is armed for ${armedLaunch}, and the countdown posts carry this same block. `
      + 'muting now would leave the group a pinned countdown and no daily block. '
      + 'cancel the launch, mute, then set it again',
  };
}

/** What the bot says after the switch moves. Never a wallet, never a user. */
export function muteLine(muted: boolean): string {
  return muted
    ? 'the READY block is off in this group. the launch posts and the CA are not affected. /ready on turns it back on'
    : 'the READY block is on in this group.';
}
