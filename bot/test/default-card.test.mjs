import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDefaultCard, renderDefaultNotFound } from '../dist/card.js';
import { makeScan } from './fixtures.mjs';

const f = (key, plain, severity, state = 'raised') =>
  ({ key, label: key, state, detail: `${key} technical`, compactDetail: key, plain, severity });

// ------------------------------------------------------- the specified shapes
test('concerns-raised card matches the specified shape exactly', () => {
  const r = makeScan({
    ageSeconds: 47, symbol: 'GHATS', buyers: 2, roundTrippers: 2, progressPct: 0,
    flagsTotal: 8,
    flags: [
      f('snipe', '8 wallets got in tax-free before you could', 108),
      f('pair_ticker', 'same ticker as the asset it trades against', 80),
      f('deployer_rate', 'deployer launched 91 tokens this week', 55),
    ],
  });
  assert.deepEqual(renderDefaultCard(r, 'vitalscheck_bot').split('\n'), [
    'VITALS  $GHATS · 47s',
    '',
    '🚩 8 wallets got in tax-free before you could',
    '🚩 same ticker as the asset it trades against',
    '🚩 deployer launched 91 tokens this week',
    '',
    '2 buyers',
    'both already sold · 0.00% to graduation',
    '',
    '@vitalscheck_bot · not financial advice',
  ]);
});

test('nothing-raised card matches the specified shape exactly', () => {
  const r = makeScan({
    ageSeconds: 1200, symbol: 'TOKEN', buyers: 38, roundTrippers: 3,
    progressPct: 12.4, windowMinutes: 20, flagsTotal: 8,
    flags: [f('a', 'x', 5, 'unknown'), f('b', 'y', 5, 'unknown')],
  });
  r.traction.uniqueBuyers10m = 12;
  assert.deepEqual(renderDefaultCard(r, 'vitalscheck_bot').split('\n'), [
    'VITALS  $TOKEN · 20m',
    '',
    'no concerns raised · 6 of 8 checked · 2 undetermined',
    '',
    '38 buyers',
    '3 of 38 sold · 12.4% to graduation',
    'buyers 12 → 38 in 20 min',
    '',
    '@vitalscheck_bot · not financial advice',
  ]);
});

// --------------------------------------------------------------------- rules
test('at most three flags, highest severity first', () => {
  const r = makeScan({ flags: [
    f('low', 'lowest', 10), f('top', 'highest', 100), f('mid', 'middle', 50), f('x', 'fourth', 20),
  ]});
  const lines = renderDefaultCard(r, 'b').split('\n').filter((l) => l.startsWith('🚩'));
  assert.deepEqual(lines, ['🚩 highest', '🚩 middle', '🚩 fourth']);
});

test('more than three raised flags adds "+N more · /full"', () => {
  const r = makeScan({ flags: Array.from({ length: 6 }, (_, i) => f(`f${i}`, `finding ${i}`, 100 - i)) });
  const text = renderDefaultCard(r, 'b');
  assert.match(text, /^\+3 more · \/full$/m);
  assert.equal(text.split('\n').filter((l) => l.startsWith('🚩')).length, 3);
});

test('undetermined is never hidden — with flags raised or without', () => {
  const withRaised = makeScan({ flags: [
    f('a', 'raised one', 90), f('u1', 'x', 5, 'unknown'), f('u2', 'y', 5, 'unknown'),
  ]});
  assert.match(renderDefaultCard(withRaised, 'b'), /2 undetermined/);

  const noneRaised = makeScan({ flagsTotal: 8, flags: [f('u1', 'x', 5, 'unknown'), f('u2', 'y', 5, 'unknown')] });
  assert.match(renderDefaultCard(noneRaised, 'b'), /no concerns raised · 6 of 8 checked · 2 undetermined/);

  // and when the three flag slots are already full
  const full = makeScan({ flags: [
    ...Array.from({ length: 5 }, (_, i) => f(`r${i}`, `r${i}`, 100 - i)),
    f('u', 'x', 5, 'unknown'),
  ]});
  assert.match(renderDefaultCard(full, 'b'), /\+2 more · 1 undetermined · \/full/);
});

test('never says clean, safe or looks good', () => {
  const banned = /\bclean\b|\bsafe\b|looks good|all good|no risk|verified|legit/i;
  for (const over of [
    { flags: [] },
    { flags: [f('u', 'x', 5, 'unknown')] },
    { flags: [f('a', 'something', 90)] },
    { buyers: 0, roundTrippers: 0, flags: [] },
  ]) {
    const text = renderDefaultCard(makeScan(over), 'b');
    assert.ok(!banned.test(text), `all-clear language in:\n${text}`);
  }
});

