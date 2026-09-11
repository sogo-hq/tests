import type { Api } from 'grammy';
import { db } from './db.js';
import { getSetting, setSetting } from './ready.js';
import { tierOf, atLeast, type Tier } from './tiers.js';
import { zonedParts, LAUNCH_TZ, envNumber } from './launch.js';
import { NATIVE_PAIR } from './reads.js';

/**
 * The holder feed: every new pons v2 launch, as the quick card, in a DM.
 *
 * DM only, and there is no chat id in feed_subs to make that structural rather
 * than a rule somebody has to remember. The existing alert machinery's posture
 * applies unchanged: nothing this produces can reach a group.
 *
 * The queue is the launches table itself, with a per-subscriber cursor, so a
 * restart loses nothing and "how far behind are you" is a subtraction rather
 * than a number held in memory.
 */

/**
 * How often a delivery pass runs, which is also the per-subscriber pacing unit:
 * at most one DM per subscriber per tick.
 *
 * The pack asks for batching every 10 s AND delivery within about 5 s of
 * TokenLaunched, and those cannot both hold: the index loop already costs up to
 * 3 s, so a 10 s batch puts the floor at 13 s. Three seconds is the per-user
 * pacing the pack also asks for, so using it as the tick satisfies the latency
 * target and the pacing rule with one number. Total load is unchanged either
 * way: it is bounded by the global limiter below, not by how often we look.
 */
export const FEED_TICK_MS = envNumber('FEED_TICK_MS', 3_000);

/** Telegram's global ceiling for a bot is around 30 messages a second. */
export const FEED_GLOBAL_PER_SEC = envNumber('FEED_GLOBAL_PER_SEC', 25);

/**
 * Past this many unsent launches a subscriber is caught up rather than caught
 * up with: the backlog is dropped and summarised in one line. Sending 400
 * cards to somebody who closed Telegram for a day is not a feed, it is a
 * denial of service with their name on it.
 */
export const FEED_BEHIND_MAX = envNumber('FEED_BEHIND_MAX', 20);

export interface FeedFilters {
  /** Only launches with at least one wallet pre-exempted from the opening tax. */
  exempt?: boolean;
  /** Only launches with at least this many buyers in the indexed opening window. */
  minBuyers?: number;
  /** 'eth', 'stock', or a specific pair token address. */
  pair?: string;
  /** Local hours to stay quiet, as [fromHour, toHour). */
  mute?: [number, number];
}

export interface FeedSub {
  userId: number;
  filters: FeedFilters;
  paused: boolean;
  lastSent: number;
  missed: number;
}

function rowToSub(r: any): FeedSub {
  let filters: FeedFilters = {};
  if (r.filters) {
    try {
      filters = JSON.parse(r.filters);
    } catch (err) {
      console.warn(`[feed] filters for ${r.user_id} will not parse, treating as none:`, String(r.filters).slice(0, 60));
    }
  }
  return { userId: r.user_id, filters, paused: Boolean(r.paused), lastSent: r.last_sent, missed: r.missed };
}

export function subOf(userId: number): FeedSub | null {
  const row = db.prepare('SELECT * FROM feed_subs WHERE user_id = ?').get(userId);
  return row ? rowToSub(row) : null;
}

export function allSubs(): FeedSub[] {
  return (db.prepare('SELECT * FROM feed_subs ORDER BY user_id').all() as any[]).map(rowToSub);
}

/** The newest launch in the index, which is where a new subscriber starts. */
export function headRow(): number {
  const row = db.prepare('SELECT MAX(rowid) AS m FROM launches').get() as { m: number | null };
  return row?.m ?? 0;
}

export function subscribe(userId: number, now = Date.now()): FeedSub {
  // From here, not from the beginning of the index: a new subscriber has not
  // missed the last eighteen thousand launches, they simply were not watching.
  db.prepare(
    `INSERT INTO feed_subs (user_id, filters, paused, last_sent, missed, created_at)
     VALUES (?,NULL,0,?,0,?)
     ON CONFLICT(user_id) DO UPDATE SET paused = 0`,
  ).run(userId, headRow(), Math.floor(now / 1000));
  return subOf(userId)!;
}

