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

export interface CachedScan {
  /** Full HTML card, for DM. */
  card: string;
  /** Compact HTML card, for groups and inline. */
  compact: string;
  /** Enough structure to build an inline result without re-scanning. */
  meta: {
    symbol: string | null;
    traction: string;
    flagsRaised: number;
    flagsTotal: number;
    flagsUnknown: number;
    topFlag: string | null;
    notFound: boolean;
  };
  ts: number;
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

  get(token: string): CachedScan | null {
    const k = this.key(token);
    const hit = this.map.get(k);
    if (!hit) {
      this.misses++;
      return null;
    }
    if (Date.now() - hit.ts > this.ttlMs) {
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
    return !!hit && Date.now() - hit.ts <= this.ttlMs;
  }

  set(token: string, value: Omit<CachedScan, 'ts'>): void {
    const k = this.key(token);
    // Re-inserting refreshes insertion order, so a hot token is not evicted
    // ahead of a cold one that happened to be written later.
    this.map.delete(k);
    this.map.set(k, { ...value, ts: Date.now() });

    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.evictions++;
    }
  }

  /** Drop expired entries. Bounds memory when traffic goes quiet. */
  sweep(): number {
    const now = Date.now();
    let n = 0;
    for (const [k, v] of this.map) {
      if (now - v.ts > this.ttlMs) {
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
