/**
 * Filters: the user picks the shape, the bot reports the match.
 *
 * Users asked for alerts on "alpha launches". Naming a launch alpha is a
 * verdict, and one that goes to zero is a screenshot of this bot making a call
 * it exists not to make. So the question is inverted -- these assert that the
 * inversion holds all the way to the message text, and that a subscription
 * cannot quietly become a feed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = process.env.DB_PATH || `/tmp/filters-${process.pid}.db`;
const { db } = await import('../dist/db.js');
const { matchingFilters, filterRates, rateLine, FILTERS, isFilterKey, MIN_RATE_SAMPLES } =
  await import('../dist/filters.js');
const {
  addFilterWatch, listFilterWatches, removeFilterWatch, filterMatchesFor, whyLine,
  countWatches, addWatch, alertsSentSince, claimCapNotice, claimDelivery, MAX_WATCHES,
} = await import('../dist/watch.js');

let block = 1_000_000;
function launch(over = {}) {
  const token = '0x' + (block++).toString(16).padStart(40, '0');
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at, buyback_enabled,
       snipe_exemption_count, phase)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    token, '0x' + 'c'.repeat(40), over.deployer ?? '0x' + 'd'.repeat(40),
    '0x' + 'e'.repeat(40), 1, '4200000000000000000', block,
    '0x' + 'f'.repeat(64), over.launchedAt ?? Math.floor(Date.now() / 1000),
    over.buyback ?? 0, over.exemptions ?? 3, 0,
  );
  return token;
}

test('a filter matches on a fact fixed at creation', () => {
  assert.deepEqual(matchingFilters(launch({ buyback: 1, exemptions: 3 })), ['buyback', 'clean-deployer']);
  assert.deepEqual(matchingFilters(launch({ buyback: 0, exemptions: 0, deployer: '0x' + '1'.repeat(40) })),
    ['no-exemptions', 'clean-deployer']);
});

test('a deployer with an earlier launch is not a clean deployer', () => {
  const dep = '0x' + '9'.repeat(40);
  launch({ deployer: dep });
  const second = launch({ deployer: dep });
  assert.ok(!matchingFilters(second).includes('clean-deployer'),
    'a deployer the index has seen before cannot be clean');
});

test('an undecoded creation is not a match', () => {
  // buyback_enabled NULL means the creation transaction has not been read. That
  // is not "no buyback" -- it is the unread-window mistake in another costume.
  const token = launch();
  db.prepare('UPDATE launches SET buyback_enabled = NULL, snipe_exemption_count = NULL WHERE token = ?').run(token);
  const m = matchingFilters(token);
  assert.ok(!m.includes('buyback'), 'an unread creation must not match buyback');
  assert.ok(!m.includes('no-exemptions'), 'an unread creation must not match no-exemptions');
});

test('the why line names the filter and says nothing else', () => {
  const line = whyLine({ userId: 1, dmChatId: 1, kind: 'filter', filter: 'buyback' }, '$TOKEN');
  assert.equal(line, 'matches your buyback filter');
  for (const banned of [/alpha/i, /opportunit/i, /worth a look/i, /gem/i, /good/i, /safe/i]) {
    assert.doesNotMatch(line, banned, `the why line must carry no verdict: "${line}"`);
  }
});

test('no rate is published from too thin an index', () => {
  const rates = filterRates();
  for (const r of rates) {
    if (r.n < MIN_RATE_SAMPLES) {
      assert.equal(r.perDay, null, 'a rate under the sample floor must not be published');
      assert.match(rateLine(r), /rate unknown/);
    }
  }
});

test('/filters reports a rate once the index can support one', () => {
  const now = Math.floor(Date.now() / 1000);
  // Two days of launches, all with the buyback set, so the rate is checkable.
  for (let i = 0; i < 40; i++) launch({ buyback: 1, launchedAt: now - 86_400 * 2 + i * 4_000 });
  const r = filterRates().find((x) => x.key === 'buyback');
  assert.ok(r.n >= MIN_RATE_SAMPLES, `only ${r.n} launches`);
  assert.ok(r.perDay > 0, 'a rate over real launches must be positive');
  assert.match(rateLine(r), /a day|a week/);
});

test('filters and address watches share one allowance', () => {
  const u = 5_001;
  assert.ok(addWatch(u, 'deployer', '0x' + '7'.repeat(40), 99).ok);
  assert.equal(countWatches(u), 1);
  assert.ok('filter' in addFilterWatch(u, 'buyback', 99));
  assert.equal(countWatches(u), 2, 'a filter counts toward the same 20');
  assert.deepEqual(listFilterWatches(u).map((f) => f.filter), ['buyback']);
  assert.equal(removeFilterWatch(u, 'buyback'), 1);
  assert.equal(countWatches(u), 1);
});

test('subscribing twice to one filter is refused, not duplicated', () => {
  const u = 5_002;
  assert.ok('filter' in addFilterWatch(u, 'no-exemptions', 99));
  const again = addFilterWatch(u, 'no-exemptions', 99);
  assert.ok('reason' in again && again.reason === 'duplicate');
});

test('two matching filters are one alert, not two', () => {
  const u = 5_003;
  addFilterWatch(u, 'buyback', 99);
  addFilterWatch(u, 'clean-deployer', 99);
  const matches = filterMatchesFor(['buyback', 'clean-deployer']).filter((m) => m.userId === u);
  assert.equal(matches.length, 1, 'one launch, one card, one alert');
});

test('the hourly cap counts what was actually delivered', () => {
  const u = 5_004;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5; i++) claimDelivery(u, '0x' + i.toString().padStart(40, '0'), now);
  assert.equal(alertsSentSince(u, now - 3600), 5);
  assert.equal(alertsSentSince(u, now + 10), 0, 'the window is what bounds it');
});

test('being over the cap costs one message, not one per suppressed alert', () => {
  const u = 5_005;
  const since = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(claimCapNotice(u, since), true, 'the first suppression tells them');
  assert.equal(claimCapNotice(u, since), false, 'a flood of "you are being flooded" is the same bug');
});

test('the noisy filter is marked so it can be warned about', () => {
  assert.ok(FILTERS.find((f) => f.key === 'no-exemptions').loud,
    'no-exemptions matches most launches and must warn on subscribe');
  assert.ok(!FILTERS.find((f) => f.key === 'buyback').loud);
  assert.ok(isFilterKey('buyback') && !isFilterKey('alpha'));
});

test('no filter describes itself as a merit', () => {
  for (const f of FILTERS) {
    for (const banned of [/alpha/i, /good/i, /safe/i, /opportunit/i, /quality/i, /best/i]) {
      assert.doesNotMatch(f.describe, banned, `"${f.describe}" reads as a judgement`);
    }
  }
});
