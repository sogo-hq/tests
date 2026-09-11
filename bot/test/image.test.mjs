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
const { db } = await import('../dist/db.js');

const AT = new Date(Date.UTC(2026, 7, 28, 14, 32));
const f = (key, plain, severity, state = 'raised') =>
  ({ key, label: key, state, detail: `${key} technical`, compactDetail: key, plain, severity });

const svg = (r, size) => cardSvg(r, AT, size);
/** The height the card actually chose, which is content-dependent. */
const svgHeight = (s) => Number(/<svg[^>]*height="(\d+)"/.exec(s)[1]);
const png = (r, size) => renderCardPng(r, AT, size);

/** Every <text> element as { x, size, anchor, body }. */
function texts(s) {
  return [...s.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const attr = (n) => (new RegExp(`${n}="([^"]*)"`).exec(m[1]) ?? [])[1];
    return {
      x: Number(attr('x')),
      y: Number(attr('y')),
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

test('both sizes render at the width the spec names, up to its height', () => {
  resetSponsor();
  const r = RICH();
  const p = png(r);
  assert.equal(p.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
  assert.equal(p.readUInt32BE(16), 1080);
  assert.ok(p.readUInt32BE(20) <= 1350, 'past the ceiling');
  assert.ok(p.readUInt32BE(20) >= SIZES.portrait.minH, 'below the floor');

  const w = png(r, 'wide');
  assert.equal(w.readUInt32BE(16), 1200);
  assert.ok(w.readUInt32BE(20) <= 675);
  assert.ok(w.readUInt32BE(20) >= SIZES.wide.minH);
});

test('a card with less to say is shorter, not padded', () => {
  // The band of empty space between the traction block and the market strip
  // grew with every check that came back undetermined: the more certain the
  // card, the emptier it looked.
  resetSponsor();
  // Enough findings and traction to fill the card, against a single finding and
  // nothing else known.
  const full = svgHeight(svg(makeScan({
    buyers: 412, buyTx: 980, sellTx: 410,
    flags: [
      f('a', 'a finding long enough that it wraps onto a second line of the card', 9),
      f('b', 'creator opened with 4.9% of supply, index median 0.5% (n=1,837)', 8),
      f('c', 'creator takes 8% per trade, index median 1% (n=1,837)', 7),
      f('d', 'top 5 hold 61% of supply, largest 34%, 412 holders', 6),
    ],
    concentration: { top5Share: 61, top1Share: 34, holders: 412, excess: 0.4 },
  })));
  const thin = svgHeight(svg(makeScan({
    flags: [f('tax', 'creator takes 8% per trade, index median 1%', 3)],
    concentration: null,
    windowIndexed: false,
  })));
  assert.ok(thin < full, `a one-finding card rendered ${thin}, a full one ${full}`);
  assert.ok(thin >= SIZES.portrait.minH, `${thin} is past the floor a phone will crop`);
  assert.ok(full > SIZES.portrait.minH, 'a full card should reach past the floor');
  assert.ok(full <= SIZES.portrait.h, 'and never past the ceiling');
});

test('the wide card shrinks too, and never past its own floor', () => {
  resetSponsor();
  const rich = svgHeight(svg(RICH(), 'wide'));
  const thin = svgHeight(svg(makeScan({ flags: [], concentration: null }), 'wide'));
  assert.ok(thin <= rich);
  assert.ok(thin >= SIZES.wide.minH && rich <= SIZES.wide.h);
});

test('the header names the chain, and the footer names the bot and the site', () => {
  resetSponsor();
  const bodies = texts(svg(RICH())).map((t) => t.body);
  assert.ok(bodies.includes('PONS V2, ROBINHOOD CHAIN'));
  assert.ok(bodies.includes('@vitalscheck_bot, paste any CA'));
  assert.ok(bodies.includes('checkvitals.xyz'));
  assert.ok(bodies.some((b) => /2026-08-28 14:32 UTC/.test(b)));
  // "0 launches indexed" under a card whose findings were measured against that
  // index is a sentence that cannot be true. With nothing indexed it is not
  // printed at all.
  assert.ok(!bodies.some((b) => /launches indexed/.test(b)),
    'an empty index must not be announced as a count');
});

test('the footer prints the real index size once there is one', () => {
  resetSponsor();
  for (let i = 0; i < 7; i++) {
    db.prepare(
      `INSERT OR IGNORE INTO launches (token, curve, deployer, pair_token, launch_config_id,
         graduation_threshold, block_number, tx_hash, launched_at)
       VALUES (?,?,?,?,1,'1',?,?,?)`,
    ).run('0x' + i.toString(16).padStart(40, '0'), '0x' + 'c'.repeat(40), '0x' + 'd'.repeat(40),
      '0x' + 'e'.repeat(40), i, '0x' + i.toString(16).padStart(64, '0'), 1);
  }
  const bodies = texts(svg(RICH())).map((t) => t.body);
  assert.ok(bodies.some((b) => /\b7 launches indexed$/.test(b)),
    `footer said: ${bodies.filter((b) => /UTC/.test(b)).join(' | ')}`);
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
    const { pad: PAD } = SIZES[size];
    // The card's own height, not the ceiling: a card that shrank and then drew
    // its footer past the new bottom would pass a check made against the old one.
    const rendered = svg(RICH(), size);
    const H = svgHeight(rendered);
    const rows = [...rendered.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => {
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

// ------------------------------------------------------- markers and wording

test('a marker never touches the word it marks', () => {
  resetSponsor();
  // The offset was one constant for markers drawn at every size. At hero size
  // the flag is 37px wide against a 40px offset: under 3px of air, and on the
  // rendered card the pennant touched the first letter.
  for (const size of ['portrait', 'wide']) {
    const s = svg(RICH(), size);
    // Each flag is a 2px pole plus a pennant 0.72 of its height wide. The pole
    // rect carries the height, so the baseline and the right edge both come
    // off it, and the line it marks is the one sharing that baseline.
    const marks = [...s.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="2" height="([\d.]+)"/g)]
      .map((m) => ({
        right: Number(m[1]) + 2 + Number(m[3]) * 0.72,
        baseline: Number(m[2]) + Number(m[3]),
      }));
    assert.ok(marks.length, `${size}: no flag drawn`);
    const rows = texts(s);
    for (const mk of marks) {
      const line = rows.find((t) => t.anchor === 'start' && Math.abs(t.y - mk.baseline) < 1);
      assert.ok(line, `${size}: a flag at y=${mk.baseline} with nothing beside it`);
      assert.ok(line.x - mk.right >= 8,
        `${size}: only ${(line.x - mk.right).toFixed(1)}px between the flag and "${line.body.slice(0, 20)}"`);
    }
  }
});

test('the flow row states both counts, and only above a usable sample', () => {
  resetSponsor();
  // "buys per sell 1.0" is two buys and two sells, or two hundred and two
  // hundred, and the card could not tell a reader which.
  const busy = measuresOf(makeScan({ buyers: 40, buyTx: 120, sellTx: 44 }));
  const flow = busy.find((m) => m.label === 'flow');
  assert.equal(flow.value, '120 buys, 44 sells');
  assert.ok(!busy.some((m) => /per sell/.test(m.label)), 'the ratio is jargon');

  const quiet = measuresOf(makeScan({ buyers: 4, buyTx: 2, sellTx: 2 }));
  assert.ok(!quiet.some((m) => m.label === 'flow'),
    'four trades cannot support a statement about flow');
});

test('the state word carries its timing', () => {
  resetSponsor();
  const onCurve = texts(svg(makeScan({ phaseName: 'NotGraduated' }))).map((t) => t.body);
  assert.ok(onCurve.some((b) => /on the curve/.test(b)));

  // Launched, graduated an hour later, scanned three hours after that.
  const grad = texts(svg(makeScan({
    phaseName: 'Swept', launchedAt: 1_700_000_000, sweptAt: 1_700_003_600, ageSeconds: 14_400,
  }))).map((t) => t.body);
  assert.ok(grad.some((b) => /graduated 3h ago/.test(b)), grad.join(' | '));
  assert.ok(!grad.some((b) => /·  graduated  ·/.test(b)), 'the bare word says nothing');

  // And the age itself is untouched.
  const young = texts(svg(makeScan({ ageSeconds: 1800 }))).map((t) => t.body);
  assert.ok(young.some((b) => /\b30m\b/.test(b)), young.join(' | '));
});

test('the "+N more" line never runs into the market strip', () => {
  resetSponsor();
  // It is reserved a slot on a second layout pass, and the slot has to cover
  // however far the body cursor had already advanced past its last baseline,
  // which depends on which section ended the card.
  const shapes = [
    RICH(),
    makeScan({ flags: Array.from({ length: 9 }, (_, i) => f(`k${i}`, `finding number ${i} of nine`, 9 - i)),
      concentration: { top5Share: 61, top1Share: 34, holders: 412, excess: 0.4 } }),
    makeScan({ flags: [f('a', 'a finding long enough to wrap onto a second line of the card', 9),
      f('b', 'another finding that also wraps onto a second line right here', 8),
      f('c', 'a third one', 7), f('d', 'a fourth one', 6), f('e', 'a fifth one', 5)],
      concentration: { top5Share: 61, top1Share: 34, holders: 412, excess: 0.4 } }),
  ];
  for (const size of ['portrait', 'wide']) {
    for (const [i, r] of shapes.entries()) {
      const s = svg(r, size);
      const note = texts(s).find((t) => /more on \/full/.test(t.body));
      if (!note) continue;
      // The strip rule is the full-width hairline nearest the bottom above the
      // footer's own; both are CW wide, so take the higher of the two.
      const rules = [...s.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="\d+" height="1"/g)]
        .map((m) => Number(m[1])).sort((a, b) => a - b);
      const stripRule = rules[rules.length - 2];
      assert.ok(note.y + note.size * 0.25 < stripRule,
        `${size} shape ${i}: "${note.body}" at y=${note.y} crosses the strip rule at ${stripRule}`);
    }
  }
});
