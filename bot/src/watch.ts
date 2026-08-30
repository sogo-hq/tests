import { db } from './db.js';
import { type FilterKey } from './filters.js';

/**
 * Alerts on facts the index already holds.
 *
 * Two kinds, both derived from a launch the indexer has just seen: the address
 * that deployed it, and the addresses it pre-exempted from the opening snipe
 * tax. Nothing here needs a price, and nothing here decides which wallets are
 * worth watching -- the user names the address and the bot reports when it
 * appears.
 */

export type WatchKind = 'deployer' | 'wallet';

/** Remember that this user has a private chat with the bot. */
export function rememberDm(userId: number, chatId: number, now = Math.floor(Date.now() / 1000)): void {
  db.prepare(
    `INSERT INTO dm_chats (user_id, chat_id, seen_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, seen_at = excluded.seen_at`,
  ).run(userId, chatId, now);
}

/** Where this user's alerts can go, or null if they have never written. */
export function dmChatFor(userId: number): number | null {
  const row = db
    .prepare('SELECT chat_id FROM dm_chats WHERE user_id = ?')
    .get(userId) as { chat_id: number } | undefined;
  return row?.chat_id ?? null;
}

/** Per user. Enough to follow a handful of deployers without becoming a feed. */
export const MAX_WATCHES = Number(process.env.MAX_WATCHES || 20) || 20;

export interface Watch {
  kind: WatchKind;
  address: string;
  createdAt: number;
}

export type AddResult =
  | { ok: true; watch: Watch }
  | { ok: false; reason: 'limit'; count: number }
  | { ok: false; reason: 'duplicate' };

export function addWatch(
  userId: number,
  kind: WatchKind,
  address: string,
  dmChatId: number,
  now = Math.floor(Date.now() / 1000),
): AddResult {
  const addr = address.toLowerCase();
  const existing = db
    .prepare('SELECT 1 FROM watches WHERE user_id = ? AND kind = ? AND address = ?')
    .get(userId, kind, addr);
  if (existing) return { ok: false, reason: 'duplicate' };

  const count = countWatches(userId);
  if (count >= MAX_WATCHES) return { ok: false, reason: 'limit', count };

  db.prepare(
    `INSERT INTO watches (user_id, kind, address, dm_chat_id, created_at) VALUES (?,?,?,?,?)`,
  ).run(userId, kind, addr, dmChatId, now);
  return { ok: true, watch: { kind, address: addr, createdAt: now } };
}

export function countWatches(userId: number): number {
  const a = (db.prepare('SELECT COUNT(*) AS n FROM watches WHERE user_id = ?').get(userId) as { n: number }).n;
  const b = (db.prepare('SELECT COUNT(*) AS n FROM filter_watches WHERE user_id = ?').get(userId) as { n: number }).n;
  return a + b;
}

