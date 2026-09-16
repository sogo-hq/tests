import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Holder concentration, check 09.
 *
 * Two rules do the work here and both are pinned. The top five of five or fewer
 * holders is 100% by arithmetic, so below that the answer is undetermined and
 * never a raised flag -- on the index this was written against, 7 of the 10
 * measurable tokens had six holders or fewer, so getting this wrong would have
 * raised a concern on nearly every launch. And the threshold is a percentile of
 * what the index recorded for a comparable holder count, never a number chosen
 * in the source, with the sample published beside it in /full.
 */
const CWD = process.cwd();

function inTempDb(body, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-conc-'));
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { db } = await import('${CWD}/dist/db.js');
      const C = await import('${CWD}/dist/metrics/concentration.js');
      const { computeFlags } = await import('${CWD}/dist/metrics/flags.js');
      const A = (n) => '0x' + String(n).padStart(40, '0');
      /** Record an observation the way a scan would. */
      const obs = (token, share, holders) =>
        C.recordConcentration(token, { top5Share: share, top1Share: share / 5, holders, circulating: 100n }, 1);
      /** The most even share this many wallets can produce. */
      const floorOf = (h) => C.arithmeticFloor(h);
      /** A share that sits a given fraction of the way from that floor to 100%. */
      const atExcess = (h, e) => floorOf(h) + e * (100 - floorOf(h));
      const flagFor = (concentration) => computeFlags({
        token: A(1), deployer: A(2), name: 'T', symbol: 'T', creatorTaxBps: 0,
        buybackEnabled: false, pairToken: '0x0000000000000000000000000000000000000000',
        pairSymbol: 'ETH', scannedAt: 1_000_000, concentration,
      }).flags.find((f) => f.key === 'holder_concentration');
      ${body}
    `], { cwd: CWD, env: { ...process.env, DB_PATH: join(dir, 'c.db'), ...env }, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the pool is not a wallet', () => {
  const out = inTempDb(`
    const { NON_HOLDER_ADDRESSES, POOL_MANAGER } = await import('${CWD}/dist/config.js');
    console.log(JSON.stringify({
      list: NON_HOLDER_ADDRESSES,
      hasPool: NON_HOLDER_ADDRESSES.includes(POOL_MANAGER.toLowerCase()),
      allLower: NON_HOLDER_ADDRESSES.every((a) => a === a.toLowerCase()),
    }));
  `);
  const r = JSON.parse(out);
  // The v4 PoolManager holds the graduated liquidity, so on a graduated token it
  // is the single largest balance. Counting it made $ARCHER read 56% rather
  // than 21% -- a false statement about a real token, on the concerns line.
  assert.equal(r.hasPool, true, 'the PoolManager must never be counted as a holder');
  // Balances are keyed by lowercase address, so an entry in any other case is
  // an exclusion that silently does nothing.
  assert.equal(r.allLower, true, `non-holder list must be lowercase: ${JSON.stringify(r.list)}`);
  assert.ok(r.list.length >= 8, 'factory, hook, escrow, vault, locker, forwarder, pool, burn, zero');
});

test('five holders or fewer is undetermined, never a raised flag', () => {
  const out = inTempDb(`
    const res = [1, 2, 5].map((h) => {
      const f = flagFor({ top5Share: 100, top1Share: 20, holders: h, circulating: 100n });
      return { h, state: f.state, detail: f.detail };
    });
    console.log(JSON.stringify(res));
  `);
  for (const r of JSON.parse(out)) {
    assert.equal(r.state, 'unknown', `${r.h} holders must be undetermined, got ${r.state}`);
    assert.match(r.detail, /too few/, 'the reason has to be stated, not implied');
    assert.match(r.detail, /arithmetic/, 'and it has to say why: the ratio is forced');
  }
});

test('an unreadable measurement is undetermined, never a low number', () => {
  const out = inTempDb(`
    const f = flagFor(null);
    console.log(JSON.stringify({ state: f.state, detail: f.detail, plain: f.plain }));
  `);
  const f = JSON.parse(out);
  assert.equal(f.state, 'unknown');
  assert.match(f.detail, /could not be read/);
  assert.ok(!/\\b0(\\.0)?%/.test(f.detail + f.plain), 'a failed read must never render as 0%');
});

test('a measurable share with no distribution behind it is a measurement, not a verdict', () => {
  const out = inTempDb(`
    for (let i = 0; i < 10; i++) obs(A(100 + i), 50 + i, 30);
    const f = flagFor({ top5Share: 44, top1Share: 9, holders: 30, circulating: 100n });
    console.log(JSON.stringify({ state: f.state, detail: f.detail }));
  `);
  const f = JSON.parse(out);
  // Not 'unknown'. The share WAS read; what is missing is a distribution to
  // judge it against, and a missing comparison does not unmeasure the thing
  // compared. The state carries no finding, the detail carries the number and
  // says the threshold is absent, and the API renders this as state "none"
  // with reference null. What it must never do is swallow the 44%.
  assert.equal(f.state, 'clean', 'the share was read, so it is not undetermined');
  assert.match(f.detail, /top 5 hold 44\.0%/, 'the measurement is still reported as a fact');
  assert.match(f.detail, /largest single wallet 9\.0%/, 'and the largest single wallet travels with it');
  assert.match(f.detail, /no threshold yet/);
  assert.match(f.detail, /n=10/, 'the sample size is published so the gap is visible');
});

test('at the floor the threshold comes from the distribution and is auditable', () => {
  const out = inTempDb(`
    // 40 observations spread evenly across the excess range. The 90th
    // percentile by nearest rank is the 36th smallest.
    for (let i = 1; i <= 40; i++) obs(A(100 + i), atExcess(20, i / 40), 20);
    const t = C.concentrationThreshold(20);
    const under = flagFor({ top5Share: atExcess(20, 35 / 40) - 0.5, holders: 20, circulating: 100n });
    const over = flagFor({ top5Share: atExcess(20, 36 / 40) + 0.5, holders: 20, circulating: 100n });
    console.log(JSON.stringify({
      n: t.n, pct: t.percentile, threshold: t.threshold, thresholdShare: t.thresholdShare,
      under: under.state, over: over.state, overDetail: over.detail, overPlain: over.plain,
    }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.n, 40);
  assert.equal(r.pct, 90);
  assert.ok(Math.abs(r.threshold - 36 / 40) < 1e-9, `nearest-rank 90th of 40, got ${r.threshold}`);
  assert.equal(r.under, 'clean', 'below the threshold the check ran and found nothing');
  assert.equal(r.over, 'raised');
  assert.match(r.overDetail, /flagged at \d+\.\d% for 20 holders/, 'the threshold is printed as a share for audit');
  assert.match(r.overDetail, /25\.0% is the least 20 wallets can hold/);
  assert.match(r.overDetail, /90th percentile of 40 launches/);
  // Rounded as the card rounds, and carrying the holder count: when this is
  // raised it is the only line the reader sees about concentration.
  assert.match(r.overPlain, /^top 5 hold \d+% of supply(, largest \d+%)? · \d+ holders$/, r.overPlain);
});

