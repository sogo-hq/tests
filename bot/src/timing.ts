/**
 * Per-phase timing for a scan.
 *
 * A scan used to be one number. When holder concentration put a
 * whole-life Transfer read on the critical path and scans went from
 * 1.1s to 56s, that number said "56,000ms" and nothing else -- no way
 * to see which check ate it, and a tester reasonably read the delay as
 * the bot being broken rather than slow. Every phase is timed now and
 * the breakdown is logged beside the outcome.
 */
export class PhaseTimer {
  private readonly started = Date.now();
  private readonly phases: { name: string; ms: number }[] = [];

  /** Time an awaited phase. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.phases.push({ name, ms: Date.now() - t0 });
    }
  }

  /** Record a phase measured elsewhere. */
  record(name: string, ms: number): void {
    this.phases.push({ name, ms });
  }

  get elapsedMs(): number {
    return Date.now() - this.started;
  }

  /** The phase that took longest, for the "what ate the budget" line. */
  get worst(): { name: string; ms: number } | null {
    return this.phases.reduce<{ name: string; ms: number } | null>(
      (a, p) => (a === null || p.ms > a.ms ? p : a),
      null,
    );
  }

  /** `reads=656 trades=120 concentration=2000` — ordered as they ran. */
  breakdown(): string {
    return this.phases.map((p) => `${p.name}=${p.ms}`).join(' ');
  }
}

/**
 * A wall-clock budget for one scan.
 *
 * Optional work races against whatever is left rather than against a
 * fixed timeout, so a scan that has already spent four seconds does not
 * then wait a further two for a check it can render as undetermined.
 */
export class Budget {
  private readonly deadline: number;
  constructor(totalMs: number) {
    this.deadline = Date.now() + totalMs;
  }
  get remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }
  get blown(): boolean {
    return this.remainingMs === 0;
  }
  /** The smaller of this phase's own limit and what the budget has left. */
  allowanceFor(phaseMs: number): number {
    return Math.min(phaseMs, this.remainingMs);
  }
}

/** Resolve to `fallback` if `p` has not settled within `ms`. Never rejects on timeout. */
export function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}