export function listWatches(userId: number): Watch[] {
  return (db
    .prepare('SELECT kind, address, created_at FROM watches WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId) as { kind: WatchKind; address: string; created_at: number }[])
    .map((r) => ({ kind: r.kind, address: r.address, createdAt: r.created_at }));
}

/** Remove every watch on an address for this user. Returns how many went. */
export function removeWatch(userId: number, address: string): number {
  return db
    .prepare('DELETE FROM watches WHERE user_id = ? AND address = ?')
    .run(userId, address.toLowerCase()).changes;
}

interface MatchBase {
  userId: number;
  dmChatId: number;
}

/**
 * Why an alert is being sent, in a shape that cannot describe itself wrongly.
 *
 * A union rather than a `kind` beside an optional address: a filter match has
 * no address and an address match has no filter, and the one field that would
 * have carried both would have to be read differently depending on the other.
 */
export type Match =
  | (MatchBase & { kind: WatchKind; address: string })
  | (MatchBase & { kind: 'filter'; filter: FilterKey });

/**
 * Who should hear about this launch, and why.
 *
 * At most one match per user. Watching both a launch's deployer and one of its
 * exempted wallets is one alert, not two -- the deployer is reported, because
 * it is the stronger relationship to the launch.
 */
export function matchesFor(launch: {
  deployer: string;
  exemptions: string[];
}): Match[] {
  const deployer = launch.deployer.toLowerCase();
  const wallets = [...new Set(launch.exemptions.map((a) => a.toLowerCase()))];

  const rows = db
    .prepare(
      `SELECT user_id, dm_chat_id, kind, address FROM watches
        WHERE (kind = 'deployer' AND address = ?)
           ${wallets.length ? `OR (kind = 'wallet' AND address IN (${wallets.map(() => '?').join(',')}))` : ''}`,
    )
    .all(deployer, ...wallets) as
    { user_id: number; dm_chat_id: number; kind: WatchKind; address: string }[];

  const byUser = new Map<number, Match>();
  for (const r of rows) {
    const existing = byUser.get(r.user_id);
    // Deployer wins a tie: it is the address that made the launch, where an
    // exempted wallet was merely listed by it.
    if (existing && !(existing.kind === 'wallet' && r.kind === 'deployer')) continue;
    byUser.set(r.user_id, {
      userId: r.user_id, dmChatId: r.dm_chat_id, kind: r.kind, address: r.address,
    });
  }
  return [...byUser.values()];
}

/**
 * Claim the right to alert this user about this token.
 *
 * Returns false if it has already been delivered. Written before sending
 * rather than after, so a crash between the two sends nothing twice -- a
 * duplicate alert is worse than a missed one for a message the user did not
 * ask to receive twice.
 */
export function claimDelivery(userId: number, token: string, now = Math.floor(Date.now() / 1000)): boolean {
  const res = db
    .prepare('INSERT OR IGNORE INTO watch_fired (user_id, token, fired_at) VALUES (?,?,?)')
    .run(userId, token.toLowerCase(), now);
  return res.changes > 0;
}

/** The line above the card, saying why it arrived. */
export function whyLine(match: Match, ticker: string): string {
  // The filter's name and nothing else. Never "alpha", never "opportunity",
  // never "worth a look" -- the user chose the shape, and saying anything about
  // what it means would be this tool making the call it exists not to make.
  if (match.kind === 'filter') return `matches your ${match.filter} filter`;
  const short = `${match.address.slice(0, 6)}…${match.address.slice(-4)}`;
  return match.kind === 'deployer'
    ? `${short} launched ${ticker} — you watch this deployer`
    : `${short} was pre-exempted on ${ticker} — you watch this wallet`;
}

// ---------------------------------------------------------------- filters


export interface FilterWatch {
  filter: FilterKey;
  createdAt: number;
}

export function addFilterWatch(
  userId: number,
  filter: FilterKey,
  dmChatId: number,
  now = Math.floor(Date.now() / 1000),
): AddResult | { ok: true; filter: FilterKey } {
  const existing = db
    .prepare('SELECT 1 FROM filter_watches WHERE user_id = ? AND filter = ?')
    .get(userId, filter);
  if (existing) return { ok: false, reason: 'duplicate' };

  // Filters and address watches share one allowance. "20 watches per user" is
  // about how much mail the bot may send someone, and that does not care which
  // table the subscription lives in.
  const count = countWatches(userId);
  if (count >= MAX_WATCHES) return { ok: false, reason: 'limit', count };

  db.prepare(
    'INSERT INTO filter_watches (user_id, filter, dm_chat_id, created_at) VALUES (?,?,?,?)',
  ).run(userId, filter, dmChatId, now);
  return { ok: true, filter };
}

export function listFilterWatches(userId: number): FilterWatch[] {
  return (db
    .prepare('SELECT filter, created_at FROM filter_watches WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId) as { filter: FilterKey; created_at: number }[])
    .map((r) => ({ filter: r.filter, createdAt: r.created_at }));
}

export function removeFilterWatch(userId: number, filter: string): number {
  return db
    .prepare('DELETE FROM filter_watches WHERE user_id = ? AND filter = ?')
    .run(userId, filter).changes;
}

/** Users subscribed to any of the filters this launch matches. */
export function filterMatchesFor(matched: FilterKey[]): Match[] {
  if (!matched.length) return [];
  const rows = db
    .prepare(
      `SELECT user_id, dm_chat_id, filter FROM filter_watches
        WHERE filter IN (${matched.map(() => '?').join(',')})`,
    )
    .all(...matched) as { user_id: number; dm_chat_id: number; filter: FilterKey }[];

  const byUser = new Map<number, Match>();
  for (const r of rows) {
    // One alert per user per launch even when two of their filters match: the
    // card is the same card, and naming one filter is enough to say why it came.
    if (byUser.has(r.user_id)) continue;
    byUser.set(r.user_id, {
      userId: r.user_id, dmChatId: r.dm_chat_id, kind: 'filter', filter: r.filter,
    });
  }
  return [...byUser.values()];
}

/**
 * Alerts already delivered to this user in the last hour.
 *
 * Counted from what was actually claimed, so it holds across a restart and
 * cannot be reset by the bot forgetting.
 */
export function alertsSentSince(userId: number, since: number): number {
  return (db
    .prepare('SELECT COUNT(*) AS n FROM watch_fired WHERE user_id = ? AND fired_at >= ?')
    .get(userId, since) as { n: number }).n;
}

/**
 * Claim the one message that says the cap has been reached.
 *
 * Returns false when the user has already been told within the window. Being
 * over the cap must cost one message, not one per suppressed alert -- the
 * failure mode this exists to prevent is a flood, and a flood of "you are being
 * flooded" is the same bug.
 */
export function claimCapNotice(userId: number, since: number, now = Math.floor(Date.now() / 1000)): boolean {
  const row = db
    .prepare('SELECT notified_at FROM alert_cap_notices WHERE user_id = ?')
    .get(userId) as { notified_at: number } | undefined;
  if (row && row.notified_at >= since) return false;
  db.prepare(
    `INSERT INTO alert_cap_notices (user_id, notified_at) VALUES (?,?)
     ON CONFLICT(user_id) DO UPDATE SET notified_at = excluded.notified_at`,
  ).run(userId, now);
  return true;
}
