/**
 * The fake-CA guard.
 *
 * From /launch set until the real CA is pinned, an address in the group is
 * either the one the bot posted or something a reader should not paste into a
 * wallet. The policy is pure so every branch is decided without a Telegram
 * server; the transport half is asserted separately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = process.env.DB_PATH || `/tmp/vitals-fakeca-${process.pid}.db`;
const { db } = await import('../dist/db.js');
const R = await import('../dist/ready.js');
const D = await import('../dist/launchday.js');

const CA = '0xd384722f6adfe7d79E8e6623896DF199afD31B76';
const FAKE = '0x1111111111111111111111111111111111111111';
const on = (over = {}) => ({ pinnedCa: CA, isAdmin: false, priorOffences: 0, active: true, ...over });

const reset = () => { db.prepare('DELETE FROM ready_settings').run(); };

test('a wrong address is warned on the first offence and muted on the second', () => {
  assert.deepEqual(D.guardVerdict(`buy here ${FAKE}`, on()), { action: 'warn', addresses: [FAKE] });
  assert.deepEqual(D.guardVerdict(`buy here ${FAKE}`, on({ priorOffences: 1 })), { action: 'mute', addresses: [FAKE] });
  assert.equal(D.guardVerdict(`buy here ${FAKE}`, on({ priorOffences: 5 })).action, 'mute');
});

test('the real CA is left alone, whatever its casing', () => {
  for (const form of [CA, CA.toLowerCase(), CA.toUpperCase().replace('0X', '0x')]) {
    assert.equal(D.guardVerdict(`the CA is ${form}`, on()).action, 'ignore', form);
  }
});

test('a message with the real CA and a fake one is still caught', () => {
  const v = D.guardVerdict(`real ${CA} but also ${FAKE}`, on());
  assert.equal(v.action, 'warn');
  assert.deepEqual(v.addresses, [FAKE], 'only the wrong one is reported');
});

test('admins are exempt', () => {
  assert.equal(D.guardVerdict(`${FAKE}`, on({ isAdmin: true })).action, 'ignore');
});

test('outside the window nothing is touched', () => {
  assert.equal(D.guardVerdict(`${FAKE}`, on({ active: false })).action, 'ignore');
});

test('a message with no address is never touched', () => {
  for (const text of ['gm', 'when launch', '0x', '0xdeadbeef', 'the price is 0x1 lol']) {
    assert.equal(D.guardVerdict(text, on()).action, 'ignore', text);
  }
});

test('before any CA exists, every address is wrong', () => {
  const v = D.guardVerdict(`${CA}`, on({ pinnedCa: null }));
  assert.equal(v.action, 'warn', 'nothing is the CA until the bot has posted one');
});

test('several fakes in one message are all reported, and count as one offence', () => {
  const b = '0x2222222222222222222222222222222222222222';
  const v = D.guardVerdict(`${FAKE} or ${b}`, on());
  assert.deepEqual(v.addresses, [FAKE, b]);
  assert.equal(v.action, 'warn');
});

test('the window opens at /launch set and closes when the CA is known', () => {
  reset();
  const at = Date.parse('2026-09-22T14:00:00Z');
  assert.equal(D.guardActive(at - 86_400_000), false, 'no launch set, no guard');

  R.setSetting('launch_at', String(Math.floor(at / 1000)));
  assert.equal(D.guardActive(at - 86_400_000), true, 'from the moment a launch is set');
  assert.equal(D.guardActive(at + 3_600_000), true,
    'and it stays on past a late launch: that is when a fake is most believed');

  R.setSetting('launch_ca', CA);
  assert.equal(D.guardActive(at + 3_600_000), false, 'until the real CA is known');
  assert.equal(D.pinnedCa(), CA.toLowerCase());
});

test('offences are counted per user and persist', () => {
  reset();
  assert.equal(D.offencesOf(5001), 0);
  assert.equal(D.recordOffence(5001), 1);
  assert.equal(D.recordOffence(5001), 2);
  assert.equal(D.offencesOf(5001), 2);
  assert.equal(D.offencesOf(5002), 0, 'counted per user, not globally');
});

test('the warning tells the reader where the only CA will come from', () => {
  assert.match(D.GUARD_WARNING, /the only CA will be posted by this bot, pinned, 3 s after launch/);
  assert.match(D.GUARD_MUTED, /muted for 24 h/);
  assert.equal(D.MUTE_SECONDS, 86_400);
  // The deleted message is never quoted back, in the group or the DM.
  for (const text of [D.GUARD_WARNING, D.GUARD_MUTED]) {
    assert.ok(!/0x[0-9a-f]{40}/i.test(text), 'the warning must not repeat the address');
  }
});
