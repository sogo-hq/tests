/**
 * A graduated launch is not a launch in progress.
 *
 * From a live /full card: "graduation progress 0.000%" sat directly under
 * "curve at 100% of graduation". Both were arithmetically correct -- the curve
 * was swept into the v4 pool, so its reserve is zero and the ratio collapses --
 * and together they said nothing true. The header called it "phase PoolCreated",
 * which names an internal enum member rather than the thing that happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCardText, phaseLabel, cardLines } from '../dist/card.js';
import { makeScan } from './fixtures.mjs';

const f = (k, plain, sev, state = 'raised') =>
  ({ key: k, label: k, state, detail: `${k} detail`, compactDetail: k, plain, severity: sev });

const graduated = (over = {}) => makeScan({
  symbol: 'ARCHER', ageSeconds: 16 * 86_400, buyers: 87, roundTrippers: 49,
  windowMinutes: 30, benchmarkMedian: 20, benchmarkN: 412, progressPct: 0,
  phaseName: 'PoolCreated', sweptAt: 1_757_000_000,
  launchedAt: 1_757_000_000 - 2_400,
  flags: [f('a', 'a finding', 90)],
  ...over,
});

test('the phase is named in words, not as an enum member', () => {
  assert.equal(phaseLabel('NotGraduated'), 'on the curve');
  assert.equal(phaseLabel('PoolCreated'), 'graduated');
  assert.equal(phaseLabel('Swept'), 'graduated');
  assert.equal(phaseLabel('Rescued'), 'graduated');
  assert.doesNotMatch(renderCardText(graduated()), /PoolCreated|phase Swept/,
    'the internal state machine must not reach the card');
});

test('a graduated launch prints when it graduated, not progress toward it', () => {
  const full = renderCardText(graduated());
  assert.doesNotMatch(full, /graduation progress/,
    'progress toward a threshold already crossed is not a measurement');
  assert.doesNotMatch(full, /progress velocity/);
  assert.doesNotMatch(full, /peak progress in window/);
  assert.match(full, /graduated at \+/, 'the fact that matters is when it happened');
});

test('a launch still on the curve keeps its progress lines', () => {
  // The fix must not delete the measurement for tokens it still describes.
  const full = renderCardText(graduated({ phaseName: 'NotGraduated', sweptAt: 0, progressPct: 12.4 }));
  assert.match(full, /graduation progress: 12\.4/);
  assert.match(full, /progress velocity/);
  assert.doesNotMatch(full, /graduated at \+/);
});

test('/full uses the same three states as the card, and hands out no approval', () => {
  const full = renderCardText(graduated({
    flags: [f('a', 'a finding', 90), f('u', 'x', 1, 'unknown'), f('c', 'y', 0, 'clean')],
  }));
  assert.doesNotMatch(full, /❔/, 'a fourth symbol for undetermined');
  assert.doesNotMatch(full, /✅/, 'a green tick renders a fact as an endorsement');
  assert.match(full, /\u{1F6A9}/u, 'findings keep the one finding marker');
  assert.match(full, /◌/, 'and undetermined keeps the one undetermined marker');
});

test('a walk that never ran is not a walk that failed', () => {
  // "transfers could not be read" claimed an attempt that had not happened.
  // The deployer's movements come from the whole-life Transfer walk, which is
  // background work; a token nobody has walked has no activity stored.
  const never = renderCardText(graduated({ }));
  assert.match(never, /deployer: not read yet/, `got: ${never.split('\n').find((l) => /deployer:/.test(l))}`);
  assert.doesNotMatch(never, /transfers could not be read/);

  const walked = graduated();
  walked.holderWalkComplete = true;
  assert.match(renderCardText(walked), /transfers could not be read — undetermined/,
    'once the walk HAS run, an empty result is genuinely undetermined');
});
