/**
 * The rules between a typed confirmation and a real transaction.
 *
 * tools/launch.mjs is a wallet and a prompt wrapped around these, and neither
 * of those can be tested. These can, and they are the ones that decide whether
 * a launch goes out at all: whether the curve model still describes the chain,
 * how much of its own supply the launch buys, and what hour it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('launch-tool');
const C = await import('../dist/curve.js');
const P = await import('../dist/launchplan.js');

/** Launch config 0, as the factory reports it. Read live on 2026-09-15. */
const CFG = { supply: 10n ** 27n, phantomQuote: 1_680_000_000_000_000_000n, curveFeeBps: 100n };

// ------------------------------------------------------------- calibration

test('the model reproduces the ZZZ launch to the wei', () => {
  const cal = C.calibrate(CFG);
  assert.equal(cal.ok, true, cal.line);
  assert.equal(cal.predicted, C.CALIBRATION.tokensOut, 'not exact');
  assert.equal(cal.errorPct, 0);
  assert.match(cal.line, /^curve calibrated: reproduces 0x2121ea24 to the wei$/);
});

test('the calibration point is the transaction it claims to be', () => {
  // 0.5 ETH, no creator tax, 227,586,206.896551724137931034 tokens out of a
  // supply of 1,000,000,000: 22.7586% of it. Checked here so a later edit
  // cannot quietly move the point the model is measured against.
  assert.equal(C.CALIBRATION.quoteIn, 500_000_000_000_000_000n);
  assert.equal(C.CALIBRATION.creatorTaxBps, 0n);
  assert.equal(C.CALIBRATION.tokensOut, 227_586_206_896_551_724_137_931_034n);
  const pct = C.quoteLaunchBuy(CFG, 0n, C.CALIBRATION.quoteIn).supplyPct;
  assert.ok(Math.abs(pct - 22.7586) < 0.0001, `${pct}`);
});

test('a model that misses the point is refused, and says by how much', () => {
  // Each of the three inputs, wrong on its own.
  for (const [what, bad] of [
    ['phantom quote', { ...CFG, phantomQuote: 2_000_000_000_000_000_000n }],
    ['supply', { ...CFG, supply: 10n ** 26n }],
    ['curve fee', { ...CFG, curveFeeBps: 300n }],
  ]) {
    const cal = C.calibrate(bad);
    assert.equal(cal.ok, false, `a wrong ${what} calibrated anyway`);
    assert.match(cal.line, /does not reproduce/);
    assert.ok(Math.abs(cal.errorPct) > C.CALIBRATION_TOLERANCE_PCT, `${what}: ${cal.errorPct}%`);
  }
});

test('the tolerance is one percent, and is applied to both sides', () => {
  assert.equal(C.CALIBRATION_TOLERANCE_PCT, 1);
  const near = (pct) => ({
    ...C.CALIBRATION,
    tokensOut: C.CALIBRATION.tokensOut * BigInt(Math.round(1e9 * (1 + pct / 100))) / 1_000_000_000n,
  });
  assert.equal(C.calibrate(CFG, near(0.9)).ok, true, '0.9% out must pass');
  assert.equal(C.calibrate(CFG, near(-0.9)).ok, true, '0.9% under must pass');
  assert.equal(C.calibrate(CFG, near(1.1)).ok, false, '1.1% out must fail');
  assert.equal(C.calibrate(CFG, near(-1.1)).ok, false, '1.1% under must fail');
});

// ------------------------------------------------- the model against receipts

test('the model reproduces other real launch buys, including a creator tax', () => {
  // Three more launch transactions, read from their CurveBuy events. The tax
  // is the part a model without it gets wrong: it is deducted from the input
  // before the curve sees it, so a taxed launch buys less than an untaxed one
  // for the same ETH.
  const measured = [
    { sym: 'RVN', eth: 50_000_000_000_000_000n, taxBps: 0n, out: 28_620_988_725_065_047_701_647_875n },
    { sym: 'POKECAT', eth: 12_000_000_000_000_000n, taxBps: 250n, out: 6_845_670_911_219_096_938_956_478n },
    { sym: 'STOX', eth: 15_000_000_000_000_000n, taxBps: 120n, out: 8_656_552_603_161_677_494_733_487n },
  ];
  for (const m of measured) {
    const q = C.quoteLaunchBuy(CFG, m.taxBps, m.eth);
    assert.equal(q.tokensOut, m.out, `${m.sym} is off by ${q.tokensOut - m.out} wei`);
  }
  // And the tax genuinely matters: the same ETH at no tax buys more.
  const taxed = C.quoteLaunchBuy(CFG, 250n, 12_000_000_000_000_000n).tokensOut;
  const free = C.quoteLaunchBuy(CFG, 0n, 12_000_000_000_000_000n).tokensOut;
  assert.ok(free > taxed, 'a creator tax must reduce what the opening buy receives');
});

