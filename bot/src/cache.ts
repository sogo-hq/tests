/**
 * Rendered-card cache.
 *
 * A scan costs roughly 1.5s and a burst of RPC requests against a rate-limited
 * node. Inline mode makes repeats the common case rather than the exception:
 * Telegram re-issues an inline_query on nearly every keystroke, and a token
 * doing the rounds in a group gets scanned by many people within the same
 * minute. Serving those from memory is the difference between the bot being
 * usable inline and it timing out.
 *
 * A hit skips all RPC. It deliberately also skips the `scans` table write --
 * that row is the analytical record of a distinct observation, and writing a
 * duplicate row with byte-identical metrics 4 seconds after the last one would
 * corrupt the very outcome-pairing the table exists for. Usage is still fully
 * recorded: every request, hit or miss, writes a `scan_events` row.
 */

import type { CompactMeta } from './card.js';
import type { ScanResult } from './scan.js';

export interface CachedScan {
  /**
   * The sponsor line this card's text was rendered with.
   *
   * Set on write; an entry whose version no longer matches is a miss, because
   * the paid line lives inside defaultCard and a card carrying the previous one
   * is simply the wrong card.
   */
  sponsorVersion?: number;
  /** Plain-text card shown by default on every surface. */
  defaultCard: string;
  /** Today's HTML card, served only by /full. */
  fullCard: string;
  /**
   * Rendered PNG, attached lazily the first time someone asks for the image.
   * Absent until then -- rendering is opt-in and most requests never want it.
   */
  png?: Buffer;
  /**
   * The scan this entry was rendered from, kept so the image can be produced
   * later without re-scanning. Held only in memory and only for the entry's
   * lifetime; a PNG is roughly 50 KB and is attached to a handful of entries at
   * most, since it exists only where somebody pressed the button.
   */
  result?: ScanResult;
  /**
   * Enough structure to build an inline result without re-scanning. Uses the
   * renderer's own type rather than a structural copy, so a field added there
   * cannot silently drift out of the cached payload.
   */
  meta: CompactMeta;
  ts: number;
  /** Per-entry lifetime. Omitted entries use the cache default. */
  ttlMs?: number;
}

/**
 * A malformed value must not silently disable the cache's limits: Number('x')
 * is NaN, and both `age > NaN` and `size > NaN` are false, which would turn off
 * expiry and the entry cap at the same time -- an unbounded cache serving
 * arbitrarily stale cards, with nothing in the logs to say so.
 */
function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[cache] ignoring invalid ${name}=${JSON.stringify(raw)}, using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

const TTL_MS = positiveInt('SCAN_CACHE_TTL_MS', process.env.SCAN_CACHE_TTL_MS, 60_000);
const MAX_ENTRIES = positiveInt('SCAN_CACHE_MAX', process.env.SCAN_CACHE_MAX, 500);

import { sponsorVersion } from './sponsor.js';

export class ScanCache {
  private map = new Map<string, CachedScan>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expired = 0;

