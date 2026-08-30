import { AsyncLocalStorage } from 'node:async_hooks';
import { RPC_URL } from './config.js';

/**
 * Client-side pacing for the RPC.
 *
 * Measured behaviour of this node: bursting uncapped concurrency at it returns
 * HTTP 429 ("Rate Limit Hit, limit will reset in 60 seconds") after roughly 158
 * requests, with a `retry-after` header. Paced at 10 req/s it sustains
 * indefinitely -- 248 consecutive requests over 25s with zero rejections. So the
 * constraint is burst rate, not a fixed quota, and pacing alone fixes it.
 *
 * This is installed as a global fetch wrapper rather than wired through each
 * call site so that viem's own internal retries are paced too -- those would
 * otherwise bypass any limiter applied at the application layer, and retries
 * are exactly what a rate-limited client does most of.
 *
 * Only requests to the configured RPC host are affected; everything else passes
 * straight through.
 */

const RATE_PER_SEC = Number(process.env.RPC_RATE_PER_SEC || 10);
const BURST = Number(process.env.RPC_BURST || 10);
const MAX_429_RETRIES = 6;

/** How long after interactive work background requests stay out of the way. */
const BULK_QUIET_MS = Number(process.env.BULK_QUIET_MS || 1_000) || 1_000;

/** Share of the bucket kept for whatever arrives next, never spent on background work. */
const BULK_RESERVE_FRACTION = Math.min(
  0.9,
  Math.max(0, Number(process.env.BULK_RESERVE_FRACTION ?? 0.5)),
);

/**
 * How long the 429 ladder may spend waiting before it gives up.
 *
 * This wrapper sleeps *inside* the fetch viem is awaiting, so viem's transport
 * timeout (60s, chain.ts) covers the whole ladder rather than a single attempt.
 * The unbounded ladder sums to 1+2+4+8+16+30 = 61s, and a `retry-after: 60` --
 * exactly what this node sends -- blows the budget on the first wait. In both
 * cases viem aborted first and the limit reached the user as a TimeoutError,
 * classified as "scan failed": the false report this class exists to prevent.
 * Kept comfortably under the transport timeout so the throw below always wins.
 */
export const BUDGET_MS = Number(process.env.RPC_429_BUDGET_MS || 45_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does this error, or anything that caused it, mean the node limited us? */
export function isRateLimit(err: unknown): boolean {
  let cur: any = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    if (cur instanceof RpcRateLimited) return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * The node rate-limited us and retrying did not clear it.
 *
 * Thrown rather than returned as a 429 response so callers can tell this apart
 * from a scan that genuinely failed. Returning the response let viem surface it
 * as an ordinary request error, which reached the user as "scan failed, try
 * again" -- a false report about a token that was perfectly fine.
 */
export class RpcRateLimited extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`rpc rate limited, retry after ${retryAfterSec}s`);
    this.name = 'RpcRateLimited';
  }
}

/**
 * Request priority.
 *
 * An interactive /scan and a bulk backfill share one rate budget, so without
 * this a scan issued during a backfill queues behind thousands of bulk requests
 * -- measured at 10s per scan under contention, versus about 1s idle. Priority
 * travels through AsyncLocalStorage because the limiter sits in a global fetch
 * wrapper and cannot take an argument from the call site.
 */
type Priority = 'interactive' | 'bulk';
const priorityStore = new AsyncLocalStorage<Priority>();

/** Run `fn` with its RPC requests served ahead of bulk work. */
export function interactive<T>(fn: () => Promise<T>): Promise<T> {
  return priorityStore.run('interactive', fn);
}

