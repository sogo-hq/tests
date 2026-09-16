/**
 * The operator's re-decode, driven on a fixture.
 *
 * The batch function and the sleep are injected, so the loop runs to
 * completion in milliseconds with no chain and no clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('decoderun');
const R = await import('../dist/decoderun.js');
const { db } = await import('../dist/db.js');

const settle = () => new Promise((r) => setImmediate(r));
/** Let the loop turn until it parks. */
const drain = async (turns = 60) => { for (let i = 0; i < turns; i++) await settle(); };

/**
 * A fake backlog that shrinks as batches are taken.
 *
 * The sleep between batches is a gate the test opens, so the loop parks after
 * every batch and mid-run state can be asserted. A sleep that resolves on its
 * own drains the whole backlog before the test can call stop.
 */
function fakeChain(rows, { perBatch = R.DECODE_BATCH, failEvery = 0 } = {}) {
  const state = { left: rows, batches: 0, slept: 0 };
  let open = null;
  const chain = {
    state,
    backlog: () => ({ pending: state.left, exhausted: 0 }),
    batch: async (limit) => {
      state.batches++;
      if (failEvery && state.batches % failEvery === 0) throw new Error('rpc gave up');
      const take = Math.min(state.left, Math.min(limit, perBatch));
      state.left -= take;
      return { decoded: take, failed: 0, remaining: state.left };
    },
    sleep: () => new Promise((r) => { state.slept++; open = r; }),
    now: () => 1_000_000,
    /** Let the loop past one pause. */
    async step() {
      await settle();
      if (open) { const r = open; open = null; r(); }
      await settle();
    },
    /** Let it run until it parks for good. */
    async finish(max = 200) {
      for (let i = 0; i < max && R.isDecoding(); i++) await chain.step();
      await settle();
    },
  };
  return chain;
}

const reset = () => { R.resetDecodeRun(); };

// --------------------------------------------------------------- start, stop

test('a fresh run starts, reports what is pending, and is not a resume', () => {
  reset();
  const c = fakeChain(500);
  const r = R.startDecodeRun(c);
  assert.deepEqual(r, { ok: true, resumed: false, pending: 500 });
  assert.equal(R.decodeRun().state, 'running');
  R.stopDecodeRun();
});

test('starting twice in one process is refused', () => {
  reset();
  const c = fakeChain(500);
  R.startDecodeRun(c);
  assert.deepEqual(R.startDecodeRun(c), { ok: false, reason: 'already-running' });
  R.stopDecodeRun();
});

test('an empty backlog is refused rather than started', () => {
  reset();
  const r = R.startDecodeRun(fakeChain(0));
  assert.deepEqual(r, { ok: false, reason: 'nothing-pending' });
  assert.equal(R.decodeRun().state, 'idle');
});

test('it drains the backlog and marks itself done', async () => {
  reset();
  const c = fakeChain(450);
  R.startDecodeRun(c);
  await c.finish();
  assert.equal(c.state.left, 0);
  assert.equal(R.decodeRun().state, 'done');
  assert.equal(R.decodeRun().processed, 450);
  assert.equal(R.isDecoding(), false);
});

test('it pauses between batches rather than spinning', async () => {
  reset();
  const c = fakeChain(600);
  R.startDecodeRun(c);
  await c.finish();
  assert.ok(c.state.batches >= 3, `${c.state.batches} batches for 600 rows at ${R.DECODE_BATCH}`);
  assert.ok(c.state.slept >= c.state.batches - 1, 'a batch went straight into the next');
  assert.ok(R.DECODE_PAUSE_MS > 0);
});

test('stop halts the loop and leaves the rows already read read', async () => {
  reset();
  const c = fakeChain(10_000);
  R.startDecodeRun(c);
  await settle();
  await settle();
  assert.equal(R.isDecoding(), true, 'the loop is parked between batches');
  assert.equal(R.stopDecodeRun(), true);
  await c.finish();
  assert.equal(R.isDecoding(), false);
  assert.equal(R.decodeRun().state, 'idle');
  const done = R.decodeRun().processed;
  assert.ok(done > 0 && done < 10_000, `stopped after ${done}`);
  assert.ok(c.state.left > 0, 'the rest is still pending, not lost');
});

