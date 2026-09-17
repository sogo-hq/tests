/**
 * The one line on a card about VITALS itself.
 *
 * Everything here is about keeping it in its place. It is the line most likely
 * to turn a card that states facts into a card that sells something, so it is
 * last, it is dim, it expires on its own, and it is checked by the same rules
 * as the paid line. A test that only checked it renders would have missed every
 * one of those.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('launchnotice');
const N = await import('../dist/launchnotice.js');
const { resetSponsor } = await import('../dist/sponsor.js');
const { renderDefaultCard, renderCard, renderCardText } = await import('../dist/card.js');
const { cardSvg, SIZES } = await import('../dist/image.js');
const { makeScan } = await import('../dist/../test/fixtures.mjs');

const LINE = '$VITALS, the first declared launch on pons: 24 Sep · t.me/vitals_official';
const LIVE = '$VITALS is live: 0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67';
const AT = new Date(Date.UTC(2026, 8, 11, 14, 32));

function configure(line, until) {
  if (line === null) delete process.env.LAUNCH_NOTICE;
  else process.env.LAUNCH_NOTICE = line;
  if (until === undefined || until === null) delete process.env.LAUNCH_NOTICE_UNTIL;
  else process.env.LAUNCH_NOTICE_UNTIL = until;
  N.resetLaunchNotice();
}

const f = (key, plain, severity, state = 'raised') =>
  ({ key, label: key, state, detail: `${key} technical`, compactDetail: key, plain, severity });

const SCAN = () => makeScan({
  flags: [
    f('exempt', '5 wallets tax-free at launch, 1 of them the deployer, together 22.3% of supply', 922),
    f('tax', 'creator takes 8% per trade · index median 1% (n=1,837)', 728),
    f('walk', 'holder transfers could not be read', 130, 'unknown'),
  ],
  concentration: { top5Share: 61, top1Share: 34, holders: 412, excess: 0.4 },
});

test('unset means no line anywhere, and no complaint about it', () => {
  configure(null);
  assert.equal(N.launchNotice(), null);
  assert.ok(!renderDefaultCard(SCAN(), 'vitalscheck_bot').includes('$VITALS'));
  assert.ok(!cardSvg(SCAN(), AT).includes('t.me/vitals_official'));
});

test('the line is the last line of both text cards', () => {
  configure(LINE, '2026-09-24');
  resetSponsor();
  for (const [name, text] of [
    ['default', renderDefaultCard(SCAN(), 'vitalscheck_bot')],
    ['full', renderCardText(SCAN())],
  ]) {
    const lines = text.split('\n').filter((l) => l.trim());
    assert.equal(lines[lines.length - 1], LINE, `${name} card does not end with it`);
    assert.equal(lines.filter((l) => l === LINE).length, 1, `${name} card says it twice`);
  }
});

test('it is below the paid line, never above it', () => {
  configure(LINE, '2026-09-24');
  process.env.SPONSOR_LINE = 'ad, a sponsor line that points at a scan';
  resetSponsor();
  const lines = renderDefaultCard(SCAN(), 'vitalscheck_bot').split('\n');
  const ad = lines.findIndex((l) => l.startsWith('ad, a sponsor'));
  const notice = lines.indexOf(LINE);
  assert.ok(ad >= 0 && notice >= 0, 'both lines should be on the card');
  assert.ok(notice > ad, 'the notice sat above the line somebody paid for');
  delete process.env.SPONSOR_LINE;
  resetSponsor();
});

test('it is never in the findings block, at either size', () => {
  configure(LINE, '2026-09-24');
  resetSponsor();
  // The findings block is everything from the hero down to the market strip.
  // The notice belongs under the footer rule, which is the LAST full-width
  // hairline on the card.
  for (const size of ['portrait', 'wide']) {
    const svg = cardSvg(SCAN(), AT, size);
    const H = Number(/<svg[^>]*height="(\d+)"/.exec(svg)[1]);
    const rules = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="\d+" height="1"/g)]
      .map((m) => Number(m[1])).sort((a, b) => a - b);
    const footerRule = rules[rules.length - 1];
    const rows = [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => ({
      y: Number(/y="([\d.]+)"/.exec(m[1])[1]),
      fill: (/fill="([^"]*)"/.exec(m[1]) ?? [])[1],
      body: m[2],
    }));
    const line = rows.find((r) => r.body.includes('t.me/vitals_official'));
    assert.ok(line, `${size}: the notice was not drawn`);
    assert.ok(line.y > footerRule,
      `${size}: the notice at y=${line.y} is above the footer rule at ${footerRule}`);
    assert.ok(line.y <= H - 6, `${size}: the notice at y=${line.y} falls off a card ${H} tall`);
    // And it is the very last thing drawn.
    const below = rows.filter((r) => r.y > line.y);
    assert.deepEqual(below, [], `${size}: something is drawn under the notice`);
  }
});

test('it never uses the reference-point colour', () => {
  configure(LINE, '2026-09-24');
  resetSponsor();
  // Green on a card means one thing: the reference point a finding was measured
  // against. A notice about our own launch is not one, and the day it is drawn
  // in that green it starts reading as a measurement.
  const REF = '#C6F73A';
  for (const size of ['portrait', 'wide']) {
    const svg = cardSvg(SCAN(), AT, size);
    const line = [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)]
      .find((m) => m[2].includes('t.me/vitals_official'));
    assert.ok(line, `${size}: the notice was not drawn`);
    const fill = (/fill="([^"]*)"/.exec(line[1]) ?? [])[1];
    assert.notEqual(fill, REF, `${size}: the notice is in the reference-point green`);
    assert.equal(fill, '#6E7A66', `${size}: the notice should be dim, got ${fill}`);
  }
});

test('the date ends it, with nothing deployed', () => {
  configure(LINE, '2026-09-24');
  // The whole of the named day, not the instant it begins.
  assert.equal(N.launchNotice(Date.parse('2026-09-24T00:00:01Z')), LINE);
  assert.equal(N.launchNotice(Date.parse('2026-09-24T23:59:59Z')), LINE);
  assert.equal(N.launchNotice(Date.parse('2026-09-25T00:00:01Z')), null);

  // And a date already past takes it off the cards, which read the real clock.
  configure(LINE, '2020-01-01');
  resetSponsor();
  const stale = renderDefaultCard(SCAN(), 'vitalscheck_bot');
  assert.ok(!stale.includes(LINE), 'an expired notice is still on the card');
  assert.ok(!renderCardText(SCAN()).includes(LINE));
  assert.ok(!cardSvg(SCAN(), AT).includes('t.me/vitals_official'));
});

test('no expiry set means it stays until it is unset', () => {
  configure(LINE, null);
  assert.equal(N.launchNotice(Date.parse('2030-01-01T00:00:00Z')), LINE);
});

test('a date that will not parse takes the line down, loudly', () => {
  // Read as "no expiry", a typo would leave a stale notice on every card for
  // as long as the bot ran, and nothing in a healthy log would say so.
  configure(LINE, 'next tuesday-ish');
  assert.equal(N.launchNotice(), null);
});

test('the same env carries the line after the launch', () => {
  configure(LIVE, null);
  assert.equal(N.launchNotice(), LIVE);
  const lines = renderDefaultCard(SCAN(), 'vitalscheck_bot').split('\n').filter((l) => l.trim());
  assert.equal(lines[lines.length - 1], LIVE);
});

test('our own line obeys the rules the paid line obeys', () => {
  // Not a theoretical guard. The line is written by whoever runs the bot, into
  // the same output that claims to make no call.
  for (const bad of [
    'buy $VITALS now',
    '$VITALS, up 40% since launch',
    '$VITALS at $0.004',
    `$VITALS ${'x'.repeat(140)}`,
    'line one\nline two',
  ]) {
    configure(bad, null);
    assert.equal(N.launchNotice(), null, `rendered "${bad.slice(0, 40)}"`);
  }
});

test('a changed line invalidates the cards rendered under the old one', () => {
  configure(LINE, null);
  const before = N.noticeVersion();
  N.launchNotice();
  configure(LIVE, null);
  N.launchNotice();
  assert.notEqual(N.noticeVersion(), before);

  // Expiry counts as a change too, and nothing happens when a date passes:
  // without this every cached card keeps an expired notice until its own TTL.
  configure(LINE, '2026-09-24');
  N.launchNotice(Date.parse('2026-09-24T12:00:00Z'));
  const live = N.noticeVersion();
  N.launchNotice(Date.parse('2026-09-25T12:00:00Z'));
  assert.notEqual(N.noticeVersion(), live, 'the expiry did not invalidate the cache');
});

test('once per user, and again only when the line changes', () => {
  configure(LINE, null);
  const user = 4242;
  N.resetLaunchNoticeSeen(user);
  assert.equal(N.claimLaunchNotice(user, LINE), true);
  assert.equal(N.claimLaunchNotice(user, LINE), false, 'said twice to the same user');
  // The line changes once, from a date to an address. A user who saw the first
  // must still see the second.
  assert.equal(N.claimLaunchNotice(user, LIVE), true);
  assert.equal(N.claimLaunchNotice(user, LIVE), false);
  // And one user's claim is not another's.
  assert.equal(N.claimLaunchNotice(4243, LIVE), true);
});

test('the card carries it on every card, independently of that claim', () => {
  // Two different rules. A group would otherwise see the line on one card and
  // not the next, which reads as a bug in the card rather than a policy.
  configure(LINE, null);
  const user = 4244;
  N.resetLaunchNoticeSeen(user);
  N.claimLaunchNotice(user, LINE);
  resetSponsor();
  for (let i = 0; i < 3; i++) {
    assert.ok(renderDefaultCard(SCAN(), 'vitalscheck_bot').endsWith(LINE));
  }
  configure(null);
});