export function unsubscribe(userId: number): boolean {
  return db.prepare('DELETE FROM feed_subs WHERE user_id = ?').run(userId).changes > 0;
}

export function setPaused(userId: number, paused: boolean): void {
  db.prepare('UPDATE feed_subs SET paused = ? WHERE user_id = ?').run(paused ? 1 : 0, userId);
}

export function setFilters(userId: number, filters: FeedFilters): void {
  db.prepare('UPDATE feed_subs SET filters = ? WHERE user_id = ?')
    .run(Object.keys(filters).length ? JSON.stringify(filters) : null, userId);
}

// -------------------------------------------------------------------- filters

export type FilterParse =
  | { ok: true; filters: FeedFilters }
  | { ok: false; reason: string };

/**
 * Parse `/feed filters exempt>0 min_buyers=5 pair=eth mute 22:00-07:00`.
 *
 * An unrecognised clause is refused rather than ignored. A filter silently
 * dropped is worse than no filter: the subscriber believes they are seeing a
 * narrowed feed and they are seeing all of it.
 */
export function parseFilters(input: string): FilterParse {
  const filters: FeedFilters = {};
  const text = input.trim();
  if (!text || text.toLowerCase() === 'none' || text.toLowerCase() === 'clear') {
    return { ok: true, filters };
  }
  // `mute 22:00-07:00` is two words; join it before splitting the rest.
  const normalised = text.replace(/\bmute\s+(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})/gi, (_m, r) => `mute=${String(r).replace(/\s+/g, '')}`);
  for (const clause of normalised.split(/\s+/).filter(Boolean)) {
    const lower = clause.toLowerCase();
    if (lower === 'exempt>0' || lower === 'exempt') { filters.exempt = true; continue; }
    let m = /^min_buyers=(\d+)$/.exec(lower);
    if (m) { filters.minBuyers = Number(m[1]); continue; }
    m = /^pair=(.+)$/.exec(lower);
    if (m) { filters.pair = m[1]!; continue; }
    m = /^mute=(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(lower);
    if (m) {
      const from = Number(m[1]);
      const to = Number(m[3]);
      if (from > 23 || to > 23) return { ok: false, reason: `${clause} is not a time` };
      filters.mute = [from, to];
      continue;
    }
    return { ok: false, reason: `could not read "${clause}". try: exempt>0 min_buyers=5 pair=eth mute 22:00-07:00` };
  }
  return { ok: true, filters };
}

export function describeFilters(f: FeedFilters): string {
  const parts: string[] = [];
  if (f.exempt) parts.push('exempt>0');
  if (f.minBuyers !== undefined) parts.push(`min_buyers=${f.minBuyers}`);
  if (f.pair) parts.push(`pair=${f.pair}`);
  if (f.mute) parts.push(`mute ${String(f.mute[0]).padStart(2, '0')}:00-${String(f.mute[1]).padStart(2, '0')}:00`);
  return parts.length ? parts.join(' ') : 'none';
}

