import { NON_HOLDER_ADDRESSES } from '../config.js';

/**
 * What the deployer did with its own supply after launching.
 *
 * Facts only. This says how much it holds, when it stopped holding, and how
 * many addresses it sent to -- never whether any of that is good or bad. "Dev
 * dumped" is a judgement; "sold 100% within 8 minutes" is a reading, and the
 * reader draws their own conclusion from it.
 *
 * Undetermined when the transfers cannot be read, like everything else here.
 */

const ZERO = '0x0000000000000000000000000000000000000000';

export interface DeployerActivity {
  /** Share of circulating supply the deployer still holds, 0-100. */
  heldPct: number;
  /** True when nothing left the deployer after the launch. */
  unchanged: boolean;
  /** Seconds from launch to the deployer's first outgoing transfer, if any. */
  firstMoveSeconds: number | null;
  /** Distinct addresses the deployer sent to, excluding the protocol's own. */
  sentTo: number;
  /** Share it started with, 0-100, for "sold 100%". */
  startedPct: number;
}


/**
 * Aggregate a deployer's movements from Transfer logs already in hand.
 *
 * Takes the logs rather than fetching them: the background holder refresh
 * walks exactly these to compute the distribution, so producing this at the
 * same time costs nothing. Fetching them again put two seconds on every scan
 * for a line that only appears in /full.
 */
export function deployerActivityFrom(
  logs: readonly any[],
  token: string,
  deployer: string,
  curve: string,
  launchBlock: bigint,
  blockTimeSeconds: number,
): DeployerActivity | null {
  const dep = deployer.toLowerCase();
  const excluded = new Set([...NON_HOLDER_ADDRESSES, curve.toLowerCase(), token.toLowerCase()]);
  if (!logs.length) return null;

  const bal = new Map<string, bigint>();
  let received = 0n;
  let firstOutBlock: number | null = null;
  const recipients = new Set<string>();

  for (const l of logs) {
    const from = String(l.args.from).toLowerCase();
    const to = String(l.args.to).toLowerCase();
    const v = l.args.value as bigint;
    if (from !== ZERO) bal.set(from, (bal.get(from) ?? 0n) - v);
    if (to !== ZERO) bal.set(to, (bal.get(to) ?? 0n) + v);
    if (to === dep) received += v;
    if (from === dep) {
      if (firstOutBlock === null) firstOutBlock = Number(l.blockNumber);
      if (!excluded.has(to)) recipients.add(to);
    }
  }

  const circulating = [...bal.entries()]
    .filter(([addr, v]) => v > 0n && !excluded.has(addr))
    .reduce((a, [, v]) => a + v, 0n);
  if (circulating <= 0n) return null;

  const held = bal.get(dep) ?? 0n;
  const pct = (v: bigint) => (v <= 0n ? 0 : Number((v * 10_000n) / circulating) / 100);

  return {
    heldPct: pct(held),
    unchanged: firstOutBlock === null,
    firstMoveSeconds:
      firstOutBlock === null
        ? null
        : Math.max(0, Math.round((firstOutBlock - Number(launchBlock)) * blockTimeSeconds)),
    sentTo: recipients.size,
    startedPct: pct(received),
  };
}

/** The /full line. Null when it could not be read. */
export function deployerActivityLine(a: DeployerActivity | null, everRead = true): string {
  /**
   * "Could not be read" claims an attempt that may never have happened.
   *
   * The deployer's movements come out of the whole-life Transfer walk, and that
   * walk is background work: a token nobody has walked yet has no activity
   * stored, which is not the same as a walk that ran and found nothing. Saying
   * "could not be read" for the first case reports a failure that did not
   * occur, and it reads as final when the answer is simply pending.
   *
   * `everRead` is whether the walk has completed for this token at all.
   */
  if (!a) {
    return everRead
      ? 'deployer: transfers could not be read — undetermined'
      : 'deployer: not read yet — the holder walk has not run for this token';
  }
  if (a.unchanged) {
    return `deployer: holds ${a.heldPct.toFixed(1)}% of supply, unchanged since launch`;
  }
  const when = a.firstMoveSeconds === null ? '' : ` within ${humanShort(a.firstMoveSeconds)}`;
  if (a.heldPct <= 0) {
    return `deployer: sold or sent all of its supply${when}`;
  }
  const moved = Math.max(0, a.startedPct - a.heldPct);
  return (
    `deployer: holds ${a.heldPct.toFixed(1)}% of supply, moved ${moved.toFixed(1)}%` +
    `${a.sentTo ? ` to ${a.sentTo} address${a.sentTo === 1 ? '' : 'es'}` : ''}${when}`
  );
}

function humanShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.round(h / 24)} days`;
}
