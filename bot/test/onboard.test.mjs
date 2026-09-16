import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('onboard');
const O = await import('../dist/onboard.js');
const A = await import('../dist/autoscan.js');
const G = await import('../dist/grants.js');
const { db } = await import('../dist/db.js');

const GROUP = -1001234;
const LICENSED = -1005678;

const reset = () => {
  db.prepare('DELETE FROM group_settings').run();
  db.prepare('DELETE FROM access_grants').run();
  db.prepare('DELETE FROM licences').run();
};

// ------------------------------------------------------------ when it posts

test('it introduces itself when it is made an admin, once', () => {
  reset();
  assert.equal(O.shouldOnboard(GROUP, 'left', 'administrator'), true);
  O.markOnboarded(GROUP);
  assert.equal(O.shouldOnboard(GROUP, 'left', 'administrator'), false, 'a second promotion is not a second introduction');
});

test('it says nothing when it is added as a plain member', () => {
  reset();
  assert.equal(O.shouldOnboard(GROUP, 'left', 'member'), false);
  assert.equal(O.shouldOnboard(GROUP, 'member', 'restricted'), false);
  assert.equal(O.shouldOnboard(GROUP, 'administrator', 'member'), false);
});

test('a demotion and a re-promotion is not a second introduction', () => {
  reset();
  O.markOnboarded(GROUP);
  assert.equal(O.shouldOnboard(GROUP, 'member', 'administrator'), false);
});

test('an admin that was already an admin is not re-introduced', () => {
  reset();
  assert.equal(O.shouldOnboard(GROUP, 'administrator', 'administrator'), false);
});

// --------------------------------------------------------------- what it says

test('three lines, and the third is the one that matters', () => {
  reset();
  const lines = O.onboardingText(GROUP).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /reads pons v2 launches on Robinhood Chain/);
  assert.match(lines[2], /No finding is not the same as clean/);
  assert.match(lines[2], /undetermined/);
});

test('it does not promise a card it will not post', () => {
  reset();
  // Autoscan off here, so it says how to turn it on rather than promising.
  const off = O.onboardingText(GROUP);
  assert.match(off, /Autoscan is off here/);
  assert.match(off, /\/autoscan on/);
  assert.doesNotMatch(off, /^Every CA posted here gets the card\.$/m);

  A.setAutoscan(GROUP, true);
  const on = O.onboardingText(GROUP);
  assert.match(on, /Every CA posted here gets the card\./);
  assert.equal(on.split('\n').length, 3);
});

test('no verdict wording, no exclamation, no em dash', () => {
  reset();
  for (const chat of [GROUP, LICENSED]) {
    const text = O.onboardingText(chat);
    assert.doesNotMatch(text, /!/);
    assert.doesNotMatch(text, /\bsafe\b|\bgood\b|\bscore\b|\brisk\b/i);
    assert.ok(!text.includes(String.fromCharCode(0x2014)));
  }
});

// -------------------------------------------------- autoscan and the licence

test('autoscan is off by default in a group nobody licensed', () => {
  reset();
  assert.equal(A.autoscanEnabled(GROUP), false);
  assert.deepEqual(A.autoscanSetting(GROUP), { on: false, setAt: null, byDefault: false });
});

test('a licensed group has it on without anybody setting it', () => {
  reset();
  G.grantAccess('chat', String(LICENSED), 30, 9001);
  assert.equal(A.autoscanEnabled(LICENSED), true);
  assert.equal(A.autoscanSetting(LICENSED).byDefault, true);
  assert.equal(A.autoscanSetting(LICENSED).setAt, null);
});

test('a bought licence does the same', () => {
  reset();
  db.prepare('INSERT INTO licences (chat_id, user_id, granted_at) VALUES (?,?,?)').run(LICENSED, 77, 0);
  assert.equal(A.autoscanEnabled(LICENSED), true);
});

test('an admin who turned it off keeps it off, licence or not', () => {
  reset();
  G.grantAccess('chat', String(LICENSED), 30, 9001);
  A.setAutoscan(LICENSED, false, 9001);
  assert.equal(A.autoscanEnabled(LICENSED), false, 'a licence must not undo an admin decision');
  assert.equal(A.autoscanSetting(LICENSED).byDefault, false);
});

test('an admin who turned it on keeps it on when the licence lapses', () => {
  reset();
  G.grantAccess('chat', String(LICENSED), 1, 9001);
  A.setAutoscan(LICENSED, true, 9001);
  db.prepare('UPDATE access_grants SET expires_at = ? WHERE kind = ?').run(1, 'chat');
  assert.equal(A.autoscanEnabled(LICENSED), true);
});

test('a lapsed licence with nothing set turns the default back off', () => {
  reset();
  G.grantAccess('chat', String(LICENSED), 1, 9001);
  assert.equal(A.autoscanEnabled(LICENSED), true);
  db.prepare('UPDATE access_grants SET expires_at = ? WHERE kind = ?').run(1, 'chat');
  assert.equal(A.autoscanEnabled(LICENSED), false);
});

// ----------------------------------------------------------------- the doc

test('the group doc explains the install and claims no partner', async () => {
  const { readFileSync } = await import('node:fs');
  const t = readFileSync('docs/partners-groups.md', 'utf8');
  assert.match(t, /Add \[@vitalscheck_bot\]/);
  assert.match(t, /\/autoscan on/);
  assert.match(t, /off by default in every group/);
  assert.match(t, /not\*{0,2} a clean bill/);
  assert.doesNotMatch(t, /backed by|partnered with|in partnership with|official partner/i);
  assert.ok(!t.includes(String.fromCharCode(0x2014)));
});