/** Is the quiet window open right now, in the bot's launch timezone? */
export function muted(f: FeedFilters, now: number): boolean {
  if (!f.mute) return false;
  const hour = zonedParts(now, LAUNCH_TZ).hour;
  const [from, to] = f.mute;
  // A window that wraps midnight is the normal case for this filter.
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

export interface LaunchRow {
  rowid: number;
  token: string;
  pair_token: string;
  snipe_exemption_count: number | null;
  buyers: number | null;
}

/**
 * Does this launch pass the subscriber's filters?
 *
 * A filter is a positive claim, so anything undetermined fails it. min_buyers
 * on a launch seconds old is the common case: the opening window has not been
 * indexed, the buyer count is unknown, and "unknown" is not "at least five".
 * The filter help says so, because otherwise it reads as a broken feed.
 */
export function matches(row: LaunchRow, f: FeedFilters): boolean {
  if (f.exempt && !(row.snipe_exemption_count !== null && row.snipe_exemption_count > 0)) return false;
  if (f.minBuyers !== undefined && !(row.buyers !== null && row.buyers >= f.minBuyers)) return false;
  if (f.pair) {
    const native = row.pair_token.toLowerCase() === NATIVE_PAIR;
    const want = f.pair.toLowerCase();
    if (want === 'eth') { if (!native) return false; }
    else if (want === 'stock') { if (native) return false; }
    else if (want.startsWith('0x')) { if (row.pair_token.toLowerCase() !== want) return false; }
    else return false; // a named asset this chain does not have
  }
  return true;
}

/**
 * Buyers in the opening window, or null when that has not been indexed.
 *
 * Null is the normal answer for a launch seconds old, which is every launch
 * this feed carries: the opening window is read by a background job minutes
 * later. So `min_buyers` filters out almost everything on a live feed, and the
 * filter help says exactly that rather than leaving it to be discovered as a
 * dead subscription. Zero rows is reported as unknown rather than as zero
 * buyers, because the two are not the same and only one of them is measured.
 */
export function buyersOf(token: string): number | null {
  const row = db
    .prepare("SELECT COUNT(DISTINCT recipient) AS n FROM trades WHERE token = ? AND side = 'buy'")
    .get(token.toLowerCase()) as { n: number } | undefined;
  return row && row.n > 0 ? row.n : null;
}

function pendingFor(sub: FeedSub, limit: number): LaunchRow[] {
  return (db
    .prepare(
      `SELECT rowid, token, pair_token, snipe_exemption_count
         FROM launches WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    )
    .all(sub.lastSent, limit) as any[])
    .map((r) => ({ ...r, buyers: buyersOf(r.token) }));
}

export function behindCount(sub: FeedSub): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM launches WHERE rowid > ?').get(sub.lastSent) as { n: number };
  return row.n;
}

/**
 * A token bucket for Telegram's global ceiling.
 *
 * Capacity is a whole tick's worth, not one second's. A pass sends its messages
 * without the clock advancing, so a bucket that could only ever hold one second
 * of budget spent 25 tokens and stopped, whichever subscribers happened to be
 * first. Measured: with 200 subscribers, everyone past number 25 was served
 * nothing at all for ten minutes.
 */
class GlobalLimiter {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  constructor(private perSec: number, now: number, burstMs: number) {
    this.capacity = Math.max(1, Math.round(perSec * (burstMs / 1000)));
    this.tokens = this.capacity;
    this.last = now;
  }
  take(now: number): boolean {
    const elapsed = (now - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perSec);
      this.last = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

let limiter: GlobalLimiter | null = null;
const lastDm = new Map<number, number>();
/**
 * Where this pass starts in the subscriber list.
 *
 * Iterating from the first subscriber every time is not fair, it is a queue
 * with a permanent front: once demand exceeds the global budget, the same early
 * user ids are served every pass and everybody behind them is served never.
 * Measured before this existed: subscribers past the bucket's capacity went ten
 * minutes and 500 launches without a single message.
 */
let rotation = 0;

/** For tests. */
export function resetFeedPacing(): void {
  limiter = null;
  lastDm.clear();
  rotation = 0;
}

export const PER_USER_GAP_MS = envNumber('FEED_USER_GAP_MS', 3_000);

export interface FeedTickOpts {
  now?: number;
  /** Render one launch as the quick card. Injected so tests need no chain. */
  render?: (token: string) => Promise<string | null>;
  /** Resolve a subscriber's tier. Injected for the same reason. */
  tier?: (userId: number) => Promise<Tier>;
}

export interface FeedTickResult {
  sent: number;
  summarised: number;
  skippedPaced: number;
  skippedGlobal: number;
}

/**
 * One delivery pass.
 *
 * At most one DM per subscriber, so the per-user gap is enforced by the tick
 * interval rather than by a sleep. The global bucket is checked LAST, after a
 * subscriber has been chosen and their card rendered, because a token spent on
 * a message that then fails a filter is a token nobody else could use.
 *
 * Nothing is ever silently dropped: a launch is either sent or counted into the
 * subscriber's missed total, which the summary line reports.
 */
export async function feedTick(api: Api, opts: FeedTickOpts = {}): Promise<FeedTickResult> {
  const now = opts.now ?? Date.now();
  limiter ??= new GlobalLimiter(FEED_GLOBAL_PER_SEC, now, FEED_TICK_MS);
  const render = opts.render ?? defaultRender;
  const tierFor = opts.tier ?? (async (u: number) => {
    const r = await tierOf(u, now);
    return r.state === 'ok' ? r.tier : 'none';
  });

  const result: FeedTickResult = { sent: 0, summarised: 0, skippedPaced: 0, skippedGlobal: 0 };
  const cards = new Map<string, string | null>();

  const subs = allSubs();
  if (subs.length) rotation %= subs.length;
  const ordered = subs.length ? [...subs.slice(rotation), ...subs.slice(0, rotation)] : subs;

  for (const sub of ordered) {
    if (sub.paused) continue;
    if (muted(sub.filters, now)) continue;
    const since = lastDm.get(sub.userId) ?? 0;
    if (now - since < PER_USER_GAP_MS) { result.skippedPaced++; continue; }

    const behind = behindCount(sub);
    if (behind === 0) continue;

    // Too far behind to catch up: bank the backlog and say so once.
    if (behind > FEED_BEHIND_MAX) {
      if (!limiter.take(now)) { result.skippedGlobal++; continue; }
      const total = sub.missed + behind;
      db.prepare('UPDATE feed_subs SET last_sent = ?, missed = 0 WHERE user_id = ?')
        .run(headRow(), sub.userId);
      lastDm.set(sub.userId, now);
      try {
        await api.sendMessage(sub.userId, `missed ${total.toLocaleString()} launches while you were away. /stats`);
        result.summarised++;
      } catch (err) {
        console.warn('[feed] summary failed:', String((err as Error)?.message ?? err).slice(0, 100));
      }
      continue;
    }

    if (!atLeast(await tierFor(sub.userId), 'premium')) continue;

    // Skip past anything this subscriber filtered out, advancing the cursor so
    // a filtered launch is not counted as missed.
    let chosen: LaunchRow | null = null;
    let cursor = sub.lastSent;
    for (const row of pendingFor(sub, FEED_BEHIND_MAX + 1)) {
      cursor = row.rowid;
      if (matches(row, sub.filters)) { chosen = row; break; }
    }
    if (!chosen) {
      db.prepare('UPDATE feed_subs SET last_sent = ? WHERE user_id = ?').run(cursor, sub.userId);
      continue;
    }

    if (!cards.has(chosen.token)) cards.set(chosen.token, await render(chosen.token));
    const card = cards.get(chosen.token) ?? null;
    if (!card) {
      // A scan that did not finish says nothing about the chain, so nothing is
      // sent and the cursor stays put for the next pass.
      continue;
    }
    if (!limiter.take(now)) { result.skippedGlobal++; continue; }
    lastDm.set(sub.userId, now);
    try {
      await api.sendMessage(sub.userId, card, { link_preview_options: { is_disabled: true } });
      db.prepare('UPDATE feed_subs SET last_sent = ? WHERE user_id = ?').run(chosen.rowid, sub.userId);
      result.sent++;
    } catch (err) {
      // A blocked bot or a deleted chat. The cursor is left alone so the launch
      // is retried, and the subscription is not silently cancelled.
      console.warn('[feed] delivery failed:', String((err as Error)?.message ?? err).slice(0, 100));
    }
  }
  // Advance past whoever was served, so the next pass starts with the people
  // this one could not reach.
  if (subs.length) rotation = (rotation + result.sent + result.summarised) % subs.length;
  return result;
}

async function defaultRender(token: string): Promise<string | null> {
  const { performScan } = await import('./service.js');
  const out = await performScan({ token, source: 'cli', unlimited: true });
  return out.kind === 'ok' ? out.defaultCard : null;
}

export function startFeedLoop(api: Api, intervalMs = FEED_TICK_MS): NodeJS.Timeout {
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    void feedTick(api)
      .catch((err) => console.warn('[feed] tick failed:', String((err as Error)?.message ?? err).slice(0, 140)))
      .finally(() => { running = false; });
  }, intervalMs);
  t.unref?.();
  return t;
}
