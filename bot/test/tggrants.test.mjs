/**
 * Premium by Telegram user id.
 *
 * The route exists because the people it is for have no wallet and are not
 * going to link one. So the two things worth pinning down are that the grant
 * resolves everywhere a premium gate is checked, and that running the same
 * batch twice does not quietly hand out two months for one decision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('tggrants');
const { db } = await import('../dist/db.js');
const G = await import('../dist/tggrants.js');

const DAY = 86_400;
const T0 = 1_800_000_000;

const reset = () => {
  db.prepare('DELETE FROM premium_tg_grants').run();
  db.prepare('DELETE FROM premium_tg_reminders').run();
};

// ------------------------------------------------------------- the parsing

test('a user id is read from the shapes an admin actually pastes', () => {
  assert.equal(G.parseUserId('123456789'), 123456789);
  assert.equal(G.parseUserId('tg:123456789'), 123456789);
  assert.equal(G.parseUserId('TG:123456789'), 123456789);
  assert.equal(G.parseUserId(' @123456789 '), 123456789);
  // Anything else is reported rather than coerced: a mistyped id is a grant
  // to a stranger, and Number('12a') being NaN is not a defence on its own.
  for (const bad of ['', '0', '-1', '12a', 'abc', '1.5', '1e9', '0x10', '@', 'tg:', '12345678901234567890']) {
    assert.equal(G.parseUserId(bad), null, `${JSON.stringify(bad)} parsed`);
  }
});

test('a pasted block separates on newlines, commas, spaces and a mix', () => {
  const newline = G.parseUserIds('111\n222\n333');
  assert.deepEqual(newline.ids, [111, 222, 333]);
  assert.deepEqual(newline.invalid, []);

  const comma = G.parseUserIds('111,222,333');
  assert.deepEqual(comma.ids, [111, 222, 333]);

  const mixed = G.parseUserIds('111, 222\n333;444  555\n\n666,');
  assert.deepEqual(mixed.ids, [111, 222, 333, 444, 555, 666]);
  assert.deepEqual(mixed.invalid, []);
});

test('invalid ids are named, not silently dropped, and order is kept', () => {
  const r = G.parseUserIds('111\nnotanid\n222\n@333\n-4\n0');
  assert.deepEqual(r.ids, [111, 222, 333]);
  assert.deepEqual(r.invalid, ['notanid', '-4', '0']);
});

test('a duplicate in the paste is granted once and counted', () => {
  const r = G.parseUserIds('111\n222\n111\n111');
  assert.deepEqual(r.ids, [111, 222]);
  assert.equal(r.duplicates, 2);
});

// -------------------------------------------------------------- the grant

test('a grant lands, and reads back as live until its date', () => {
  reset();
  const r = G.grantTg(7001, 30, { note: 'floor kol', by: 9001, at: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.result.outcome, 'added');
  assert.equal(r.result.previousExpiry, null);
  assert.equal(r.result.grant.expiresAt, T0 + 30 * DAY);
  assert.equal(r.result.grant.note, 'floor kol');
  assert.equal(r.result.grant.grantedBy, 9001);

  assert.ok(G.activeTgGrant(7001, T0 + 29 * DAY));
  // Expired rows never surface, whether or not anything pruned them.
  assert.equal(G.activeTgGrant(7001, T0 + 30 * DAY + 1), null);
  assert.deepEqual(G.liveTgGrants(T0 + 30 * DAY + 1), []);
});

test('the same grant twice extends to the later date, it does not add', () => {
  reset();
  G.grantTg(7001, 30, { by: 9001, at: T0 });
  // A day later, the same batch again. 30 days from THEN is later than what
  // is on the row, so it moves; it does not become 60 days from the start.
  const again = G.grantTg(7001, 30, { by: 9001, at: T0 + DAY });
  assert.equal(again.result.outcome, 'extended');
  assert.equal(again.result.previousExpiry, T0 + 30 * DAY);
  assert.equal(again.result.grant.expiresAt, T0 + DAY + 30 * DAY);
  assert.notEqual(again.result.grant.expiresAt, T0 + 60 * DAY, 'the days were added');
});

test('a shorter grant never shortens a longer one', () => {
  reset();
  G.grantTg(7001, 90, { by: 9001, at: T0 });
  const short = G.grantTg(7001, 30, { by: 9002, at: T0 });
  assert.equal(short.result.outcome, 'unchanged');
  assert.equal(short.result.grant.expiresAt, T0 + 90 * DAY);
});

test('re-running the identical batch in the same second changes nothing', () => {
  reset();
  const first = G.grantTg(7001, 30, { note: 'floor kol', by: 9001, at: T0 });
  const second = G.grantTg(7001, 30, { note: 'floor kol', by: 9001, at: T0 });
  assert.equal(second.result.outcome, 'unchanged');
  assert.equal(second.result.grant.expiresAt, first.result.grant.expiresAt);
  assert.equal(G.liveTgGrants(T0).length, 1);
});

test('an expired grant starts the clock again from now', () => {
  reset();
  G.grantTg(7001, 30, { by: 9001, at: T0 });
  const after = T0 + 40 * DAY;
  const r = G.grantTg(7001, 30, { by: 9001, at: after });
  assert.equal(r.result.outcome, 'added', 'an expired row is not an extension');
  assert.equal(r.result.grant.expiresAt, after + 30 * DAY);
});

test('a note survives a grant that does not carry one, and created_at is kept', () => {
  reset();
  const first = G.grantTg(7001, 30, { note: 'floor kol', by: 9001, at: T0 });
  const later = G.grantTg(7001, 60, { by: 9002, at: T0 + DAY });
  assert.equal(later.result.grant.note, 'floor kol', 'the note was cleared by a grant with none');
  assert.equal(later.result.grant.createdAt, first.result.grant.createdAt);
  assert.equal(later.result.grant.updatedAt, T0 + DAY);
});

test('a bad id or a bad day count is refused, and nothing is written', () => {
  reset();
  assert.deepEqual(G.grantTg(0, 30), { ok: false, reason: 'user' });
  assert.deepEqual(G.grantTg(-1, 30), { ok: false, reason: 'user' });
  assert.deepEqual(G.grantTg(7001, 0), { ok: false, reason: 'days' });
  assert.deepEqual(G.grantTg(7001, -5), { ok: false, reason: 'days' });
  assert.deepEqual(G.grantTg(7001, Number.NaN), { ok: false, reason: 'days' });
  assert.deepEqual(G.grantTg(7001, G.MAX_TG_GRANT_DAYS + 1), { ok: false, reason: 'days' });
  assert.deepEqual(G.liveTgGrants(T0), []);
});

test('ungrant removes it and hands back what was there, for the audit line', () => {
  reset();
  G.grantTg(7001, 30, { note: 'floor kol', by: 9001, at: T0 });
  const gone = G.ungrantTg(7001);
  assert.equal(gone.expiresAt, T0 + 30 * DAY);
  assert.equal(gone.note, 'floor kol');
  assert.equal(G.activeTgGrant(7001, T0), null);
  assert.equal(G.ungrantTg(7001), null, 'ungranting twice reported a second removal');
});

// ------------------------------------------------------------ the reminder

test('the ending-soon reminder fires exactly once', async () => {
  reset();
  G.grantTg(7001, 30, { by: 9001, at: T0 });
  const ends = T0 + 30 * DAY;

  const sent = [];
  const send = async (userId, text) => { sent.push({ userId, text }); };

  // Outside the window: nothing.
  assert.deepEqual(await G.runReminderPass(send, ends - 5 * DAY), { sent: 0, failed: 0 });
  assert.equal(sent.length, 0);

  // Inside it: once.
  assert.deepEqual(await G.runReminderPass(send, ends - 2 * DAY), { sent: 1, failed: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, 7001);
  assert.match(sent[0].text, /^premium ends \d{4}-\d{2}-\d{2}\. hold 1M \$VITALS to keep it, or ask sirius\.$/);

  // Every later pass in the same window: nothing again.
  await G.runReminderPass(send, ends - 2 * DAY + 3600);
  await G.runReminderPass(send, ends - DAY);
  assert.equal(sent.length, 1, 'the reminder fired more than once');

  // And silence at expiry itself.
  await G.runReminderPass(send, ends + 1);
  assert.equal(sent.length, 1);
});

test('extending a grant arms the reminder again for the new date', async () => {
  reset();
  G.grantTg(7001, 30, { by: 9001, at: T0 });
  const ends = T0 + 30 * DAY;
  const sent = [];
  const send = async (userId, text) => { sent.push({ userId, text }); };
  await G.runReminderPass(send, ends - 2 * DAY);
  assert.equal(sent.length, 1);

  G.grantTg(7001, 30, { by: 9001, at: ends - 2 * DAY });
  const newEnds = ends - 2 * DAY + 30 * DAY;
  await G.runReminderPass(send, newEnds - 2 * DAY);
  assert.equal(sent.length, 2, 'the new expiry was never announced');
  assert.notEqual(sent[0].text, sent[1].text);
});

test('a DM that throws is recorded as sent so it is not retried every pass', async () => {
  reset();
  G.grantTg(7001, 30, { by: 9001, at: T0 });
  const ends = T0 + 30 * DAY;
  let calls = 0;
  const failing = async () => { calls++; throw new Error('bot was blocked by the user'); };
  assert.deepEqual(await G.runReminderPass(failing, ends - 2 * DAY), { sent: 0, failed: 1 });
  await G.runReminderPass(failing, ends - DAY);
  assert.equal(calls, 1, 'a blocked user was retried');
  // And the grant is untouched: not being reachable is not losing access.
  assert.ok(G.activeTgGrant(7001, ends - DAY));
});

test('ungranting clears the reminder record with the grant', () => {
  reset();
  G.grantTg(7001, 30, { by: 9001, at: T0 });
  const ends = T0 + 30 * DAY;
  G.markReminded(7001, ends, T0);
  G.ungrantTg(7001);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM premium_tg_reminders WHERE user_id = ?').get(7001).n, 0);
});

// --------------------------------------------------------------- the words

test('the DMs say what they say, with no em dash and no exclamation', () => {
  const at = T0 + 30 * DAY;
  assert.match(G.grantDmText(at), /^vitals premium active until \d{4}-\d{2}-\d{2} UTC\. no token needed\.$/);
  assert.match(G.endingDmText(at), /hold 1M \$VITALS to keep it, or ask sirius\./);
  for (const s of [G.grantDmText(at), G.endingDmText(at)]) {
    assert.ok(!s.includes(String.fromCharCode(0x2014)), 'em dash');
    assert.doesNotMatch(s, /!/);
    assert.doesNotMatch(s, /\bclean\b|\bsafe\b|\bguarantee/i);
  }
});

test('the audit line carries the admin, the target and both dates', () => {
  const line = G.auditLine('extend', {
    admin: 9001, target: 7001, oldExpiry: T0, newExpiry: T0 + 30 * DAY, note: 'floor kol',
  });
  assert.match(line, /^\[premium\] extend admin=9001 target=7001 /);
  assert.match(line, new RegExp(`old=${G.dayStamp(T0)} \\(${T0}\\)`));
  assert.match(line, new RegExp(`new=${G.dayStamp(T0 + 30 * DAY)} \\(${T0 + 30 * DAY}\\)`));
  assert.match(line, /note="floor kol"/);
  // A first grant has no old date, and says so rather than printing a zero.
  assert.match(
    G.auditLine('grant', { admin: 9001, target: 7001, oldExpiry: null, newExpiry: T0 }),
    /old=none/,
  );
});
