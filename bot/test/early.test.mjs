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

// ------------------------------------------------ early cache cannot outlive the window
test('an early card is never served after the token stops being early', async () => {
  const { earlyTtlForTest } = await import('../dist/service.js');
  // at 5s there is plenty of window left, so the full 10s cap applies
  assert.equal(earlyTtlForTest({ early: true, ageSeconds: 5 }), 10_000);
  // at 175s only 5s of window remains, so the card must not outlive it
  assert.equal(earlyTtlForTest({ early: true, ageSeconds: 175 }), 5_000);
  // at 179s, one second
  assert.equal(earlyTtlForTest({ early: true, ageSeconds: 179 }), 1_000);
  // a settled card takes the normal cache lifetime
  assert.equal(earlyTtlForTest({ early: false, ageSeconds: 900 }), undefined);
});

test('an explicit tiny TTL is honoured, not silently promoted to the default', async () => {
  const c = new ScanCache(60_000, 10);
  const meta = { symbol: 'X', traction: 'early', flagsRaised: 0, flagsTotal: 7, flagsUnknown: 0, topFlag: null, notFound: false, early: true, ageSeconds: 179 };
  c.set('t', { card: 'c', compact: 'c', meta, ttlMs: 30 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.get('t'), null, 'a 30ms TTL must expire in 30ms, not inherit the 60s default');
});

// ------------------------------------------- config robustness (review round)
test('a malformed EARLY_WINDOW_SECONDS cannot silently disable early mode', async () => {
  // Number('180s') is NaN and `age < NaN` is false, which would switch the whole
  // mode off with nothing in the logs
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['-e',
    "import('./dist/config.js').then(c => console.log(JSON.stringify({w: c.EARLY_WINDOW_SECONDS, t: c.EARLY_CACHE_TTL_MS})))"],
    { cwd: process.cwd(), env: { ...process.env, EARLY_WINDOW_SECONDS: '180s', EARLY_CACHE_TTL_MS: 'abc' }, encoding: 'utf8' });
  const cfg = JSON.parse(out.trim().split('\n').pop());
  assert.equal(cfg.w, 180, 'falls back to the default rather than NaN');
  assert.equal(cfg.t, 10_000);
  assert.ok(Number.isFinite(cfg.w) && cfg.w > 0);
});

test('the drift margin is applied in the safe direction', async () => {
  const { EARLY_WINDOW_SECONDS, EARLY_DRIFT_MARGIN_SECONDS } = await import('../dist/config.js');
  assert.ok(EARLY_DRIFT_MARGIN_SECONDS > 0);
  // widening, never narrowing: a token that might still be early must not be
  // handed a traction verdict
  assert.ok(EARLY_WINDOW_SECONDS + EARLY_DRIFT_MARGIN_SECONDS > EARLY_WINDOW_SECONDS);
});

// ------------------------------------- review round 2: undetermined vs clean
test('an undecoded creation tx never renders as a clean creator-buy', () => {
  const undecoded = makeScan({ ageSeconds: 10, snipeExemptionCount: null, launchBuyAmount: null });
  const clean = makeScan({ ageSeconds: 10, snipeExemptionCount: 0, launchBuyAmount: null });
  const uText = renderCardText(undecoded);
  const cText = renderCardText(clean);
  assert.match(uText, /creator opening buy: unknown/);
  assert.doesNotMatch(uText, /creator opening buy: none/);
  assert.match(cText, /creator opening buy: none/);
});

test('an undecoded creation tx is visibly different from a clean one in compact', () => {
  const undecoded = renderCompactText(makeScan({ ageSeconds: 10, snipeExemptionCount: null }), 'b');
  const clean = renderCompactText(makeScan({ ageSeconds: 10, snipeExemptionCount: 0 }), 'b');
  assert.notEqual(undecoded, clean, 'undetermined must not be byte-identical to clean');
  assert.match(undecoded, /❔ creation tx not decoded — exemptions unconfirmed/);
  assert.doesNotMatch(clean, /not decoded/);
});

test('the undetermined line does not push the compact card over its budget', () => {
  const r = makeScan({
    ageSeconds: 10, snipeExemptionCount: null, launchBuyAmount: 10n ** 17n,
    flags: Array.from({ length: 5 }, (_, i) => flag(`f${i}`, 'raised', `finding ${i}`, i * 10)),
  });
  const lines = renderCompactText(r, 'vitalscheck_bot').split('\n');
  assert.ok(lines.length <= 8, `compact card was ${lines.length} lines`);
  assert.equal(lines.filter((l) => l.startsWith('❔')).length, 1);
  assert.equal(lines.filter((l) => l.startsWith('🚩')).length, 1, 'one slot yields to the undetermined line');
});

// ------------------------- review round 3: one lifetime, two caches, one rule
test('the TTL cap uses the threshold that actually decided early, not the constant', async () => {
  const { earlyTtlForTest } = await import('../dist/service.js');
  // exact launch time available: threshold 180
  assert.equal(earlyTtlForTest({ early: true, ageSeconds: 179, earlyThresholdSeconds: 180 }), 1_000);
  // no exact launch time: threshold widened to 190, so 185 still has life left.
  // Against the bare constant this would compute -5000 and clamp to 0, meaning
  // the card is never cached and every request in that state re-scans.
  assert.equal(earlyTtlForTest({ early: true, ageSeconds: 185, earlyThresholdSeconds: 190 }), 5_000);
  assert.ok(earlyTtlForTest({ early: true, ageSeconds: 185, earlyThresholdSeconds: 190 }) > 0);
});