test('stop on a run that is not turning says so', () => {
  reset();
  assert.equal(R.stopDecodeRun(), false);
});

// ------------------------------------------------------------- resumption

test('a start after a stop continues the count, not a second run', async () => {
  reset();
  const c = fakeChain(1_000);
  R.startDecodeRun(c);
  await settle(); await settle();
  R.stopDecodeRun();
  await c.finish();
  const first = R.decodeRun().processed;
  assert.ok(first > 0);

  // Stopped, so this is a new run and the count starts again. What must NOT
  // happen is the rows being read twice: the backlog is what it was left at.
  const before = c.state.left;
  R.startDecodeRun(c);
  await c.finish();
  assert.equal(c.state.left, 0);
  assert.ok(c.state.batches * R.DECODE_BATCH >= 1_000);
  assert.ok(before < 1_000, 'the second run started from where the first stopped');
});

test('a restart mid-run resumes it, keeping the clock and the count', async () => {
  reset();
  const c = fakeChain(2_000);
  R.startDecodeRun(c);
  await settle(); await settle();
  const mid = R.decodeRun();
  assert.equal(mid.state, 'running');
  assert.ok(mid.processed > 0);

  // The process dies here: the in-memory flags go, the stored run does not.
  R.forgetProcessState();
  const resumed = R.startDecodeRun(c);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true, 'a run marked running is resumed, not restarted');
  assert.equal(R.decodeRun().startedAt, mid.startedAt, 'the clock carried over');
  assert.ok(R.decodeRun().processed >= mid.processed, 'the count carried over');
  R.stopDecodeRun();
  await c.finish();
});

test('resumeDecodeRun picks up a run left running, and only that', async () => {
  reset();
  assert.equal(R.resumeDecodeRun(), false, 'nothing to resume');
  const c2 = fakeChain(900);
  R.startDecodeRun(c2);
  R.stopDecodeRun();
  await c2.finish();
  assert.equal(R.decodeRun().state, 'idle');
  assert.equal(R.resumeDecodeRun(), false, 'a run that was stopped stays stopped');
});

test('a batch that moves nothing ends the run instead of spinning on it', async () => {
  reset();
  // Pending never reaches zero, but no row can be moved: every remaining row
  // is out of attempts. Turning again would ask the same rows forever.
  const stuck = {
    backlog: () => ({ pending: 40, exhausted: 40 }),
    batch: async () => ({ decoded: 0, failed: 0, remaining: 40 }),
    sleep: async () => {},
    now: () => 1_000_000,
  };
  R.startDecodeRun(stuck);
  await drain();
  assert.equal(R.decodeRun().state, 'done');
  assert.equal(R.isDecoding(), false);
});

test('an error stops the loop and is kept, not swallowed', async () => {
  reset();
  const c = fakeChain(1_000, { failEvery: 1 });
  R.startDecodeRun(c);
  await drain();
  assert.equal(R.isDecoding(), false);
  assert.equal(R.decodeRun().state, 'idle');
  assert.match(R.decodeRun().lastError, /rpc gave up/);
});

// ----------------------------------------------------------------- status