test('the cuts are floored separately, as the contract floors them', () => {
  // An amount where taking both cuts together and flooring once differs from
  // flooring each: 1 wei of difference in the input is a different token amount.
  const q = C.quoteBuy({
    quoteReserve: 1_680_000_000_000_000_000n, tokenReserve: 10n ** 27n,
    curveFeeBps: 100n, creatorTaxBps: 250n, quoteIn: 12_345n,
  });
  assert.equal(q.curveFee, 123n);
  assert.equal(q.creatorTax, 308n);
  assert.equal(q.quoteNet, 12_345n - 123n - 308n);
});

test('a buy smaller than its own fees returns nothing rather than a negative', () => {
  const q = C.quoteBuy({
    quoteReserve: 1_680_000_000_000_000_000n, tokenReserve: 10n ** 27n,
    curveFeeBps: 5000n, creatorTaxBps: 5000n, quoteIn: 10n,
  });
  assert.equal(q.quoteNet, 0n);
  assert.equal(q.tokensOut, 0n);
  assert.equal(q.supplyPct, 0);
});

// --------------------------------------------------------------- the cap

test('the dev buy cap is five percent of supply, and refuses above it', () => {
  assert.equal(P.DEV_BUY_MAX_PCT, 5);
  assert.equal(P.checkDevBuyCap(4.9999).ok, true);
  assert.equal(P.checkDevBuyCap(5).ok, true, 'exactly at the cap is not over it');
  const over = P.checkDevBuyCap(5.0001);
  assert.equal(over.ok, false);
  assert.match(over.reason, /5\.0001% of supply, over the 5% cap/);
  assert.match(over.reason, /lower devBuyEth/);
});

test('the cap is checked against the share, not the ETH', () => {
  // The same 0.09 ETH is over the cap at no creator tax and under it at 2.5%,
  // because the tax comes off the input before the curve sees it. An ETH
  // figure alone cannot answer the question the cap asks.
  const free = C.quoteLaunchBuy(CFG, 0n, 90_000_000_000_000_000n);
  const taxed = C.quoteLaunchBuy(CFG, 250n, 90_000_000_000_000_000n);
  assert.ok(free.supplyPct > 5, `no tax: ${free.supplyPct}%`);
  assert.ok(taxed.supplyPct < 5, `2.5% tax: ${taxed.supplyPct}%`);
  assert.equal(P.checkDevBuyCap(free.supplyPct).ok, false, 'the untaxed buy is over the cap');
  assert.equal(P.checkDevBuyCap(taxed.supplyPct).ok, true, 'the taxed buy is under it');
});

test('a share that could not be computed is refused, never waved through', () => {
  const r = P.checkDevBuyCap(Number.NaN);
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be computed/);
});

// ------------------------------------------------------------- the window

/** A wall-clock time in Europe/Bratislava, as a unix ms instant. */
const { zonedToUtcMs } = await import('../dist/launch.js');
const bratislava = (y, m, d, hh, mm = 0) => zonedToUtcMs(y, m, d, hh, mm, 'Europe/Bratislava');

test('inside Mon to Thu, 15:00 to 18:00, it runs', () => {
  for (const [label, d] of [
    ['Mon 15:00', bratislava(2026, 9, 14, 15, 0)],
    ['Tue 16:30', bratislava(2026, 9, 15, 16, 30)],
    ['Thu 17:59', bratislava(2026, 9, 17, 17, 59)],
  ]) {
    assert.equal(P.checkLaunchWindow(d).ok, true, `${label} was refused`);
  }
});

test('outside it, it refuses and says what time it thinks it is', () => {
  const cases = [
    ['Tue 14:59, a minute early', bratislava(2026, 9, 15, 14, 59), /Tue 14:59 CEST/],
    ['Tue 18:00, on the edge', bratislava(2026, 9, 15, 18, 0), /Tue 18:00 CEST/],
    ['Fri 16:00, the wrong day', bratislava(2026, 9, 18, 16, 0), /Fri 16:00 CEST/],
    ['Sun 16:00', bratislava(2026, 9, 13, 16, 0), /Sun 16:00 CEST/],
  ];
  for (const [label, d, says] of cases) {
    const r = P.checkLaunchWindow(d);
    assert.equal(r.ok, false, `${label} was allowed`);
    assert.match(r.reason, says);
    assert.match(r.reason, /Mon to Thu, 15:00 to 18:00 Europe\/Bratislava/);
    assert.match(r.reason, /--force/);
  }
});

