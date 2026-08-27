import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCard, renderCardText, renderCompactCard, renderCompactText,
  compactMeta, inlineDescription, earlyFindings, EARLY_TRACTION_LINE, COMPACT_DISCLAIMER,
} from '../dist/card.js';
import { ScanCache } from '../dist/cache.js';
import { makeScan, flag } from './fixtures.mjs';

const AGES_EARLY = [5, 60, 179];
const AGE_NORMAL = 181;

// ------------------------------------------------------------ the rule itself
test('under 180s the card never claims TRACTION none', () => {
  for (const ageSeconds of AGES_EARLY) {
    const r = makeScan({ ageSeconds, traction: 'none', buyers: 0, roundTrippers: 0 });
    const full = renderCardText(r);
    const compact = renderCompactText(r, 'vitalscheck_bot');
    for (const [name, text] of [['full', full], ['compact', compact]]) {
      assert.doesNotMatch(text, /TRACTION\s+none/i, `${name} card at ${ageSeconds}s printed "TRACTION none"`);
      assert.doesNotMatch(text, /traction none/i, `${name} card at ${ageSeconds}s printed "traction none"`);
    }
  }
});

test('under 180s the structurally-undefined metrics are absent, not zeroed', () => {
  for (const ageSeconds of AGES_EARLY) {
    const r = makeScan({ ageSeconds, buyers: 0, roundTrippers: 0 });
    for (const [name, text] of [
      ['full', renderCardText(r)],
      ['compact', renderCompactText(r, 'b')],
    ]) {
      assert.doesNotMatch(text, /round-trippers/i, `${name} at ${ageSeconds}s printed round-trippers`);
      assert.doesNotMatch(text, /buyer growth/i, `${name} at ${ageSeconds}s printed buyer growth`);
      assert.doesNotMatch(text, /progress velocity/i, `${name} at ${ageSeconds}s printed progress velocity`);
      assert.doesNotMatch(text, /unique buyers/i, `${name} at ${ageSeconds}s printed unique buyers`);
    }
  }
});

test('at 181s the normal card is rendered', () => {
  const r = makeScan({ ageSeconds: AGE_NORMAL, traction: 'none', buyers: 0, roundTrippers: 0 });
  const full = renderCardText(r);
  const compact = renderCompactText(r, 'vitalscheck_bot');
  assert.match(full, /TRACTION\s+none/, 'the normal full card is expected at 181s');
  assert.match(full, /progress velocity/i);
  assert.match(compact, /^traction none/m, 'the normal compact card is expected at 181s');
  assert.match(compact, /round-trippers/);
  assert.doesNotMatch(full, /too early for traction/);
  assert.doesNotMatch(compact, /too early for traction/);
});

test('the 179s/181s boundary flips exactly once', () => {
  const early = (n) => renderCardText(makeScan({ ageSeconds: n })).includes('too early for traction');
  assert.equal(early(0), true);
  assert.equal(early(179), true);
  assert.equal(early(180), false, '180 is not "under 180"');
  assert.equal(early(181), false);
});

// ------------------------------------------------------------------ full card
test('early full card: header, replacement line, no traction block', () => {
  const r = makeScan({ ageSeconds: 12, snipeExemptionCount: 8, launchBuyAmount: 10n ** 17n });
  const text = renderCardText(r);
  assert.match(text, /launched 12s ago — too early for traction/);
  assert.ok(text.includes(EARLY_TRACTION_LINE), `missing the replacement line:\n${text}`);
  assert.match(text, /re-scan in 2 minutes/);
  assert.doesNotMatch(text, /^TRACTION/m);
  assert.ok(text.trim().endsWith('Signals and flags only. Not financial advice.'));
});

test('early full card shows what IS fixed at creation', () => {
  const r = makeScan({
    ageSeconds: 30, snipeExemptionCount: 8, launchBuyAmount: 3n * 10n ** 17n,
    flags: [
      flag('creator_tax', 'raised', 'creator tax 300 bps vs 90 bps median', 60),
      flag('deployer_rate', 'raised', 'deployer launched 91 other tokens in 7d', 55),
      flag('collision', 'raised', 'name collides with 60 tokens after homoglyph normalisation', 70),
    ],
  });
  const text = renderCardText(r);
  assert.match(text, /8 wallets pre-exempted from the opening tax/);
  assert.match(text, /creator opening buy: 0\.3 .* bought in the launch transaction/);
  assert.match(text, /creator tax/i);
  assert.match(text, /deployer/i);
  assert.match(text, /collision/i);
  assert.match(text, /buyback/i);
});

test('early full card reports an undecoded creation tx as undetermined, never clean', () => {
  const r = makeScan({ ageSeconds: 9, snipeExemptionCount: null });
  const text = renderCardText(r);
  assert.match(text, /not decoded — not confirmed clean/);
  assert.doesNotMatch(text, /none — no wallets pre-exempted/);
});

// --------------------------------------------------------------- compact card
test('early compact card matches the specified shape exactly', () => {
  const r = makeScan({
    ageSeconds: 12, symbol: 'TICKER',
    snipeExemptionCount: 8, launchBuyAmount: 10n ** 17n,
  });
  const lines = renderCompactText(r, 'vitalscheck_bot').split('\n');
  assert.deepEqual(lines, [
    'VITALS  $TICKER',
    'launched 12s ago · too early for traction',
    '🚩 8 wallets pre-exempted from the opening tax',
    '🚩 creator bought in the launch tx',
    're-scan in 2 min',
    'via @vitalscheck_bot · signals only, not financial advice',
  ]);
});

