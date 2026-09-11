/**
 * The one thing a card cannot say about itself.
 *
 * A card shows markers and numbers. What it cannot convey on its own is that a
 * missing marker is not an all-clear -- which is the entire distinction this
 * product is built on, and the one a first-time user has no way to infer. So it
 * is said once, in words, on the way in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('legend');
const { LEGEND, claimLegend, resetLegend } = await import('../dist/legend.js');

test('the legend is five lines and explains all three states', () => {
  const lines = LEGEND.split('\n');
  assert.equal(lines.length, 5, `legend is ${lines.length} lines, spec says five`);
  assert.match(LEGEND, /\u{1F6A9}/u, 'the finding marker must be explained');
  assert.match(LEGEND, /◌/, 'the undetermined marker must be explained');
  assert.match(LEGEND, /no marker/, 'the absent-marker state must be explained');
  assert.match(LEGEND, /index median/, '"index median" must be explained');
});

test('it says the thing the card cannot say for itself', () => {
  assert.match(LEGEND, /no finding ≠ clean/,
    'the legend exists to say that an absence is not an all-clear');
});

test('it never presents an absence as an all-clear', () => {
  // "no finding ≠ clean" is the only permitted use of the word, and it negates it.
  for (const line of LEGEND.split('\n')) {
    if (/≠ clean/.test(line)) continue;
    for (const banned of [/\bclean\b/i, /\bsafe\b/i, /\ball good\b/i, /\bok to\b/i]) {
      assert.doesNotMatch(line, banned, `the legend reads as an all-clear: "${line}"`);
    }
  }
});

test('shown once per user, and it survives a restart', async () => {
  const uid = 987_001;
  resetLegend(uid);
  assert.equal(claimLegend(uid), true, 'a new user is shown it');
  assert.equal(claimLegend(uid), false, 'and is never shown it again');

  // Persisted in SQLite, not in memory: this container has no volume, so an
  // in-memory set would re-send the legend to everyone after every deploy.
  const { db } = await import('../dist/db.js');
  const row = db.prepare('SELECT legend_at FROM dm_chats WHERE user_id = ?').get(uid);
  assert.ok(row?.legend_at, 'the showing was not written down, so a restart repeats it');
});

test('a user with no DM row yet can still be shown it', () => {
  // Somebody can reach a card before the middleware has recorded a DM for them,
  // so the claim has to create the row rather than assume one.
  const uid = 987_002;
  resetLegend(uid);
  assert.equal(claimLegend(uid), true);
  assert.equal(claimLegend(uid), false);
});
