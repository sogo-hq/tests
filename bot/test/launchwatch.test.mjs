/**
 * The CA going into more than one chat, each on its own delay.
 *
 * BLOCK ZERO takes it at zero so the room has it the moment the opening tax
 * window closes; THE FLOOR takes it at seven so it is not reading the other
 * room's screenshot. Both are fixtures here; nothing sends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('launchwatch');
const W = await import('../dist/launchwatch.js');
const { db } = await import('../dist/db.js');

const BLOCK_ZERO = -1001;
const FLOOR = -1002;
const CA = '0x' + 'ab'.repeat(20);
const T0 = 1_800_000_000;

const reset = () => db.prepare('DELETE FROM launch_watchers').run();

test('a chat registers itself with a delay, and the delay defaults to zero', () => {
  reset();
  assert.equal(W.addWatcher(BLOCK_ZERO, 0, 7).ok, true);
  assert.equal(W.addWatcher(FLOOR, 7, 7).ok, true);
  assert.equal(W.watcherFor(BLOCK_ZERO).delaySeconds, 0);
  assert.equal(W.watcherFor(FLOOR).delaySeconds, 7);
  assert.equal(W.watchers().length, 2);
  // Soonest first, so the list reads in the order the rooms get it.
  assert.deepEqual(W.watchers().map((w) => w.chatId), [BLOCK_ZERO, FLOOR]);
});

test('running it again in the same chat corrects the delay rather than refusing', () => {
  reset();
  W.addWatcher(FLOOR, 7, 7);
  const again = W.addWatcher(FLOOR, 12, 7);
  assert.equal(again.ok, true);
  assert.equal(again.changed, true);
  assert.equal(W.watchers().length, 1, 'one chat, one row');
  assert.equal(W.watcherFor(FLOOR).delaySeconds, 12);
  assert.equal(W.addWatcher(FLOOR, 12, 7).changed, false, 'the same delay again changes nothing');
});

test('a delay that is not seconds is refused, and nothing is stored', () => {
  reset();
  for (const bad of [-1, Number.NaN, W.MAX_WATCH_DELAY_SECONDS + 1, Infinity]) {
    assert.deepEqual(W.addWatcher(FLOOR, bad, 7), { ok: false, reason: 'delay' }, String(bad));
  }
  assert.equal(W.watchers().length, 0);
});

// -------------------------------------------------------------- the stagger

test('at T+0 only the zero-delay chat is due', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  W.addWatcher(FLOOR, 7, 7);
  assert.deepEqual(W.dueWatchers(CA, T0, T0).map((w) => w.chatId), [BLOCK_ZERO]);
  assert.deepEqual(W.pendingWatchers(CA, T0, T0).map((w) => w.chatId), [FLOOR]);
});

test('at the delay the second chat becomes due, and not a second before', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  W.addWatcher(FLOOR, 7, 7);
  assert.deepEqual(W.dueWatchers(CA, T0, T0 + 6).map((w) => w.chatId), [BLOCK_ZERO]);
  assert.deepEqual(W.dueWatchers(CA, T0, T0 + 7).map((w) => w.chatId), [BLOCK_ZERO, FLOOR]);
  assert.deepEqual(W.pendingWatchers(CA, T0, T0 + 7), []);
});

test('a chat that has the CA is never due again, however many ticks run', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  W.addWatcher(FLOOR, 7, 7);
  W.markWatcherPosted(BLOCK_ZERO, CA, 500, T0);
  assert.deepEqual(W.dueWatchers(CA, T0, T0 + 30).map((w) => w.chatId), [FLOOR]);
  W.markWatcherPosted(FLOOR, CA, 501, T0 + 7);
  assert.deepEqual(W.dueWatchers(CA, T0, T0 + 999), []);
});

test('a different CA makes every chat due again', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  W.markWatcherPosted(BLOCK_ZERO, CA, 500, T0);
  const other = '0x' + 'cd'.repeat(20);
  assert.deepEqual(W.dueWatchers(other, T0, T0).map((w) => w.chatId), [BLOCK_ZERO]);
});

test('clearing the posts arms every chat for the next launch', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  W.markWatcherPosted(BLOCK_ZERO, CA, 500, T0);
  assert.deepEqual(W.dueWatchers(CA, T0, T0), []);
  W.clearWatcherPosts();
  assert.deepEqual(W.dueWatchers(CA, T0, T0).map((w) => w.chatId), [BLOCK_ZERO]);
});

test('the case of the CA never decides whether a chat gets it twice', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  W.markWatcherPosted(BLOCK_ZERO, CA.toUpperCase().replace('0X', '0x'), 500, T0);
  assert.deepEqual(W.dueWatchers(CA.toLowerCase(), T0, T0), []);
});

// ------------------------------------------------------------- the fallback

test('with no chat registered, the ready group is the one that gets it', () => {
  reset();
  const ready = -900;
  assert.deepEqual(W.effectiveWatchers(ready).map((w) => w.chatId), [ready]);
  assert.equal(W.effectiveWatchers(ready)[0].delaySeconds, 0, 'and it gets it immediately');
  assert.deepEqual(W.dueWatchers(CA, T0, T0, ready).map((w) => w.chatId), [ready]);
  // Synthetic: nothing was written into the table behind the operator's back.
  assert.equal(W.watchers().length, 0);
});

test('once a chat registers, the fallback stops applying', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  assert.deepEqual(W.effectiveWatchers(-900).map((w) => w.chatId), [BLOCK_ZERO]);
});

test('no fallback and no chats means nobody is due, not everybody', () => {
  reset();
  assert.deepEqual(W.effectiveWatchers(null), []);
  assert.deepEqual(W.dueWatchers(CA, T0, T0, null), []);
});

// --------------------------------------------------------------- unwatching

test('a chat can drop out without touching the others', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  W.addWatcher(FLOOR, 7, 7);
  assert.equal(W.removeWatcher(FLOOR), true);
  assert.deepEqual(W.watchers().map((w) => w.chatId), [BLOCK_ZERO]);
  assert.equal(W.removeWatcher(FLOOR), false);
});

// ------------------------------------------------------------- the listing

test('status lists every chat, its delay and whether it has the CA', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  W.addWatcher(FLOOR, 7, 7);
  W.markWatcherPosted(BLOCK_ZERO, CA, 500, T0);
  const text = W.watchersText(T0 + 12).join('\n');
  assert.match(text, /2 chats watching:/);
  assert.match(text, new RegExp(`${BLOCK_ZERO}\\s+immediately\\s+posted 0xabababab`));
  assert.match(text, new RegExp(`${FLOOR}\\s+after 7s\\s+nothing posted yet`));
  assert.match(text, /12s ago/);
});

test('status says so plainly when nothing is watching', () => {
  reset();
  const text = W.watchersText(T0).join('\n');
  assert.match(text, /no chat is watching yet/);
  assert.match(text, /\/launch watch in each one/);
});

test('nothing in the listing is a verdict, an exclamation or an em dash', () => {
  reset();
  W.addWatcher(BLOCK_ZERO, 0, 7);
  const text = W.watchersText(T0).join('\n');
  assert.doesNotMatch(text, /\bclean\b|\bsafe\b|!/i);
  assert.ok(!text.includes(String.fromCharCode(0x2014)));
});