test('early compact card shows at most two findings', () => {
  const r = makeScan({
    ageSeconds: 5, snipeExemptionCount: 13, launchBuyAmount: 10n ** 17n,
    flags: Array.from({ length: 5 }, (_, i) => flag(`f${i}`, 'raised', `finding ${i}`, i * 10)),
  });
  const lines = renderCompactText(r, 'b').split('\n');
  assert.equal(lines.filter((l) => l.startsWith('🚩')).length, 2);
  assert.equal(lines.length, 6);
});

test('early compact card with nothing raised still says too early and re-scan', () => {
  const r = makeScan({ ageSeconds: 3, snipeExemptionCount: 0, launchBuyAmount: null });
  const lines = renderCompactText(r, 'b').split('\n');
  assert.deepEqual(lines, [
    'VITALS  $GHATS',
    'launched 3s ago · too early for traction',
    're-scan in 2 min',
    'via @b · signals only, not financial advice',
  ]);
});

test('early findings lead with the exemption count, then the creator buy', () => {
  const r = makeScan({
    ageSeconds: 5, snipeExemptionCount: 3, launchBuyAmount: 10n ** 16n,
    flags: [flag('collision', 'raised', 'name collides with 2 tokens', 70)],
  });
  assert.deepEqual(earlyFindings(r), [
    '3 wallets pre-exempted from the opening tax',
    'creator bought in the launch tx',
    'name collides with 2 tokens',
  ]);
});

test('early findings never promote an undetermined flag', () => {
  const r = makeScan({
    ageSeconds: 5, snipeExemptionCount: null,
    flags: [flag('peaks', 'unknown', 'no prior outcomes for this deployer yet', 900)],
  });
  assert.deepEqual(earlyFindings(r), [], 'undetermined is not a finding');
});

// -------------------------------------------------------------------- inline
test('inline metadata reports early, not a traction verdict', () => {
  const m = compactMeta(makeScan({ ageSeconds: 7, traction: 'none', snipeExemptionCount: 8 }));
  assert.equal(m.early, true);
  assert.equal(m.traction, 'early', 'must not report the computed "none"');
  assert.equal(m.ageSeconds, 7);
  const d = inlineDescription(m);
  assert.match(d, /launched 7s ago · too early for traction/);
  assert.doesNotMatch(d, /traction none/);
});

test('inline metadata past the window reports the real verdict again', () => {
  const m = compactMeta(makeScan({ ageSeconds: 181, traction: 'building' }));
  assert.equal(m.early, false);
  assert.equal(m.traction, 'building');
  assert.match(inlineDescription(m), /traction building/);
});

// --------------------------------------------------------------------- cache
test('early results are cached for 10s, not the normal 60s', async () => {
  const c = new ScanCache(60_000, 10);
  const meta = (early) => ({
    symbol: 'X', traction: early ? 'early' : 'none', flagsRaised: 0, flagsTotal: 7,
    flagsUnknown: 0, topFlag: null, notFound: false, early, ageSeconds: early ? 5 : 900,
  });
  c.set('early', { card: 'c', compact: 'c', meta: meta(true), ttlMs: 40 });
  c.set('settled', { card: 'c', compact: 'c', meta: meta(false) });
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(c.get('early'), null, 'the early entry must have expired on its own short TTL');
  assert.ok(c.get('settled'), 'the settled entry keeps the normal TTL');
});

test('a per-entry TTL never outlives the cache default silently', () => {
  const c = new ScanCache(1000, 10);
  c.set('a', { card: 'c', compact: 'c', meta: { symbol: null, traction: 'none', flagsRaised: 0, flagsTotal: 7, flagsUnknown: 0, topFlag: null, notFound: false, early: false, ageSeconds: 0 } });
  assert.ok(c.peek('a'), 'default TTL applies when no per-entry TTL is set');
});

// ----------------------------------------------------------------- invariants
test('every early card still carries its disclaimer and no trade language', () => {
  const banned = /price target|will pump|safe to buy|good entry|recommend|moon/i;
  for (const ageSeconds of [0, 1, 5, 60, 179]) {
    for (const over of [{ snipeExemptionCount: 0 }, { snipeExemptionCount: 13, launchBuyAmount: 10n ** 18n }]) {
      const r = makeScan({ ageSeconds, ...over });
      const full = renderCardText(r);
      const compact = renderCompactText(r, 'vitalscheck_bot');
      assert.ok(full.trim().endsWith('Signals and flags only. Not financial advice.'));
      assert.ok(compact.trim().endsWith(COMPACT_DISCLAIMER));
      assert.ok(!banned.test(full) && !banned.test(compact));
      assert.ok(compact.split('\n').length <= 8);
    }
  }
});

test('early HTML is balanced so Telegram will accept it', () => {
  const r = makeScan({ ageSeconds: 12, symbol: '<b>evil</b>', snipeExemptionCount: 8, launchBuyAmount: 1n });
  for (const html of [renderCard(r), renderCompactCard(r, 'b')]) {
    for (const tag of ['b', 'i', 'code', 'a']) {
      const open = (html.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'g')) || []).length;
      const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      assert.equal(open, close, `unbalanced <${tag}> in an early card`);
    }
    assert.ok(html.includes('&lt;'), 'hostile ticker still escaped in early mode');
  }
});
