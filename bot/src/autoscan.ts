import { db } from './db.js';
import { ADDRESS_PATTERN } from './text.js';
import { groupLicensed } from './grants.js';

/**
 * Answering an address somebody pasted in a group.
 *
 * OFF in every group until an admin turns it on, and that is the whole design
 * rather than a default anyone should change lightly. A scanner that answers
 * every address in every group it sits in is an unsolicited poster, which is
 * both the fastest way to get a bot removed and a thing nobody asked for. The
 * rule the product is built on is that in a group the bot acts only when the
 * group has asked it to, once, explicitly, through somebody who can speak for
 * the group.
 *
 * DMs and inline queries are unaffected: a person messaging the bot directly
 * has already asked.
 */

/** How long one address stays answered in one group before a full card again. */
export const AUTOSCAN_DEDUPE_MS = Number(process.env.AUTOSCAN_DEDUPE_MS || 600_000) || 600_000;

const KEY = 'autoscan';

/**
 * Is autoscan on here?
 *
 * An explicit setting wins either way: an admin who turned it off has decided,
 * and a licence must not turn it back on behind them. With nothing set, a
 * licensed group defaults to on and every other group to off, which is the
 * standing rule that the bot never scans what it was not asked to.
 */
export function autoscanEnabled(chatId: number): boolean {
  const row = db
    .prepare('SELECT value FROM group_settings WHERE chat_id = ? AND key = ?')
    .get(chatId, KEY) as { value: string } | undefined;
  if (row) return row.value === 'on';
  return groupLicensed(chatId).licensed;
}

export function setAutoscan(chatId: number, on: boolean, setBy?: number): void {
  db.prepare(
    `INSERT INTO group_settings (chat_id, key, value, set_by, set_at) VALUES (?,?,?,?,?)
     ON CONFLICT(chat_id, key) DO UPDATE SET
       value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`,
  ).run(chatId, KEY, on ? 'on' : 'off', setBy ?? null, Math.floor(Date.now() / 1000));
}

/** Who turned it on or off, and when, for the settings line in /help. */
export function autoscanSetting(chatId: number):
  { on: boolean; setAt: number | null; byDefault: boolean } {
  const row = db
    .prepare('SELECT value, set_at FROM group_settings WHERE chat_id = ? AND key = ?')
    .get(chatId, KEY) as { value: string; set_at: number } | undefined;
  if (row) return { on: row.value === 'on', setAt: row.set_at ?? null, byDefault: false };
  // On because the group is licensed, rather than because anybody chose it.
  const licensed = groupLicensed(chatId).licensed;
  return { on: licensed, setAt: null, byDefault: licensed };
}

// ------------------------------------------------------------ what is in it

// Hashes are not addresses: see ADDRESS_PATTERN in text.ts.
const ADDRESS = new RegExp(ADDRESS_PATTERN, 'g');

/**
 * Every address readable in a message, wherever it is hiding.
 *
 * An address reaches a group in more ways than a line of text. It arrives in a
 * caption under a chart, inside the URL behind the words "BUY HERE", in an
 * explorer link, in a poll option, and in the message somebody replied to or
 * forwarded. A reader sees all of those as "the address in the chat", so the
 * bot has to as well or it answers some pastes and not others for reasons
 * nobody can see.
 *
 * The quoted and forwarded cases are deliberate: a forward is how a call
 * travels between groups, and it is exactly the moment somebody wants the card.
 */
export function addressesIn(msg: any): string[] {
  const parts: string[] = [];
  const collect = (m: any): void => {
    if (!m) return;
    parts.push(
      m.text ?? '',
      m.caption ?? '',
      m.poll?.question ?? '',
      ...((m.poll?.options ?? []) as any[]).map((o) => o?.text ?? ''),
      ...[...(m.entities ?? []), ...(m.caption_entities ?? [])].map((e: any) => e.url ?? ''),
    );
  };
  collect(msg);
  collect(msg?.reply_to_message);
  // A forward keeps its own text, so the outer collect already has it; this
  // covers the quoted-fragment shape Telegram sends alongside a reply.
  parts.push(msg?.quote?.text ?? '', msg?.external_reply?.quote?.text ?? '');

  const text = parts.filter(Boolean).join(' ');
  if (!text) return [];
  ADDRESS.lastIndex = 0;
  const out: string[] = [];
  for (const m of text.matchAll(ADDRESS)) {
    const a = m[0].toLowerCase();
    if (!out.includes(a)) out.push(a);
  }
  ADDRESS.lastIndex = 0;
  return out;
}

// ------------------------------------------------------------------- dedupe

export type ReplyKind = 'card' | 'repeat';

/**
 * Claim the right to answer this address in this group.
 *
 * 'card' the first time in the window, 'repeat' for every paste inside it. A
 * repeat still gets a one-line answer with a refresh button, because silence
 * reads as the bot being broken, but it does not cost the group a second card.
 */
export function claimAutoReply(
  chatId: number, address: string, now = Date.now(),
): ReplyKind {
  const addr = address.toLowerCase();
  const nowSec = Math.floor(now / 1000);
  const row = db
    .prepare('SELECT last_at FROM auto_replies WHERE chat_id = ? AND address = ?')
    .get(chatId, addr) as { last_at: number } | undefined;

  if (row && nowSec - row.last_at < AUTOSCAN_DEDUPE_MS / 1000) {
    db.prepare(
      'UPDATE auto_replies SET hits = hits + 1 WHERE chat_id = ? AND address = ?',
    ).run(chatId, addr);
    return 'repeat';
  }
  db.prepare(
    `INSERT INTO auto_replies (chat_id, address, last_at, hits) VALUES (?,?,?,1)
     ON CONFLICT(chat_id, address) DO UPDATE SET last_at = excluded.last_at, hits = auto_replies.hits + 1`,
  ).run(chatId, addr, nowSec);
  return 'card';
}

/**
 * Has this address ever been answered in this group?
 *
 * Used for the one address a launch room has pinned. The countdown pins it, a
 * hundred people quote it, and the group does not need a hundred cards, or one
 * every ten minutes for a week.
 */
export function everAnswered(chatId: number, address: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM auto_replies WHERE chat_id = ? AND address = ?')
      .get(chatId, address.toLowerCase()),
  );
}

/** For tests. */
export function resetAutoReplies(chatId: number): void {
  db.prepare('DELETE FROM auto_replies WHERE chat_id = ?').run(chatId);
}
