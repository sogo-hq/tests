import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('watchdog');
process.env.ADMIN_IDS = '9001,9002';
const W = await import('../dist/watchdog.js');
const { db } = await import('../dist/db.js');
const { resetIndexHealth, recordIndexFailure, recordIndexAdvance } = await import('../dist/indexer/health.js');

const NOW = 1_800_000_000_000;

/** An Api that records instead of sending. */
const fakeApi = () => {
  const sent = [];
  return {
    sent,
    sendMessage: async (chat_id, text) => { sent.push({ chat_id, text }); return { message_id: 1 }; },
  };
};

const setCursor = (name, value) =>
  db.prepare('INSERT INTO cursors (name, block_number, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET block_number = excluded.block_number, updated_at = excluded.updated_at')
    .run(name, Number(value), Math.floor(NOW / 1000));

const reset = () => {
  W.resetWatchdog();
  resetIndexHealth();
  db.prepare('DELETE FROM cursors').run();
};

// ------------------------------------------------------------------ /status

test('status reports both heads, the lag between them, and the uptime', () => {
  reset();
  setCursor('launches', 1_000_000);
  setCursor('launches_head', 1_000_030);
  const s = W.statusReport(NOW);
  assert.equal(s.indexerHead, 1_000_000);
  assert.equal(s.chainHead, 1_000_030);
  assert.equal(s.lagBlocks, 30);
  assert.equal(s.lagSeconds, 3, '30 blocks at 0.1s');
  assert.ok(s.uptimeSeconds >= 0);
  const text = W.statusText(s);
  assert.match(text, /indexer head {2}1,000,000/);
  assert.match(text, /chain head {4}1,000,030/);
  assert.match(text, /lag {11}30 blocks, about 3s of chain/);
});

test('a head nobody has recorded is undetermined, never zero lag', () => {
  reset();
  setCursor('launches', 1_000_000);
  const s = W.statusReport(NOW);
  assert.equal(s.chainHead, null);
  assert.equal(s.lagBlocks, null);
  assert.match(W.statusText(s), /lag {11}undetermined/);
  assert.doesNotMatch(W.statusText(s), /lag {11}0 blocks/);
});

test('status names the armed launch, the watch list and the seats', () => {
  reset();
  db.prepare('DELETE FROM watches').run();
  for (const i of [1, 2, 3]) {
    db.prepare('INSERT INTO watches (user_id, kind, address, dm_chat_id, created_at) VALUES (?,?,?,?,?)')
      .run(i, 'deployer', '0x' + String(i).repeat(40), i, 0);
  }
  const s = W.statusReport(NOW);
  assert.equal(s.watches, 3);
  const text = W.statusText(s);
  assert.match(text, /watch list {4}3 subscriptions/);
  assert.match(text, /launch armed {2}none/);
  assert.match(text, /uptime/);
});

test('the status text carries no exclamation and no em dash', () => {
  reset();
  setCursor('launches', 5);
  setCursor('launches_head', 500);
  const text = W.statusText(W.statusReport(NOW));
  assert.doesNotMatch(text, /!/);
  assert.ok(!text.includes(String.fromCharCode(0x2014)));
});

// --------------------------------------------------------------------- lag

test('a lag under the threshold starts no clock', () => {
  reset();
  assert.deepEqual(W.noteLag(W.WATCHDOG_LAG_BLOCKS, NOW), { due: false, heldSeconds: 0 });
  assert.deepEqual(W.noteLag(0, NOW), { due: false, heldSeconds: 0 });
  assert.deepEqual(W.noteLag(null, NOW), { due: false, heldSeconds: 0 });
});

test('a wide lag starts a clock and does not fire on the first reading', () => {
  reset();
  const first = W.noteLag(200, NOW);
  assert.equal(first.due, false);
  // Still not due a minute later: the threshold is two minutes.
  assert.equal(W.noteLag(200, NOW + 60_000).due, false);
});

test('a lag that holds past two minutes is due', () => {
  reset();
  W.noteLag(200, NOW);
  const held = W.noteLag(200, NOW + W.WATCHDOG_LAG_SECONDS * 1000);
  assert.equal(held.due, true);
  assert.equal(held.heldSeconds, W.WATCHDOG_LAG_SECONDS);
});

test('a lag that clears stops the clock, so a lag that comes and goes never fires', () => {
  reset();
  W.noteLag(200, NOW);
  W.noteLag(5, NOW + 60_000);            // cleared
  W.noteLag(200, NOW + 61_000);          // starts again
  assert.equal(W.noteLag(200, NOW + 120_000).due, false, 'the clock restarted when the lag cleared');
});

test('the threshold is sixty blocks over two minutes, as specified', () => {
  assert.equal(W.WATCHDOG_LAG_BLOCKS, 60);
  assert.equal(W.WATCHDOG_LAG_SECONDS, 120);
  assert.equal(W.WATCHDOG_FAILURES, 2);
  assert.equal(W.ALERT_COOLDOWN_MS, 600_000);
});

