/**
 * Answering an address in a group, and the consent that has to come first.
 *
 * The rule these tests exist to hold: the bot never scans an address in a group
 * that has not asked it to. A scanner that answers everything in every group it
 * sits in is an unsolicited poster, and the default has to be off in a way that
 * cannot drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('autoscan');
const A = await import('../dist/autoscan.js');
const F = await import('../dist/firstcall.js');
const { db } = await import('../dist/db.js');

const CHAT = -1001;
const TOKEN = '0xd384722f6adfe7d79e8e6623896df199afd31b76';
const OTHER = '0x5a05ff9c0d10e89701bae5b35d64adf99903073b';
const NOW = 1_789_000_000_000;

// ----------------------------------------------------------------- the gate

test('a group that has never been asked is off, and stays off', () => {
  assert.equal(A.autoscanEnabled(CHAT), false, 'a fresh group must not be scanned');
  assert.equal(A.autoscanEnabled(-999), false);
  // No row at all is the same as off: nothing has to be written for a group
  // the bot was just added to for it to be silent.
  const rows = db.prepare('SELECT COUNT(*) AS n FROM group_settings').get();
  assert.equal(rows.n, 0);
});

test('it is per chat, and it persists', () => {
  A.setAutoscan(CHAT, true, 7);
  assert.equal(A.autoscanEnabled(CHAT), true);
  assert.equal(A.autoscanEnabled(-1002), false, 'one group turning it on is not every group');

  A.setAutoscan(CHAT, false, 7);
  assert.equal(A.autoscanEnabled(CHAT), false);
  assert.equal(A.autoscanSetting(CHAT).on, false);
  assert.ok(A.autoscanSetting(CHAT).setAt, 'a decision is dated so /help can report it');
  A.setAutoscan(CHAT, true, 7);
});

// ---------------------------------------------------------- what it reads

test('an address is found wherever it is in the message', () => {
  const cases = {
    'plain text': { text: `look at ${TOKEN}` },
    'a caption under a chart': { caption: `${TOKEN} chart` },
    'a link with words over it': {
      text: 'BUY HERE',
      entities: [{ type: 'text_link', offset: 0, length: 8, url: `https://x.example/${TOKEN}` }],
    },
    'an explorer link': { text: `https://explorer.example/address/${TOKEN}` },
    'a poll option': { poll: { question: 'which', options: [{ text: TOKEN }] } },
    'the message replied to': { text: 'this one', reply_to_message: { text: TOKEN } },
    'a quoted fragment': { text: 'this', quote: { text: `ca ${TOKEN}` } },
  };
  for (const [name, msg] of Object.entries(cases)) {
    assert.deepEqual(A.addressesIn(msg), [TOKEN], `missed an address in ${name}`);
  }
  assert.deepEqual(A.addressesIn({ text: 'no address here' }), []);
  assert.deepEqual(A.addressesIn({}), []);
});

test('the same address twice in one message is one address', () => {
  assert.deepEqual(A.addressesIn({ text: `${TOKEN} and again ${TOKEN.toUpperCase()}` }), [TOKEN]);
});

// --------------------------------------------------------------- the dedupe

test('one card per address per group per window', () => {
  A.resetAutoReplies(CHAT);
  assert.equal(A.claimAutoReply(CHAT, TOKEN, NOW), 'card');
  assert.equal(A.claimAutoReply(CHAT, TOKEN, NOW + 1000), 'repeat');
  assert.equal(A.claimAutoReply(CHAT, TOKEN, NOW + A.AUTOSCAN_DEDUPE_MS - 1000), 'repeat');
  // Past the window it is a card again.
  assert.equal(A.claimAutoReply(CHAT, TOKEN, NOW + A.AUTOSCAN_DEDUPE_MS + 1000), 'card');

  // A different address in the same group is its own claim.
  assert.equal(A.claimAutoReply(CHAT, OTHER, NOW), 'card');
  // And the same address in a different group is too: the window is per group.
  assert.equal(A.claimAutoReply(-1003, TOKEN, NOW), 'card');
});

test('case does not open a second window', () => {
  A.resetAutoReplies(CHAT);
  assert.equal(A.claimAutoReply(CHAT, TOKEN, NOW), 'card');
  assert.equal(A.claimAutoReply(CHAT, TOKEN.toUpperCase(), NOW + 1000), 'repeat');
});

test('an address answered once is remembered forever, for the pinned CA', () => {
  A.resetAutoReplies(CHAT);
  assert.equal(A.everAnswered(CHAT, TOKEN), false);
  A.claimAutoReply(CHAT, TOKEN, NOW);
  assert.equal(A.everAnswered(CHAT, TOKEN), true);
  // Still true long past the dedupe window: a launch room's pinned address is
  // answered once, not once every ten minutes for a week.
  assert.equal(A.everAnswered(CHAT, TOKEN), true);
  assert.equal(A.everAnswered(-1004, TOKEN), false);
});

// ----------------------------------------------------------- the first call

test('the first caller is recorded once and never overwritten', () => {
  const first = F.recordFirstCall({
    chatId: CHAT, token: TOKEN, userId: 11, username: 'alice',
    mcapQuote: 1.5, blockNumber: 500, now: NOW,
  });
  assert.equal(first.userId, 11);
  assert.equal(first.mcapQuote, 1.5);

  const second = F.recordFirstCall({
    chatId: CHAT, token: TOKEN, userId: 22, username: 'bob',
    mcapQuote: 9.5, blockNumber: 900, now: NOW + 60_000,
  });
  assert.equal(second.userId, 11, 'the second poster took the record');
  assert.equal(second.username, 'alice');
  assert.equal(F.firstCallOf(CHAT, TOKEN).userId, 11);

  // Per group: the same token called in another group is another record.
  const elsewhere = F.recordFirstCall({
    chatId: -1009, token: TOKEN, userId: 22, username: 'bob',
    mcapQuote: 2.5, blockNumber: 900, now: NOW,
  });
  assert.equal(elsewhere.userId, 22);
});

test('no record for a token nobody has called here', () => {
  assert.equal(F.firstCallOf(CHAT, OTHER), null);
});
