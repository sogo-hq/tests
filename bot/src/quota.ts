/**
 * Per-user quota and global scan concurrency.
 *
 * Distinct from src/ratelimit.ts, which paces this process's own requests to
 * the RPC node. This module limits what *users* can ask the bot to do, and the
 * same instance backs DM, group and inline so there is no surface that can be
 * used to bypass the others.
 *
 * Only real scans are counted. A cache hit does no RPC and is served without
 * consuming quota -- which is both literally what "10 scans per minute" means
 * and a hard requirement for inline mode, where Telegram re-issues a query on
 * every keystroke and a single pasted address can produce a dozen events. It is
 * still sound as abuse protection: hammering distinct tokens produces cache
 * misses, and those are exactly what the counter sees.
 */

const PER_MINUTE = Number(process.env.SCANS_PER_MINUTE || 10);
const PER_HOUR = Number(process.env.SCANS_PER_HOUR || 100);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_SCANS || 5);

export interface QuotaDecision {
  allowed: boolean;
  /** Seconds until the user may retry. Only meaningful when denied. */
  retryAfterSec: number;
  /** Which window was exhausted, for the message and for logging. */
  window: 'minute' | 'hour' | null;
}

export class UserQuota {
  private minute = new Map<number, number[]>();
  private hour = new Map<number, number[]>();

  constructor(
    private perMinute = PER_MINUTE,
    private perHour = PER_HOUR,
  ) {}

  private static prune(list: number[] | undefined, cutoff: number): number[] {
    if (!list) return [];
    // Timestamps are appended in order, so the survivors are a suffix.
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i++;
    return i === 0 ? list : list.slice(i);
  }

  /** Would this user be allowed to scan right now? Does not consume. */
  check(userId: number, now = Date.now()): QuotaDecision {
    const m = UserQuota.prune(this.minute.get(userId), now - 60_000);
    const h = UserQuota.prune(this.hour.get(userId), now - 3_600_000);
    this.minute.set(userId, m);
    this.hour.set(userId, h);

    if (m.length >= this.perMinute) {
      const retry = Math.max(1, Math.ceil((m[0]! + 60_000 - now) / 1000));
      return { allowed: false, retryAfterSec: retry, window: 'minute' };
    }
    if (h.length >= this.perHour) {
      const retry = Math.max(1, Math.ceil((h[0]! + 3_600_000 - now) / 1000));
      return { allowed: false, retryAfterSec: retry, window: 'hour' };
    }
    return { allowed: true, retryAfterSec: 0, window: null };
  }

  /** Check and, if allowed, consume one scan from both windows. */
  consume(userId: number, now = Date.now()): QuotaDecision {
    const decision = this.check(userId, now);
    if (!decision.allowed) return decision;
    this.minute.get(userId)!.push(now);
    this.hour.get(userId)!.push(now);
    return decision;
  }

  /** Drop users with no activity in the last hour. */
  sweep(now = Date.now()): number {
    let dropped = 0;
    for (const [id, list] of this.hour) {
      const kept = UserQuota.prune(list, now - 3_600_000);
      if (kept.length === 0) {
        this.hour.delete(id);
        this.minute.delete(id);
        dropped++;
      } else {
        this.hour.set(id, kept);
      }
    }
    return dropped;
  }

  stats() {
    return { trackedUsers: this.hour.size, perMinute: this.perMinute, perHour: this.perHour };
  }
}

/** Raised when a scan slot could not be acquired inside its deadline. */
export class SlotTimeout extends Error {
  constructor() {
    super('timed out waiting for a scan slot');
    this.name = 'SlotTimeout';
  }
}

/**
 * Global concurrency limit. Excess scans queue rather than being rejected --
 * except where the caller supplies a deadline, which inline mode does because
 * Telegram drops an inline answer that arrives late anyway.
 */
export class Semaphore {
  private active = 0;
  private queue: { resolve: (release: () => void) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }[] = [];
  private peakQueue = 0;
  private timeouts = 0;

  constructor(private limit = MAX_CONCURRENT) {}

  private release = (): void => {
    this.active--;
    this.pump();
  };

  private pump(): void {
    while (this.active < this.limit && this.queue.length) {
      const next = this.queue.shift()!;
      if (next.timer) clearTimeout(next.timer);
      this.active++;
      next.resolve(this.release);
    }
  }

  /** Resolves with a release function. Rejects with SlotTimeout past the deadline. */
  acquire(timeoutMs?: number): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.release);
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: null as NodeJS.Timeout | null,
      };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i !== -1) this.queue.splice(i, 1);
          this.timeouts++;
          reject(new SlotTimeout());
        }, timeoutMs);
        // Deliberately NOT unref'd: this promise cannot settle any other way,
        // so letting the loop exit past it would leave the caller hanging
        // forever rather than getting its timeout.

      }
      this.queue.push(entry);
      this.peakQueue = Math.max(this.peakQueue, this.queue.length);
    });
  }

  stats() {
    return {
      limit: this.limit,
      active: this.active,
      queued: this.queue.length,
      peakQueue: this.peakQueue,
      timeouts: this.timeouts,
    };
  }
}

export const userQuota = new UserQuota();
export const scanSemaphore = new Semaphore();

export function startQuotaSweeper(intervalMs = 600_000): NodeJS.Timeout {
  const t = setInterval(() => userQuota.sweep(), intervalMs);
  t.unref?.();
  return t;
}

/**
 * Human-readable wait, e.g. "12s", "60s" or "4m 10s".
 *
 * Stays in seconds up to 90s so the common case -- the per-minute window, which
 * can never exceed 60s -- always reads as "try again in Ns". Only the hourly
 * window, where "3400s" would be useless, switches to minutes.
 */
export function formatRetry(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
