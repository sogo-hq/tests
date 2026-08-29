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

  private pump(): void {
    this.refill();
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      // Interactive requests are served first; bulk work fills the gaps.
      let idx = this.queue.findIndex((q) => q.priority === 'interactive');
      if (idx === -1) idx = 0;
      this.queue.splice(idx, 1)[0]!.resolve();
    }
    if (this.queue.length && !this.timer) {
      const waitMs = Math.max(10, ((1 - this.tokens) / this.rate) * 1000);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, waitMs);
    }
  }

  acquire(): Promise<void> {
    const priority = priorityStore.getStore() ?? 'interactive';
    return new Promise((resolve) => {
      this.queue.push({ resolve, priority });
      this.pump();
    });
  }
}

const bucket = new TokenBucket(RATE_PER_SEC, BURST);
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