// ------------------------------------------------------------ the alerting

test('every admin is DMed, not just the first', async () => {
  reset();
  const api = fakeApi();
  const n = await W.alertAdmins(api, 'lag', 'the index is behind', NOW);
  assert.equal(n, 2);
  assert.deepEqual(api.sent.map((s) => s.chat_id), [9001, 9002]);
});

test('one alert per kind per ten minutes, however often it is noticed', async () => {
  reset();
  const api = fakeApi();
  assert.equal(await W.alertAdmins(api, 'lag', 'first', NOW), 2);
  assert.equal(await W.alertAdmins(api, 'lag', 'second', NOW + 60_000), 0);
  assert.equal(await W.alertAdmins(api, 'lag', 'third', NOW + 599_000), 0);
  assert.equal(await W.alertAdmins(api, 'lag', 'fourth', NOW + 600_000), 2);
  assert.equal(api.sent.length, 4);
});

test('the kinds are rate limited separately', async () => {
  reset();
  const api = fakeApi();
  await W.alertAdmins(api, 'lag', 'lag', NOW);
  assert.equal(await W.alertAdmins(api, 'errors', 'errors', NOW), 2);
  assert.equal(await W.alertAdmins(api, 'restart', 'restart', NOW), 2);
  assert.equal(await W.alertAdmins(api, 'lag', 'lag again', NOW), 0);
});

test('the cooldown survives a restart, so a crash loop does not flood', async () => {
  reset();
  const api = fakeApi();
  await W.alertAdmins(api, 'restart', 'restarted', NOW);
  // A new process reads the same settings row.
  assert.equal(W.alertAllowed('restart', NOW + 60_000), false);
  assert.equal(W.alertAllowed('restart', NOW + 600_000), true);
});

test('the cooldown is marked before the sends, so a send that throws does not reopen it', async () => {
  reset();
  const throwing = { sendMessage: async () => { throw new Error('429'); } };
  const n = await W.alertAdmins(throwing, 'lag', 'x', NOW);
  assert.equal(n, 0);
  assert.equal(W.alertAllowed('lag', NOW), false, 'a failed send must not alert again ten seconds later');
});

test('no admins configured means no alert, not an alert to nobody', async () => {
  reset();
  const saved = process.env.ADMIN_IDS;
  process.env.ADMIN_IDS = '';
  const api = fakeApi();
  assert.equal(await W.alertAdmins(api, 'lag', 'x', NOW), 0);
  assert.equal(api.sent.length, 0);
  process.env.ADMIN_IDS = saved;
});

// ---------------------------------------------------------------- the tick

test('the tick alerts on a lag that held, and once only', async () => {
  reset();
  setCursor('launches', 1_000_000);
  setCursor('launches_head', 1_000_500);
  const api = fakeApi();
  assert.deepEqual(await W.watchdogTick(api, NOW), [], 'the first wide reading starts a clock');
  assert.deepEqual(await W.watchdogTick(api, NOW + 120_000), ['lag']);
  assert.deepEqual(await W.watchdogTick(api, NOW + 130_000), [], 'rate limited');
  assert.match(api.sent[0].text, /500 blocks behind the chain/);
  assert.match(api.sent[0].text, /withheld rather than answered/);
});

test('two failed passes in a row alert, one does not', async () => {
  reset();
  const api = fakeApi();
  recordIndexFailure('rpc timeout');
  assert.deepEqual(await W.watchdogTick(api, NOW), [], 'one failure is a network');
  recordIndexFailure('rpc timeout');
  assert.deepEqual(await W.watchdogTick(api, NOW + 1000), ['errors']);
  assert.match(api.sent[0].text, /failed 2 passes in a row/);
  assert.match(api.sent[0].text, /rpc timeout/);
});

test('a restart notice says whether a launch is armed', async () => {
  reset();
  setCursor('launches', 1_000_000);
  setCursor('launches_head', 1_000_010);
  const api = fakeApi();
  assert.equal(await W.announceRestart(api, NOW), true);
  assert.match(api.sent[0].text, /the bot restarted/);
  assert.match(api.sent[0].text, /no launch is armed/);
  assert.match(api.sent[0].text, /10 blocks behind/);
  assert.equal(await W.announceRestart(api, NOW + 1000), false, 'rate limited like the rest');
});

test('no alert text ever says the word clean, safe or fine', async () => {
  reset();
  setCursor('launches', 1);
  setCursor('launches_head', 100_000);
  const s = W.statusReport(NOW);
  for (const kind of ['lag', 'errors', 'restart']) {
    const text = W.alertText(kind, s, { heldSeconds: 300 });
    assert.doesNotMatch(text, /\bclean\b|\bsafe\b|\ball good\b/i, kind);
    assert.doesNotMatch(text, /!/, kind);
    assert.ok(!text.includes(String.fromCharCode(0x2014)), kind);
  }
});
