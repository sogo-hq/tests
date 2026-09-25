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
const { renderDefaultCard, renderCard, renderCardText, cardLines } = await import('../dist/card.js');
const { cardSvg, SIZES } = await import('../dist/image.js');
const { makeScan } = await import('../dist/../test/fixtures.mjs');

const LINE = '$VITALS, the first declared launch on pons: 24 Sep · t.me/vitals_official';
const LIVE = '$VITALS is live: 0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67';

/**
 * The expiry, and an instant on each side of it.
 *
 * Every render below is given one of these two instants. Nothing here reads the
 * real clock, which is how this file went red on its own the morning after the
 * date in UNTIL: the notice expired, the renderers asked Date.now(), and four
 * tests that had nothing to do with today started failing every day. A suite
 * that is permanently red is a suite nobody reads, and the day that matters is
 * the day "green" has to mean something.
 *
 * Both sides are pinned on purpose. A test that only checks the line is there
 * before the date passes cannot tell a working expiry from an expiry that never
 * fires, and that is the half of this feature nobody would notice was broken.
 */
const UNTIL = '2026-09-24';
const BEFORE = Date.parse('2026-09-24T23:59:59Z');
const AFTER = Date.parse('2026-09-25T00:00:01Z');
const AT = new Date(BEFORE);
const AT_AFTER = new Date(AFTER);

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
  assert.equal(N.launchNotice(BEFORE), null);
  assert.ok(!renderDefaultCard(SCAN(), 'vitalscheck_bot', BEFORE).includes('$VITALS'));
  assert.ok(!cardSvg(SCAN(), AT).includes('t.me/vitals_official'));
});

test('the line is the last line of both text cards, and gone the day after', () => {
  configure(LINE, UNTIL);
  resetSponsor();
  for (const [name, text] of [
    ['default', renderDefaultCard(SCAN(), 'vitalscheck_bot', BEFORE)],
    ['full', renderCardText(SCAN(), BEFORE)],
  ]) {
    const lines = text.split('\n').filter((l) => l.trim());
    assert.equal(lines[lines.length - 1], LINE, `${name} card does not end with it`);
    assert.equal(lines.filter((l) => l === LINE).length, 1, `${name} card says it twice`);
  }
  // The other side of the same boundary, through the same renderers.
  for (const [name, text] of [
    ['default', renderDefaultCard(SCAN(), 'vitalscheck_bot', AFTER)],
    ['full', renderCardText(SCAN(), AFTER)],
  ]) {
    assert.ok(!text.includes(LINE), `${name} card carried an expired notice`);
    const lines = text.split('\n').filter((l) => l.trim());
    // The two cards word the disclaimer differently, so this asserts that the
    // footer is still the last line rather than which footer it is.
    assert.match(lines[lines.length - 1], /not financial advice/i,
      `${name} card lost its footer when the notice went`);
  }
});

test('it is below the paid line, never above it', () => {
  configure(LINE, UNTIL);
  process.env.SPONSOR_LINE = 'ad, a sponsor line that points at a scan';
  resetSponsor();
  const lines = renderDefaultCard(SCAN(), 'vitalscheck_bot', BEFORE).split('\n');
  const ad = lines.findIndex((l) => l.startsWith('ad, a sponsor'));
  const notice = lines.indexOf(LINE);
  assert.ok(ad >= 0 && notice >= 0, 'both lines should be on the card');
  assert.ok(notice > ad, 'the notice sat above the line somebody paid for');
  delete process.env.SPONSOR_LINE;
  resetSponsor();
});

test('it is never in the findings block, at either size', () => {
  configure(LINE, UNTIL);
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
  configure(LINE, UNTIL);
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
  configure(LINE, UNTIL);
  // The whole of the named day, not the instant it begins.
  assert.equal(N.launchNotice(Date.parse('2026-09-24T00:00:01Z')), LINE);
  assert.equal(N.launchNotice(BEFORE), LINE);
  assert.equal(N.launchNotice(AFTER), null);

  // And the same boundary on every surface that draws the line, each given the
  // instant to render at rather than asking the clock for it.
  resetSponsor();
  assert.ok(renderDefaultCard(SCAN(), 'vitalscheck_bot', BEFORE).includes(LINE));
  assert.ok(renderCardText(SCAN(), BEFORE).includes(LINE));
  assert.ok(cardSvg(SCAN(), AT).includes('t.me/vitals_official'));

  assert.ok(!renderDefaultCard(SCAN(), 'vitalscheck_bot', AFTER).includes(LINE),
    'an expired notice is still on the default card');
  assert.ok(!renderCardText(SCAN(), AFTER).includes(LINE),
    'an expired notice is still on the full card');
  assert.ok(!cardSvg(SCAN(), AT_AFTER).includes('t.me/vitals_official'),
    'an expired notice is still on the picture');
});

