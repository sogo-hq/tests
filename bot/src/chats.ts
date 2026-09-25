import { db } from './db.js';

/**
 * Which chats the bot is in.
 *
 * Telegram tells a bot about its own membership through my_chat_member, which
 * this bot has asked for since the launch guard needed to know about a
 * demotion, and then never recorded. So "groups the bot is in" had no source
 * at all: the only trace of a group was that somebody had scanned in it, and
 * a group that removed the bot a week ago leaves exactly the same trace.
 *
 * One row per chat, holding the LAST state Telegram reported. A row seeded from
 * activity before the handler existed is marked 'seen' and counts as present
 * until an update says otherwise, because the alternative -- counting zero
 * groups on the day the feature ships -- would be a false number too.
 */

export type BotChatStatus = 'member' | 'administrator' | 'left' | 'kicked' | 'restricted' | 'seen';

const PRESENT: ReadonlySet<BotChatStatus> = new Set(['member', 'administrator', 'restricted', 'seen']);
const GROUP_TYPES: ReadonlySet<string> = new Set(['group', 'supergroup']);

const upsert = db.prepare(
  `INSERT INTO bot_chats (chat_id, type, title, status, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(chat_id) DO UPDATE SET
     type = excluded.type,
     title = COALESCE(excluded.title, bot_chats.title),
     status = excluded.status,
     updated_at = excluded.updated_at`,
);

export function recordBotChat(
  chatId: number,
  type: string,
  title: string | null,
  status: BotChatStatus,
  at = Math.floor(Date.now() / 1000),
): void {
  upsert.run(chatId, type, title, status, at);
}

/** Groups and supergroups the bot is, as far as it knows, still in. */
export function groupsBotIsIn(): number {
  const rows = db
    .prepare(`SELECT status FROM bot_chats WHERE type IN ('group', 'supergroup')`)
    .all() as { status: BotChatStatus }[];
  return rows.filter((r) => PRESENT.has(r.status)).length;
}

/**
 * Seed from what the bot already knows, once.
 *
 * Every group that ever produced a scan event or set a group setting is a
 * group the bot was in at that moment. Inserted as 'seen', and only where no
 * row exists, so a real membership update is never overwritten by history.
 */
export function seedBotChatsFromActivity(at = Math.floor(Date.now() / 1000)): number {
  const seen = db
    .prepare(
      `SELECT DISTINCT chat_id FROM (
         SELECT chat_id FROM scan_events WHERE source = 'group' AND chat_id IS NOT NULL
         UNION
         SELECT chat_id FROM group_settings
       ) WHERE chat_id NOT IN (SELECT chat_id FROM bot_chats)`,
    )
    .all() as { chat_id: number }[];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO bot_chats (chat_id, type, title, status, updated_at) VALUES (?, 'supergroup', NULL, 'seen', ?)`,
  );
  const tx = db.transaction((rows: { chat_id: number }[]) => {
    for (const r of rows) insert.run(r.chat_id, at);
  });
  tx(seen);
  return seen.length;
}

/**
 * The last title Telegram reported for a chat, when there is one.
 *
 * For telling two groups apart in an admin report. A bare id is not something an
 * operator can match to a room under any pressure, and -1001234567890 against
 * -1009876543210 at T-5 is exactly the check that gets skipped.
 */
export function chatTitle(chatId: number): string | null {
  const row = db
    .prepare('SELECT title FROM bot_chats WHERE chat_id = ?')
    .get(chatId) as { title: string | null } | undefined;
  return row?.title ?? null;
}

/** Whether a Telegram chat type is a group of any kind. */
export function isGroupType(type: string | undefined): boolean {
  return type !== undefined && GROUP_TYPES.has(type);
}