test('status names the state, the counts and the split', async () => {
  reset();
  db.prepare('DELETE FROM launches').run();
  const add = (t, count, source) => db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id, graduation_threshold,
       block_number, tx_hash, launched_at, snipe_exemption_count, exemption_source)
     VALUES (?,?,?,?,0,'0',1,?,1,?,?)`,
  ).run(t, t, t, '0x0', t, count, source);
  add('0x1', 1, 'logs');
  add('0x2', 1, 'logs');
  add('0x3', 3, 'logs');
  add('0x4', null, null);

  const text = R.decodeStatusText(1_000_000_000);
  assert.match(text, /decode: not running/);
  assert.match(text, /rows read\s+3 from the curve's own events/);
  assert.match(text, /exactly the deployer\s+2 \(66\.7%\)/);
  assert.match(text, /beyond the deployer\s+1 \(33\.3%\)/);
  assert.match(text, /rows remaining\s+\d/);
  assert.match(text, /below anything interactive/);
});

test('status reports a rate and an eta while it runs, and never a false zero', async () => {
  reset();
  const c = fakeChain(5_000);
  R.startDecodeRun(c);
  await settle(); await settle();
  assert.equal(R.isDecoding(), true);
  // startedAt is the fake clock's 1,000,000; ten seconds later.
  const text = R.decodeStatusText(1_000_010_000);
  assert.match(text, /decode: running/);
  assert.match(text, /this run\s+\d+ rows in/);
  assert.match(text, /rate\s+\d+\.\d rows\/s/);
  assert.match(text, /eta\s+/);
  R.stopDecodeRun();
  await c.finish();
});

test('a run that has moved nothing says the rate is undetermined, not zero', () => {
  reset();
  const c = fakeChain(100);
  R.startDecodeRun(c);
  const text = R.decodeStatusText(1_000_001_000);
  assert.match(text, /rate\s+undetermined, nothing has moved yet/);
  assert.doesNotMatch(text, /rate\s+0\.0 rows\/s/);
  R.stopDecodeRun();
});

test('status after a restart says the run is not turning here', async () => {
  reset();
  const c = fakeChain(3_000);
  R.startDecodeRun(c);
  await settle();
  R.forgetProcessState();
  const text = R.decodeStatusText(1_000_010_000);
  assert.match(text, /marked running, not turning in this process/);
  assert.match(text, /\/decode start resumes it/);
});

test('nothing in the status is a verdict, an exclamation or an em dash', () => {
  reset();
  const text = R.decodeStatusText(1_000_000_000);
  assert.doesNotMatch(text, /\bclean\b|\bsafe\b|!/i);
  assert.ok(!text.includes(String.fromCharCode(0x2014)));
});

test('/decode is in the command table, admin and DM only', async () => {
  const { COMMANDS } = await import('../dist/commands.js');
  const c = COMMANDS.find((x) => x.name === 'decode');
  assert.ok(c, '/decode is not in /help');
  assert.equal(c.scope, 'admin');
  assert.equal(c.where, 'dm');
  assert.match(c.usage, /start\|status\|stop/);
});

test('the count moves inside a batch, so the rate is not understated', async () => {
  reset();
  // Observed from inside the batch: a counter that only moved at the boundary
  // would still read zero here, and the rate and the eta with it.
  let seenMidBatch = null;
  const slow = {
    backlog: () => ({ pending: 1_000, exhausted: 0 }),
    batch: async (limit, onProgress) => {
      for (let i = 1; i <= 50; i++) onProgress?.(i, limit);
      seenMidBatch = R.decodeRun().processed;
      return { decoded: 50, failed: 0, remaining: 950 };
    },
    sleep: async () => { R.stopDecodeRun(); },
    now: () => 1_000_000,
  };
  R.startDecodeRun(slow);
  await drain();
  assert.equal(seenMidBatch, 50, 'the rows were not counted until the batch ended');
});

test('a batch is never counted twice, however often it reported', async () => {
  reset();
  let left = 200;
  const chatty = {
    backlog: () => ({ pending: left, exhausted: 0 }),
    batch: async (limit, onProgress) => {
      for (let i = 1; i <= 200; i++) onProgress?.(i, limit);
      left = 0;
      return { decoded: 180, failed: 20, remaining: 0 };
    },
    sleep: async () => {},
    now: () => 1_000_000,
  };
  R.startDecodeRun(chatty);
  await drain();
  // 180 decoded plus 20 undetermined is 200 rows attempted, once.
  assert.equal(R.decodeRun().processed, 200);
  assert.equal(R.decodeRun().state, 'done');
});

test('a queue that stops shrinking ends the run instead of spinning on it', async () => {
  reset();
  // Rows move every batch and the backlog never gets smaller, which cannot
  // both be true. Without a guard this is an operator-started infinite loop
  // reporting progress the whole time.
  let batches = 0;
  const contradiction = {
    backlog: () => ({ pending: 500, exhausted: 0 }),
    batch: async () => { batches++; return { decoded: 100, failed: 0, remaining: 500 }; },
    sleep: async () => {},
    now: () => 1_000_000,
  };
  R.startDecodeRun(contradiction);
  await drain();
  assert.equal(R.isDecoding(), false, 'the loop is still turning');
  assert.ok(batches < 10, `${batches} batches before it gave up`);
  assert.match(R.decodeRun().lastError, /stopped shrinking/);
  assert.equal(R.decodeRun().state, 'idle');
});
