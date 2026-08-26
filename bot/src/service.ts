import { isAddress, getAddress } from 'viem';
import { scanToken, type ScanResult } from './scan.js';
import { renderCard, renderCompactCard, renderCompactNotFound, compactMeta, type CompactMeta } from './card.js';
import { scanCache, type CachedScan } from './cache.js';
import { userQuota, scanSemaphore, SlotTimeout, formatRetry } from './quota.js';
import { db } from './db.js';

export type ScanSource = 'dm' | 'group' | 'inline' | 'cli';

export type ScanOutcome =
  | { kind: 'ok'; card: string; compact: string; meta: CompactMeta; cacheHit: boolean; durationMs: number }
  | { kind: 'not_found'; card: string; compact: string; meta: CompactMeta; cacheHit: boolean; durationMs: number }
  | { kind: 'rate_limited'; retryAfterSec: number; window: 'minute' | 'hour'; message: string }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string };

export interface ScanRequest {
  token: string;
  source: ScanSource;
  userId?: number;
  chatId?: number;
  /** Abandon rather than exceed this budget. Inline mode sets it; DM does not. */
  deadlineMs?: number;
  botUsername?: string;
}

const insertEvent = db.prepare(`
  INSERT INTO scan_events (ts, source, chat_id, user_id, token, cache_hit, duration_ms, outcome, scan_id)
  VALUES (?,?,?,?,?,?,?,?,?)
`);

function logEvent(req: ScanRequest, cacheHit: boolean, durationMs: number, outcome: string, scanId?: number): void {
  try {
    insertEvent.run(
      Math.floor(Date.now() / 1000),
      req.source,
      req.chatId ?? null,
      req.userId ?? null,
      req.token ? req.token.toLowerCase() : null,
      cacheHit ? 1 : 0,
      Math.round(durationMs),
      outcome,
      scanId ?? null,
    );
  } catch (err) {
    // Telemetry must never break a scan.
    console.error('[events] insert failed:', err);
  }
}

export function normaliseToken(raw: string): string | null {
  const m = raw.match(/0x[a-fA-F0-9]{40}/);
  if (!m) return null;
  return isAddress(m[0]) ? getAddress(m[0]) : null;
}

function fromCache(hit: CachedScan): { card: string; compact: string; meta: CompactMeta } {
  return { card: hit.card, compact: hit.compact, meta: hit.meta };
}

interface RenderedScan {
  card: string;
  compact: string;
  meta: CompactMeta;
  scanId?: number;
}

/**
 * Scans currently running, keyed by token.
 *
 * Two things depend on this, and both were broken without it:
 *
 * 1. Thundering herd. Five people pasting the same trending token within a
 *    second would each have run a full scan, and could occupy all five global
 *    slots with identical work. Now the first starts it and the rest await it.
 *
 * 2. Honest timeouts. The inline deadline abandons the *caller*, not the scan.
 *    Previously the result was simply discarded, so "still indexing, try again
 *    in a moment" sent the user back to a cache that was still empty and they
 *    paid the full cost again. The shared scan writes to the cache when it
 *    finishes regardless of whether anyone is still waiting, which is what makes
 *    that message a true statement.
 */
const inFlight = new Map<string, Promise<RenderedScan>>();

function render(token: string, result: Awaited<ReturnType<typeof scanToken>>, botUsername?: string): RenderedScan {
  if (!result) {
    const compact = renderCompactNotFound(token, botUsername);
    return {
      card: compact,
      compact,
      meta: {
        symbol: null, traction: 'unknown', flagsRaised: 0, flagsTotal: 0,
        flagsUnknown: 0, topFlag: null, notFound: true,
      },
    };
  }
  return {
    card: renderCard(result),
    compact: renderCompactCard(result, botUsername),
    meta: compactMeta(result),
    scanId: result.scanId,
  };
}

/**
 * Start a scan, or join the one already running for this token.
 *
 * The global concurrency slot is taken inside here rather than by the caller,
 * so joiners cost nothing and a caller that gives up does not release a slot
 * the shared work is still using.
 */