test('the picture uses the instant it was given, not the clock', () => {
  // cardSvg already took a renderedAt and then asked Date.now() for this one
  // line, so a picture's own timestamp and its notice could disagree about what
  // day it was. Two renders, same process, same second, different answers.
  configure(LINE, UNTIL);
  resetSponsor();
  assert.ok(cardSvg(SCAN(), AT).includes('t.me/vitals_official'));
  assert.ok(!cardSvg(SCAN(), AT_AFTER).includes('t.me/vitals_official'));
});

test('no render path reads the wall clock for the notice', () => {
  // The whole point. Whatever today is, the line is there before the date and
  // gone after it, on every surface.
  configure(LINE, UNTIL);
  resetSponsor();
  const surfaces = [
    ['default', (now) => renderDefaultCard(SCAN(), 'vitalscheck_bot', now)],
    ['full', (now) => renderCardText(SCAN(), now)],
    ['lines', (now) => cardLines(SCAN(), 'vitalscheck_bot', now).map((l) => l.text).join('\n')],
    ['svg', (now) => cardSvg(SCAN(), new Date(now))],
  ];
  for (const [name, render] of surfaces) {
    const on = render(BEFORE);
    const off = render(AFTER);
    const needle = name === 'svg' ? 't.me/vitals_official' : LINE;
    assert.ok(on.includes(needle), `${name}: missing before the date`);
    assert.ok(!off.includes(needle), `${name}: still there after the date`);
  }
});

test('no expiry set means it stays until it is unset', () => {
  configure(LINE, null);
  assert.equal(N.launchNotice(Date.parse('2030-01-01T00:00:00Z')), LINE);
});

test('a date that will not parse takes the line down, loudly', () => {
  // Read as "no expiry", a typo would leave a stale notice on every card for
  // as long as the bot ran, and nothing in a healthy log would say so.
  configure(LINE, 'next tuesday-ish');
  assert.equal(N.launchNotice(BEFORE), null);
});

test('the same env carries the line after the launch', () => {
  configure(LIVE, null);
  assert.equal(N.launchNotice(BEFORE), LIVE);
  const lines = renderDefaultCard(SCAN(), 'vitalscheck_bot', BEFORE).split('\n').filter((l) => l.trim());
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
    assert.equal(N.launchNotice(BEFORE), null, `rendered "${bad.slice(0, 40)}"`);
  }
});

test('a changed line invalidates the cards rendered under the old one', () => {
  configure(LINE, null);
  const before = N.noticeVersion();
  N.launchNotice(BEFORE);
  configure(LIVE, null);
  N.launchNotice(BEFORE);
  assert.notEqual(N.noticeVersion(), before);

  // Expiry counts as a change too, and nothing happens when a date passes:
  // without this every cached card keeps an expired notice until its own TTL.
  configure(LINE, UNTIL);
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
    assert.ok(renderDefaultCard(SCAN(), 'vitalscheck_bot', BEFORE).endsWith(LINE));
  }
  configure(null);
});

test('no renderer asks the clock for the notice, so no test of one can go stale', async () => {
  // The structural version of everything above. A renderer that reaches for
  // Date.now() puts the date back into the test, and the test goes red on its
  // own the morning after. Sweeping the source is the only way to keep that
  // from coming back one call site at a time.
  //
  // bot.ts is deliberately not in this list: withLaunchNotice appends the line
  // to a live /start or /legend, which has no render time and for which the
  // clock IS the right answer.
  const { readFileSync } = await import('node:fs');
  const offenders = [];
  for (const file of ['src/card.ts', 'src/image.ts', 'src/groupcard.ts']) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/\blaunchNotice\(\s*\)/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `a renderer reads the wall clock for the launch notice:\n${offenders.join('\n')}`);
});

// ------------------------------------------------- what the boot log says

/**
 * Capture what the module logs, because the log IS the feature here.
 *
 * An unset notice used to return null in silence. From outside the process that
 * is indistinguishable from a working one: no line on any card, nothing in the
 * log, and LAUNCH_NOTICE_UNTIL sitting on the dashboard making it look
 * configured. Asserting the state without asserting the line would leave the
 * silence exactly where it was.
 */