test('a share the holder count forces cannot be flagged, however low the threshold', () => {
  // The exact case that made the raw-share threshold wrong: 45 ordinary
  // observations from 12-20 holder tokens put the threshold at 60% of supply,
  // and a six-holder token distributed as evenly as six wallets physically can
  // be holds 83.3% -- it was raised on arithmetic.
  const out = inTempDb(`
    for (let i = 0; i < 45; i++) obs(A(100 + i), [40, 45, 50, 55, 60][i % 5], 12 + (i % 9));
    const even = flagFor({ top5Share: floorOf(6), holders: 6, circulating: 100n });
    const allOfIt = flagFor({ top5Share: 100, holders: 6, circulating: 100n });
    console.log(JSON.stringify({ even: even.state, evenDetail: even.detail, allOfIt: allOfIt.state }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.even, 'clean', 'the most even distribution six wallets allow is not a concern');
  assert.match(r.evenDetail, /83\.3% is the least 6 wallets can hold/, 'and it says why');
  assert.equal(r.allOfIt, 'raised', 'one wallet holding everything still is');
});

test('forced shares from tiny launches cannot bury real concentration', () => {
  // The mirror of the case above: 24 observations from 6-8 holder tokens at
  // their forced 75-100%, and the raw-share threshold went to 99% -- a
  // twenty-holder token whose top five held 96% came back clean.
  const out = inTempDb(`
    for (let i = 0; i < 24; i++) obs(A(200 + i), 75 + (i % 26), 6 + (i % 3));
    for (let i = 0; i < 6; i++) obs(A(300 + i), 38 + i * 4, 15 + i);
    const f = flagFor({ top5Share: 96, holders: 20, circulating: 100n });
    console.log(JSON.stringify({ state: f.state, detail: f.detail }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.state, 'raised', 'five wallets holding 96% of a twenty-holder supply is the finding');
  assert.match(r.detail, /top 5 hold 96\.0%/);
});

test('excess is scale-free: the same distribution shape scores the same at any size', () => {
  const out = inTempDb(`
    const halfway = [6, 10, 20, 100, 500].map((h) => ({
      h, e: C.excessConcentration({ top5Share: atExcess(h, 0.5), holders: h, circulating: 1n }),
    }));
    const forced = [6, 10, 20, 100].map((h) => ({
      h, e: C.excessConcentration({ top5Share: floorOf(h), holders: h, circulating: 1n }),
    }));
    console.log(JSON.stringify({ halfway, forced, tooFew: C.excessConcentration({ top5Share: 100, holders: 5, circulating: 1n }) }));
  `);
  const r = JSON.parse(out);
  for (const { h, e } of r.halfway) assert.ok(Math.abs(e - 0.5) < 1e-9, `${h} holders scored ${e}, not 0.5`);
  for (const { h, e } of r.forced) assert.equal(e, 0, `${h} holders at their floor scored ${e}, not 0`);
  assert.equal(r.tooFew, null, 'five holders have no excess to measure');
});

test('a token is never part of the distribution it is judged against', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 40; i++) obs(A(100 + i), atExcess(30, i / 40), 30);
    const all = C.concentrationThreshold(30);
    const self = C.concentrationThreshold(30, A(140));
    console.log(JSON.stringify({ all: all.n, self: self.n }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.all, 40);
  assert.equal(r.self, 39);
});

test('observations below the holder floor are never recorded', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 20; i++) obs(A(100 + i), 100, 3);   // forced 100%, meaningless
    for (let i = 1; i <= 5; i++) obs(A(200 + i), 40, 30);
    const n = db.prepare('SELECT COUNT(*) n FROM holder_snapshots').get().n;
    console.log(JSON.stringify({ n, floor: C.MIN_HOLDERS_FOR_SHARE }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.floor, 6);
  assert.equal(r.n, 5, 'three holders have no excess to contribute');
});

