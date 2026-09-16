import { getSetting, setSetting } from './ready.js';
import { decodePending, decodeBacklog } from './indexer/launches.js';
import { exemptionDistribution } from './taxstats.js';
import { agoWords } from './indexer/health.js';

/**
 * The operator's re-decode: the same work as `node dist/index.js decode`, run
 * inside the bot process and reportable while it runs.
 *
 * A background decode loop already ticks every fifteen seconds, which is the
 * right cadence for keeping up with new launches and the wrong one for
 * draining a backlog of eighteen thousand rows that were counted wrongly. This
 * runs the batches back to back instead, and says where it has got to.
 *
 * It adds no new way to read the chain. decodePending does every read through
 * bulk(), which the limiter serves only when nothing interactive is queued, so
 * a scan typed in Telegram still goes first whether this is running or not.
 *
 * Resumption is a property of the work, not of a counter. decodePending
 * selects the rows that still need a decode, so stopping and starting again
 * continues from where the rows are rather than from where a cursor said it
 * was. The cumulative count and the start time are stored so a restart
 * continues one run rather than opening a second.
 */

/** Rows per batch. The same batch the ambient loop uses. */
export const DECODE_BATCH = Number(process.env.DECODE_RUN_BATCH || 200) || 200;

/**
 * The pause between batches.
 *
 * Not the throttle: bulk() is the throttle, and it already yields to anything
 * interactive. This is a floor under how often the loop can come back around,
 * so a chain that answers instantly cannot turn this into a spin.
 */
export const DECODE_PAUSE_MS = Number(process.env.DECODE_RUN_PAUSE_MS || 1_000) || 1_000;

/** How often the row counter is written down inside a batch. */
const PROGRESS_EVERY = 10;

const KEY = {
  state: 'decode_run_state',
  startedAt: 'decode_run_started_at',
  processed: 'decode_run_processed',
  error: 'decode_run_error',
  finishedAt: 'decode_run_finished_at',
};

export type RunState = 'idle' | 'running' | 'done';

export interface DecodeRun {
  state: RunState;
  /** Unix seconds, or null when no run has been started. */
  startedAt: number | null;
  /** Rows attempted across every restart of this run. */
  processed: number;
  lastError: string | null;
  finishedAt: number | null;
}

/** True only while this process is actually turning the loop. */
let active = false;
let stopping = false;

export function decodeRun(): DecodeRun {
  const raw = getSetting(KEY.state);
  const state: RunState = raw === 'running' || raw === 'done' ? raw : 'idle';
  return {
    state,
    startedAt: Number(getSetting(KEY.startedAt) || 0) || null,
    processed: Number(getSetting(KEY.processed) || 0) || 0,
    lastError: getSetting(KEY.error) || null,
    finishedAt: Number(getSetting(KEY.finishedAt) || 0) || null,
  };
}

/** Whether this process is turning the loop right now. */
export function isDecoding(): boolean {
  return active;
}

export function resetDecodeRun(): void {
  active = false;
  stopping = false;
  for (const k of Object.values(KEY)) setSetting(k, '');
}

/**
 * Drop what this process knows and keep what is stored.
 *
 * Which is exactly what a restart does: the flags are memory and the run is a
 * row. Exported so the resume path can be tested without killing a process,
 * and used by nothing else.
 */
export function forgetProcessState(): void {
  active = false;
  stopping = false;
}

function write(run: Partial<DecodeRun> & { state?: RunState }): void {
  if (run.state !== undefined) setSetting(KEY.state, run.state);
  if (run.startedAt !== undefined) setSetting(KEY.startedAt, String(run.startedAt ?? ''));
  if (run.processed !== undefined) setSetting(KEY.processed, String(run.processed));
  if (run.lastError !== undefined) setSetting(KEY.error, run.lastError ?? '');
  if (run.finishedAt !== undefined) setSetting(KEY.finishedAt, String(run.finishedAt ?? ''));
}

export type StartResult =
  | { ok: true; resumed: boolean; pending: number }
  | { ok: false; reason: 'already-running' | 'nothing-pending' };

/**
 * Begin, or pick a stored run back up.
 *
 * `deps` exists so the loop can be driven in a test without a chain: the real
 * arguments are the real decoder and a real sleep, and nothing in the bot
 * passes anything else.
 */
