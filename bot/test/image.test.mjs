/**
 * The card as an image, v2.
 *
 * The old renderer mirrored the text card line for line, and the test that
 * guarded it existed because the image had three times silently dropped a
 * feature: a renderer that forgets something still produces a perfectly good
 * smaller picture, and nothing fails. v2 is a different layout, so the guard is
 * different, but it guards the same thing. Every piece of content comes from
 * one of the exported selectors, and anything that does not fit is COUNTED on
 * the card rather than dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('image');
const { resetSponsor } = await import('../dist/sponsor.js');
const {
  cardSvg, renderCardPng, drawable, heroOf, secondariesOf, measuresOf, marketOf, SIZES,
  SANS_FILE, SANS_BOLD_FILE,
} = await import('../dist/image.js');
const { measure } = await import('../dist/fontmetrics.js');
const { makeScan } = await import('./fixtures.mjs');

const AT = new Date(Date.UTC(2026, 7, 28, 14, 32));
const f = (key, plain, severity, state = 'raised') =>
  ({ key, label: key, state, detail: `${key} technical`, compactDetail: key, plain, severity });

const svg = (r, size) => cardSvg(r, AT, size);
const png = (r, size) => renderCardPng(r, AT, size);

/** Every <text> element as { x, size, anchor, body }. */
function texts(s) {
  return [...s.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const attr = (n) => (new RegExp(`${n}="([^"]*)"`).exec(m[1]) ?? [])[1];
    return {
      x: Number(attr('x')),
      size: Number(attr('font-size')),
      weight: Number(attr('font-weight') ?? 400),
      anchor: attr('text-anchor') ?? 'start',
      family: attr('font-family'),
      fill: attr('fill'),
      body: m[2].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'),
    };
  });
}

const RICH = () => makeScan({
  flags: [
    f('tax', 'creator takes 8% per trade, index median 1%', 3),
    f('exempt', '5 wallets tax-free at launch, together 22.3% of supply', 2),
    f('deployer', 'deployer launched 4 tokens in 7d', 2),
    f('conc', 'top 5 hold 61%, largest 34%', 2),
    f('pair', 'priced in RDDT, not ETH', 1),
    f('walk', 'holder transfers could not be read', 1, 'unknown'),
  ],
  concentration: { top5Share: 61, top1Share: 34, holders: 412, excess: 0.4 },
});

// ------------------------------------------------------------------- shape

test('both sizes render at the dimensions the spec names', () => {
  resetSponsor();
  const r = RICH();
  const p = png(r);
  assert.equal(p.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
  assert.equal(p.readUInt32BE(16), 1080);
  assert.equal(p.readUInt32BE(20), 1350);

  const w = png(r, 'wide');
  assert.equal(w.readUInt32BE(16), 1200);
  assert.equal(w.readUInt32BE(20), 675);
});

test('the header names the chain, and the footer names the bot and the site', () => {
  resetSponsor();
  const bodies = texts(svg(RICH())).map((t) => t.body);
  assert.ok(bodies.includes('PONS V2, ROBINHOOD CHAIN'));
  assert.ok(bodies.includes('@vitalscheck_bot, paste any CA'));
  assert.ok(bodies.includes('checkvitals.xyz'));
  assert.ok(bodies.some((b) => /launches indexed/.test(b)));
  assert.ok(bodies.some((b) => /2026-08-28 14:32 UTC/.test(b)));
});

// -------------------------------------------------------------- the hero

test('the hero is the worst finding whenever anything is flagged', () => {
  const r = RICH();
  const hero = heroOf(r);
  assert.equal(hero.headline, 'creator takes 8% per trade, index median 1%');
  assert.equal(hero.marked, 'finding');
  // And it is the largest type on the card.
  const t = texts(svg(r));
  const biggest = Math.max(...t.map((x) => x.size));
  const heroLine = t.find((x) => x.body.startsWith('creator takes'));
  assert.equal(heroLine.size, biggest, 'the worst finding is what a reader sees first');
});

test('with nothing flagged the hero is a traction number beside its reference', () => {
  const r = makeScan({ flags: [], benchmarkMedian: 12, buyers: 41 });
  const hero = heroOf(r);
  assert.match(hero.headline, /^41 buyers/);
  assert.ok(hero.reference, 'a buyer count alone says nothing about whether a launch is early or over');
  assert.match(hero.reference, /index median 12/);
  assert.equal(hero.marked, 'none');
});

test('with no window at all the hero says so rather than inventing a number', () => {
  const r = makeScan({ flags: [], windowIndexed: false });
  const hero = heroOf(r);
  assert.match(hero.headline, /not measured yet/);
  assert.equal(hero.marked, 'undetermined');
});

// --------------------------------------------------- nothing dropped silently

test('findings that do not fit are counted on the card, not dropped', () => {
  const r = RICH();
  const { shown, more } = secondariesOf(r, 3);
  assert.equal(shown.length, 3);
  // six flags, one is the hero, three are shown, two remain
  assert.equal(more, 2);
  const bodies = texts(svg(r)).map((t) => t.body);
  assert.ok(bodies.includes('+2 more on /full'),
    'a renderer that forgets a finding still produces a perfectly good smaller picture');
});

test('every drawn body line comes from a selector, not from a second implementation', () => {
  const r = RICH();
  const allowed = new Set([
    heroOf(r).headline, heroOf(r).reference,
    ...secondariesOf(r).shown.map((s) => s.label),
    ...measuresOf(r).flatMap((m) => [m.label, m.value, m.reference]),
    ...marketOf(r).flatMap((c) => [c.label, c.value]),
  ].filter(Boolean));
  // Chrome the card owns, as opposed to content about this token.
  const chrome = /^(PONS V2, ROBINHOOD CHAIN|DECLARED|@vitalscheck_bot, paste any CA|checkvitals\.xyz|GHATS|0x147B…9E67|\+\d+ more on \/full|.*launches indexed|.*UTC|\d+[smhd].*|30m.*)$/;
  for (const t of texts(svg(r))) {
    if (chrome.test(t.body)) continue;
    // Long lines are wrapped, so a drawn line is a fragment of an allowed one.
    const ok = [...allowed].some((a) => a.includes(t.body));
    assert.ok(ok, `"${t.body}" appears on the card but comes from no selector`);
  }
});

// ------------------------------------------------------------------ markers

test('markers are drawn shapes, never characters', () => {
  const r = makeScan({ flags: [
    f('tax', 'creator takes 8% per trade', 3),
    f('walk', 'holder transfers could not be read', 1, 'unknown'),
  ] });
  const s = svg(r);
  // A red flag per finding, a hollow circle per undetermined.
  assert.ok(/<path d="M [\d.]+ [\d.]+ L/.test(s), 'the flag is a path');
  assert.ok(/<circle [^>]*fill="none"/.test(s), 'undetermined is a hollow circle');
  for (const t of texts(s)) {
    assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}◌]/u.test(t.body),
      `a marker leaked into text: ${JSON.stringify(t.body)}`);
  }
});

