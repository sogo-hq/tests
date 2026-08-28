import { isAddress, getAddress } from 'viem';
import { scanToken, type ScanResult } from './scan.js';
import { renderCard, renderDefaultCard, renderDefaultNotFound, compactMeta, type CompactMeta } from './card.js';
import { scanCache, type CachedScan } from './cache.js';
import { userQuota, floodQuota, scanSemaphore, SlotTimeout, formatRetry } from './quota.js';
import { db } from './db.js';
import { EARLY_CACHE_TTL_MS, EARLY_WINDOW_SECONDS } from './config.js';

export type ScanSource = 'dm' | 'group' | 'inline' | 'cli';

/**
 * What a user sees when a scan fails for a reason that is not their problem.
 * The real error goes to the server log -- an RPC stack trace in a group chat
 * helps nobody and leaks internals.
 */
export const SCAN_FAILED = 'scan failed, try again';

export type ScanOutcome =
  | { kind: 'ok'; defaultCard: string; fullCard: string; meta: CompactMeta; cacheHit: boolean; durationMs: number }
  | { kind: 'not_found'; defaultCard: string; fullCard: string; meta: CompactMeta; cacheHit: boolean; durationMs: number }
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
  /**
   * Identity the limiters key on. Callers resolve this because the right answer
   * is surface-specific -- see quotaIdentity() in bot.ts, where anonymous group
   * admins have to be keyed on the chat rather than the single shared bot id
   * Telegram gives them all.
   */
  quotaKey?: number;
  /**
   * Skip all user limits. Only the local CLI sets this. It is explicit rather
   * than inferred from a missing user id, so an update that simply arrives
   * without a sender can never be mistaken for a trusted local caller.
   */
  unlimited?: boolean;
}

const insertEvent = db.prepare(`
  INSERT INTO scan_events (ts, source, chat_id, user_id, token, cache_hit, duration_ms, outcome, scan_id)
  VALUES (?,?,?,?,?,?,?,?,?)
`);

/**
 * One line per scan request, on stdout.
 *
 * Nothing about scans reached the logs before this: whether anyone was using
 * the bot, from which surface, and where the time went were all invisible
 * outside the database. key=value so it greps and so a line stays readable when
 * a field is genuinely unknown -- a rate-limited request has no age and no
 * early-mode verdict, and printing 0 for those would be a measurement nobody
 * took.
 */
function logScanLine(
  req: ScanRequest,
  cacheHit: boolean,
  durationMs: number,
  outcome: string,
  meta?: { ageSeconds: number; early: boolean },
): void {
  const parts = [
    `source=${req.source}`,
    `token=${req.token}`,
    meta ? `age=${meta.ageSeconds}s` : 'age=?',
    `cache=${cacheHit ? 'hit' : 'miss'}`,
    `duration=${Math.round(durationMs)}ms`,
    meta ? `early=${meta.early ? 'yes' : 'no'}` : 'early=?',
    `outcome=${outcome}`,
  ];
  console.log(`[scan] ${parts.join(' ')}`);
}

/** Exposed for tests: the log format is the operator-facing contract. */
export const logScanLineForTest = logScanLine;