export function startDecodeRun(deps: {
  batch?: (limit: number, onProgress?: (done: number, total: number) => void) =>
    Promise<{ decoded: number; failed: number; remaining: number }>;
  backlog?: () => { pending: number; exhausted: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): StartResult {
  if (active) return { ok: false, reason: 'already-running' };
  const backlog = deps.backlog ?? decodeBacklog;
  const pending = backlog().pending;
  if (!pending) return { ok: false, reason: 'nothing-pending' };

  const stored = decodeRun();
  // A run that was already marked running is this run: the process restarted
  // under it. Its clock and its count carry over rather than starting again.
  const resumed = stored.state === 'running' && stored.startedAt !== null;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  write({
    state: 'running',
    startedAt: resumed ? stored.startedAt : now(),
    processed: resumed ? stored.processed : 0,
    lastError: null,
    finishedAt: null,
  });

  active = true;
  stopping = false;
  void loop(deps).catch((err) => {
    active = false;
    write({ state: 'idle', lastError: String((err as Error)?.message ?? err).slice(0, 160) });
    console.error('[decode-run] stopped on an error:', err);
  });
  return { ok: true, resumed, pending };
}

/** Ask the loop to stop after the batch it is in. */
export function stopDecodeRun(): boolean {
  if (!active) {
    // Not turning here, but the stored run may still say running from before a
    // restart. Clearing it is what "stop" means to whoever typed it.
    if (decodeRun().state === 'running') {
      write({ state: 'idle' });
      return true;
    }
    return false;
  }
  stopping = true;
  return true;
}

type RunDeps = NonNullable<Parameters<typeof startDecodeRun>[0]>;

async function loop(deps: RunDeps): Promise<void> {
  const batch = deps.batch ?? decodePending;
  const backlog = deps.backlog ?? decodeBacklog;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  // A batch that moves rows while the queue stays the same size is a
  // contradiction, and an operator-started loop that spins on one would read
  // as progress in the status while doing nothing. Two in a row ends the run.
  let lastPending = Infinity;
  let stuckRounds = 0;

  try {
    while (!stopping) {
      if (!backlog().pending) {
        write({ state: 'done', finishedAt: now() });
        console.log('[decode-run] the backlog is empty.');
        break;
      }
      // Counted as rows land, not as batches finish. A batch of two hundred
      // takes minutes, and a counter that only moves at the boundary makes the
      // rate read low for all of it and the eta read long to match.
      const base = decodeRun().processed;
      let written = 0;
      const res = await batch(DECODE_BATCH, (done) => {
        if (done - written < PROGRESS_EVERY) return;
        written = done;
        write({ processed: base + done });
      });
      const moved = res.decoded + res.failed;
      write({ processed: base + moved });
      // A batch that moved nothing means every remaining row is out of
      // attempts. Turning the loop again would spin against the same rows.
      if (moved === 0) {
        write({ state: 'done', finishedAt: now() });
        console.log('[decode-run] nothing left that another attempt would change.');
        break;
      }
      const pendingNow = backlog().pending;
      stuckRounds = pendingNow >= lastPending ? stuckRounds + 1 : 0;
      lastPending = pendingNow;
      if (stuckRounds >= 2) {
        write({ state: 'idle', lastError: 'the queue stopped shrinking while rows were still moving' });
        console.warn('[decode-run] the backlog is not shrinking. stopped rather than spinning.');
        break;
      }
      if (stopping) break;
      await sleep(DECODE_PAUSE_MS);
    }
    if (stopping) write({ state: 'idle' });
  } finally {
    active = false;
    stopping = false;
  }
}

/**
 * Pick a run back up after a restart.
 *
 * Called once on boot. A run the operator started and never stopped keeps
 * going, and one they stopped stays stopped.
 */
export function resumeDecodeRun(): boolean {
  if (decodeRun().state !== 'running') return false;
  const r = startDecodeRun();
  if (r.ok) console.log(`[decode-run] resumed, ${r.pending.toLocaleString()} rows still to read`);
  return r.ok;
}

// --------------------------------------------------------------------- status

export function decodeStatusText(nowMs = Date.now()): string {
  const run = decodeRun();
  const backlog = decodeBacklog();
  const d = exemptionDistribution();
  const nowSec = Math.floor(nowMs / 1000);
  const elapsed = run.startedAt ? Math.max(1, nowSec - run.startedAt) : 0;
  const rate = run.processed > 0 && elapsed > 0 ? run.processed / elapsed : 0;

  const L: string[] = [];
  L.push(
    run.state === 'running'
      ? (active ? 'decode: running' : 'decode: marked running, not turning in this process. /decode start resumes it')
      : run.state === 'done' ? 'decode: finished' : 'decode: not running',
  );
  if (run.lastError) L.push(`  last error: ${run.lastError}`);
  L.push('');
  L.push(`rows read      ${d.read.toLocaleString()} from the curve's own events`);
  L.push(`rows remaining ${backlog.pending.toLocaleString()}`);
  if (backlog.exhausted) {
    L.push(`  ${backlog.exhausted.toLocaleString()} out of attempts, entry points this build has no ABI for`);
  }
  L.push('');
  if (d.read === 0) {
    L.push('split          nothing read yet, so there is nothing to split');
  } else {
    const pct = (a: number) => `${((a / d.read) * 100).toFixed(1)}%`;
    L.push(`exactly the deployer  ${d.deployerOnly.toLocaleString()} (${pct(d.deployerOnly)})`);
    L.push(`beyond the deployer   ${d.beyondDeployer.toLocaleString()} (${pct(d.beyondDeployer)})`);
  }
  L.push('');
  if (run.startedAt) {
    L.push(`this run       ${run.processed.toLocaleString()} rows in ${agoWords(elapsed)}`);
    // A rate needs something to have moved. Dividing by an elapsed second that
    // nothing happened in reports 0.0/s as though the decoder were stuck.
    L.push(rate > 0 ? `rate           ${rate.toFixed(1)} rows/s` : 'rate           undetermined, nothing has moved yet');
    if (run.state === 'running' && rate > 0 && backlog.pending > 0) {
      L.push(`eta            ${agoWords(Math.round(backlog.pending / rate))}`);
    } else if (run.state === 'running') {
      L.push('eta            undetermined');
    }
  }
  if (run.state === 'done' && run.finishedAt) {
    L.push(`finished       ${agoWords(Math.max(0, nowSec - run.finishedAt))} ago`);
  }
  L.push('');
  L.push('reads go through the same limiter as everything else, below anything interactive.');
  return L.join('\n');
}