test('no predictions or trade language, on any shape', () => {
  const banned = /price target|will pump|good entry|buy now|sell now|to the moon|\bmoon\b|recommend|should buy/i;
  for (const over of [
    { ageSeconds: 5, buyers: 0, roundTrippers: 0 },
    { ageSeconds: 2000, buyers: 90, roundTrippers: 2, progressPct: 88, windowMinutes: 30 },
    { flags: [f('a', 'x', 90), f('b', 'y', 80)] },
  ]) {
    assert.ok(!banned.test(renderDefaultCard(makeScan(over), 'b')));
  }
});

test('age lives in the header and nowhere else', () => {
  const lines = renderDefaultCard(makeScan({ ageSeconds: 47, symbol: 'X' }), 'b').split('\n');
  assert.match(lines[0], /· 47s$/);
  assert.equal(lines.filter((l) => /\b\d+[smhd]\b/.test(l) && !l.startsWith('VITALS') && !/in \d+ min/.test(l)).length, 0);
});

test('metadata the default card must not carry', () => {
  const text = renderDefaultCard(makeScan({ ageSeconds: 900 }), 'b');
  for (const gone of [/phase/i, /0x[0-9a-fA-F]{40}/, /NotGraduated/, /graduation threshold/i, /velocity/i, /median buy/i]) {
    assert.ok(!gone.test(text), `default card still carries ${gone}`);
  }
});