test('a malformed sample floor or percentile falls back rather than switching off', () => {
  const out = inTempDb(
    `console.log(JSON.stringify([C.MIN_CONCENTRATION_SAMPLES, C.CONCENTRATION_PERCENTILE]));`,
    { MIN_CONCENTRATION_SAMPLES: 'thirty', CONCENTRATION_PERCENTILE: '' },
  );
  assert.deepEqual(JSON.parse(out), [30, 90], 'NaN comparisons are all false, the floor would vanish');
});

test('an observation is one row per token, refreshed not appended', () => {
  const out = inTempDb(`
    obs(A(7), 40, 30); obs(A(7), 55, 44);
    const row = db.prepare('SELECT top5_share s, holders h FROM holder_snapshots WHERE token = ?').get(A(7));
    const n = db.prepare('SELECT COUNT(*) n FROM holder_snapshots').get().n;
    console.log(JSON.stringify({ n, s: row.s, h: row.h }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.n, 1, 'a re-scanned token must not vote twice in its own distribution');
  assert.equal(r.s, 55);
  assert.equal(r.h, 44);
});

test('a reading without a largest-holder share degrades, it does not throw', () => {
  // top1Share arrived after the first readings were stored, so rows written
  // before it carry undefined. A card that throws on a missing optional field
  // is worse than one that omits it -- and this one crashed a whole scan.
  const out = inTempDb(`
    const shapes = {
      missing: { top5Share: 44, holders: 23, circulating: 1n },
      null_: { top5Share: 44, top1Share: null, holders: 23, circulating: 1n },
      nan: { top5Share: 44, top1Share: NaN, holders: 23, circulating: 1n },
    };
    const out = {};
    for (const [name, c] of Object.entries(shapes)) {
      const f = flagFor(c);
      out[name] = { state: f.state, plain: f.plain };
    }
    // and recording one must not fail on the bind either
    C.recordConcentration(A(7), { top5Share: 44, holders: 23, circulating: 1n });
    out.recorded = db.prepare('SELECT top1_share FROM holder_snapshots WHERE token = ?').get(A(7));
    console.log(JSON.stringify(out));
  `);
  const r = JSON.parse(out);
  // What matters is that the three shapes agree: a missing optional field is
  // not allowed to change the verdict, whatever that verdict is.
  for (const key of ['missing', 'null_', 'nan']) {
    assert.equal(r[key].state, r.missing.state, `${key} changed the verdict`);
    assert.ok(!/largest/.test(r[key].plain), `${key} claimed a largest holder: ${r[key].plain}`);
    assert.ok(!/NaN|undefined|null/.test(r[key].plain), `${key} leaked a non-number: ${r[key].plain}`);
  }
  assert.equal(r.recorded.top1_share, 0, 'stored as zero, which the renderers treat as absent');
});

// ------------------------------------------- a partial first read is not a reading

/**
 * A refresh that stops early on a token with no row yet writes the row, because
 * the balances it read are what the next attempt resumes from. It writes it
 * with measured_at = 0, and no reader may see that as a holder count: it was
 * going out through /scout as a finished one.
 */
test('a snapshot with measured_at = 0 is invisible to every reader of holder counts', () => {
  const out = inTempDb(`
    // A finished reading, and a partial first row beside it.
    for (let i = 0; i < 40; i++) obs(A(100 + i), 50 + i, 30);
    db.prepare(\`INSERT INTO holder_snapshots (token, top5_share, top1_share, holders, excess, measured_at, balances, read_to_block)
                VALUES (?, 99, 40, 300, 0.99, 0, '{}', 12345)\`).run(A(7));
    const stored = C.readStoredConcentration(A(7));
    const coverage = C.concentrationCoverage();
    const t = C.concentrationThreshold(20, A(999));
    console.log(JSON.stringify({ stored, coverage, n: t?.n ?? null, threshold: t?.thresholdShare ?? null }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.stored, null, 'a partial row read back as a holder count');
  assert.equal(r.coverage, 40, 'a partial row counted toward the threshold sample');
  assert.equal(r.n, 40, 'a partial row entered the threshold distribution');
});

test('a partial first row is not a finished walk: the scan gate and the group card do not see it', () => {
  const out = inTempDb(`
    db.prepare(\`INSERT INTO holder_snapshots (token, top5_share, top1_share, holders, excess, measured_at, balances, read_to_block)
                VALUES (?, 99, 40, 300, 0.99, 0, ?, 12345)\`).run(A(8), JSON.stringify({ [A(1)]: '100', [A(2)]: '50' }));
    db.prepare(\`INSERT INTO holder_snapshots (token, top5_share, top1_share, holders, excess, measured_at, balances, read_to_block)
                VALUES (?, 60, 40, 2, 0.5, 777, ?, 12345)\`).run(A(9), JSON.stringify({ [A(1)]: '100', [A(2)]: '50' }));
    console.log(JSON.stringify({
      partialStored: C.hasStoredBalances(A(8)), partialBreakdown: C.holderBreakdown(A(8), A(99)),
      finishedStored: C.hasStoredBalances(A(9)), finishedBreakdown: C.holderBreakdown(A(9), A(99)),
    }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.partialStored, false, 'a walk that stopped early read as a finished one');
  assert.equal(r.partialBreakdown, null, 'a top-ten from the middle of the token\'s life');
  assert.equal(r.finishedStored, true);
  assert.equal(r.finishedBreakdown.holders, 2);
});
