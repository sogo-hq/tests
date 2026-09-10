import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardLines, renderDefaultCard } from '../dist/card.js';
import { cardSvg } from '../dist/image.js';
import { makeScan } from './fixtures.mjs';

/**
 * One card, two renderers, one list of lines.
 *
 * The image silently missed three features -- the growth line, the market cap,
 * the first-scan receipt -- because it built its own header and its own list of
 * body lines from the same ScanResult. Nothing failed any of those times: a
 * renderer that forgets a line still produces a perfectly valid smaller
 * picture, and every assertion added afterwards patched one line.
 *
 * This asserts the cause instead. Both renderers consume cardLines(), so a line
 * added there appears in both or in neither.
 */
const f = (k, plain, severity, state = 'raised') =>
  ({ key: k, label: k, state, detail: k, compactDetail: k, plain, severity });

/**
 * The image substitutes glyphs the bundled font subset cannot draw (→ becomes
 * ->) and XML-escapes the result, so both sides are normalised through the same
 * transform before comparison. Otherwise this test would fail on a substitution
 * that is deliberate and correct.
 */
const normalise = (s) =>
  s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/\u2192/g, '->');

function svgText(r) {
  return [...cardSvg(r).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => normalise(m[1]));
}

/**
 * Every card line, in the form the image would draw it.
 *
 * imageText where a line declares one: a PNG cannot be clicked and its bundled
 * font subset has no U+2260, so two lines carry a per-surface variant. That is
 * a declared divergence on the CardLine, not the picture inventing text, and
 * the parity check has to read it the same way the renderer does.
 *
 * The markers come off because the picture draws the state as a shape.
 */
function expectedInImage(r) {
  return cardLines(r)
    .filter((l) => !['spacer', 'footer', 'header'].includes(l.role))
    .map((l) => normalise((l.imageText ?? l.text).replace(/^(🚩|◌|·)\s+/u, '')));
}

const FULL = () => {
  const r = makeScan({
    ageSeconds: 158400, symbol: 'NPC', buyers: 13, roundTrippers: 1, progressPct: 12.4,
    windowMinutes: 30, flagsTotal: 9, benchmarkMedian: 20, benchmarkN: 412, measuredAtAge: false,
    mcapInQuote: 1.68, realQuoteReserve: 186_200000000000000n,
    concentration: { top5Share: 44.2, top1Share: 17.1, holders: 23, circulating: 1n },
    firstScan: { mcap: 0.4, at: 1, since: 22 },
    flags: [
      f('a', '38 other tokens use this exact ticker', 100),
      f('b', 'creator takes 3% of every trade', 60),
      f('c', 'deployer launched 91 tokens this week', 55),
      f('d', 'fourth', 50), f('u', 'x', 1, 'unknown'),
    ],
  });
  r.traction.window.uniqueBuyers10m = 8;
  r.traction.window.earlyBuyers = 13;
  // The cohort's later selling is not a window figure: it comes from the
  // whole-life Transfer walk, so it is set where the card reads it.
  r.earlySells = { cohort: 13, sold: 1 };
  return r;
};

test('every body line is drawn, or the shortfall is counted', () => {
  // The card can now say more than a fixed-height picture holds. That is not a
  // reason to weaken this: what it exists to catch is a SILENT drop, so every
  // line must be either drawn or accounted for by the overflow notice, and the
  // count in that notice must match the number actually missing.
  const r = FULL();
  const drawn = svgText(r);
  const missing = expectedInImage(r).filter((line) => !drawn.some((t) => t === line));
  if (!missing.length) return;

  const notice = drawn.find((t) => /more on the card$/.test(t));
  assert.ok(notice, `the image dropped ${missing.length} line(s) with nothing saying so: ${missing.join(' | ')}`);
  const claimed = Number(/^\+(\d+)/.exec(notice)?.[1] ?? -1);
  assert.equal(claimed, missing.length,
    `the notice says +${claimed} but ${missing.length} are missing: ${missing.join(' | ')}`);
});

