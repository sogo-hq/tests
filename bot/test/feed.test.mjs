/**
 * The holder feed.
 *
 * DM only: feed_subs has no chat id, so a group delivery is not a rule somebody
 * has to remember, it is a column that does not exist.
 *
 * The load case is the real test. Fifty launches a minute against two hundred
 * subscribers is 10,000 DMs a minute, and Telegram's ceiling is around 30 a
 * second. Nothing can deliver that, so the question is not whether everyone
 * gets everything, it is whether anything is lost WITHOUT being counted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('feed');
const { db } = await import('../dist/db.js');
const F = await import('../dist/feed.js');

const A = (n) => '0x' + String(n).padStart(40, '0');
const NATIVE = '0x' + '0'.repeat(40);
const STOCK = '0x' + 'e'.repeat(40);

let seq = 0;
const addLaunch = (over = {}) => {
  seq++;
  const token = A(seq);
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at, snipe_exemption_count)
     VALUES (?,?,?,?,0,'0',?,?,?,?)`,
  ).run(token, A(9000 + seq), A(8000), over.pair ?? NATIVE, 60_000_000 + seq,
        '0x' + String(seq).padStart(64, 'f'), 1_789_000_000 + seq, over.exempt ?? null);
  return token;
};

function stubApi(over = {}) {
  const sends = [];
  return {
    sends,
    api: {
      async sendMessage(chat_id, text) {
        if (over.failFor?.has(chat_id)) throw new Error('bot was blocked by the user');
        sends.push({ chat_id, text });
        return { message_id: sends.length, chat: { id: chat_id }, text };
      },
    },
  };
}

const reset = () => {
  db.prepare('DELETE FROM feed_subs').run();
  db.prepare('DELETE FROM launches').run();
  db.prepare('DELETE FROM trades').run();
  F.resetFeedPacing();
  seq = 0;
};

const premium = async () => 'premium';
const render = async (token) => `VITALS  ${token.slice(0, 8)}`;

// ------------------------------------------------------------------- filters

test('filters parse the way the pack writes them', () => {
  const r = F.parseFilters('exempt>0 min_buyers=5 pair=eth mute 22:00-07:00');
  assert.equal(r.ok, true);
  assert.deepEqual(r.filters, { exempt: true, minBuyers: 5, pair: 'eth', mute: [22, 7] });
  assert.equal(F.describeFilters(r.filters), 'exempt>0 min_buyers=5 pair=eth mute 22:00-07:00');
  assert.deepEqual(F.parseFilters('').filters, {});
  assert.deepEqual(F.parseFilters('clear').filters, {});
});

test('an unrecognised clause is refused, never ignored', () => {
  const r = F.parseFilters('exempt>0 whatever=7');
  assert.equal(r.ok, false, 'a filter silently dropped shows the whole feed to somebody who narrowed it');
  assert.match(r.reason, /could not read "whatever=7"/);
});

test('exempt>0 needs a measured count, not an absent one', () => {
  const row = (exempt) => ({ rowid: 1, token: A(1), pair_token: NATIVE, snipe_exemption_count: exempt, buyers: null });
  assert.equal(F.matches(row(3), { exempt: true }), true);
  assert.equal(F.matches(row(0), { exempt: true }), false);
  assert.equal(F.matches(row(null), { exempt: true }), false,
    'an undecoded creation transaction is not evidence of an exemption');
});

test('min_buyers fails an unknown buyer count, which is every fresh launch', () => {
  const row = (buyers) => ({ rowid: 1, token: A(1), pair_token: NATIVE, snipe_exemption_count: 1, buyers });
  assert.equal(F.matches(row(9), { minBuyers: 5 }), true);
  assert.equal(F.matches(row(2), { minBuyers: 5 }), false);
  assert.equal(F.matches(row(null), { minBuyers: 5 }), false, '"unknown" is not "at least five"');
});

test('pair filters on what the stored column can actually answer', () => {
  const row = (pair) => ({ rowid: 1, token: A(1), pair_token: pair, snipe_exemption_count: 1, buyers: null });
  assert.equal(F.matches(row(NATIVE), { pair: 'eth' }), true);
  assert.equal(F.matches(row(STOCK), { pair: 'eth' }), false);
  assert.equal(F.matches(row(STOCK), { pair: 'stock' }), true);
  assert.equal(F.matches(row(NATIVE), { pair: 'stock' }), false);
  assert.equal(F.matches(row(STOCK), { pair: STOCK }), true);
  // This chain has no stablecoin pair, so a named one matches nothing rather
  // than erroring.
  assert.equal(F.matches(row(NATIVE), { pair: 'usdg' }), false);
  assert.equal(F.matches(row(STOCK), { pair: 'usdg' }), false);
});

test('the mute window wraps midnight', () => {
  const at = (h) => Date.parse(`2026-07-01T${String((h + 22) % 24).padStart(2, '0')}:00:00Z`);
  // 22:00-07:00 local. Bratislava is UTC+2 in July, so 20:00Z is 22:00 local.
  const f = { mute: [22, 7] };
  assert.equal(F.muted(f, Date.parse('2026-07-01T20:30:00Z')), true, '22:30 local');
  assert.equal(F.muted(f, Date.parse('2026-07-01T02:00:00Z')), true, '04:00 local');
  assert.equal(F.muted(f, Date.parse('2026-07-01T10:00:00Z')), false, '12:00 local');
  assert.equal(F.muted({}, Date.now()), false);
});

// ------------------------------------------------------------------ delivery

test('a new subscriber starts at the head, not at the beginning of the index', async () => {
  reset();
  for (let i = 0; i < 5; i++) addLaunch();
  F.subscribe(1);
  assert.equal(F.behindCount(F.subOf(1)), 0, 'they were not watching, they did not miss anything');
  addLaunch();
  assert.equal(F.behindCount(F.subOf(1)), 1);
});

test('a launch is delivered as the quick card, one per subscriber per tick', async () => {
  reset();
  F.subscribe(1);
  F.subscribe(2);
  addLaunch();
  addLaunch();
  const s = stubApi();
  const t0 = Date.now();
  const r = await F.feedTick(s.api, { now: t0, render, tier: premium });
  assert.equal(r.sent, 2, 'both subscribers, one launch each');
  assert.deepEqual(s.sends.map((x) => x.chat_id).sort(), [1, 2]);
  assert.match(s.sends[0].text, /^VITALS  0x/);
});

test('a subscriber gets at most one DM per three seconds', async () => {
  reset();
  F.subscribe(1);
  for (let i = 0; i < 5; i++) addLaunch();
  const s = stubApi();
  const t0 = Date.now();
  await F.feedTick(s.api, { now: t0, render, tier: premium });
  assert.equal(s.sends.length, 1);
  await F.feedTick(s.api, { now: t0 + 1000, render, tier: premium });
  assert.equal(s.sends.length, 1, 'one second later, still one');
  await F.feedTick(s.api, { now: t0 + 3100, render, tier: premium });
  assert.equal(s.sends.length, 2);
});

test('a paused or muted subscriber gets nothing, and misses nothing', async () => {
  reset();
  F.subscribe(1);
  F.setPaused(1, true);
  addLaunch();
  const s = stubApi();
  await F.feedTick(s.api, { now: Date.now(), render, tier: premium });
  assert.equal(s.sends.length, 0);
  assert.equal(F.behindCount(F.subOf(1)), 1, 'the backlog is still theirs when they resume');
});

test('filtered-out launches advance the cursor rather than counting as missed', async () => {
  reset();
  F.subscribe(1);
  F.setFilters(1, { exempt: true });
  addLaunch({ exempt: 0 });
  addLaunch({ exempt: 0 });
  const wanted = addLaunch({ exempt: 2 });
  const s = stubApi();
  await F.feedTick(s.api, { now: Date.now(), render, tier: premium });
  assert.equal(s.sends.length, 1);
  assert.match(s.sends[0].text, new RegExp(wanted.slice(0, 8)));
  assert.equal(F.behindCount(F.subOf(1)), 0, 'the two it skipped are not a backlog');
});

test('a subscriber below premium is not delivered to', async () => {
  reset();
  F.subscribe(1);
  addLaunch();
  const s = stubApi();
  await F.feedTick(s.api, { now: Date.now(), render, tier: async () => 'watch' });
  assert.equal(s.sends.length, 0);
});

test('past twenty behind the backlog is banked and summarised in one line', async () => {
  reset();
  F.subscribe(1);
  for (let i = 0; i < 34; i++) addLaunch();
  const s = stubApi();
  const r = await F.feedTick(s.api, { now: Date.now(), render, tier: premium });
  assert.equal(r.summarised, 1);
  assert.equal(s.sends.length, 1);
  assert.equal(s.sends[0].text, 'missed 34 launches while you were away. /stats');
  assert.equal(F.behindCount(F.subOf(1)), 0, 'and they are caught up, not owed 34 cards');
});

test('a delivery that failed is retried, not silently dropped', async () => {
  reset();
  F.subscribe(1);
  const token = addLaunch();
  const s = stubApi({ failFor: new Set([1]) });
  await F.feedTick(s.api, { now: Date.now(), render, tier: premium });
  assert.equal(F.behindCount(F.subOf(1)), 1, 'the cursor did not advance past a message that never arrived');
});

test('a scan that did not finish sends nothing and keeps the launch due', async () => {
  reset();
  F.subscribe(1);
  addLaunch();
  const s = stubApi();
  await F.feedTick(s.api, { now: Date.now(), render: async () => null, tier: premium });
  assert.equal(s.sends.length, 0, 'a scan that did not finish says nothing about the chain');
  assert.equal(F.behindCount(F.subOf(1)), 1);
});

// ---------------------------------------------------------------- under load

test('50 launches a minute to 200 subscribers: nothing lost, nothing unaccounted', async () => {
  reset();
  const SUBS = 200;
  for (let u = 1; u <= SUBS; u++) F.subscribe(u);
  const s = stubApi();
  const t0 = Date.parse('2026-07-01T10:00:00Z'); // outside any mute window

  // Ten minutes of chain at fifty launches a minute, ticking every three
  // seconds as the loop does.
  let launches = 0;
  let ticks = 0;
  const perTick = [];
  for (let ms = 0; ms < 10 * 60_000; ms += F.FEED_TICK_MS) {
    // 50/min at a 3s tick is 2.5 launches per tick.
    const due = Math.round(((ms / 60_000) * 50) - launches);
    for (let i = 0; i < due; i++) addLaunch();
    launches += due;
    const before = s.sends.length;
    const r = await F.feedTick(s.api, { now: t0 + ms, render, tier: premium });
    perTick.push(s.sends.length - before);
    ticks++;
  }

  // Telegram's ceiling, respected: never more than the bucket allows in the
  // three seconds a tick represents.
  const cap = F.FEED_GLOBAL_PER_SEC * (F.FEED_TICK_MS / 1000);
  const worst = Math.max(...perTick);
  assert.ok(worst <= cap + 1, `a tick sent ${worst}, over the ${cap} the global bucket allows`);

  // Nothing is lost without being counted: every launch is either delivered or
  // inside somebody's summary.
  // Nobody is starved. Before the queue rotated, every subscriber past the
  // bucket's capacity went the whole ten minutes without a single message.
  const served = new Set(s.sends.map((x) => x.chat_id));
  assert.equal(served.size, SUBS, `only ${served.size} of ${SUBS} subscribers heard anything`);

  // And nobody is left silently behind: at this rate no one can keep up, so
  // everybody is repeatedly caught up by a summary rather than owed cards.
  const worstBehind = Math.max(...Array.from({ length: SUBS }, (_, i) => F.behindCount(F.subOf(i + 1))));
  assert.ok(worstBehind <= F.FEED_BEHIND_MAX * 3,
    `somebody is ${worstBehind} behind, which is a backlog nobody told them about`);
  const summaries = s.sends.filter((x) => x.text.startsWith('missed ')).length;
  assert.ok(summaries > 0, 'at this rate every subscriber falls behind and must be told so');
});

test('the per-user gap holds under load, so no subscriber is flooded', async () => {
  reset();
  for (let u = 1; u <= 50; u++) F.subscribe(u);
  for (let i = 0; i < 5; i++) addLaunch();
  const s = stubApi();
  const t0 = Date.parse('2026-07-01T10:00:00Z');
  const at = new Map();
  for (let ms = 0; ms < 30_000; ms += 1000) {
    const before = s.sends.length;
    await F.feedTick(s.api, { now: t0 + ms, render, tier: premium });
    for (const send of s.sends.slice(before)) {
      const prev = at.get(send.chat_id);
      if (prev !== undefined) {
        assert.ok(ms - prev >= F.PER_USER_GAP_MS,
          `subscriber ${send.chat_id} got two DMs ${ms - prev}ms apart`);
      }
      at.set(send.chat_id, ms);
    }
  }
});
