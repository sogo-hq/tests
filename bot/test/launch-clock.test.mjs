/**
 * The launch clock.
 *
 * September in Bratislava is CEST (UTC+2) and January is CET (UTC+1). Every
 * assertion here pins a real UTC instant against a wall-clock time, so a
 * hardcoded offset creeping back in fails rather than drifting an hour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = process.env.DB_PATH || `/tmp/vitals-clock-${process.pid}.db`;
const L = await import('../dist/launch.js');

const UTC = (s) => Date.parse(s);
// A Tuesday, comfortably before everything under test.
const NOW = UTC('2026-09-14T09:00:00Z');

test('a Tuesday at 16:00 local is accepted, and lands at 14:00 UTC', () => {
  const r = L.parseLaunchTime('2026-09-22 16:00', NOW);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.at, UTC('2026-09-22T14:00:00Z'), 'September is CEST, so local is UTC+2');
});

test('the same wall clock in January would be UTC+1', () => {
  assert.equal(L.zonedToUtcMs(2027, 1, 19, 16, 0), UTC('2027-01-19T15:00:00Z'));
  assert.equal(L.zonedToUtcMs(2026, 9, 22, 16, 0), UTC('2026-09-22T14:00:00Z'));
});

test('the printed line names the zone it is actually in', () => {
  assert.equal(L.launchTimeLine(UTC('2026-09-22T14:00:00Z')), 'launch: 2026-09-22 16:00 CEST');
  assert.equal(L.launchTimeLine(UTC('2027-01-19T15:00:00Z')), 'launch: 2027-01-19 16:00 CET');
});

test('Friday, Saturday and Sunday are refused by name', () => {
  for (const [date, day] of [['2026-09-18', 'Friday'], ['2026-09-19', 'Saturday'], ['2026-09-20', 'Sunday']]) {
    const r = L.parseLaunchTime(`${date} 16:00`, NOW);
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(`^${day} is not a launch day`), `${date}: ${r.reason}`);
  }
});

test('Monday through Thursday are accepted', () => {
  for (const date of ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']) {
    assert.equal(L.parseLaunchTime(`${date} 16:00`, NOW).ok, true, date);
  }
});

test('the hour window is 15:00 to 18:00, half open', () => {
  const at = (t) => L.parseLaunchTime(`2026-09-22 ${t}`, NOW);
  assert.equal(at('14:59').ok, false);
  assert.equal(at('15:00').ok, true, 'the window opens at 15:00');
  assert.equal(at('17:59').ok, true);
  assert.equal(at('18:00').ok, false, 'and closes before 18:00');
  assert.match(at('18:00').reason, /18:00 CEST is outside the window/);
});

test('past the cutoff is refused, and the weekday rule bites first', () => {
  // 2026-09-25 is a Friday, so the last slot the rules actually allow is the
  // Thursday before it. The refusal must say which rule was broken.
  assert.match(L.parseLaunchTime('2026-09-25 16:00', NOW).reason, /^Friday is not a launch day/);
  assert.match(L.parseLaunchTime('2026-09-28 16:00', NOW).reason, /past the 2026-09-25 cutoff/);
  assert.equal(L.parseLaunchTime('2026-09-24 17:00', NOW).ok, true, 'Thursday the 24th is the real last slot');
});

test('a time that has already passed is refused', () => {
  assert.match(L.parseLaunchTime('2026-09-08 16:00', NOW).reason, /already passed/);
});

test('malformed and impossible dates are refused, not rolled over', () => {
  for (const bad of ['', 'tomorrow', '2026-09-22', '16:00', '2026-9-22 16:00', '2026-09-22 25:00']) {
    assert.equal(L.parseLaunchTime(bad, NOW).ok, false, `"${bad}" must not parse`);
  }
  const r = L.parseLaunchTime('2026-09-31 16:00', NOW);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a real date/, 'September has 30 days and must not roll into October');
});

test('the ISO T separator is accepted too', () => {
  assert.equal(L.parseLaunchTime('2026-09-22T16:00', NOW).at, UTC('2026-09-22T14:00:00Z'));
});

// ------------------------------------------------------------------- countdown

const LAUNCH = UTC('2026-09-22T14:00:00Z');
const posted = new Set();
const isPosted = (k) => posted.has(k);

test('every offset comes due exactly once, in order', () => {
  posted.clear();
  const seen = [];
  for (const o of L.COUNTDOWN_OFFSETS) {
    // One second after the offset is reached.
    const r = L.dueCountdown(LAUNCH, LAUNCH - o.seconds * 1000 + 1000, isPosted);
    assert.ok(r, `${o.key} did not come due`);
    seen.push(r.due.key);
    posted.add(r.due.key);
    assert.equal(L.dueCountdown(LAUNCH, LAUNCH - o.seconds * 1000 + 2000, isPosted)?.due.key, undefined,
      `${o.key} came due twice`);
  }
  assert.deepEqual(seen, ['T-5d', 'T-4d', 'T-3d', 'T-2d', 'T-24h', 'T-12h', 'T-6h', 'T-1h', 'T-10min']);
});

test('nothing is due before the first offset', () => {
  posted.clear();
  assert.equal(L.dueCountdown(LAUNCH, LAUNCH - 6 * 86_400_000, isPosted), null);
});

test('a bot that was down posts only the closest offset and buries the rest', () => {
  posted.clear();
  // Down from before T-5d, back at T-2d: four offsets have come due.
  const r = L.dueCountdown(LAUNCH, LAUNCH - 2 * 86_400_000 + 1000, isPosted);
  assert.equal(r.due.key, 'T-2d', 'the only one that is still true');
  assert.deepEqual(r.skipped.map((o) => o.key), ['T-5d', 'T-4d', 'T-3d'],
    'the stale ones are named so the caller can mark them without posting them');
});

test('nothing is due once the launch has happened', () => {
  posted.clear();
  assert.equal(L.dueCountdown(LAUNCH, LAUNCH, isPosted), null);
  assert.equal(L.dueCountdown(LAUNCH, LAUNCH + 60_000, isPosted), null);
});

test('the CA notice is fixed text and says three seconds', () => {
  assert.equal(L.CA_NOTICE, 'CA lands here 3 s after launch. anything before that is fake.');
});

test('an unset DECLARED_COUNT is omitted, never printed as zero', () => {
  delete process.env.DECLARED_COUNT;
  assert.equal(L.declaredCount(), null, 'an unset variable is not a measurement of zero');
  process.env.DECLARED_COUNT = '7';
  assert.equal(L.declaredCount(), 7);
  process.env.DECLARED_COUNT = 'nonsense';
  assert.equal(L.declaredCount(), null);
  delete process.env.DECLARED_COUNT;
});

test('a zone ICU will not name falls back to an offset rather than guessing', () => {
  // en-GB names CEST and BST but not America/New_York, and a guessed "EDT"
  // would be a fact the runtime never gave us.
  assert.match(L.zonedParts(UTC('2026-09-22T14:00:00Z'), 'Europe/Bratislava').abbrev, /^CEST$/);
  const ny = L.zonedParts(UTC('2026-09-22T14:00:00Z'), 'America/New_York').abbrev;
  assert.match(ny, /^(EDT|UTC-4)$/, `unexpected abbreviation ${ny}`);
  assert.equal(L.zonedParts(UTC('2026-09-22T14:00:00Z'), 'UTC').abbrev, 'UTC');
});

test('the two DST transitions round-trip, and the hour that does not exist is unreachable', () => {
  // Bratislava springs forward on the last Sunday of March (02:00 -> 03:00) and
  // falls back on the last Sunday of October (03:00 -> 02:00).
  const rt = (y, m, d, hh, mm) => {
    const p = L.zonedParts(L.zonedToUtcMs(y, m, d, hh, mm));
    return `${p.hour}:${String(p.minute).padStart(2, '0')}`;
  };
  assert.equal(rt(2026, 3, 29, 1, 30), '1:30');
  assert.equal(rt(2026, 3, 29, 3, 30), '3:30');
  assert.equal(rt(2026, 10, 25, 1, 30), '1:30');
  assert.equal(rt(2026, 10, 25, 2, 30), '2:30');
  assert.equal(rt(2026, 10, 25, 3, 30), '3:30');
  // 02:30 on the spring-forward day is a wall-clock time that does not exist;
  // it resolves forward to 03:30. Unreachable for a launch regardless: the day
  // is a Sunday and the time is outside the window, so two rules refuse it
  // before the ambiguity can matter.
  assert.equal(rt(2026, 3, 29, 2, 30), '3:30');
  assert.match(L.parseLaunchTime('2026-03-29 02:30', UTC('2026-01-05T09:00:00Z')).reason, /Sunday is not a launch day/);
});

test('a deadline on the last day of a month does not roll into the wrong one', () => {
  // The cutoff is the start of the day AFTER the deadline, so September's is
  // day 31 of September. Date.UTC normalises that to 1 October rather than
  // producing an invalid instant.
  const cutoff = L.zonedToUtcMs(2026, 9, 31, 0, 0);
  assert.equal(new Date(cutoff).toISOString(), '2026-09-30T22:00:00.000Z', '00:00 on 1 Oct, CEST');
  const dec = L.zonedToUtcMs(2026, 12, 32, 0, 0);
  assert.equal(new Date(dec).toISOString(), '2026-12-31T23:00:00.000Z', '00:00 on 1 Jan, CET');
});
