/**
 * A rate-limited recheck must go back in the queue, not be filed as done.
 *
 * completed_at is never cleared anywhere and nothing re-arms a row, so writing
 * it on a transient failure permanently destroys that scan's +1h/+6h/+24h/+7d
 * observation -- and the outcome table is the entire point of the product.
 * Rechecks run four at a time against one node, so a whole batch failing to a
 * limit together is the expected shape rather than an edge case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = `/tmp/recheck-retry-${process.pid}.db`;
// keep the 429 ladder short; the point here is the branch, not the backoff
process.env.RPC_429_BUDGET_MS = '150';

let limiting = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (limiting && url.includes('rpc.mainnet.chain.robinhood.com')) {
    return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } });
  }
  return realFetch(input, init);
};
const { installRateLimit } = await import('../dist/ratelimit.js');
installRateLimit();
const { db } = await import('../dist/db.js');
const { runRecheck } = await import('../dist/recheck.js');

const TOKEN = '0xd384722f6adfe7d79E8e6623896DF199afD31B76';

function seedRow(offsetHours) {
  const now = Math.floor(Date.now() / 1000);
  const scanId = db
    .prepare(`INSERT INTO scans (token, curve, deployer, scanned_at, scanned_block) VALUES (?,?,?,?,?)`)
    .run(TOKEN, TOKEN, TOKEN, now, 1).lastInsertRowid;
  const id = db
    .prepare(`INSERT INTO rechecks (scan_id, token, offset_hours, due_at) VALUES (?,?,?,?)`)
    .run(scanId, TOKEN, offsetHours, now - 10).lastInsertRowid;
  return { id, scanId, now };
}
const rowOf = (id) => db.prepare('SELECT * FROM rechecks WHERE id = ?').get(id);

test('a rate-limited recheck is re-armed, not marked complete', async () => {
  const { id, now } = seedRow(1);
  limiting = true;
  try {
    await runRecheck({ id, scan_id: 0, token: TOKEN, offset_hours: 1, due_at: now - 10, attempts: 0 });
  } finally {
    limiting = false;
  }
  const row = rowOf(id);
  assert.equal(row.completed_at, null, 'a limit must not file the recheck as done — the observation is lost forever');
  assert.equal(row.attempts, 1, 'the attempt must be counted so it cannot retry forever');
  assert.ok(row.due_at > now, `due_at must move forward, got ${row.due_at} vs ${now}`);
  assert.ok(row.error, 'the reason is still recorded');
});

test('a re-armed recheck gives up after the attempt ceiling', async () => {
  const { id, now } = seedRow(6);
  db.prepare('UPDATE rechecks SET attempts = 5 WHERE id = ?').run(id);
  limiting = true;
  try {
    await runRecheck({ id, scan_id: 0, token: TOKEN, offset_hours: 6, due_at: now - 10, attempts: 5 });
  } finally {
    limiting = false;
  }
  const row = rowOf(id);
  assert.ok(row.completed_at, 'past the ceiling it is filed rather than retried forever');
  assert.equal(row.attempts, 5, 'the ceiling is not incremented past');
});

test('a re-armed row is picked up again by the due query', () => {
  const { id } = seedRow(24);
  db.prepare('UPDATE rechecks SET attempts = 1, due_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, id);
  const due = db
    .prepare('SELECT id FROM rechecks WHERE completed_at IS NULL AND due_at <= ? ORDER BY due_at ASC')
    .all(Math.floor(Date.now() / 1000));
  assert.ok(due.some((r) => r.id === id), 'the re-armed row must come back around');
});
