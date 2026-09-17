/**
 * Launch day, the room side, with no chain.
 *
 * Two chats registered at 0 and 7 seconds, the way BLOCK ZERO and THE FLOOR
 * will be. Everything here is a fixture: no node, no factory, no sends. What
 * it checks is the part that cannot be rehearsed twice on the day, which is
 * that each room gets the CA exactly once and that a refusal in one of them
 * does not turn into silence in the other or a second post in the first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('launch-dryrun');
const { db } = await import('../dist/db.js');
const R = await import('../dist/ready.js');
const D = await import('../dist/launchday.js');
const W = await import('../dist/launchwatch.js');

const BLOCK_ZERO = -100501;
const THE_FLOOR = -100502;
const DEPLOYER = '0x447c8dc55b88c09830e123f9fb3e7c484714ed93';
const TOKEN = '0xae3020888aed39556469c8a8026672d781ff5f84';
const LAUNCH_MS = Date.parse('2026-09-24T14:00:00Z');
const T0 = Math.floor(LAUNCH_MS / 1000);

/** An api that records, and refuses whatever it is told to refuse. */
function room({ refuse = new Set() } = {}) {
  const calls = [];
  let id = 900;
  return {
    calls,
    sends: () => calls.filter((c) => c.method === 'send'),
    pins: () => calls.filter((c) => c.method === 'pin'),
    sentTo: (chat) => calls.filter((c) => c.method === 'send' && c.chat === chat),
    api: {
      async sendMessage(chat, text) {
        if (refuse.has(chat)) {
          calls.push({ method: 'refused', chat });
          throw new Error('Too Many Requests: retry after 5');
        }
        const message_id = ++id;
        calls.push({ method: 'send', chat, text, message_id });
        return { message_id, chat: { id: chat }, text };
      },
      async pinChatMessage(chat, message_id) {
        calls.push({ method: 'pin', chat, message_id });
        return true;
      },
      async unpinChatMessage(chat, message_id) {
        calls.push({ method: 'unpin', chat, message_id });
        return true;
      },
      async getChatMemberCount() { return 50; },
    },
  };
}

const armRooms = () => {
  db.prepare('DELETE FROM ready_settings').run();
  db.prepare('DELETE FROM launches').run();
  db.prepare('DELETE FROM launch_watchers').run();
  R.setSetting('launch_at', String(T0));
  R.setSetting('launch_deployer', DEPLOYER);
  R.setSetting('launch_name', '$VITALS');
  W.addWatcher(BLOCK_ZERO, 0, 1);
  W.addWatcher(THE_FLOOR, 7, 1);
};

// --------------------------------------------------------------- the stagger

test('each room gets one CA message and one pin, on its own clock', async () => {
  armRooms();
  const r = room();

  // T+0: the room running the launch.
  assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', T0), 1);
  assert.deepEqual(r.sends().map((c) => c.chat), [BLOCK_ZERO]);
  assert.deepEqual(r.pins().map((c) => c.chat), [BLOCK_ZERO]);

  // The floor is not skipped and is not early.
  for (const t of [T0 + 1, T0 + 3, T0 + 6]) {
    assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', t), 0, `posted at +${t - T0}`);
  }
  assert.equal(r.sends().length, 1);

  // T+7: the floor.
  assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 7), 1);
  assert.deepEqual(r.sends().map((c) => c.chat), [BLOCK_ZERO, THE_FLOOR]);

  // One message and one pin each, and two distinct messages.
  for (const chat of [BLOCK_ZERO, THE_FLOOR]) {
    assert.equal(r.sentTo(chat).length, 1, `${chat} got ${r.sentTo(chat).length} messages`);
    assert.equal(r.pins().filter((c) => c.chat === chat).length, 1, `${chat} pin count`);
  }
  assert.equal(new Set(r.pins().map((c) => c.message_id)).size, 2, 'one message each, not one shared');

  // And every message names the CA and says it is the only one.
  for (const c of r.sends()) {
    assert.ok(c.text.includes(TOKEN), c.chat);
    assert.match(c.text, /this is the only CA/);
  }
});

test('later ticks change nothing once both rooms have it', async () => {
  armRooms();
  const r = room();
  await D.deliverCa(r.api, TOKEN, '$VITALS', T0);
  await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 7);
  const before = r.calls.length;
  for (const t of [T0 + 8, T0 + 20, T0 + 300, T0 + 3600]) {
    assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', t), 0);
  }
  assert.equal(r.calls.length, before, 'a later tick touched the rooms');
});

// ------------------------------------------------------------- the refusal

test('a 429 in the first room does not stop the second', async () => {
  armRooms();
  // Both due at once, so the refusal and the send are in the same pass.
  W.addWatcher(THE_FLOOR, 0, 1);
  const r = room({ refuse: new Set([BLOCK_ZERO]) });

  assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', T0), 1, 'the second room got it');
  assert.deepEqual(r.sends().map((c) => c.chat), [THE_FLOOR]);
  assert.equal(r.calls.filter((c) => c.method === 'refused').length, 1);
  // The room that refused is still owed it.
  assert.deepEqual(W.dueWatchers(TOKEN, T0, T0 + 30).map((w) => w.chatId), [BLOCK_ZERO]);
});