test('the window is the local hour in winter too, not a fixed offset', () => {
  // January is CET, an hour off September's CEST. A hardcoded offset would put
  // the window an hour wrong for five months of the year.
  assert.equal(P.checkLaunchWindow(bratislava(2026, 1, 14, 16, 0)).ok, true, 'Wed 16:00 CET was refused');
  assert.equal(P.checkLaunchWindow(bratislava(2026, 1, 14, 14, 30)).ok, false);
  const r = P.checkLaunchWindow(bratislava(2026, 1, 14, 14, 30));
  assert.match(r.reason, /CET/, 'the zone abbreviation is read, not assumed');
});

test('--force goes anyway, and only with --force', () => {
  const sunday = bratislava(2026, 9, 13, 3, 0);
  assert.equal(P.checkLaunchWindow(sunday, false).ok, false);
  assert.equal(P.checkLaunchWindow(sunday, true).ok, true);
});

// ------------------------------------------------------------ the config

const GOOD = JSON.parse(JSON.stringify({
  name: 'VITALS', symbol: 'VITALS', logo: 'ipfs://x', description: 'd',
  socials: { twitter: '', telegram: 't', discord: '', website: 'w', farcaster: '' },
  creatorFeeRecipient: '0x' + '1'.repeat(40), creatorTaxBps: 0, buybackEnabled: false,
  expectedEconomics: '0x' + 'a'.repeat(64), salt: '0x' + 'b'.repeat(64),
  launchConfigId: 0, pairToken: '0x' + '0'.repeat(40),
  devBuyEth: '0.05', minTokensOut: '0', recipient: '0x' + '2'.repeat(40),
  extraExemptions: [], rehearsal: { symbolSuffix: 'RH1', devBuyEth: '0.001' },
}));

test('the shipped config file is valid', () => {
  const raw = JSON.parse(readFileSync(new URL('../tools/launch.config.json', import.meta.url), 'utf8'));
  const r = P.validateConfig(raw);
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join('; '));
});

test('a fee recipient or a buy recipient of zero is refused', () => {
  const zero = '0x' + '0'.repeat(40);
  const a = P.validateConfig({ ...GOOD, creatorFeeRecipient: zero });
  assert.equal(a.ok, false);
  assert.ok(a.errors.some((e) => /creatorFeeRecipient is the zero address/.test(e)));
  const b = P.validateConfig({ ...GOOD, recipient: zero });
  assert.equal(b.ok, false);
  assert.ok(b.errors.some((e) => /opening buy would be burned/.test(e)));
});

test('a pair that is not ETH is refused, because the model is not calibrated for it', () => {
  const r = P.validateConfig({ ...GOOD, pairToken: '0x' + 'c'.repeat(40) });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not ETH/.test(e)), r.errors.join('; '));
});

