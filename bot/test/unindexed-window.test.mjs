/**
 * A read that did not happen is not a measurement of zero.
 *
 * Live card, on a launch that had graduated -- crossed 4.2 ETH, so it plainly
 * had buyers:
 *
 *   VITALS  $BULL · 23d
 *   no buyers yet — median in the first 30 min is 14
 *
 * Nothing was broken in the renderer. Its opening window had never been
 * indexed, the count came back zero because there were no rows to count, and
 * zero rendered as a finding about the chain. The same zero fed the sold count,
 * the growth line and the benchmark comparison beside it.
 *
 * The fix is structural rather than a guard on each line: the window figures
 * live behind `traction.window`, which is null when nothing was read, so there
 * is no zero to render. These assert the behaviour that shape buys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTraction } from '../dist/metrics/traction.js';
import { renderDefaultCard, buyerLine, sellingLine, growthLine, earlySellLine, activityLine } from '../dist/card.js';
import { makeScan } from './fixtures.mjs';

const WINDOW = 18_000;

test('an unindexed window is undetermined, not zero', () => {
  // No coverage recorded at all: nobody has read this token's opening window.
  const t = computeTraction('0x' + 'ab'.repeat(20), 1_000_000, 2_000_000, 4_200000000000000000n, null);
  assert.equal(t.window, null, 'there must be no figures to read from an unread window');
  assert.equal(t.label, 'undetermined');
});

test('coverage that stops short of the window is still undetermined', () => {
  // Read halfway and abandoned. Reporting the buyers of the first half as
  // though they were all of them is the same lie in a smaller size.
  const t = computeTraction('0x' + 'cd'.repeat(20), 1_000_000, 2_000_000, 4_200000000000000000n, 1_000_000 + WINDOW / 2);
  assert.equal(t.window, null);
  assert.equal(t.label, 'undetermined');
});

test('a graduated launch with no indexed window says undetermined, never "no buyers"', () => {
  const r = makeScan({
    symbol: 'BULL',
    ageSeconds: 23 * 86_400,
    windowIndexed: false,
    phaseName: 'Graduated',
    benchmarkMedian: 14,
    benchmarkN: 412,
  });

  const line = buyerLine(r);
  assert.match(line, /undetermined/, `buyer line must be undetermined, got "${line}"`);
  assert.doesNotMatch(line, /no buyers/, 'an unread window must never render as no buyers');
  // The median is a comparison against a count we do not have. Printing it
  // beside "undetermined" invites the reader to supply the missing side.
  assert.doesNotMatch(line, /median/, `no reference point without a measurement: "${line}"`);

  const card = renderDefaultCard(r, 'b');
  assert.doesNotMatch(card, /no buyers/, `card still claims a zero:\n${card}`);
  assert.doesNotMatch(card, /0 of 0/, `card still renders an empty ratio:\n${card}`);
});

test('every figure derived from the window goes with it', () => {
  const r = makeScan({ windowIndexed: false, ageSeconds: 23 * 86_400, roundTrippers: 4, buyers: 9 });
  // Each of these read the window. None may invent a number from its absence.
  assert.doesNotMatch(sellingLine(r), /sold/, 'selling is a window figure');
  assert.equal(growthLine(r), null, 'growth needs two counts from the window');
  assert.equal(earlySellLine(r), null, 'the early cohort is a window figure');
  assert.match(activityLine(r), /undetermined/, 'the compact line must say so too');
});

test('the graduation distance survives, because the curve was read', () => {
  // Not everything on the card comes from the window. The reserve is a live
  // contract read and stays true when the window is unread -- dropping it would
  // be its own kind of wrong.
  const r = makeScan({
    windowIndexed: false,
    ageSeconds: 23 * 86_400,
    realQuoteReserve: 1_700000000000000000n,
    graduationThreshold: 4_200000000000000000n,
  });
  assert.match(renderDefaultCard(r, 'b'), /of 4\.2 ETH to graduation/);
});

test('an indexed but genuinely empty window is a real zero and says so', () => {
  // The counterpart: coverage exists, the window really had no buys. That IS a
  // measurement and must not be hidden behind "undetermined".
  const r = makeScan({ buyers: 0, roundTrippers: 0, ageSeconds: 23 * 86_400 });
  assert.match(buyerLine(r), /no buyers in the first 30 min/);
});