test('the image draws no body line the card did not produce', () => {
  // The other direction: the picture must not invent or keep a stale line.
  const r = FULL();
  const fromCard = new Set(expectedInImage(r));
  // The footer is a declared per-surface variant (CardLine.imageText), not a
  // line the picture invented: a PNG cannot be clicked, so it carries
  // t.me/handle where the text card carries the bare @handle.
  const footerVariant = cardLines(r).find((l) => l.role === 'footer')?.imageText;
  const chrome = new RegExp(
    `^(VITALS|checkvitals\\.xyz|not financial advice|0x[0-9a-fA-F]{40}|` +
      `\\d{4}-\\d{2}-\\d{2}.*UTC|\\$NPC.*|\\+\\d+ more on the card|checkvitals\\.xyz|` +
      `${footerVariant?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`,
  );
  for (const t of svgText(r)) {
    if (!t.trim() || chrome.test(t)) continue;
    assert.ok(fromCard.has(t), `the image drew "${t}", which is not a card line`);
  }
});

test('a line added to the card reaches the image without touching the image', () => {
  // The property that matters. Two scans differing only by a measurement the
  // card decides to include: the image must differ by exactly that line.
  // Trimmed to a card that fits the picture: with the body overflowing, adding
  // one line pushes another out and the difference is no longer just the line
  // under test. Overflow accounting is asserted separately above.
  const withReceipt = FULL();
  withReceipt.flags.flags = withReceipt.flags.flags.slice(0, 1);
  const without = FULL();
  without.flags.flags = without.flags.flags.slice(0, 1);
  without.firstScan = null;

  const a = new Set(svgText(withReceipt));
  const b = new Set(svgText(without));
  const extra = [...a].filter((t) => !b.has(t));
  assert.deepEqual(extra, ['first scanned here at 0.4 ETH · 22 scans since'],
    'the image should differ by exactly the line the card added');
});

test('the header comes from the card, not from a second implementation', () => {
  const r = FULL();
  const header = cardLines(r).find((l) => l.role === 'header').text.replace(/^VITALS\s+/, '');
  assert.ok(svgText(r).includes(header), `the image header "${header}" was rebuilt rather than taken`);
});

test('when the image runs out of room it says so', () => {
  // Silence is what let three features go missing. A picture that cannot fit
  // everything must report the shortfall rather than quietly render less.
  const r = FULL();
  r.flags.flags = Array.from({ length: 3 }, (_, i) => f(`f${i}`, `a concern with a fairly long description ${i}`, 100 - i));
  const many = { ...r };
  const drawn = svgText(many);
  const overflow = drawn.find((t) => /more on the card/.test(t));
  // Either everything fits, or the shortfall is stated -- never a silent drop.
  const bodyCount = expectedInImage(many).filter((l) => drawn.includes(l)).length;
  assert.ok(
    bodyCount === expectedInImage(many).length || overflow,
    'lines were dropped from the image with nothing saying so',
  );
});

test('the undetermined card reaches the image too', () => {
  // A card state that did not exist when the shared line list was built: an
  // unindexed window renders one undetermined line in place of four figures.
  // It is in the picture because it is in cardLines(), and for no other reason
  // -- image.ts was not touched to add it.
  const r = makeScan({ windowIndexed: false, ageSeconds: 23 * 86_400, symbol: 'BULL' });
  const drawn = svgText(r);
  for (const line of expectedInImage(r)) {
    assert.ok(drawn.some((t) => t === line), `the image dropped "${line}"`);
  }
  assert.ok(
    drawn.some((t) => /undetermined/.test(t)),
    'the picture must carry the undetermined statement, not silently omit it',
  );
  assert.ok(!drawn.some((t) => /no buyers/.test(t)), 'and must never render the zero');
});