function logEvent(
  req: ScanRequest,
  cacheHit: boolean,
  durationMs: number,
  outcome: string,
  scanId?: number,
  meta?: { ageSeconds: number; early: boolean },
): void {
  logScanLine(req, cacheHit, durationMs, outcome, meta);
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

/**
 * A 20-byte address, and only when it stands alone.
 *
 * The lookarounds matter: a transaction hash is 0x plus 64 hex characters, and
 * an unanchored 40-hex match happily takes the first 40 of them and hands back a
 * plausible-looking address that belongs to nobody. The user would get "not a
 * pons v2 launch" for a perfectly real transaction, with no hint why.
 */
const ADDRESS_RE = /(?<![a-fA-F0-9])0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/;
const TX_HASH_RE = /(?<![a-fA-F0-9])0x[a-fA-F0-9]{64}(?![a-fA-F0-9])/;

export function normaliseToken(raw: string): string | null {
  const m = raw.match(ADDRESS_RE);
  if (!m) return null;
  return isAddress(m[0]) ? getAddress(m[0]) : null;
}

/** Did the user paste a transaction hash instead of a token address? */
export function looksLikeTxHash(raw: string): boolean {
  return TX_HASH_RE.test(raw);
}

function fromCache(hit: CachedScan): { defaultCard: string; fullCard: string; meta: CompactMeta } {
  return { defaultCard: hit.defaultCard, fullCard: hit.fullCard, meta: hit.meta };
}

interface RenderedScan {
  /** Plain-text card shown by default on every surface. */
  defaultCard: string;
  /** Today's HTML card, shown only for /full. */
  fullCard: string;
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
    const notFound = renderDefaultNotFound(token, botUsername);
    return {
      defaultCard: notFound,
      fullCard: notFound,
      meta: {
        symbol: null, traction: 'unknown', flagsRaised: 0, flagsTotal: 0,
        flagsUnknown: 0, topFlag: null, notFound: true, early: false, ageSeconds: 0,
        earlyThresholdSeconds: EARLY_WINDOW_SECONDS,
      },
    };
  }
  return {
    defaultCard: renderDefaultCard(result, botUsername),
    fullCard: renderCard(result),
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
      //
      // An early-mode card is only true for a few seconds -- the same launch at
      // 5s and at 90s are different answers, and one of them says "too early"
      // while the other has real traction -- so it gets a much shorter life than
      // the settled card that follows it.
      scanCache.set(token, {
        defaultCard: rendered.defaultCard,
        fullCard: rendered.fullCard,
        meta: rendered.meta,
        ttlMs: earlyTtlFor(rendered.meta),
      });
      return rendered;
    } finally {
      release();
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  // Every real caller awaits `run` and handles its rejection. This handler
  // exists only so that a scan whose callers have all timed out does not count
  // as an unhandled rejection, which Node escalates to a process exit. The
  // error itself is logged by performScan's catch on the awaiting path.
  run.catch(() => { /* handled by awaiting callers in performScan */ });
  return run;
}

/**
 * How long an early-mode card may be served for.
 *
 * Capped at the shorter of the early cache life and the time left in the early
 * window itself. Without the second bound a card rendered at 179s would keep
 * telling users "too early for traction" until 189s -- nine seconds after the
 * token stopped being early and the real card became available. Returns
 * undefined for a settled card, which then takes the normal cache lifetime.
 */
function earlyTtlFor(meta: { early: boolean; ageSeconds: number; earlyThresholdSeconds?: number }): number | undefined {
  if (!meta.early) return undefined;
  // The threshold this scan actually used, not the constant: without an exact
  // launch time the window is widened by the drift margin, and computing the
  // remaining life against the narrower constant yields a negative number that
  // clamps to zero -- an early card that is never cached at all, so every
  // request in that state re-scans.
  const threshold = meta.earlyThresholdSeconds ?? EARLY_WINDOW_SECONDS;
  const untilSettled = (threshold - meta.ageSeconds) * 1000;
  return Math.max(0, Math.min(EARLY_CACHE_TTL_MS, untilSettled));
}

/**
 * Seconds an early answer may be cached by Telegram itself.
 *
 * The same computation as the in-process TTL, deliberately: Telegram's inline
 * answer cache is shared across every user, so a flat value there would re-open
 * exactly the overhang the server-side cap closes -- a card rendered at 179s
 * still being served as "too early" well after the token settled.
 */
export function inlineCacheSeconds(
  meta: { early: boolean; ageSeconds: number; earlyThresholdSeconds?: number },
  settledSeconds = 60,
): number {
  const ttl = earlyTtlFor(meta);
  return ttl === undefined ? settledSeconds : Math.max(1, Math.round(ttl / 1000));
}

/** Exposed for tests; the window cap is a boundary worth asserting directly. */
export const earlyTtlForTest = earlyTtlFor;

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

  // Quota identity: the user, falling back to the chat. Telegram does not always
  // supply `from` -- anonymous group admins post as a single shared bot id, and
  // some automated posts omit it entirely -- so callers pass a resolved key.
  // A bot-surface request with no identity at all still gets limited, under key
  // 0; only an explicitly unlimited caller (the CLI) escapes.
  const quotaKey = req.unlimited ? undefined : (req.quotaKey ?? req.userId ?? req.chatId ?? 0);

  // 0. Flood cap. Applies to EVERY request, cache hits included.
  //
  // The scan quota below deliberately exempts cache hits, because they cost no
  // RPC -- but the bot still emits a message per request, so without this a user
  // could pay one scan for a token and then have the bot post the cached card
  // two hundred times into a group inside a minute. This cap is set well above
  // any legitimate rhythm and only bites on flooding.
  if (quotaKey !== undefined) {
    const flood = floodQuota.consume(quotaKey);
    if (!flood.allowed) {
      const d = Date.now() - started;
      logEvent(req, false, d, `flood_limited_${flood.window}`);
      return {
        kind: 'rate_limited',
        retryAfterSec: flood.retryAfterSec,
        window: flood.window!,
        message: `rate limited, try again in ${formatRetry(flood.retryAfterSec)}`,
      };
    }
  }

  // 1. Cache.
  const hit = scanCache.get(token);
  if (hit) {
    const d = Date.now() - started;
    const payload = fromCache(hit);
    // No age or early verdict for an address that is not a launch at all.
    logEvent(req, true, d, hit.meta.notFound ? 'not_found' : 'ok', undefined, hit.meta.notFound ? undefined : hit.meta);
    return hit.meta.notFound
      ? { kind: 'not_found', ...payload, cacheHit: true, durationMs: d }
      : { kind: 'ok', ...payload, cacheHit: true, durationMs: d };
  }

  // 2. Scan quota. Counts real scans only -- a cache hit did no RPC.
  let consumedScanQuota = false;
  if (quotaKey !== undefined) {
    const decision = userQuota.consume(quotaKey);
    consumedScanQuota = decision.allowed;
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
    // A token the factory has never heard of is not a scan the user should be
    // charged for -- they asked a fair question and got no answer.
    if (kind === 'not_found' && consumedScanQuota && quotaKey !== undefined) {
      userQuota.refund(quotaKey);
    }
    logEvent(req, false, d, kind, rendered.scanId, rendered.meta.notFound ? undefined : rendered.meta);
    return {
      kind,
      defaultCard: rendered.defaultCard,
      fullCard: rendered.fullCard,
      meta: rendered.meta,
      cacheHit: false,
      durationMs: d,
    } as ScanOutcome;
  } catch (err: any) {
    const d = Date.now() - started;
    if (err instanceof DeadlineExceeded || err instanceof SlotTimeout) {
      // The scan itself continues and will still fill the cache, so the user is
      // not charged for work they will get the benefit of on retry either.
      if (consumedScanQuota && quotaKey !== undefined) userQuota.refund(quotaKey);
      logEvent(req, false, d, 'timeout');
      return { kind: 'busy', message: 'still indexing, try again in a moment' };
    }
    // A failed scan is not the user's fault and is not charged to them. The
    // full error goes to the server log; the user gets a plain sentence.
    if (consumedScanQuota && quotaKey !== undefined) userQuota.refund(quotaKey);
    console.error(`[scan] failed for ${token} (${req.source}):`, err);
    logEvent(req, false, d, 'error');
    return { kind: 'error', message: SCAN_FAILED };
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
    p.catch(() => { /* abandoned by design; the caller is told via DeadlineExceeded */ });
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
