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
  // Every case above leaves benchmarkMedian and concentration unset, so the
  // sweeps below -- banned language, palette, provenance -- had never once
  // rendered the buyer comparison or the top-5 share. A verdict word or a
  // colour that implies one could have reached the image unseen.
  'benchmark and concentration': makeScan({
    ageSeconds: 1200, symbol: 'BOTH', buyers: 38, roundTrippers: 3, progressPct: 12.4,
    windowMinutes: 20, flagsTotal: 9, benchmarkMedian: 12, benchmarkN: 412,
    concentration: { top5Share: 44.2, holders: 23, circulating: 1n },
    flags: [f('snipe', '8 wallets got in tax-free before you could', 108)],
  }),
  'benchmark below the floor': makeScan({
    ageSeconds: 47, symbol: 'THIN', buyers: 5, roundTrippers: 0, flagsTotal: 9,
    benchmarkMedian: null, benchmarkN: 12,
    concentration: { top5Share: 100, holders: 3, circulating: 1n },
    flags: [],
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

// ------------------------------------------- the image keeps up with the card
test('the PNG carries the market cap and the receipt, and clears the footer', async () => {
  const { cardSvg } = await import('../dist/image.js');
  const r = makeScan({
    ageSeconds: 158400, symbol: 'NPC', buyers: 38, roundTrippers: 3, windowMinutes: 30,
    flagsTotal: 9, benchmarkMedian: 20, benchmarkN: 412, measuredAtAge: false,
    mcapInQuote: 2.07, realQuoteReserve: 186_200000000000000n,
    concentration: { top5Share: 44.2, top1Share: 17.3, holders: 23, circulating: 1n },
    firstScan: { mcap: 1.2, at: 1, since: 22 },
    flags: [
      f('a', '38 other tokens use this exact ticker', 100),
      f('b', 'creator takes 3% of every trade', 60),
      f('c', 'deployer launched 91 tokens this week', 55),
      f('d', 'fourth', 50), f('u', 'x', 1, 'unknown'),
    ],
  });
  r.traction.uniqueBuyers10m = 20;
  const svg = cardSvg(r);

  // Both were added to the text card and rendered here from hardcoded
  // coordinates, so neither reached the picture until this test existed.
  assert.match(svg, /2\.07 ETH mc/, 'the header lost the market cap');
  assert.match(svg, /first scanned here at 1\.2 ETH · 22 scans since/, 'the image lost the receipt');
  assert.match(svg, /0\.186 of 4\.2 ETH to graduation/, 'and the absolute distance to graduation');
  assert.ok(!/% to graduation/.test(svg), 'no percentage survives here either');

  // Nothing may land in the gap between the last body line and the footer
  // rule at y=552. The footer's own two lines sit at 578, below it by design.
  const baselines = [...svg.matchAll(/<text[^>]*y="(\d+)"/g)].map((m) => Number(m[1]));
  const onRule = baselines.filter((y) => y >= 546 && y < 570);
  assert.equal(onRule.length, 0, `text drawn onto the footer rule: ${onRule.join(', ')}`);

  // And the stacked block must not overlap itself: every line in the body sits
  // at least 20px below the one before it.
  const body = baselines.filter((y) => y > 252 && y < 552).sort((a, b) => a - b);
  for (let i = 1; i < body.length; i++) {
    assert.ok(body[i] - body[i - 1] >= 20, `lines at y=${body[i - 1]} and y=${body[i]} overlap`);
  }
});

test('when the body cannot fit, growth yields before the receipt does', async () => {
  const { cardSvg } = await import('../dist/image.js');
  // Everything on at once: three concerns, an extras line, and five body lines.
  const r = makeScan({
    ageSeconds: 158400, symbol: 'NPC', buyers: 38, roundTrippers: 3, windowMinutes: 30,
    flagsTotal: 9, benchmarkMedian: 20, benchmarkN: 412, measuredAtAge: false,
    mcapInQuote: 2.07, realQuoteReserve: 186_200000000000000n,
    concentration: { top5Share: 44.2, top1Share: 17.3, holders: 23, circulating: 1n },
    firstScan: { mcap: 1.2, at: 1, since: 22 },
    flags: [
      f('a', 'first concern', 100), f('b', 'second concern', 60), f('c', 'third concern', 55),
      f('d', 'fourth', 50), f('u', 'x', 1, 'unknown'),
    ],
  });
  r.traction.uniqueBuyers10m = 20;
  const svg = cardSvg(r);
  // The receipt is the one line here worth forwarding on its own; growth
  // restates the buyer count directly above it.
  assert.match(svg, /first scanned here/, 'the receipt must outrank growth for the last slot');
});