test('every malformed field is named, not just the first', () => {
  const r = P.validateConfig({ ...GOOD, symbol: '', expectedEconomics: '0xnope', creatorTaxBps: 2000, extraExemptions: ['nope'] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 4, r.errors.join('; '));
  assert.ok(r.errors.some((e) => /symbol is empty/.test(e)));
  assert.ok(r.errors.some((e) => /expectedEconomics/.test(e)));
  assert.ok(r.errors.some((e) => /0\.\.1000/.test(e)));
  assert.ok(r.errors.some((e) => /extraExemptions\[0\]/.test(e)));
});

test('a rehearsal never carries the real ticker', () => {
  assert.equal(P.rehearsalSymbol('VITALS', 'RH1'), 'VITALSRH1');
  assert.notEqual(P.rehearsalSymbol('VITALS', 'RH1'), 'VITALS');
  const r = P.validateConfig({ ...GOOD, rehearsal: { symbolSuffix: '  ', devBuyEth: '0' } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /must not carry the real ticker/.test(e)));
});

// ----------------------------------------------------------- amounts, diff

test('ETH decimals convert exactly, with no float in the path', () => {
  assert.equal(P.toWei('0.05'), 50_000_000_000_000_000n);
  assert.equal(P.toWei('1'), 10n ** 18n);
  assert.equal(P.toWei('0.000000000000000001'), 1n);
  assert.equal(P.toWei('123.456'), 123_456_000_000_000_000_000n);
  assert.throws(() => P.toWei('0.0000000000000000001'), /more than 18 decimal places/);
  assert.equal(P.fromWei(50_000_000_000_000_000n), '0.05');
  assert.equal(P.fromWei(10n ** 18n), '1.0');
});

test('the diff separates a field that differs from one this mode cannot read', () => {
  const rows = P.diffRows(
    { symbol: 'VITALS', token: '0xAbC', openingBuyTokens: '100' },
    { symbol: 'VITALS', token: '0xdef', openingBuyTokens: null },
  );
  const by = Object.fromEntries(rows.map((r) => [r.field, r]));
  assert.equal(by.symbol.same, true);
  assert.equal(by.token.same, false, 'a real difference was missed');
  assert.equal(by.openingBuyTokens.unobserved, true);
  assert.equal(by.openingBuyTokens.same, false);

  const text = P.renderDiff(rows);
  assert.match(text, /^config vs chain: 1 field differs, 1 not observable in this mode/);
  assert.match(text, /! token/);
  assert.match(text, /\? openingBuyTokens .*\(not read in this mode\)/);

  // A dry run reads nothing from a receipt, and must not report that as a problem.
  const dry = P.renderDiff(P.diffRows({ a: '1', b: '2' }, { a: '1', b: null }));
  assert.match(dry, /^config vs chain: every field the chain reported matches, 1 not observable/);
  assert.doesNotMatch(dry, /differ/);
});

test('an address that differs only in case is the same address', () => {
  const rows = P.diffRows({ token: '0xAbCdEf' }, { token: '0xabcdef' });
  assert.equal(rows[0].same, true);
});

// ------------------------------------------------ the inverse, and the table

test('the inverse lands under the share it was asked for, never over', () => {
  for (const tax of [0n, 400n, 1000n]) {
    for (const pct of [0.5, 1, 2, 3, 4.2, 5, 10, 22.7586]) {
      const q = C.quoteInForSupplyPct(CFG, tax, pct);
      const got = C.quoteLaunchBuy(CFG, tax, q).supplyPct;
      assert.ok(got <= pct, `${pct}% at ${tax}bps: ${q} wei takes ${got}%, over the target`);
      // And it is the LARGEST such amount: one wei more goes over.
      const more = C.quoteLaunchBuy(CFG, tax, q + 1n).supplyPct;
      assert.ok(more > pct, `${pct}% at ${tax}bps: not the largest, ${q + 1n} wei still takes only ${more}%`);
    }
  }
});

test('the share is resolved finely enough for the inverse to be exact', () => {
  // At the old resolution of 0.0001% the inverse overshot by a THOUSAND tokens
  // and the published table said 1% where the buy took 1.0001%. At 1e-10% the
  // overshoot is one granule, a thousandth of a token on a supply of a billion.
  const onePct = CFG.supply / 100n;
  const out = C.quoteLaunchBuy(CFG, 400n, C.quoteInForSupplyPct(CFG, 400n, 1)).tokensOut;
  const off = out > onePct ? out - onePct : onePct - out;
  assert.ok(off < 10n ** 16n, `1% of supply is ${onePct}, the inverse gives ${out}, off by ${off} wei`);
  // The figure a human reads is right either way.
  assert.equal((Number(out / 10n ** 15n) / 1000).toFixed(0), '10000000');
});

test('the figure in the docs for 5% at our tax is under the cap, and rounding up is not', () => {
  // The table's safe column, and the trap beside it.
  const safe = P.toWei('0.0930');
  const rounded = P.toWei('0.0931');
  assert.equal(P.checkDevBuyCap(C.quoteLaunchBuy(CFG, 400n, safe).supplyPct).ok, true);
  assert.equal(P.checkDevBuyCap(C.quoteLaunchBuy(CFG, 400n, rounded).supplyPct).ok, false,
    '0.0931 is 5.0012% and must be refused');
});

test('the docs table is the model, not a hand-written number', async () => {
  const md = readFileSync(new URL('../docs/launch-configs.md', import.meta.url), 'utf8');
  const rows = [...md.matchAll(/^\| (\d+)% \| ([\d,]+) \| ([\d.]+) \| \*\*([\d.]+)\*\* \(([\d.]+)%\) \| ([\d.]+) \|$/gm)];
  assert.equal(rows.length, 5, 'the table is not where the docs say it is');
  for (const [, pct, tokens, exact, safe, safePct] of rows) {
    const q = C.quoteInForSupplyPct(CFG, 400n, Number(pct));
    const b = C.quoteLaunchBuy(CFG, 400n, q);
    // Compared as numbers: the doc prints six places, fromWei trims zeros.
    assert.ok(Math.abs(Number(exact) - Number(P.fromWei(q, 6))) < 1e-6,
      `${pct}%: docs say ${exact}, model says ${P.fromWei(q, 6)}`);
    assert.equal(Math.round(Number(b.tokensOut / 10n ** 18n)).toLocaleString('en-US'), tokens);
    const sb = C.quoteLaunchBuy(CFG, 400n, P.toWei(safe));
    assert.equal(sb.supplyPct.toFixed(4), safePct, `${pct}%: the safe column's share is wrong`);
    assert.ok(sb.supplyPct <= Number(pct), `${pct}%: the safe column is over its own target`);
  }
});
