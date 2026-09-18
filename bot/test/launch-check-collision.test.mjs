/**
 * The ticker collision row in --check.
 *
 * The point of the row is that the number printed on a Sunday is the number
 * the card prints at T+15, so most of what is asserted here is that the two
 * count the same rows. If they ever stop doing that, the row is worse than
 * not having one: it is a rehearsal that does not rehearse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('launch-check-collision');
const { db, normaliseKey } = await import('../dist/db.js');
const C = await import('../dist/collision.js');

const A = (n) => '0x' + String(n).padStart(40, '0');

let seq = 0;
function launch(name, symbol) {
  seq++;
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
        graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key, symbol_key)
      VALUES (?,?,?,?,0,'0',?,?,?,?,?,?,?)`,
  ).run(A(seq), A(900000 + seq), A(98), A(0), 1000 + seq,
        '0x' + String(seq).padStart(64, '0'), 1_000_000 + seq,
        name, symbol, normaliseKey(name), normaliseKey(symbol));
  return A(seq);
}

const reset = () => { db.prepare('DELETE FROM launches').run(); seq = 0; };

/** An index that has read enough to be allowed to report a zero. */
const COVERED = { indexed: 478_610, decoded: 478_188, trustNegatives: { collision: true } };
/** One that has not. */
const THIN = { indexed: 12, decoded: 4, trustNegatives: { collision: false } };

const row = (cov = COVERED, reason = 'index rebuilding, counts incomplete') =>
  C.collisionCheckRow('VITALS', 'VITALS', cov, reason);

test('a unique ticker counts zero, with the denominator beside it', () => {
  reset();
  launch('Chipper', 'CHIPPER');
  launch('Dogwifhat', 'WIF');
  const r = row();
  assert.equal(r.matches, 0);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.value, '0 other indexed tokens');
  assert.match(r.note, /out of 478,610 indexed, 478,188 of them decoded/);
  // The denominator is said with what it means, because a row that cannot
  // carry the keys cannot match and counting it silently overstates the check.
  assert.match(r.note, /only a decoded row carries the keys this matches on/);
});

test('a zero the index cannot support is undetermined, not a zero', () => {
  reset();
  const r = row(THIN);
  assert.equal(r.matches, 0);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.value, 'undetermined');
  assert.match(r.note, /index rebuilding, counts incomplete/);
  assert.match(r.note, /not "nobody else uses it"/);
});

test('homoglyphs count: a Cyrillic A is a collision, not a different ticker', () => {
  reset();
  launch('Vitals', 'VІTALS');
  const r = row();
  assert.equal(r.matches, 1);
  assert.equal(r.verdict, 'pass', 'one match is below the threshold the card uses');
  assert.match(r.note, /below the 2 that make it a finding on the card/);
});

test('at the threshold it is a warn, with the spellings, and never a fail', () => {
  reset();
  launch('Vitals', 'VІTALS');
  launch('vitals', 'VITALS');
  launch('V I T A L S', 'VITALS');
  const r = row();
  assert.equal(r.matches, 3);
  assert.equal(r.verdict, 'warn', 'a ticker somebody else took is not a broken config');
  assert.match(r.note, /the card calls this a finding at 2 or more/);
  // Distinct spellings, not the same glyph three times.
  assert.match(r.note, /VІTALS/);
  assert.match(r.note, /VITALS/);
  assert.match(r.note, /out of 478,610 indexed/);
});

test('the name alone collides, and an empty key matches nothing', () => {
  reset();
  launch('VITALS', 'NOTVITALS');
  assert.equal(row().matches, 1, 'the name matched even though the symbol did not');

  reset();
  launch('', '');
  launch('', '');
  assert.equal(row().matches, 0, 'an empty key matched every empty row');
  assert.equal(C.collisionCheckRow('', '', COVERED, 'x').matches, 0, 'an empty query matched something');
});

test('the row counts the rows the card counts', async () => {
  reset();
  launch('Vitals', 'VІTALS');
  launch('vitals', 'VITALS');
  const keys = C.collisionKeys('VITALS', 'VITALS');
  // What the card does on a scan: exclude the token being scanned, count the
  // rest. Before a launch there is nothing to exclude, and the sentinel is a
  // token no launch has.
  assert.equal(C.countCollisions(C.NOT_ON_CHAIN_YET, keys), row().matches);
  // And the exclusion is real: asked as one of them, the count drops by one.
  assert.equal(C.countCollisions(A(1), keys), row().matches - 1);
});

test('the threshold the row prints is the one the card raises at', async () => {
  const { MIN_COLLISION_MATCHES } = C;
  assert.equal(MIN_COLLISION_MATCHES, 2);
  reset();
  for (let i = 0; i < MIN_COLLISION_MATCHES; i++) launch('Vitals', 'VITALS');
  assert.equal(row().verdict, 'warn');
  reset();
  for (let i = 0; i < MIN_COLLISION_MATCHES - 1; i++) launch('Vitals', 'VITALS');
  assert.equal(row().verdict, 'pass');
});

// --------------------------------------------------------------- /collision

test('collisionText prints the three states, the keys and the denominator', () => {
  reset();
  launch('Chipper', 'CHIPPER');
  const none = C.collisionText('VITALS', 'VITALS', COVERED, 'x');
  // The comparison is printed, because the whole point of normalising is that
  // it changes what is being compared.
  assert.match(none, /compared as {2}vitals \/ vitals/);
  assert.match(none, /0 other indexed tokens/);
  assert.match(none, /out of 478,610 indexed, 478,188 of them decoded/);

  reset();
  launch('Vitals', 'VІTALS');
  launch('vitals', 'VITALS');
  const some = C.collisionText('VITALS', 'VITALS', COVERED, 'x');
  assert.match(some, /2 other indexed tokens/);
  assert.match(some, /the card calls this a finding at 2 or more/);

  reset();
  const thin = C.collisionText('VITALS', 'VITALS', THIN, 'index stalled 2h ago, counts may be behind');
  assert.match(thin, /undetermined/);
  assert.match(thin, /index stalled 2h ago/);
  // Never the word that would make an undetermined read as a negative.
  assert.doesNotMatch(thin, /\bclean\b|\bsafe\b|looks good/i);
});

test('a name with spaces keeps its spaces and the last word is the symbol', () => {
  reset();
  launch('Vital Signs', 'VITALS');
  // What the handler does with "/collision Vital Signs VITALS".
  const parts = 'Vital Signs VITALS'.split(/\s+/);
  const symbol = parts[parts.length - 1];
  const name = parts.slice(0, -1).join(' ');
  assert.equal(name, 'Vital Signs');
  assert.equal(symbol, 'VITALS');
  assert.equal(C.collisionKeys(name, symbol).nameKey, 'vitalsigns');
  assert.equal(C.collisionCheckRow(name, symbol, COVERED, 'x').matches, 1);
});