test('red marks findings and green marks reference points, and nothing else', () => {
  const r = makeScan({ flags: [], benchmarkMedian: 12, buyers: 41 });
  const s = svg(r);
  // No findings here, so no red anywhere.
  assert.ok(!/#FF5A47/i.test(s), 'red is a finding and this card has none');
  const green = texts(s).filter((t) => (t.fill ?? '').toUpperCase() === '#C6F73A');
  assert.ok(green.length > 0);
  for (const t of green) {
    assert.match(t.body, /median|reference|no index median/,
      `green is for reference points only, not ${JSON.stringify(t.body)}`);
  }
});

// -------------------------------------------------------------------- layout

test('no drawn line runs past the edge of the card', () => {
  resetSponsor();
  for (const size of ['portrait', 'wide']) {
    const { w: W, pad: PAD } = SIZES[size];
    for (const t of texts(svg(RICH(), size))) {
      const file = t.weight >= 600 ? SANS_BOLD_FILE : SANS_FILE;
      const width = measure(t.body, t.size, file);
      const right = t.anchor === 'end' ? t.x : t.x + width;
      assert.ok(right <= W - PAD + 2,
        `${size}: "${t.body.slice(0, 40)}" ends at ${right.toFixed(0)}, past ${W - PAD}`);
      assert.ok(t.x >= PAD - 1, `${size}: "${t.body.slice(0, 30)}" starts left of the margin`);
    }
  }
});

test('the hero shrinks to fit rather than overflowing', () => {
  const long = 'a finding with a great many words in it that will not fit on one line at any size at all whatsoever';
  const r = makeScan({ flags: [f('x', long, 3)] });
  const heroLines = texts(svg(r)).filter((t) => t.weight === 700 && t.body !== 'GHATS');
  assert.ok(heroLines.length <= 3, 'the hero is at most three lines');
  const { w: W, pad: PAD } = SIZES.portrait;
  for (const t of heroLines) {
    assert.ok(t.x + measure(t.body, t.size, SANS_BOLD_FILE) <= W - PAD + 2);
  }
});

// -------------------------------------------------------------------- fonts

test('text is proportional and only the address is mono', () => {
  const t = texts(svg(RICH()));
  const mono = t.filter((x) => x.family === 'IBM Plex Mono');
  assert.equal(mono.length, 1, 'mono is for the shortened address and nothing else');
  assert.match(mono[0].body, /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/);
  assert.ok(t.filter((x) => x.family === 'Inter').length > 5);
});

test('the two families actually render differently', () => {
  // The whole family set used to collapse to one face: four subsets sharing a
  // family name fought for it, resvg picked one, and every string on the card
  // rendered in whichever family happened to win. This catches that.
  const w = (s, file) => measure(s, 40, file);
  const { MONO_FILE } = SIZES.portrait ? { MONO_FILE: 'assets/fonts/ibm-plex-mono-latin-400-normal.ttf' } : {};
  assert.notEqual(Math.round(w('mmmiii', SANS_FILE)), Math.round(w('mmmiii', MONO_FILE)),
    'a proportional face and a monospace one cannot measure the same');
  assert.equal(Math.round(w('iiiiii', MONO_FILE)), Math.round(w('mmmmmm', MONO_FILE)),
    'mono advances are uniform');
  assert.notEqual(Math.round(w('iiiiii', SANS_FILE)), Math.round(w('mmmmmm', SANS_FILE)),
    'Inter advances are not');
});

test('anything the font cannot draw is dropped rather than drawn as tofu', () => {
  assert.equal(drawable('GHATS'), 'GHATS');
  assert.equal(drawable('ГХАТС'), '', 'Cyrillic is not in the shipped subset');
  assert.equal(drawable('a\u{1F6A9}b'), 'ab', 'no emoji reaches the SVG');
  assert.equal(drawable('  spaced   out '), 'spaced out');
});

// ------------------------------------------------------------------ declared

test('the declared badge appears only when a declaration exists', async () => {
  const { db } = await import('../dist/db.js');
  const r = RICH();
  db.prepare('DELETE FROM declarations').run();
  assert.ok(!texts(svg(r)).some((t) => t.body === 'DECLARED'));

  db.prepare('INSERT INTO declarations (token, declared_by, declared_at) VALUES (?,?,?)')
    .run(r.reads.token.toLowerCase(), 7, 1_789_000_000);
  assert.ok(texts(svg(r)).some((t) => t.body === 'DECLARED'),
    'the badge says a claim exists, and nothing more');
  db.prepare('DELETE FROM declarations').run();
});

// ------------------------------------------------------------------ sponsor

test('the sponsor line sits above the footer and never overlaps it', async () => {
  // No address: one in a sponsor line has to be a real launch, which needs a
  // chain read this test has no business making.
  process.env.SPONSOR_LINE = 'ad, a sponsor line that points at a scan';
  resetSponsor();
  const s = svg(RICH());
  const rows = [...s.matchAll(/<text [^>]*y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ y: Number(m[1]), body: m[2] }));
  const foot = rows.find((r) => r.body === '@vitalscheck_bot, paste any CA');
  const ad = rows.find((r) => /sponsor line/.test(r.body));
  assert.ok(ad, 'the sponsor line is drawn');
  assert.ok(ad.y < foot.y - 20, 'and it is clear of the footer');
  delete process.env.SPONSOR_LINE;
  resetSponsor();
});