/** Run `fn` with its RPC requests yielding to interactive work. */
export function bulk<T>(fn: () => Promise<T>): Promise<T> {
  return priorityStore.run('bulk', fn);
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private queue: { resolve: () => void; priority: Priority }[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private rate: number, private capacity: number) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  /** Temporarily slow down after a 429, then recover. */
  penalise(): void {
    this.tokens = 0;
    this.rate = Math.max(1, this.rate * 0.6);
    setTimeout(() => {
      this.rate = Math.min(RATE_PER_SEC, this.rate / 0.6);
    }, 30_000);
  }

  /**
   * May a background request take a token right now?
   *
   * Serving bulk work ahead of nothing is not the same as serving it for free:
   * every token it takes is one an interactive request has to wait to be
   * refilled. Measured, a scan's cumulative queue wait went from 1.5s idle to
   * 12s with the indexer running, and its queue from 4 deep to 15 -- priority
   * ordering alone could not prevent that, because ordering decides who is
   * served next, not who already drank the bucket dry.
   *
   * So background work is served only out of genuine surplus: nothing
   * interactive waiting, nothing interactive served in the last second, and a
   * reserve of tokens left untouched for whatever arrives next.
   */
  private bulkMayProceed(): boolean {
    if (this.queue.some((q) => q.priority === 'interactive')) return false;
    if (Date.now() - this.lastInteractiveAt < BULK_QUIET_MS) return false;
    return this.tokens >= 1 + this.capacity * BULK_RESERVE_FRACTION;
  }

  private pump(): void {
    this.refill();
    while (this.queue.length && this.tokens >= 1) {
      // Interactive requests are served first; bulk work fills the gaps -- and
      // only the gaps.
      let idx = this.queue.findIndex((q) => q.priority === 'interactive');
      if (idx === -1) {
        if (!this.bulkMayProceed()) break;
        idx = 0;
      }
      this.tokens -= 1;
      this.queue.splice(idx, 1)[0]!.resolve();
    }
    if (this.queue.length && !this.timer) {
      // Re-armed even when nothing was servable: a queue holding only bulk work
      // during a busy spell still has to be woken once the spell passes, or it
      // waits for the next arrival to pump it and can sit indefinitely.
      const waitMs = Math.max(10, Math.min(BULK_QUIET_MS, ((1 - this.tokens) / this.rate) * 1000));
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, waitMs);
    }
  }

  /** Tokens beyond the interactive reserve, for sizing a background batch. */
  spareTokens(): number {
    this.refill();
    if (!this.bulkMayProceed()) return 0;
    return Math.max(0, Math.floor(this.tokens - this.capacity * BULK_RESERVE_FRACTION));
  }

  pendingInteractive(): number {
    return this.queue.reduce((n, q) => n + (q.priority === 'interactive' ? 1 : 0), 0);
  }

  /** When an interactive request last took a token. */
  lastInteractiveAt = 0;

  acquire(): Promise<void> {
    const priority = priorityStore.getStore() ?? 'interactive';
    if (priority === 'interactive') this.lastInteractiveAt = Date.now();

    // Measured at the moment of enqueue, because that is the number that
    // answers "did this scan wait behind background work" -- the depth it
    // arrived into and the time it then spent queued. Inferring it from total
    // scan duration cannot tell contention apart from a slow node.
    const stats = waitStore.getStore();
    const queuedBehind = this.queue.length;
    const enqueuedAt = Date.now();

    return new Promise((resolve) => {
      this.queue.push({
        priority,
        resolve: () => {
          if (stats) {
            stats.requests++;
            stats.waitMs += Date.now() - enqueuedAt;
            stats.maxQueue = Math.max(stats.maxQueue, queuedBehind);
            stats.bulkAhead = Math.max(
              stats.bulkAhead,
              // How much of that queue was background work. This is the number
              // that confirms or refutes "scans are waiting behind the indexer".
              queuedBehind === 0 ? 0 : this.bulkAheadAtEnqueue,
            );
          }
          resolve();
        },
      });
      this.bulkAheadAtEnqueue = this.queue.reduce(
        (n, q) => n + (q.priority === 'bulk' ? 1 : 0),
        0,
      );
      this.pump();
    });
  }

  /** Bulk items queued when the most recent acquire arrived. */
  private bulkAheadAtEnqueue = 0;
}

/** What one scan spent waiting for the limiter. */
export interface WaitStats {
  requests: number;
  waitMs: number;
  maxQueue: number;
  bulkAhead: number;
}

const waitStore = new AsyncLocalStorage<WaitStats>();

/**
 * Run `fn` with its limiter waits recorded.
 *
 * Wraps rather than replaces `interactive`, so the priority context and the
 * measurement context are established together and a caller cannot get one
 * without the other.
 */
export function measuringWaits<T>(fn: () => Promise<T>): Promise<{ value: T; waits: WaitStats }> {
  const waits: WaitStats = { requests: 0, waitMs: 0, maxQueue: 0, bulkAhead: 0 };
  return waitStore.run(waits, async () => ({ value: await fn(), waits }));
}

const bucket = new TokenBucket(RATE_PER_SEC, BURST);

/**
 * Interactive requests waiting for a token right now.
 *
 * Background work uses this to stay out of the way. Priority ordering decides
 * who is served next once a request is queued, but it cannot undo the node
 * slowing down while it serves a heavy query -- and a whole-life Transfer read
 * is heavy enough to take a concurrent scan from 1.5s to 20s. So the background
 * reader checks this between chunks and waits rather than pressing on.
 */
export function interactivePending(): number {
  return bucket.pendingInteractive();
}

/** Requests background work may issue right now without taking from scans. */
export function spareCapacity(): number {
  return bucket.spareTokens();
}

/**
 * Has anything interactive happened just now?
 *
 * Counting only QUEUED interactive requests reads zero for most of a scan --
 * seventeen reads spend their time in flight, not waiting for a token -- so
 * background work checking that guard saw an idle system and pressed on
 * regardless. Recent activity is the honest signal.
 */
export function interactivelyBusy(withinMs = 2_000): boolean {
  return bucket.pendingInteractive() > 0 || Date.now() - bucket.lastInteractiveAt < withinMs;
}
let installed = false;

export function installRateLimit(): void {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (!url.startsWith(RPC_URL)) return realFetch(input, init);

    // viem hands us its own abort signal; if it fires while we are sleeping off
    // a 429, the reason we stopped is still the limit, not a slow node.
    const signal: AbortSignal | undefined = init?.signal ?? (input as any)?.signal;
    let waited = 0;

    for (let attempt = 0; ; attempt++) {
      await bucket.acquire();
      const res = await realFetch(input, init);
      if (res.status !== 429) return res;

      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 1000 * 2 ** attempt);

      // Give up while the answer is still ours to give. Waiting past the budget
      // only lets the transport time out first and relabel a limit as a fault.
      if (attempt >= MAX_429_RETRIES || waited + waitMs > BUDGET_MS || signal?.aborted) {
        throw new RpcRateLimited(Math.max(1, Math.round(waitMs / 1000)));
      }
      bucket.penalise();
      const thisWait = waitMs + Math.random() * 250;
      waited += thisWait;
      await sleep(thisWait);
      if (signal?.aborted) throw new RpcRateLimited(Math.max(1, Math.round(waitMs / 1000)));
    }
  };
}
