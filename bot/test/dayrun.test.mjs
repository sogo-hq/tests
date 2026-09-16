import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../dist/dayrun.js';

const TOKEN = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const ROOM = -1001234567890;
const NOW = 1_800_000_000;

const fresh = (fast = false) => D.freshState(TOKEN, ROOM, fast, NOW);

test('a fresh run has every step still to do, in order', () => {
  const s = fresh();
  assert.deepEqual(D.remaining(s), ['detect', 'pin', 'selfscan', 'preview', 'csv', 'pay', 'tx', 'post']);
  assert.deepEqual(D.STEPS, D.remaining(s));
});

test('a step that is done is skipped and never comes back', () => {
  const s = fresh();
  D.markDone(s, 'pin', { messageId: 42 }, NOW);
  assert.equal(D.isDone(s, 'pin'), true);
  assert.deepEqual(D.remaining(s), ['detect', 'selfscan', 'preview', 'csv', 'pay', 'tx', 'post']);
  assert.equal(s.steps.pin.detail.messageId, 42);
});

test('a rerun loads the state and reports itself resumed', () => {
  const s = fresh();
  D.markDone(s, 'detect', {}, NOW);
  D.markDone(s, 'pin', { messageId: 42 }, NOW);
  const back = D.loadState(JSON.stringify(s), TOKEN, ROOM, false, NOW + 60);
  assert.ok(!back.error);
  assert.equal(back.resumed, true);
  assert.equal(D.isDone(back.state, 'pin'), true);
  assert.deepEqual(D.remaining(back.state), ['selfscan', 'preview', 'csv', 'pay', 'tx', 'post']);
});

test('no state file is a first run, not an error', () => {
  const back = D.loadState(null, TOKEN, ROOM, false, NOW);
  assert.ok(!back.error);
  assert.equal(back.resumed, false);
  assert.deepEqual(D.remaining(back.state), D.STEPS);
});

test('a state file for another token is refused, not continued', () => {
  const s = fresh();
  const other = D.loadState(JSON.stringify(s), '0x1111111111111111111111111111111111111111', ROOM, false, NOW);
  assert.match(other.error, /is for 0xabcdef/);
});

test('a state file for another room is refused: it would post to strangers', () => {
  const s = fresh();
  const other = D.loadState(JSON.stringify(s), TOKEN, -999, false, NOW);
  assert.match(other.error, /not -999/);
  assert.match(other.error, /strangers/);
});

test('an unreadable or future state file is refused rather than guessed at', () => {
  assert.match(D.loadState('{not json', TOKEN, ROOM, false, NOW).error, /not readable json/);
  assert.match(D.loadState(JSON.stringify({ ...fresh(), version: 2 }), TOKEN, ROOM, false, NOW).error, /version 2/);
});

test('the fast flag may change between runs without repeating a step', () => {
  const s = fresh(false);
  D.markDone(s, 'pin', {}, NOW);
  const back = D.loadState(JSON.stringify(s), TOKEN, ROOM, true, NOW);
  assert.equal(back.state.fast, true);
  assert.equal(D.isDone(back.state, 'pin'), true);
});

// ------------------------------------------------------------- the timeline

test('real time is measured from the launch, not from the run', () => {
  const s = fresh();
  s.t0 = NOW - 3600;     // launched an hour ago
  assert.equal(D.dueAt(s, 'selfscan'), NOW - 3600 + 15 * 60);
  assert.equal(D.dueAt(s, 'preview'), NOW - 3600 + 4 * 3600);
  // The self scan is already past, the ledger is three hours out.
  assert.equal(D.waitFor(s, 'selfscan', NOW), 0);
  assert.equal(D.waitFor(s, 'preview', NOW), 3 * 3600);
});

test("a token launched yesterday replays the timeline with no waiting", () => {
  const s = fresh();
  s.t0 = NOW - 86_400;
  for (const step of D.STEPS) assert.equal(D.waitFor(s, step, NOW), 0, step);
});

test('fast compresses every wait to seconds, from the start of this run', () => {
  const s = fresh(true);
  s.t0 = NOW - 86_400;
  assert.equal(D.waitFor(s, 'selfscan', NOW), D.FAST_SELF_SCAN_SECONDS);
  assert.equal(D.waitFor(s, 'preview', NOW), D.FAST_LEDGER_SECONDS);
  assert.ok(D.FAST_LEDGER_SECONDS < 60, 'the whole fast run has to fit in one sitting');
  // And the steps that carry no wait of their own are due immediately.
  for (const step of ['detect', 'pin', 'csv', 'pay', 'tx', 'post']) {
    assert.equal(D.waitFor(s, step, NOW), 0, step);
  }
});

test('the real deadlines are the ones the runbook states', () => {
  assert.equal(D.SELF_SCAN_AFTER_SECONDS, 15 * 60);
  assert.equal(D.LEDGER_AFTER_SECONDS, 4 * 60 * 60);
});

test('a missing launch time falls back to the run start rather than to 1970', () => {
  const s = fresh();
  assert.equal(s.t0, null);
  assert.equal(D.dueAt(s, 'selfscan'), NOW + D.SELF_SCAN_AFTER_SECONDS);
});

// ---------------------------------------------------------------- the report

test('progress names every step, done or not, with no em dash', () => {
  const s = fresh();
  D.markDone(s, 'detect', { symbol: 'VITALSRH1' }, NOW);
  const lines = D.progressLines(s);
  assert.equal(lines.length, D.STEPS.length);
  assert.match(lines[0], /detect\s+done .* symbol=VITALSRH1/);
  assert.match(lines[1], /pin\s+not yet/);
  for (const l of lines) assert.ok(!l.includes(String.fromCharCode(0x2014)));
});

// ------------------------------------------------ rehearsal hashes to seats

test('burner hashes attach to seats in order and stop when they run out', () => {
  const seats = [{ seat: 1 }, { seat: 2 }, { seat: 3 }, { seat: 4 }, { seat: 5 }];
  const hashes = ['0xaa', '0xbb', '0xcc'];
  assert.deepEqual(D.rehearsalTxRecords(seats, hashes), [
    { seat: 1, txHash: '0xaa' },
    { seat: 2, txHash: '0xbb' },
    { seat: 3, txHash: '0xcc' },
  ]);
});

test('no hashes records nothing rather than recording empty strings', () => {
  assert.deepEqual(D.rehearsalTxRecords([{ seat: 1 }], []), []);
});

test('more hashes than seats records one per seat and no more', () => {
  const out = D.rehearsalTxRecords([{ seat: 7 }], ['0xaa', '0xbb']);
  assert.deepEqual(out, [{ seat: 7, txHash: '0xaa' }]);
});
