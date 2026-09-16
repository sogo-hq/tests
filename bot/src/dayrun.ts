/**
 * The launch-day timeline, run against a token that already exists.
 *
 * Launch day is a sequence with deadlines and no rehearsal built into it: the
 * CA is pinned once, the self scan goes out once, the payout run happens once.
 * Everything in it has been tested in pieces. This runs the pieces in order
 * against Thursday's rehearsal token so the ORDER is tested too, which is the
 * part that has never run.
 *
 * The rules that make it safe to run twice live here rather than in the script:
 * every step records that it finished, a finished step is skipped, and a step
 * that sends something records what it sent before anything else can decide to
 * send it again. A crash between two steps costs the steps that had not run.
 */

export type StepName = 'detect' | 'pin' | 'selfscan' | 'preview' | 'csv' | 'pay' | 'tx' | 'post';

/** The order they run in, which is also the order they are printed in. */
export const STEPS: StepName[] = ['detect', 'pin', 'selfscan', 'preview', 'csv', 'pay', 'tx', 'post'];

export interface StepState {
  done: boolean;
  at: number;
  /** Whatever the step needs to hand to a later one, or to prove it happened. */
  detail?: Record<string, unknown>;
}

export interface DayrunState {
  version: 1;
  token: string;
  room: number;
  fast: boolean;
  startedAt: number;
  /** The launch time the timeline is measured from, unix seconds. */
  t0: number | null;
  steps: Partial<Record<StepName, StepState>>;
}

/** Where the self scan and the ledger land on a real launch day. */
export const SELF_SCAN_AFTER_SECONDS = 15 * 60;
export const LEDGER_AFTER_SECONDS = 4 * 60 * 60;

/** What --fast compresses them to. Seconds, so a private group test is minutes. */
export const FAST_SELF_SCAN_SECONDS = 5;
export const FAST_LEDGER_SECONDS = 15;

export function freshState(token: string, room: number, fast: boolean, now: number): DayrunState {
  return {
    version: 1,
    token: token.toLowerCase(),
    room,
    fast,
    startedAt: now,
    t0: null,
    steps: {},
  };
}

/**
 * A state file from an earlier run, or a fresh one.
 *
 * A file for a different token or a different room is not this run's file and
 * is refused rather than continued: resuming into the wrong room would post a
 * launch card to strangers.
 */
export function loadState(
  raw: string | null,
  token: string,
  room: number,
  fast: boolean,
  now: number,
): { state: DayrunState; resumed: boolean } | { error: string } {
  if (!raw) return { state: freshState(token, room, fast, now), resumed: false };
  let parsed: DayrunState;
  try {
    parsed = JSON.parse(raw) as DayrunState;
  } catch (err) {
    return { error: `the state file is not readable json: ${String((err as Error)?.message ?? err).slice(0, 80)}` };
  }
  if (parsed.version !== 1) return { error: `the state file is version ${parsed.version}, this tool writes version 1` };
  if (parsed.token !== token.toLowerCase()) {
    return { error: `the state file is for ${parsed.token}, not ${token.toLowerCase()}` };
  }
  if (parsed.room !== room) {
    return { error: `the state file is for room ${parsed.room}, not ${room}. resuming into the wrong room would post to strangers` };
  }
  // --fast is allowed to change between runs: it only moves the waits, and a
  // step that already ran is skipped whichever way the flag is set.
  return { state: { ...parsed, fast }, resumed: Object.values(parsed.steps).some((s) => s?.done) };
}

export function isDone(state: DayrunState, step: StepName): boolean {
  return state.steps[step]?.done === true;
}

export function markDone(
  state: DayrunState, step: StepName, detail: Record<string, unknown> = {}, now = Math.floor(Date.now() / 1000),
): DayrunState {
  state.steps[step] = { done: true, at: now, detail };
  return state;
}

/** What is left to do, in order. */
export function remaining(state: DayrunState): StepName[] {
  return STEPS.filter((s) => !isDone(state, s));
}

/**
 * When a step is due, in unix seconds.
 *
 * Real time runs from the launch: a token launched on Thursday is already past
 * both deadlines on Friday, so both steps run at once and the timeline is
 * replayed rather than waited out. --fast runs from the start of THIS run,
 * because the point of it is to see the order in one sitting.
 */
export function dueAt(state: DayrunState, step: StepName): number {
  if (state.fast) {
    if (step === 'selfscan') return state.startedAt + FAST_SELF_SCAN_SECONDS;
    if (step === 'preview') return state.startedAt + FAST_LEDGER_SECONDS;
    return state.startedAt;
  }
  const t0 = state.t0 ?? state.startedAt;
  if (step === 'selfscan') return t0 + SELF_SCAN_AFTER_SECONDS;
  if (step === 'preview') return t0 + LEDGER_AFTER_SECONDS;
  return t0;
}

/** Seconds still to wait for a step, never negative. */
export function waitFor(state: DayrunState, step: StepName, now: number): number {
  return Math.max(0, dueAt(state, step) - now);
}

/** One line per step for the run's own summary. */
export function progressLines(state: DayrunState): string[] {
  return STEPS.map((s) => {
    const st = state.steps[s];
    if (!st?.done) return `  ${s.padEnd(9)} not yet`;
    const when = new Date(st.at * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const detail = st.detail && Object.keys(st.detail).length
      ? `  ${Object.entries(st.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`
      : '';
    return `  ${s.padEnd(9)} done ${when}${detail}`;
  });
}

/**
 * The hashes a burner run produced, against the seats of a ledger run.
 *
 * The burner pays three throwaway addresses, not the roster, so the hashes
 * cannot be matched to seats by wallet the way a real run's are. They are
 * attached in order, and only to a run marked hypothetical: a rehearsal hash
 * against a real payout row would read afterwards as money that moved.
 */
export function rehearsalTxRecords(
  seats: { seat: number }[],
  hashes: string[],
): { seat: number; txHash: string }[] {
  return seats.slice(0, hashes.length).map((s, i) => ({ seat: s.seat, txHash: hashes[i]! }));
}