function capturing(fn) {
  const said = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a) => said.push(a.join(' '));
  console.warn = (...a) => said.push(a.join(' '));
  try {
    return { value: fn(), said };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

test('an unset line says so once, and names the date that is doing nothing', () => {
  // The failure exactly as it happened: UNTIL set on Railway, the line not.
  configure(null, '2026-09-28');
  const { value, said } = capturing(() => N.announceLaunchNotice(BEFORE));
  assert.equal(value, 'off');
  const off = said.filter((l) => l.includes('[notice] OFF'));
  assert.equal(off.length, 1, `said ${off.length} times:\n${said.join('\n')}`);
  assert.match(off[0], /LAUNCH_NOTICE is not set, so no card carries a launch notice/);
  assert.match(off[0], /LAUNCH_NOTICE_UNTIL is "2026-09-28", which does nothing by itself/);
  assert.ok(!off[0].includes(String.fromCharCode(0x2014)));
});

test('neither set says neither, rather than naming a date that is not there', () => {
  configure(null, null);
  const { value, said } = capturing(() => N.announceLaunchNotice(BEFORE));
  assert.equal(value, 'off');
  assert.match(said.join('\n'), /LAUNCH_NOTICE_UNTIL is not set either/);
});

test('the off line is said once per configuration, not once per card', () => {
  // launchNotice is on the scan path. A plain console call here would put a
  // line in the log for every card the bot renders.
  configure(null, '2026-09-28');
  const { said } = capturing(() => {
    for (let i = 0; i < 50; i++) N.launchNotice(BEFORE);
  });
  assert.equal(said.filter((l) => l.includes('[notice] OFF')).length, 1,
    `50 renders produced ${said.length} lines`);
});

test('a configuration change is announced again, not swallowed by the first', () => {
  configure(null, '2026-09-28');
  capturing(() => N.announceLaunchNotice(BEFORE));
  // Same process, a different half configured.
  configure(null, null);
  const { said } = capturing(() => N.announceLaunchNotice(BEFORE));
  assert.equal(said.filter((l) => l.includes('[notice] OFF')).length, 1,
    'a changed configuration was not re-announced');
});

test('a line whose date has already passed is accepted and says it renders nowhere', () => {
  // The second silence. "accepted, until 2026-09-24" in a boot log above a bot
  // that shows no notice reads as working.
  configure(LINE, UNTIL);
  const { value, said } = capturing(() => N.announceLaunchNotice(AFTER));
  assert.equal(value, 'expired');
  const expired = said.filter((l) => l.includes('[notice] EXPIRED'));
  assert.equal(expired.length, 1, said.join('\n'));
  assert.match(expired[0], /has already passed, so no card carries it/);
  assert.match(expired[0], /move the date or unset the line/);
  // And it really does render nowhere, which is what the line claims.
  assert.equal(N.launchNotice(AFTER), null);
});

test('a live line reports on, with the date it stops', () => {
  configure(LINE, UNTIL);
  const { value, said } = capturing(() => N.announceLaunchNotice(BEFORE));
  assert.equal(value, 'on');
  assert.match(said.join('\n'), new RegExp(`\\[notice\\] ON, until ${UNTIL}`));
  assert.match(said.join('\n'), /the first declared launch on pons/);
});

test('a line with no expiry reports on, and says there is no expiry', () => {
  configure(LINE, null);
  const { value, said } = capturing(() => N.announceLaunchNotice(BEFORE));
  assert.equal(value, 'on');
  assert.match(said.join('\n'), /\[notice\] ON, with no expiry set/);
});

test('a rejected line reports rejected, and the reason is already loud', () => {
  configure('buy $VITALS now', null);
  const { value, said } = capturing(() => N.announceLaunchNotice(BEFORE));
  assert.equal(value, 'rejected');
  assert.match(said.join('\n'), /\[notice\] REJECTED/);
  assert.equal(N.launchNotice(BEFORE), null);
});

test('every state the notice can be in says something', () => {
  // The whole point: there is no configuration of these two variables that
  // produces no card line and no log line.
  const cases = [
    [null, null, 'off'],
    [null, '2026-09-28', 'off'],
    [LINE, UNTIL, 'on'],
    [LINE, null, 'on'],
    ['buy $VITALS now', null, 'rejected'],
    [LINE, '2020-01-01', 'expired'],
    [LINE, 'next tuesday-ish', 'rejected'],
  ];
  for (const [line, until, want] of cases) {
    configure(line, until);
    const { value, said } = capturing(() => N.announceLaunchNotice(BEFORE));
    assert.equal(value, want, `${JSON.stringify([line, until])} reported ${value}`);
    assert.ok(said.some((l) => l.startsWith('[notice]')),
      `${JSON.stringify([line, until])} said nothing at all`);
  }
  configure(null, null);
});
