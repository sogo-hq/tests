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
    '⚠️ 8 wallets got in tax-free before you could',
    '',
    '· same ticker as the asset it trades against',
    '· deployer launched 91 tokens this week',
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
  const lines = renderDefaultCard(r, 'b').split('\n').filter((l) => /^(⚠️|·) /.test(l));
  assert.deepEqual(lines, ['⚠️ highest', '· middle', '· fourth'],
    'the worst one is lifted; the rest stay, at a lower weight');
});

test('more than three raised flags adds "+N more · /full"', () => {
  const r = makeScan({ flags: Array.from({ length: 6 }, (_, i) => f(`f${i}`, `finding ${i}`, 100 - i)) });
  const text = renderDefaultCard(r, 'b');
  assert.match(text, /^\+3 more · \/full$/m);
  const shown = text.split('\n').filter((l) => /^(⚠️|·) /.test(l));
  assert.equal(shown.length, 3, 'three shown however they are marked');
  assert.equal(shown.filter((l) => l.startsWith('⚠️')).length, 1, 'exactly one is lifted');
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
  assert.ok(lines.length <= 14, `hostile ticker produced ${lines.length} lines`);
  assert.equal(lines[0].split('\n').length, 1);
});

test('every shape stays within the card ceiling', () => {
  for (const over of [
    { flags: Array.from({ length: 8 }, (_, i) => f(`f${i}`, `finding number ${i}`, 100 - i)) },
    { ageSeconds: 1800, buyers: 50, roundTrippers: 4, windowMinutes: 30, flags: [] },
    { buyers: 0, roundTrippers: 0, flags: [] },
  ]) {
    const n = renderDefaultCard(makeScan(over), 'vitalscheck_bot').split('\n').length;
    assert.ok(n <= 14, `card was ${n} lines`);
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

test('"at this age" is claimed only when the measurement really was at that age', () => {
  const buyer = (over) =>
    renderDefaultCard(makeScan(over), 'b').split('\n').find((l) => /^\d+ buyer|^no buyers/.test(l));

  // a young token: the window IS its life, so "at this age" is literally true
  assert.equal(
    buyer({ ageSeconds: 120, windowMinutes: 2, buyers: 5, benchmarkMedian: 3, benchmarkN: 412 }),
    '5 buyers \u2014 median at this age is 3',
  );
  // past the 30-minute cap the count is of the first 30 minutes, not of "now",
  // and the line must say so rather than describe a comparison never made
  assert.equal(
    buyer({ ageSeconds: 86400, windowMinutes: 30, buyers: 87, benchmarkMedian: 4, benchmarkN: 412 }),
    '87 buyers \u2014 median in the first 30 min is 4',
  );
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
    renderDefaultCard(makeScan(over), 'b').split('\n').find((l) => /top 5 hold/.test(l));

  // unreadable, and below the arithmetic floor: absent from the card, because a
  // top-5 share of five or fewer holders is 100% whatever the distribution is
  assert.equal(conc({}), undefined);
  assert.equal(conc({ concentration: { top5Share: 100, holders: 1, circulating: 1n } }), undefined);
  assert.equal(conc({ concentration: { top5Share: 100, holders: 5, circulating: 1n } }), undefined);

  assert.equal(
    conc({ concentration: { top5Share: 44.2, top1Share: 0, holders: 23, circulating: 1n } }),
    'top 5 hold 44% \u00b7 23 holders',
  );
});

// --------------------------------------------------- lifting the worst concern
test('the worst concern gets its own line, its own marker, and room under it', () => {
  const lines = renderDefaultCard(makeScan({ flags: [
    f('top', '38 other tokens use this exact ticker', 100),
    f('mid', 'creator takes 3% of every trade', 60),
  ]}), 'b').split('\n');
  const i = lines.indexOf('\u26a0\ufe0f 38 other tokens use this exact ticker');
  assert.ok(i > 0, `the worst concern is not lifted:\n${lines.join('\n')}`);
  assert.equal(lines[i + 1], '', 'a blank line under it is what does the lifting');
  assert.equal(lines[i + 2], '\u00b7 creator takes 3% of every trade', 'the rest drop to a plain bullet');
});

test('one concern is the top one, with nothing below it', () => {
  const lines = renderDefaultCard(makeScan({ flags: [f('a', 'the only concern', 90)] }), 'b').split('\n');
  assert.equal(lines[2], '\u26a0\ufe0f the only concern');
  // One blank before the measurements, not two: the blank belongs to the top
  // concern and is only spent when something follows.
  assert.equal(lines[3], '');
  assert.match(lines[4], /buyer/, `a second blank opened a hole:\n${lines.join('\n')}`);
});

test('exactly one concern is ever lifted, at any count', () => {
  for (const n of [1, 2, 3, 4, 9]) {
    const flags = Array.from({ length: n }, (_, i) => f(`f${i}`, `finding ${i}`, 100 - i));
    const lines = renderDefaultCard(makeScan({ flags }), 'b').split('\n');
    const lifted = lines.filter((l) => l.startsWith('\u26a0\ufe0f'));
    assert.equal(lifted.length, 1, `${n} concerns lifted ${lifted.length}`);
    assert.equal(lifted[0], '\u26a0\ufe0f finding 0', 'and it is the highest severity');
    assert.equal(lines.filter((l) => l.startsWith('\ud83d\udea9')).length, 0, 'the old marker is gone');
  }
});

test('nothing raised prints no concern block at all', () => {
  const card = renderDefaultCard(makeScan({ flags: [f('u', 'x', 1, 'unknown')] }), 'b');
  assert.ok(!card.includes('\u26a0\ufe0f'), 'no marker with nothing to mark');
  assert.ok(!/^\u00b7 /m.test(card), 'and no orphaned bullets');
  // The summary line stays: it carries the undetermined count and the "of N
  // checked" framing, without which an absence of findings reads as an
  // all-clear -- which this card must never imply.
  assert.match(card, /^no concerns raised · \d+ of \d+ checked · 1 undetermined$/m);
});

test('lifting is emphasis, not a verdict', () => {
  // Nothing about the marker or its neighbours may say whether this is good or
  // bad. The card ranks; it does not conclude.
  const VERDICT = /\b(safe|unsafe|danger|dangerous|risky|warning|avoid|scam|rug|clean|good|bad)\b/i;
  for (const n of [1, 3, 5]) {
    const flags = Array.from({ length: n }, (_, i) => f(`f${i}`, `finding ${i}`, 100 - i));
    const card = renderDefaultCard(makeScan({ flags }), 'b');
    assert.ok(!VERDICT.test(card), `a verdict word reached the card at ${n} concerns:\n${card}`);
  }
});

// ------------------------------------------------ market cap in the header
test('the header carries the market cap, in the asset the launch is priced in', () => {
  const head = (over) => renderDefaultCard(makeScan(over), 'b').split('\n')[0];
  assert.equal(head({ symbol: 'NPC', ageSeconds: 158400, mcapInQuote: 1.68 }), 'VITALS  $NPC · 44h · 1.68 ETH mc');
  assert.equal(
    head({ symbol: 'NPC', ageSeconds: 158400, mcapInQuote: 57000, pairSymbol: 'NVDA' }),
    'VITALS  $NPC · 44h · 57K NVDA mc',
    'priced in a tokenised equity, and said so — there is no stablecoin pair on this chain to read dollars from',
  );
});

test('an unreadable market cap is omitted, never printed as zero', () => {
  // A graduated curve reports 0 because it no longer holds the supply. "0 mc"
  // in a header reads as a worthless token rather than a finished one.
  for (const v of [0, -1, NaN, Infinity]) {
    const head = renderDefaultCard(makeScan({ symbol: 'NPC', ageSeconds: 158400, mcapInQuote: v }), 'b').split('\n')[0];
    assert.equal(head, 'VITALS  $NPC · 44h', `mcap ${v} reached the header`);
  }
});

test('the market cap is scaled, not spelled out', () => {
  const mc = (v) => renderDefaultCard(makeScan({ mcapInQuote: v }), 'b').split('\n')[0].split(' · ').pop();
  assert.equal(mc(0.4237), '0.424 ETH mc');
  assert.equal(mc(1.68), '1.68 ETH mc');
  assert.equal(mc(12.42), '12.4 ETH mc');
  assert.equal(mc(340.7), '341 ETH mc');
  assert.equal(mc(5218), '5.2K ETH mc');
  assert.equal(mc(1_120_000), '1.1M ETH mc');
});

// ------------------------------------------------------- the receipt line
test('the first scan is reported once there has been one', () => {
  const line = (over) =>
    renderDefaultCard(makeScan(over), 'b').split('\n').find((l) => l.startsWith('first scanned'));
  assert.equal(
    line({ firstScan: { mcap: 1.2, at: 1_700_000_000, since: 22 } }),
    'first scanned here at 1.2 ETH · 22 scans since',
  );
  assert.equal(line({ firstScan: { mcap: 1.2, at: 1, since: 1 } }), 'first scanned here at 1.2 ETH · 1 scan since');
  assert.equal(line({ firstScan: { mcap: 1.2, at: 1, since: 0 } }), 'first scanned here at 1.2 ETH');
});

test('a first scan says nothing at all', () => {
  // No "you are first", no badge. There is nothing to report yet.
  const card = renderDefaultCard(makeScan({ firstScan: null }), 'b');
  assert.ok(!/first scanned|you are first|first here/i.test(card), `a first scan announced itself:\n${card}`);
});

test('the receipt is a fact, with no framing on it', () => {
  const FRAMING = /\b(early|good call|nice|well spotted|you (found|called)|congrat|winner|gem)\b/i;
  for (const since of [0, 1, 22, 5000]) {
    for (const mcap of [0.001, 1.2, 900, 120000]) {
      const card = renderDefaultCard(makeScan({ firstScan: { mcap, at: 1, since } }), 'b');
      assert.ok(!FRAMING.test(card), `framing reached the card at ${mcap}/${since}`);
    }
  }
});

// --------------------------------------------------- the largest single holder
test('the largest single holder is stated beside the aggregate', () => {
  const conc = (over) =>
    renderDefaultCard(makeScan(over), 'b').split('\n').find((l) => /top 5 hold/.test(l));
  // One wallet at 17% and five at 4% both aggregate to 21%, and they are not
  // the same situation.
  assert.equal(
    conc({ concentration: { top5Share: 21, top1Share: 17, holders: 40, circulating: 1n } }),
    'top 5 hold 21% — largest 17% · 40 holders',
  );
  assert.equal(
    conc({ concentration: { top5Share: 21, top1Share: 4.4, holders: 40, circulating: 1n } }),
    'top 5 hold 21% — largest 4% · 40 holders',
  );
});

test('a reading taken before the largest was recorded omits it rather than saying zero', () => {
  const line = renderDefaultCard(makeScan({
    concentration: { top5Share: 21, top1Share: 0, holders: 40, circulating: 1n },
  }), 'b').split('\n').find((l) => /top 5 hold/.test(l));
  assert.equal(line, 'top 5 hold 21% · 40 holders');
  assert.ok(!/largest/.test(line), 'a legacy row must not claim a largest holder of 0%');
});

test('the card is bounded at 14 lines with every optional line rendering', () => {
  const r = makeScan({
    ageSeconds: 1200, symbol: 'TOKEN', buyers: 38, roundTrippers: 3, progressPct: 12.4,
    windowMinutes: 20, flagsTotal: 9, benchmarkMedian: 12, benchmarkN: 412,
    concentration: { top5Share: 44.2, holders: 23, circulating: 1n },
    flags: [
      f('a', 'first concern', 100), f('b', 'second concern', 90), f('c', 'third concern', 80),
      f('d', 'fourth concern', 70), f('e', 'undetermined one', 1, 'unknown'),
    ],
  });
  r.traction.uniqueBuyers10m = 12;
  const lines = renderDefaultCard(r, 'vitalscheck_bot').split('\n');
  // header, blank, the lifted concern, blank, two more, "+N more", blank,
  // buyers, concentration, sold, growth, blank, footer. Fourteen: it gained the
  // blank line that does the lifting. This card is forwarded into groups, so
  // the ceiling is deliberate rather than incidental.
  assert.equal(lines.length, 14, lines.join('\n'));
  assert.equal(lines[lines.length - 1], '@vitalscheck_bot \u00b7 not financial advice');
});

test('concentration is stated once, not twice with two roundings', () => {
  const raised = {
    key: 'holder_concentration', label: 'Holder concentration', state: 'raised',
    detail: 'technical', compactDetail: 'x',
    plain: 'top 5 hold 44% of supply \u00b7 23 holders', severity: 60,
  };
  const card = renderDefaultCard(makeScan({
    ageSeconds: 1200, buyers: 38, windowMinutes: 20, benchmarkMedian: 12, benchmarkN: 412,
    concentration: { top5Share: 44.2, holders: 23, circulating: 1n }, flags: [raised],
  }), 'b');
  const mentions = card.split('\n').filter((l) => /top 5 hold/.test(l));
  assert.equal(mentions.length, 1, `stated ${mentions.length} times:\n${card}`);
  assert.match(mentions[0], /^(\u26a0\ufe0f|\u00b7) /, 'when it is a concern it belongs in the concerns block');
  assert.ok(mentions[0].includes('23 holders'), 'and it must not lose the holder count in the move');

  // unraised, it keeps its own slot below the buyer count
  const plainCard = renderDefaultCard(makeScan({
    ageSeconds: 1200, buyers: 38, windowMinutes: 20, benchmarkMedian: 12, benchmarkN: 412,
    concentration: { top5Share: 44.2, holders: 23, circulating: 1n },
  }), 'b');
  const lines = plainCard.split('\n');
  assert.equal(lines.filter((l) => /top 5 hold/.test(l)).length, 1);
  assert.ok(lines.indexOf('top 5 hold 44% \u00b7 23 holders') > lines.findIndex((l) => /^38 buyers/.test(l)));
});

test('a window under a minute is never rendered as "0 min"', () => {
  const buyer = (over) =>
    renderDefaultCard(makeScan(over), 'b').split('\n').find((l) => /^\d+ buyer|^no buyers/.test(l));
  // reachable when the host clock runs ahead of block progression: the token
  // reads as a minute old while only twenty seconds of blocks were observed
  assert.equal(
    buyer({ ageSeconds: 60, buyers: 1, windowMinutes: 20 / 60, benchmarkMedian: 1, benchmarkN: 412, measuredAtAge: false }),
    '1 buyer \u2014 median in the first 20s is 1',
  );
  assert.equal(
    buyer({ ageSeconds: 86400, buyers: 87, windowMinutes: 30, benchmarkMedian: 4, benchmarkN: 412 }),
    '87 buyers \u2014 median in the first 30 min is 4',
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
    '\u26a0\ufe0f 8 wallets got in tax-free before you could',
    '',
    '38 buyers \u2014 median at this age is 12',
    'top 5 hold 44% \u00b7 23 holders',
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