test('the refused room gets it on the retry, and exactly once', async () => {
  armRooms();
  W.addWatcher(THE_FLOOR, 0, 1);
  const refusing = room({ refuse: new Set([BLOCK_ZERO]) });
  await D.deliverCa(refusing.api, TOKEN, '$VITALS', T0);

  // The next tick, with the room answering again.
  const r = room();
  assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 20), 1);
  assert.deepEqual(r.sends().map((c) => c.chat), [BLOCK_ZERO]);
  assert.deepEqual(r.pins().map((c) => c.chat), [BLOCK_ZERO]);

  // And not again after that: the retry is not a second announcement.
  assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 40), 0);
  assert.equal(r.sentTo(BLOCK_ZERO).length, 1);
  assert.equal(r.sentTo(THE_FLOOR).length, 0, 'the room that already had it was left alone');
});

test('a room that already has the CA is never posted to twice by a refusal elsewhere', async () => {
  armRooms();
  const r1 = room();
  await D.deliverCa(r1.api, TOKEN, '$VITALS', T0);
  assert.equal(r1.sentTo(BLOCK_ZERO).length, 1);

  // The floor refuses at +7, over and over.
  const r2 = room({ refuse: new Set([THE_FLOOR]) });
  for (const t of [T0 + 7, T0 + 27, T0 + 47]) await D.deliverCa(r2.api, TOKEN, '$VITALS', t);
  assert.equal(r2.sentTo(BLOCK_ZERO).length, 0, 'the room that had it was posted to again');
  assert.equal(r2.calls.filter((c) => c.method === 'refused').length, 3);
});

// ------------------------------------------------------------- the restart

test('a restart mid-stagger still delivers the pending room, once', async () => {
  armRooms();
  const before = room();
  await D.deliverCa(before.api, TOKEN, '$VITALS', T0);
  assert.deepEqual(before.sends().map((c) => c.chat), [BLOCK_ZERO]);

  // The process goes away here. Nothing in memory survives; the timer that was
  // holding the floor's post is gone with it. What is left is the database.
  const after = room();
  assert.equal(await D.deliverCa(after.api, TOKEN, '$VITALS', T0 + 9), 1,
    'the pending room was lost with the timer');
  assert.deepEqual(after.sends().map((c) => c.chat), [THE_FLOOR]);
  assert.deepEqual(after.pins().map((c) => c.chat), [THE_FLOOR]);

  // Once, not once per tick after the restart.
  for (const t of [T0 + 10, T0 + 30]) {
    assert.equal(await D.deliverCa(after.api, TOKEN, '$VITALS', t), 0);
  }
  assert.equal(after.sentTo(THE_FLOOR).length, 1);
});

test('a restart before anything went out keeps the stagger, it does not collapse it', async () => {
  armRooms();
  // Nothing was posted at all, and the process comes back at +30. The clock
  // runs from the first post that lands, so the room gets it now and the floor
  // seven seconds after that. The stagger is relative on purpose: if the first
  // post was held up, the second still follows it rather than arriving with it.
  const r = room();
  assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 30), 1);
  assert.deepEqual(r.sends().map((c) => c.chat), [BLOCK_ZERO]);

  assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 36), 0, 'the floor was early');
  assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 37), 1);
  assert.deepEqual(r.sends().map((c) => c.chat), [BLOCK_ZERO, THE_FLOOR]);
  assert.equal(r.pins().length, 2);
});

test('the detection clock survives the restart, so the stagger is not restarted', async () => {
  armRooms();
  const r = room();
  await D.deliverCa(r.api, TOKEN, '$VITALS', T0);
  const detected = Number(R.getSetting('launch_detected_at'));
  assert.equal(detected, T0, 'the clock is the first post that landed');

  // A later pass does not move it, which is what would push the floor back.
  await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 5);
  assert.equal(Number(R.getSetting('launch_detected_at')), detected);
  assert.equal(await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 7), 1, 'the floor was due at +7, not +12');
});

// --------------------------------------------------------- nothing else moves

test('no room is posted to that did not ask, and no wallet reaches any of them', async () => {
  armRooms();
  const r = room();
  await D.deliverCa(r.api, TOKEN, '$VITALS', T0);
  await D.deliverCa(r.api, TOKEN, '$VITALS', T0 + 7);
  const chats = new Set(r.calls.map((c) => c.chat));
  assert.deepEqual([...chats].sort(), [BLOCK_ZERO, THE_FLOOR].sort());
  for (const c of r.sends()) {
    // The CA is an address and belongs here. A 40-hex wallet that is not it
    // does not, and neither does an exclamation or an em dash.
    const others = (c.text.match(/0x[0-9a-fA-F]{40}/g) ?? []).filter((a) => a.toLowerCase() !== TOKEN);
    assert.deepEqual(others, [], c.text);
    assert.doesNotMatch(c.text, /!/);
    assert.ok(!c.text.includes(String.fromCharCode(0x2014)));
  }
});
