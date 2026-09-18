/**
 * The launch-day lookalike watch.
 *
 * The room guard covers addresses posted in our own chats. This covers the
 * case it cannot see: a token nobody has posted yet, landing on chain with a
 * name or ticker that normalises to ours. Everything here runs on fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('collision-watch');
const { db, normaliseKey } = await import('../dist/db.js');
const C = await import('../dist/collision.js');

const A = (n) => '0x' + String(n).padStart(40, '0');

let seq = 0;
function land(name, symbol, { deployer = 98, block = 64_000_000 } = {}) {
  seq++;
  const token = A(seq);
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
        graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key, symbol_key)
      VALUES (?,?,?,?,0,'0',?,?,?,?,?,?,?)`,
  ).run(token, A(900000 + seq), A(deployer), A(0), block,
        '0x' + String(seq).padStart(64, '0'), 1_000_000 + seq,
        name, symbol, normaliseKey(name), normaliseKey(symbol));
  return token;
}

const reset = () => {
  db.prepare('DELETE FROM launches').run();
  db.prepare('DELETE FROM collision_watches').run();
  db.prepare('DELETE FROM collision_watch_hits').run();
  seq = 0;
};

test('a watch stores the normalised keys and the strings as typed', () => {
  reset();
  const r = C.startCollisionWatch('VITALS', 'VITALS', { at: 100, by: 9001 });
  assert.equal(r.ok, true);
  assert.equal(r.already, false);
  assert.equal(r.watch.name, 'VITALS');
  assert.deepEqual(r.watch.keys, { nameKey: 'vitals', symbolKey: 'vitals' });
  assert.deepEqual(C.liveCollisionWatches().map((w) => w.id), [r.watch.id]);
});

test('a pair that normalises to nothing is refused rather than stored', () => {
  reset();
  const r = C.startCollisionWatch('...', '!!!', { at: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-keys');
  assert.deepEqual(C.liveCollisionWatches(), []);
});

test('asking twice returns the running watch rather than making a second', () => {
  reset();
  const a = C.startCollisionWatch('VITALS', 'VITALS', { at: 100 });
  // A different spelling of the same thing is the same watch, because the
  // keys are what it matches on.
  const b = C.startCollisionWatch('vitals', 'VІTALS', { at: 200 });
  assert.equal(b.already, true);
  assert.equal(b.watch.id, a.watch.id);
  assert.equal(C.liveCollisionWatches().length, 1);
});

test('a homoglyph landing is claimed once, with the CA, the deployer and the block', () => {
  reset();
  const w = C.startCollisionWatch('VITALS', 'VITALS', { at: 100 }).watch;
  const token = land('Vitals', 'VІTALS', { deployer: 4242, block: 64_623_813 });
  land('Chipper', 'CHIPPER');

  const first = C.claimWatchNotices([token, A(2)], 500);
  assert.equal(first.length, 1, 'the unrelated launch was reported too');
  assert.equal(first[0].watch.id, w.id);
  assert.equal(first[0].hit.token, token);
  assert.equal(first[0].hit.deployer, A(4242));
  assert.equal(first[0].hit.blockNumber, 64_623_813);

  // Idempotent: the indexer handing the same block back is not a second DM.
  assert.deepEqual(C.claimWatchNotices([token, A(2)], 600), []);
});

test('the notice says what landed and where, and nothing about what it means', () => {
  reset();
  C.startCollisionWatch('VITALS', 'VITALS', { at: 100 });
  const token = land('Vitals', 'VІTALS', { deployer: 4242, block: 64_623_813 });
  const text = C.watchNoticeText(C.claimWatchNotices([token], 500)[0]);
  assert.match(text, new RegExp(`CA {9}${token}`));
  assert.match(text, new RegExp(`deployer {3}${A(4242)}`));
  assert.match(text, /block {6}64,623,813/);
  assert.match(text, /matched on the ticker and the name, after homoglyph normalisation/);
  assert.match(text, /landed as {2}Vitals \/ VІTALS/);
  // No verdict, no grade, no advice. A lookalike may be an impersonation or a
  // coincidence and the chain does not say which.
  assert.doesNotMatch(text, /\bclean\b|\bsafe\b|\bscam\b|\bfake\b|\bscore\b|\bgrade\b|looks good/i);
  assert.doesNotMatch(text, /!/);
  assert.ok(!text.includes(String.fromCharCode(0x2014)));
});

test('a ticker is somebody else\'s text, so it is clamped', () => {
  reset();
  C.startCollisionWatch('VITALS', 'VITALS', { at: 100 });
  const token = land('V'.repeat(300) + 'ITALS', 'VITALS');
  const text = C.watchNoticeText(C.claimWatchNotices([token], 500)[0]);
  for (const line of text.split('\n')) assert.ok(line.length < 120, `a line ran to ${line.length}`);
});

test('only the ticker matching is enough, and so is only the name', () => {
  reset();
  C.startCollisionWatch('VITALS', 'VITALS', { at: 100 });
  const tickerOnly = land('Something Else', 'VITALS');
  const nameOnly = land('Vitals', 'XYZ');
  const neither = land('Chipper', 'CHIPPER');
  const got = C.claimWatchNotices([tickerOnly, nameOnly, neither], 500);
  assert.deepEqual(got.map((g) => g.hit.token).sort(), [nameOnly, tickerOnly].sort());
  assert.match(C.watchNoticeText(got.find((g) => g.hit.token === tickerOnly)), /matched on the ticker,/);
  assert.match(C.watchNoticeText(got.find((g) => g.hit.token === nameOnly)), /matched on the name,/);
});

test('a stopped watch matches nothing from then on', () => {
  reset();
  const w = C.startCollisionWatch('VITALS', 'VITALS', { at: 100 }).watch;
  assert.equal(C.stopCollisionWatch(w.id, 300), true);
  assert.equal(C.stopCollisionWatch(w.id, 400), false, 'stopping twice reported a second stop');
  assert.deepEqual(C.liveCollisionWatches(), []);
  const token = land('Vitals', 'VITALS');
  assert.deepEqual(C.claimWatchNotices([token], 500), []);
});

test('the watch matches what the count matches, on the same keys', () => {
  reset();
  C.startCollisionWatch('VITALS', 'VITALS', { at: 100 });
  const a = land('Vitals', 'VІTALS');
  const b = land('vitals', 'VITALS');
  land('Chipper', 'CHIPPER');
  const keys = C.collisionKeys('VITALS', 'VITALS');
  // The count says two others share it; the watch names those same two.
  assert.equal(C.countCollisions(C.NOT_ON_CHAIN_YET, keys), 2);
  assert.deepEqual(C.claimWatchNotices([a, b, A(3)], 500).map((n) => n.hit.token).sort(), [a, b].sort());
});

test('two watches on different pairs each get their own launch', () => {
  reset();
  const v = C.startCollisionWatch('VITALS', 'VITALS', { at: 100 }).watch;
  const c = C.startCollisionWatch('Chipper', 'CHIPPER', { at: 100 }).watch;
  const one = land('Vitals', 'VITALS');
  const two = land('Chipper', 'CHIPPER');
  const got = C.claimWatchNotices([one, two], 500);
  assert.equal(got.length, 2);
  assert.equal(got.find((g) => g.hit.token === one).watch.id, v.id);
  assert.equal(got.find((g) => g.hit.token === two).watch.id, c.id);
});