test('Telegram inline cache_time matches the in-process TTL exactly', async () => {
  const { inlineCacheSeconds, earlyTtlForTest } = await import('../dist/service.js');
  for (const ageSeconds of [0, 5, 60, 175, 179]) {
    const meta = { early: true, ageSeconds, earlyThresholdSeconds: 180 };
    const server = earlyTtlForTest(meta);
    const telegram = inlineCacheSeconds(meta);
    assert.equal(telegram, Math.max(1, Math.round(server / 1000)),
      `at ${ageSeconds}s Telegram would cache ${telegram}s against a server TTL of ${server}ms`);
    assert.ok(telegram <= 10, `Telegram cache_time ${telegram}s exceeds the 10s early cap`);
  }
  // a settled card goes back to the normal minute
  assert.equal(inlineCacheSeconds({ early: false, ageSeconds: 900, earlyThresholdSeconds: 180 }), 60);
});

test('an early card is never served past its own window, by either cache', async () => {
  const { earlyTtlForTest, inlineCacheSeconds } = await import('../dist/service.js');
  for (const ageSeconds of [170, 175, 179]) {
    const meta = { early: true, ageSeconds, earlyThresholdSeconds: 180 };
    const expiresAt = ageSeconds + earlyTtlForTest(meta) / 1000;
    assert.ok(expiresAt <= 180, `server cache would serve an early card until ${expiresAt}s`);
    assert.ok(ageSeconds + inlineCacheSeconds(meta) <= 181, 'Telegram cache would overrun the window');
  }
});

// --------------------------------------- review round 4: spec-literal details
test('the early cache TTL is a ceiling, not a default configuration can raise', async () => {
  const { execFileSync } = await import('node:child_process');
  const read = (env) => JSON.parse(execFileSync(process.execPath, ['-e',
    "import('./dist/config.js').then(c => console.log(JSON.stringify({t: c.EARLY_CACHE_TTL_MS})))"],
    { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8' }).trim().split('\n').pop()).t;
  assert.equal(read({ EARLY_CACHE_TTL_MS: '60000' }), 10_000, 'configuration must not raise the 10s maximum');
  assert.equal(read({ EARLY_CACHE_TTL_MS: '3000' }), 3_000, 'but may lower it');
});

test('the early full card says nothing about traction beyond the two specified lines', () => {
  const text = renderCardText(makeScan({ ageSeconds: 12, snipeExemptionCount: 8 }));
  const mentions = text.split('\n').filter((l) => /traction/i.test(l));
  // exactly the spec's header and its single replacement line -- an earlier
  // draft also appended "Traction: not yet measurable." to the summary, which
  // restated the replacement line the spec says is the only one
  assert.deepEqual(mentions, [
    'launched 12s ago — too early for traction',
    'traction unavailable — the snipe tax window is still open. re-scan in 2 minutes.',
  ]);
});

// ------------------- review round 5: stale NULLs and pair-token decimals
test('a stale NULL buy amount is never reported as a confident "none"', async () => {
  const { creationUndecoded } = await import('../dist/card.js');
  // the shape the old upsert produced: exemption count decoded, buy amount lost
  const stale = makeScan({ ageSeconds: 12, snipeExemptionCount: 8, entryPoint: 'launchAndBuy', launchBuyAmount: null });
  assert.equal(creationUndecoded(stale), false, 'a fully decoded row is not "undecoded"');

  // and a genuinely undecoded row is caught even though the count column alone
  // would not reveal it
  const undecoded = makeScan({ ageSeconds: 12, snipeExemptionCount: null, entryPoint: 'unknown', launchBuyAmount: null });
  assert.equal(creationUndecoded(undecoded), true);
  assert.match(renderCardText(undecoded), /creator opening buy: unknown/);

  const clean = makeScan({ ageSeconds: 12, snipeExemptionCount: 0, entryPoint: 'launchToken', launchBuyAmount: null });
  assert.equal(creationUndecoded(clean), false);
  assert.match(renderCardText(clean), /creator opening buy: none/);
});

test('quote amounts use the pair token decimals, not a hardcoded 18', () => {
  // USDG on this chain has 6 decimals; 5 USDG is 5_000_000 base units
  const usdg = makeScan({
    ageSeconds: 12, pairSymbol: 'USDG', pairDecimals: 6,
    snipeExemptionCount: 1, launchBuyAmount: 5_000_000n,
  });
  const text = renderCardText(usdg);
  assert.match(text, /creator opening buy: 5 USDG/, `printed: ${text.split('\n').find((l) => /creator opening buy/.test(l))}`);
  assert.doesNotMatch(text, /0\.000000000005/, 'an 18-decimal reading would be 10^12 times too small');
});

test('the settled card also uses pair decimals for the median buy', () => {
  const usdg = makeScan({
    ageSeconds: 1800, pairSymbol: 'USDG', pairDecimals: 6,
    medianBuySize: 12_500_000n, buyers: 9, roundTrippers: 1,
  });
  const line = renderCardText(usdg).split('\n').find((l) => /median buy/.test(l));
  assert.match(line, /median buy: 12\.5 USDG/, `printed: ${line}`);
});