test('no em dash reaches the card', () => {
  resetSponsor();
  for (const size of ['portrait', 'wide']) {
    const s = svg(RICH(), size);
    assert.ok(!s.includes(String.fromCharCode(0x2014)), `${size} carries an em dash`);
  }
});

test('nothing is drawn on top of anything else, at either size', () => {
  resetSponsor();
  for (const size of ['portrait', 'wide']) {
    const { h: H, pad: PAD } = SIZES[size];
    const rows = [...svg(RICH(), size).matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => {
      const attr = (n) => (new RegExp(`${n}="([^"]*)"`).exec(m[1]) ?? [])[1];
      return {
        y: Number(attr('y')),
        x: Number(attr('x')),
        size: Number(attr('font-size')),
        anchor: attr('text-anchor') ?? 'start',
        body: m[2],
      };
    });
    for (const r of rows) {
      assert.ok(r.y <= H - PAD + 22, `${size}: "${r.body.slice(0, 30)}" sits below the card`);
    }
    // Two lines on different baselines must not have overlapping ink, unless
    // they are side by side.
    const sorted = [...rows].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const above = sorted[i - 1];
      const below = sorted[i];
      if (below.y - above.y > above.size * 0.9) continue;
      if (Math.abs(below.y - above.y) < 0.01) continue;  // same row, different column
      const aRight = above.anchor === 'end' ? above.x : above.x + measure(above.body, above.size, SANS_FILE);
      const bLeft = below.anchor === 'end' ? below.x - measure(below.body, below.size, SANS_FILE) : below.x;
      const sideBySide = bLeft >= aRight - 1 || aRight <= bLeft;
      assert.ok(sideBySide,
        `${size}: "${below.body.slice(0, 28)}" at y=${below.y} collides with "${above.body.slice(0, 28)}" at y=${above.y}`);
    }
  }
});

test('a card that had to drop something always says so', () => {
  resetSponsor();
  for (const size of ['portrait', 'wide']) {
    const bodies = texts(svg(RICH(), size)).map((t) => t.body);
    const shown = secondariesOf(RICH(), size === 'wide' ? 2 : 3).shown.length;
    const note = bodies.find((b) => /^\+\d+ more on \/full$/.test(b));
    assert.ok(note, `${size}: findings were dropped with nothing said`);
    // Everything the card knows, minus the hero and what it drew.
    const total = RICH().flags.flags.length - 1 + measuresOf(RICH()).length;
    const drawnMeasures = bodies.includes('buyers') ? measuresOf(RICH()).length : 0;
    assert.equal(Number(note.slice(1).split(' ')[0]), total - shown - drawnMeasures,
      `${size}: the count must match what was actually left out`);
  }
});