  constructor(ttlMs = TTL_MS, maxEntries = MAX_ENTRIES) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 60_000;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 500;
  }

  private ttlMs: number;
  private maxEntries: number;

  private key(token: string): string {
    return token.toLowerCase();
  }

  /**
   * Lifetime for one entry: its own if it set one, otherwise the default.
   *
   * An explicit ttlMs is authoritative even when it is very small or zero.
   * Treating a small value as "unset" and falling back to the 60s default would
   * invert the caller's intent at exactly the moment it matters most -- a card
   * asked to live one more second would instead live a minute.
   */
  private lifetime(entry: CachedScan): number {
    return entry.ttlMs === undefined ? this.ttlMs : Math.max(0, entry.ttlMs);
  }

  get(token: string): CachedScan | null {
    const k = this.key(token);
    const hit = this.map.get(k);
    if (!hit) {
      this.misses++;
      return null;
    }
    if (hit.sponsorVersion !== sponsorVersion()) {
      // The paid line is part of the card's text, so a card rendered under a
      // different one is the wrong card now. Dropped rather than served: the
      // whole point of reading it at send time is that it changes without a
      // deploy, and a minute of the old line is a minute nobody paid for.
      this.map.delete(k);
      this.expired++;
      this.misses++;
      return null;
    }
    if (Date.now() - hit.ts > this.lifetime(hit)) {
      // Expired entries are dropped on read; a stale card is worse than a slow
      // one when the underlying metrics move minute to minute.
      this.map.delete(k);
      this.expired++;
      this.misses++;
      return null;
    }
    this.hits++;
    // A shallow copy, so a caller cannot mutate what the next reader will see.
    // The cards are strings; only meta is worth copying.
    return { ...hit, meta: { ...hit.meta } };
  }

  /**
   * Is this token cached right now? Does not count as a hit or a miss.
   *
   * Used only so a DM can skip the "Scanning..." notice when the answer is
   * already in hand; counting it would inflate the hit rate with lookups that
   * were never really requests.
   */
  peek(token: string): boolean {
    const hit = this.map.get(this.key(token));
    return !!hit && Date.now() - hit.ts <= this.lifetime(hit);
  }

  set(token: string, value: Omit<CachedScan, 'ts'>): void {
    const k = this.key(token);
    // Re-inserting refreshes insertion order, so a hot token is not evicted
    // ahead of a cold one that happened to be written later.
    this.map.delete(k);
    // Stamped on write, so a later read can tell whether the paid line inside
    // this card is still the one being sold.
    this.map.set(k, { ...value, ts: Date.now(), sponsorVersion: sponsorVersion() });

    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.evictions++;
    }
  }

  /**
   * Attach a rendered PNG to an existing entry without touching its timestamp.
   *
   * The image shares the text card's key and lifetime: re-rendering the same
   * scan is waste, and an image that outlived the text it was made from would
   * be a different answer wearing the same address. Returns false when the
   * entry has already gone, in which case the caller has nothing to attach to.
   */
  attachPng(token: string, png: Buffer): boolean {
    const hit = this.map.get(this.key(token));
    if (!hit || Date.now() - hit.ts > this.lifetime(hit)) return false;
    hit.png = png;
    return true;
  }

  /**
   * Forget one token.
   *
   * `sweep()` only drops entries that have expired, so it cannot be used to
   * force a miss -- several tests called it expecting exactly that and were
   * quietly measuring cache hits instead.
   */
  drop(token: string): boolean {
    return this.map.delete(this.key(token));
  }

  /** Drop expired entries. Bounds memory when traffic goes quiet. */
  sweep(): number {
    const now = Date.now();
    let n = 0;
    for (const [k, v] of this.map) {
      if (now - v.ts > this.lifetime(v)) {
        this.map.delete(k);
        n++;
      }
    }
    this.expired += n;
    return n;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      requests: total,
      hitRate: total > 0 ? this.hits / total : 0,
      evictions: this.evictions,
      expired: this.expired,
    };
  }

  toString(): string {
    const s = this.stats();
    return `hit rate ${(s.hitRate * 100).toFixed(1)}% (${s.hits}/${s.requests}), ${s.size}/${s.maxEntries} entries, ${s.evictions} evicted, ${s.expired} expired`;
  }
}

export const scanCache = new ScanCache();

/** Periodically sweep and report the hit rate, so it is visible in the log. */
export function startCacheReporter(intervalMs = 300_000): NodeJS.Timeout {
  const t = setInterval(() => {
    const swept = scanCache.sweep();
    const s = scanCache.stats();
    if (s.requests > 0) {
      console.log(`[cache] ${scanCache.toString()}${swept ? `, ${swept} swept` : ''}`);
    }
  }, intervalMs);
  t.unref?.();
  return t;
}
