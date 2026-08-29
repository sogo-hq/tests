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
        C.recordConcentration(token, { top5Share: share, holders, circulating: 100n }, 1);
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

test('five holders or fewer is undetermined, never a raised flag', () => {
  const out = inTempDb(`
    const res = [1, 2, 5].map((h) => {
      const f = flagFor({ top5Share: 100, holders: h, circulating: 100n });
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

test('a measurable share with no distribution behind it is undetermined, not clean', () => {
  const out = inTempDb(`
    for (let i = 0; i < 10; i++) obs(A(100 + i), 50 + i, 30);
    const f = flagFor({ top5Share: 44, holders: 30, circulating: 100n });
    console.log(JSON.stringify({ state: f.state, detail: f.detail }));
  `);
  const f = JSON.parse(out);
  assert.equal(f.state, 'unknown', 'ten observations is not a threshold');
  assert.match(f.detail, /top 5 wallets hold 44\.0%/, 'the measurement is still reported as a fact');
  assert.match(f.detail, /no threshold yet/);
  assert.match(f.detail, /n=10/, 'the sample size is published so the gap is visible');
});

test('at the floor the threshold comes from the distribution and is auditable', () => {
  const out = inTempDb(`
    // 40 observations, shares 1..40 in the 21-100 band. 90th percentile by
    // nearest rank is the 36th smallest, which is 36.
    for (let i = 1; i <= 40; i++) obs(A(100 + i), i, 30);
    const t = C.concentrationThreshold(30);
    const under = flagFor({ top5Share: 35, holders: 30, circulating: 100n });
    const over = flagFor({ top5Share: 36, holders: 30, circulating: 100n });
    console.log(JSON.stringify({
      threshold: t.threshold, n: t.n, pct: t.percentile, band: t.band.key,
      under: under.state, underDetail: under.detail,
      over: over.state, overDetail: over.detail, overPlain: over.plain,
    }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.threshold, 36, 'nearest-rank 90th percentile of 1..40');
  assert.equal(r.n, 40);
  assert.equal(r.pct, 90);
  assert.equal(r.band, '21-100');
  assert.equal(r.under, 'clean', 'below the threshold the check ran and found nothing');
  assert.equal(r.over, 'raised');
  assert.match(r.overDetail, /threshold 36\.0%/, 'the threshold is printed for audit');
  assert.match(r.overDetail, /90th percentile of 40 launches with 21-100 holders/);
  assert.match(r.overPlain, /^top 5 wallets hold 36\.0% of supply$/);
});

test('the threshold is taken within a holder band, not pooled', () => {
  const out = inTempDb(`
    // a small-holder band full of near-100% shares, and a large-holder band of low ones
    for (let i = 1; i <= 40; i++) obs(A(100 + i), 95 + (i % 5), 10);
    for (let i = 1; i <= 40; i++) obs(A(200 + i), 20 + (i % 10), 300);
    const small = C.concentrationThreshold(10);
    const large = C.concentrationThreshold(300);
    console.log(JSON.stringify({ small: small.threshold, large: large.threshold, sn: small.n, ln: large.n }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.sn, 40);
  assert.equal(r.ln, 40);
  assert.ok(r.small > 90, `small-holder threshold should sit near 100, got ${r.small}`);
  assert.ok(r.large < 40, `large-holder threshold should be far lower, got ${r.large}`);
  assert.ok(r.small > r.large, 'a pooled threshold would flag every small token and no large one');
});

test('a token is never part of the distribution it is judged against', () => {
  const out = inTempDb(`
    for (let i = 1; i <= 40; i++) obs(A(100 + i), i, 30);
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
  assert.equal(r.n, 5, 'a forced 100% would drag every band percentile to 100 and flag nothing');
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