function sharedScan(token: string, userId?: number, botUsername?: string): Promise<RenderedScan> {
  const key = token.toLowerCase();
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = (async (): Promise<RenderedScan> => {
    const release = await scanSemaphore.acquire();
    try {
      const result = await scanToken(token, userId);
      const rendered = render(token, result, botUsername);
      // Cached here, not at the call site: the caller may already have timed out.
      scanCache.set(token, { card: rendered.card, compact: rendered.compact, meta: rendered.meta });
      return rendered;
    } finally {
      release();
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  // Callers attach their own handlers; this one only stops Node treating a
  // fully-abandoned rejection as unhandled.
  run.catch(() => {});
  return run;
}

/** In-flight scans, for diagnostics. */
export function inFlightCount(): number {
  return inFlight.size;
}

/**
 * The single entry point behind DM, group and inline.
 *
 * Ordering matters and is deliberate:
 *   1. cache first, so a hit costs no quota and no RPC
 *   2. per-user quota, before queueing, so one user cannot fill the queue
 *   3. global concurrency slot, with an optional deadline
 *
 * Checking quota before the semaphore is the part that actually protects the
 * node: if a spammer could queue first, their requests would occupy scan slots
 * that legitimate users are waiting behind, and rejecting them at the front of
 * the queue afterwards would have already cost the wait.
 */
export async function performScan(req: ScanRequest): Promise<ScanOutcome> {
  const started = Date.now();
  const token = req.token;

  // 1. Cache.
  const hit = scanCache.get(token);
  if (hit) {
    const d = Date.now() - started;
    const payload = fromCache(hit);
    logEvent(req, true, d, hit.meta.notFound ? 'not_found' : 'ok');
    return hit.meta.notFound
      ? { kind: 'not_found', ...payload, cacheHit: true, durationMs: d }
      : { kind: 'ok', ...payload, cacheHit: true, durationMs: d };
  }

  // 2. Per-user quota. Anonymous callers (CLI) are not limited.
  if (req.userId !== undefined) {
    const decision = userQuota.consume(req.userId);
    if (!decision.allowed) {
      const d = Date.now() - started;
      logEvent(req, false, d, `rate_limited_${decision.window}`);
      return {
        kind: 'rate_limited',
        retryAfterSec: decision.retryAfterSec,
        window: decision.window!,
        message: `rate limited, try again in ${formatRetry(decision.retryAfterSec)}`,
      };
    }
  }

  // 3. Run it, or join a scan already running for this token.
  const shared = sharedScan(token, req.userId, req.botUsername);
  try {
    const remaining = req.deadlineMs !== undefined
      ? req.deadlineMs - (Date.now() - started)
      : undefined;
    const rendered = remaining !== undefined
      ? await withDeadline(shared, remaining)
      : await shared;

    const d = Date.now() - started;
    const kind = rendered.meta.notFound ? 'not_found' : 'ok';
    logEvent(req, false, d, kind, rendered.scanId);
    return {
      kind,
      card: rendered.card,
      compact: rendered.compact,
      meta: rendered.meta,
      cacheHit: false,
      durationMs: d,
    } as ScanOutcome;
  } catch (err: any) {
    const d = Date.now() - started;
    if (err instanceof DeadlineExceeded || err instanceof SlotTimeout) {
      // The scan itself continues and will still fill the cache.
      logEvent(req, false, d, 'timeout');
      return { kind: 'busy', message: 'still indexing, try again in a moment' };
    }
    console.error('[scan] failed:', err);
    logEvent(req, false, d, 'error');
    return { kind: 'error', message: String(err?.shortMessage ?? err?.message ?? err).slice(0, 200) };
  }
}

export class DeadlineExceeded extends Error {
  constructor() {
    super('deadline exceeded');
    this.name = 'DeadlineExceeded';
  }
}

/**
 * Races a promise against a deadline.
 *
 * Abandons the caller, never the work: the shared scan behind it keeps running
 * and writes its result to the cache when it finishes (see sharedScan). That is
 * what lets the bot say "try again in a moment" and be telling the truth.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    // Still attach a handler before walking away: returning without one leaves
    // an unhandled rejection if the abandoned promise later fails, which Node
    // escalates to a process crash by default.
    p.catch(() => {});
    return Promise.reject(new DeadlineExceeded());
  }
  return new Promise<T>((resolve, reject) => {
    // Not unref'd, for the same reason as the semaphore's queue timer: the
    // rejection is this promise's only other exit.
    const timer = setTimeout(() => reject(new DeadlineExceeded()), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
