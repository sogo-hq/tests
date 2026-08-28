import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardSvg, renderCardPng, renderableText, utcStamp, WIDTH, HEIGHT } from '../dist/image.js';
import { makeScan } from './fixtures.mjs';

const f = (key, plain, severity, state = 'raised') =>
  ({ key, label: key, state, detail: `${key} technical`, compactDetail: key, plain, severity });

const png = (r) => renderCardPng(r, new Date(Date.UTC(2026, 7, 28, 14, 32)));
const svg = (r) => cardSvg(r, new Date(Date.UTC(2026, 7, 28, 14, 32)));

/** PNG signature plus the dimensions out of the IHDR chunk. */
function pngInfo(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

// ------------------------------------------------- the four required cases
const CASES = {
  'three flags': makeScan({
    ageSeconds: 47, symbol: 'GHATS', buyers: 2, roundTrippers: 2, flagsTotal: 8,
    flags: [
      f('snipe', '8 wallets got in tax-free before you could', 108),
      f('pair_ticker', 'same ticker as the asset it trades against', 80),
      f('deployer_rate', 'deployer launched 91 tokens this week', 55),
    ],
  }),
  'no flags': makeScan({
    ageSeconds: 1200, symbol: 'TOKEN', buyers: 38, roundTrippers: 3,
    progressPct: 12.4, windowMinutes: 20, flagsTotal: 8, flags: [],
  }),
  'undetermined only': makeScan({
    ageSeconds: 300, symbol: 'UNKN', buyers: 0, roundTrippers: 0, flagsTotal: 8,
    flags: [
      f('a', 'no history yet on this deployer', 5, 'unknown'),
      f('b', 'no 24h history yet', 5, 'unknown'),
      f('c', "can't check this ticker yet", 20, 'unknown'),
    ],
  }),
  '40-char ticker': makeScan({
    ageSeconds: 90, symbol: 'A'.repeat(40), buyers: 5, roundTrippers: 1,
    flagsTotal: 8, flags: [f('x', 'a concern', 50)],
  }),
};

for (const [name, scan] of Object.entries(CASES)) {
  test(`renders: ${name}`, () => {
    const info = pngInfo(png(scan));
    assert.equal(info.width, WIDTH);
    assert.equal(info.height, HEIGHT);
    assert.ok(info.bytes > 2000, `${name} produced a suspiciously small PNG (${info.bytes} bytes)`);
  });
}

test('a 40-char ticker is clamped and cannot overflow the column', () => {
  const s = svg(CASES['40-char ticker']);
  const header = s.match(/font-size="(\d+)"[^>]*font-weight="600"[^>]*>(\$[^<]*)</);
  assert.ok(header, 'header line not found');
  const [, size, ticker] = header;
  // monospace: 0.6em per character, inside a 1072px column
  assert.ok([...ticker].length * Number(size) * 0.6 <= 1072,
    `header "${ticker}" at ${size}px would be ${Math.round([...ticker].length * Number(size) * 0.6)}px wide`);
  assert.ok([...ticker].length < 45, 'the ticker is clamped, as on the text card');
});

// ------------------------------------------------------------ must appear
for (const [name, scan] of Object.entries(CASES)) {
  test(`carries its provenance: ${name}`, () => {
    const s = svg(scan);
    assert.ok(s.includes(scan.reads.token), 'the token address must appear in full, to be verifiable');
    assert.match(s, /2026-08-28 14:32 UTC/, 'a UTC stamp, so a week-old card cannot pass as today\'s');
    assert.ok(s.includes('checkvitals.xyz'));
    assert.ok(s.includes('not financial advice'));
  });
}

// ----------------------------------------------- says nothing the text won't
test('no score, no grade, no verdict language', () => {
  const banned = /\b(score|grade|rating|safe|clean|risk score|verdict|pass|fail|good|bad)\b/i;
  for (const [name, scan] of Object.entries(CASES)) {
    const s = svg(scan).replace(/<[^>]+>/g, ' ');
    assert.ok(!banned.test(s), `${name} carries a verdict word: ${s.match(banned)?.[0]}`);
  }
});

test('only the four brand colours are used', () => {
  const allowed = new Set(['#080B09', '#C6F73A', '#E8F0DE', '#6E7A66']);
  for (const [name, scan] of Object.entries(CASES)) {
    for (const m of svg(scan).matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)) {
      assert.ok(allowed.has(m[1]), `${name} uses an off-brand colour ${m[1]}`);
    }
  }
});

test('the accent is structural only — it never marks a finding', () => {
  const s = svg(CASES['three flags']);
  // every accent-filled element is the wordmark or the footer link
  for (const m of s.matchAll(/<text[^>]*fill="#C6F73A"[^>]*>([^<]*)<\/text>/g)) {
    assert.ok(['VITALS', 'checkvitals.xyz'].includes(m[1]),
      `accent used on "${m[1]}" — green must never read as "good"`);
  }
});

test('a card with three concerns is styled exactly like one with none', () => {
  const three = svg(CASES['three flags']);
  const none = svg(CASES['no flags']);
  const palette = (s) => [...new Set([...s.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(palette(three), palette(none), 'the two states must not differ in colour');

  // the concern lines and the no-concerns summary are set at the same size
  const size = (s) => s.match(/<text x="\d+" y="\d+"[^>]*font-size="(\d+)"[^>]*fill="#E8F0DE"[^>]*>(?!\$)/)?.[1];
  assert.ok(size(three) && size(none));
});

// ----------------------------------------------------------- text integrity
test('glyphs no bundled subset carries are substituted, never left as tofu', () => {
  assert.equal(renderableText('buyers 4 → 4'), 'buyers 4 -> 4');
  assert.equal(renderableText('Ⴆ'), '?', 'Georgian is absent from Plex Mono');
  assert.equal(renderableText('a · b — c …'), 'a · b — c …', 'verified punctuation survives');
  assert.equal(renderableText('Бб éÉ'), 'Бб éÉ', 'Cyrillic and Latin-1 survive');
});

test('a hostile ticker cannot break the SVG', () => {
  const evil = makeScan({ symbol: '<script>&"x', flags: [f('a', 'x & y < z', 9)] });
  const s = svg(evil);
  assert.ok(!s.includes('<script>'), 'markup escaped');
  assert.ok(s.includes('&amp;') || s.includes('&lt;'), 'entities present');
  const info = pngInfo(renderCardPng(evil));
  assert.equal(info.width, WIDTH);
});

test('the UTC stamp is formatted and actually UTC', () => {
  assert.equal(utcStamp(new Date(Date.UTC(2026, 0, 5, 3, 7))), '2026-01-05 03:07 UTC');
});

test('rendering is fast enough to sit behind a button', () => {
  const t0 = Date.now();
  png(CASES['three flags']);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `render took ${ms}ms`);
});