// ------------------------------------------------------ built to be forwarded
test('plain text: no tags, no HTML entities, survives a copy-paste', () => {
  // an ampersand must appear as itself, not as &amp; — the card is copied out of
  // Telegram and pasted elsewhere, and an entity there is a visible artefact
  const r = makeScan({ symbol: 'A&B', flags: [f('a', 'x & y', 90)] });
  const text = renderDefaultCard(r, 'vitalscheck_bot');
  assert.ok(text.includes('$A&B'), `ampersand was altered:\n${text}`);
  assert.ok(!/&(amp|lt|gt|quot|#\d+);/.test(text), `HTML entity in the card:\n${text}`);
  assert.ok(!/<[a-z/]/i.test(text), `markup in the card:\n${text}`);

  // and a ticker that looks like a tag must not render as one
  const evil = renderDefaultCard(makeScan({ symbol: '<b>x</b>' }), 'b');
  assert.ok(!evil.includes('<'), `angle brackets survived:\n${evil}`);
});

test('a hostile ticker cannot add lines or blow the height budget', () => {
  const r = makeScan({ symbol: 'A\nB\nC'.repeat(40), flags: [f('a', 'x', 90)] });
  const lines = renderDefaultCard(r, 'b').split('\n');
  assert.ok(lines.length <= 12, `hostile ticker produced ${lines.length} lines`);
  assert.equal(lines[0].split('\n').length, 1);
});

test('every shape stays under twelve lines', () => {
  for (const over of [
    { flags: Array.from({ length: 8 }, (_, i) => f(`f${i}`, `finding number ${i}`, 100 - i)) },
    { ageSeconds: 1800, buyers: 50, roundTrippers: 4, windowMinutes: 30, flags: [] },
    { buyers: 0, roundTrippers: 0, flags: [] },
  ]) {
    const n = renderDefaultCard(makeScan(over), 'vitalscheck_bot').split('\n').length;
    assert.ok(n <= 12, `card was ${n} lines`);
  }
});

test('the footer is always the last line and names the bot', () => {
  for (const over of [{ flags: [] }, { flags: [f('a', 'x', 9)] }, { buyers: 0, roundTrippers: 0 }]) {
    const lines = renderDefaultCard(makeScan(over), 'vitalscheck_bot').split('\n');
    assert.equal(lines[lines.length - 1], '@vitalscheck_bot · not financial advice');
  }
  const nf = renderDefaultNotFound('0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67', 'vitalscheck_bot').split('\n');
  assert.equal(nf[nf.length - 1], '@vitalscheck_bot · not financial advice');
});

// ------------------------------------------------- buyer line and what follows
test('the buyer count stands alone, with what happened to them on the next line', () => {
  const lines = (over) => renderDefaultCard(makeScan(over), 'b').split('\n');
  const buyer = (over) => lines(over).find((l) => /^\d+ buyer|^no buyers/.test(l));
  const rest = (over) => lines(over).find((l) => /to graduation$/.test(l));

  assert.equal(buyer({ buyers: 0, roundTrippers: 0, progressPct: 0 }), 'no buyers yet');
  assert.equal(rest({ buyers: 0, roundTrippers: 0, progressPct: 0 }), '0.00% to graduation');
  assert.equal(buyer({ buyers: 1, roundTrippers: 0, progressPct: 1 }), '1 buyer');
  assert.equal(rest({ buyers: 1, roundTrippers: 0, progressPct: 1 }), 'none sold yet \u00b7 1% to graduation');
  assert.equal(rest({ buyers: 2, roundTrippers: 2, progressPct: 0 }), 'both already sold \u00b7 0.00% to graduation');
  assert.equal(rest({ buyers: 9, roundTrippers: 9, progressPct: 5.5 }), 'all already sold \u00b7 5.5% to graduation');
  assert.equal(rest({ buyers: 9, roundTrippers: 3, progressPct: 5.5 }), '3 of 9 sold \u00b7 5.5% to graduation');
});

test('the buyer count carries its reference point, and only above the floor', () => {
  const buyer = (over) =>
    renderDefaultCard(makeScan(over), 'b').split('\n').find((l) => /^\d+ buyer|^no buyers/.test(l));

  // below the floor the count stands alone -- a median of twelve launches would
  // be an anecdote presented as a reference
  assert.equal(buyer({ buyers: 5, benchmarkMedian: null, benchmarkN: 12 }), '5 buyers');
  assert.equal(buyer({ buyers: 5, benchmarkMedian: 3, benchmarkN: 412 }), '5 buyers \u2014 median at this age is 3');
  assert.equal(buyer({ buyers: 38, benchmarkMedian: 12, benchmarkN: 412 }), '38 buyers \u2014 median at this age is 12');
  assert.equal(buyer({ buyers: 0, benchmarkMedian: 3, benchmarkN: 412 }), 'no buyers yet \u2014 median at this age is 3');
});

test('the comparison never reads as a verdict', () => {
  const VERDICT = /\b(above|below) average\b|\bstrong\b|\bhealthy\b|\bweak\b|\bgood\b|\bbad\b|\bpoor\b|\bsolid\b|\boutperform/i;
  for (const median of [0, 1, 3, 12, 500]) {
    for (const buyers of [0, 1, 5, 38, 900]) {
      const card = renderDefaultCard(makeScan({ buyers, benchmarkMedian: median, benchmarkN: 412 }), 'b');
      assert.ok(!VERDICT.test(card), `a verdict word reached the card at ${buyers} vs ${median}`);
    }
  }
});

test('holder concentration appears only when it is a measurement', () => {
  const conc = (over) =>
    renderDefaultCard(makeScan(over), 'b').split('\n').find((l) => /top 5 wallets/.test(l));

  // unreadable, and below the arithmetic floor: absent from the card, because a
  // top-5 share of five or fewer holders is 100% whatever the distribution is
  assert.equal(conc({}), undefined);
  assert.equal(conc({ concentration: { top5Share: 100, holders: 1, circulating: 1n } }), undefined);
  assert.equal(conc({ concentration: { top5Share: 100, holders: 5, circulating: 1n } }), undefined);

  assert.equal(
    conc({ concentration: { top5Share: 44.2, holders: 23, circulating: 1n } }),
    'top 5 wallets hold 44% \u00b7 23 holders',
  );
});

test('card order: concerns, then the buyer count, then concentration, then the rest', () => {
  const r = makeScan({
    ageSeconds: 1200, symbol: 'TOKEN', buyers: 38, roundTrippers: 3, progressPct: 12.4,
    windowMinutes: 20, flagsTotal: 9, benchmarkMedian: 12, benchmarkN: 412,
    concentration: { top5Share: 44.2, holders: 23, circulating: 1n },
    flags: [f('snipe', '8 wallets got in tax-free before you could', 108)],
  });
  r.traction.uniqueBuyers10m = 12;
  assert.deepEqual(renderDefaultCard(r, 'vitalscheck_bot').split('\n'), [
    'VITALS  $TOKEN \u00b7 20m',
    '',
    '\ud83d\udea9 8 wallets got in tax-free before you could',
    '',
    '38 buyers \u2014 median at this age is 12',
    'top 5 wallets hold 44% \u00b7 23 holders',
    '3 of 38 sold \u00b7 12.4% to graduation',
    'buyers 12 \u2192 38 in 20 min',
    '',
    '@vitalscheck_bot \u00b7 not financial advice',
  ]);
});

test('buyer growth appears only once there are two points in time', () => {
  // the arrow, not the word: "no buyers yet" also contains "buyers "
  const has = (over) => /buyers \d+ → \d+ in \d+ min/.test(renderDefaultCard(makeScan(over), 'b'));
  assert.equal(has({ ageSeconds: 47, buyers: 2 }), false, 'no +10min reading exists at 47s');
  assert.equal(has({ ageSeconds: 1200, buyers: 38, windowMinutes: 20 }), true);
  assert.equal(has({ ageSeconds: 1200, buyers: 0, windowMinutes: 20 }), false, 'nothing to grow from');
});
