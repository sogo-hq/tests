import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The index lives in a SQLite file on a container with no persistent volume, so
 * a deploy starts from nothing. These run in child processes because DB_PATH is
 * read once when db.js is imported.
 */
function withDb(dbPath, script) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
}

const UNIQUE = `ZQXJV${Date.now().toString(36).toUpperCase()}`;

const FLAGS = `
// a ticker no real launch can already be using, so a "no collision" answer
// reflects the index's coverage rather than an actual match
const UNIQUE = '${UNIQUE}';
const { computeFlags } = await import('${process.cwd()}/dist/metrics/flags.js');
const f = computeFlags({
  token: '0x' + '11'.repeat(20), deployer: '0x' + '22'.repeat(20),
  name: UNIQUE, symbol: UNIQUE, creatorTaxBps: 100, buybackEnabled: false,
  pairToken: '0x0000000000000000000000000000000000000000', pairSymbol: 'ETH',
  scannedAt: Math.floor(Date.now() / 1000),
});
console.log(JSON.stringify(f.flags.map((x) => ({ key: x.key, state: x.state, detail: x.detail, plain: x.plain }))));
`;

function flagsWithEmptyIndex() {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-empty-'));
  try {
    const out = withDb(join(dir, 'empty.db'), FLAGS);
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- the required test
test('with an empty database the collision flag is undetermined, not "no match"', () => {
  const flags = flagsWithEmptyIndex();
  const collision = flags.find((f) => f.key === 'collision');
  assert.ok(collision, 'collision flag must still be present');
  assert.equal(collision.state, 'unknown',
    `collision was "${collision.state}" on an empty index — "${collision.detail}" is a confident negative derived from zero rows`);
  assert.doesNotMatch(collision.detail, /no match against indexed pons tokens/,
    'the false all-clear this whole project exists to avoid');
  assert.doesNotMatch(collision.plain, /no other token uses this ticker/);
  // "never advanced" is the empty index's more specific reason: it has neither
  // enough rows NOR a cursor, and the stall is the one that would still hold if
  // the rows arrived from somewhere other than the indexer.
  assert.match(collision.detail, /too few|rebuilding|never advanced|stalled/);
});

test('every index-derived negative is withheld on an empty database', () => {
  const flags = flagsWithEmptyIndex();
  for (const key of ['collision', 'deployer_rate', 'creator_tax', 'deployer_peaks', 'deployer_survival']) {
    const f = flags.find((x) => x.key === key);
    assert.equal(f.state, 'unknown', `${key} asserted "${f.detail}" from an empty index`);
  }
});

test('checks that do not touch the index still answer on an empty database', () => {
  const flags = flagsWithEmptyIndex();
  // both read straight from the chain, so an empty index does not blind them
  assert.equal(flags.find((f) => f.key === 'pair_ticker').state, 'clean');
  assert.equal(flags.find((f) => f.key === 'custom_pair').state, 'clean');
});

test('a populated index does assert its negatives', function (t) {
  if (!existsSync('pons.db')) return t.skip('no populated index available');
  const dir = mkdtempSync(join(tmpdir(), 'vitals-full-'));
  try {
    const db = join(dir, 'full.db');
    copyFileSync('pons.db', db);
    // A copied index is by definition not advancing, and a stalled index now
    // withholds its negatives -- correctly. This test is about coverage DEPTH,
    // so the cursor is marked current to isolate that from freshness; the stall
    // behaviour is asserted on its own in index-stall.test.mjs.
    withDb(db, `
      const { db } = await import('${process.cwd()}/dist/db.js');
      const { recordIndexAdvance } = await import('${process.cwd()}/dist/indexer/health.js');
      recordIndexAdvance(1n);
    `);
    const flags = JSON.parse(withDb(db, FLAGS).trim().split('\n').pop());
    assert.equal(flags.find((f) => f.key === 'collision').state, 'clean',
      'with a real index behind it, "no collision" is a statement worth making');
    assert.equal(flags.find((f) => f.key === 'deployer_rate').state, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ boot decision
test('boot assesses the index and reports its decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-boot-'));
  try {
    const out = withDb(join(dir, 'empty.db'), `
      const { assessIndex } = await import('${process.cwd()}/dist/recovery.js');
      console.log(JSON.stringify(assessIndex()));
    `);
    const d = JSON.parse(out.trim().split('\n').pop());
    assert.equal(d.needed, true);
    assert.equal(d.indexed, 0);
    assert.equal(d.reason, 'index empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery in progress withholds negatives even once rows exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-rec-'));
  try {
    const db = join(dir, 'rec.db');
    if (existsSync('pons.db')) copyFileSync('pons.db', db);
    const out = withDb(db, `
      const { markRecovering, indexCoverage } = await import('${process.cwd()}/dist/coverage.js');
      const { db } = await import('${process.cwd()}/dist/db.js');
      // This test is about the recovery flag, so the index is marked current to
      // hold the other reason for withholding constant.
      const { recordIndexAdvance } = await import('${process.cwd()}/dist/indexer/health.js');
      recordIndexAdvance(1n);
      const before = indexCoverage().trustNegatives;
      markRecovering(true);
      const during = indexCoverage().trustNegatives;
      markRecovering(false);
      console.log(JSON.stringify({ before, during }));
    `);
    const { before, during } = JSON.parse(out.trim().split('\n').pop());
    assert.equal(before.collision, true, 'a populated index trusts its negatives');
    assert.equal(during.collision, false, 'a rebuild in progress does not');
    assert.equal(during.deployerHistory, false);
    assert.equal(during.taxBaseline, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------- advancing, and still far behind

/**
 * The gap the time-based rule cannot see.
 *
 * A tail pass covers at most 30,000 blocks, so an index restarted after
 * downtime advances on every pass and never looks stalled while days of chain
 * sit unread behind it. "Did it move recently" is liveness. "How much of the
 * chain has it read" is coverage, and only the second one entitles a check to
 * say nothing happened.
 */
function flagsAtLag(lagBlocks, t) {
  if (!existsSync('pons.db')) return t.skip('no populated index available');
  const dir = mkdtempSync(join(tmpdir(), 'vitals-lag-'));
  try {
    const dbFile = join(dir, 'lag.db');
    copyFileSync('pons.db', dbFile);
    withDb(dbFile, `
      const { db, getCursor } = await import('${process.cwd()}/dist/db.js');
      const { recordIndexAdvance } = await import('${process.cwd()}/dist/indexer/health.js');
      const cursor = Number(getCursor('launches'));
      // Advancing right now, which is the whole point: the timestamp is fresh,
      // so the stall rule is satisfied and only the block gap can withhold.
      recordIndexAdvance(BigInt(cursor), BigInt(cursor + ${lagBlocks}));
    `);
    return JSON.parse(withDb(dbFile, FLAGS).trim().split('\n').pop());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an index advancing but far behind head withholds its negatives', function (t) {
  // 3,000,000 blocks is about three and a half days of chain at ~0.1s/block.
  const flags = flagsAtLag(3_000_000, t);
  if (!flags) return;
  for (const key of ['collision', 'deployer_rate', 'creator_tax']) {
    const f = flags.find((x) => x.key === key);
    assert.equal(f.state, 'unknown',
      `${key} asserted "${f.detail}" while 3,000,000 blocks were unread`);
  }
  const rate = flags.find((x) => x.key === 'deployer_rate');
  assert.match(rate.detail, /blocks behind the chain/,
    'the reason a negative is withheld is stated, not merely the withholding');
  assert.doesNotMatch(rate.plain, /only launch this week/);
});

test('an index a few blocks behind head still answers', function (t) {
  // 100 blocks is ten seconds. Refusing here would make the bot useless.
  const flags = flagsAtLag(100, t);
  if (!flags) return;
  assert.equal(flags.find((x) => x.key === 'collision').state, 'clean');
  assert.equal(flags.find((x) => x.key === 'deployer_rate').state, 'clean');
});

test('the block gap is reported alongside the time gap', function (t) {
  if (!existsSync('pons.db')) return t.skip('no populated index available');
  const dir = mkdtempSync(join(tmpdir(), 'vitals-cov-'));
  try {
    const dbFile = join(dir, 'cov.db');
    copyFileSync('pons.db', dbFile);
    const out = withDb(dbFile, `
      const { getCursor } = await import('${process.cwd()}/dist/db.js');
      const { recordIndexAdvance } = await import('${process.cwd()}/dist/indexer/health.js');
      const { indexCoverage } = await import('${process.cwd()}/dist/coverage.js');
      const cursor = Number(getCursor('launches'));
      recordIndexAdvance(BigInt(cursor), BigInt(cursor + 12345));
      const c = indexCoverage();
      console.log(JSON.stringify({ lagBlocks: c.lagBlocks, behindHead: c.behindHead, stalled: c.stalled }));
    `);
    const c = JSON.parse(out.trim().split('\n').pop());
    assert.equal(c.lagBlocks, 12345);
    assert.equal(c.behindHead, true);
    assert.equal(c.stalled, false, 'it is advancing, which is exactly why the time rule misses this');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecorded head is unknown, not caught up', function (t) {
  if (!existsSync('pons.db')) return t.skip('no populated index available');
  const dir = mkdtempSync(join(tmpdir(), 'vitals-nohead-'));
  try {
    const dbFile = join(dir, 'nohead.db');
    copyFileSync('pons.db', dbFile);
    const out = withDb(dbFile, `
      const { recordIndexAdvance } = await import('${process.cwd()}/dist/indexer/health.js');
      const { indexCoverage } = await import('${process.cwd()}/dist/coverage.js');
      recordIndexAdvance(1n);
      const c = indexCoverage();
      console.log(JSON.stringify({ lagBlocks: c.lagBlocks, behindHead: c.behindHead }));
    `);
    const c = JSON.parse(out.trim().split('\n').pop());
    assert.equal(c.lagBlocks, null, 'no head recorded is not a lag of zero');
    assert.equal(c.behindHead, false, 'and an unknown gap is left to the time rule');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- the shared note

test('coverageNote names the earliest cause, in the same words on every surface', async () => {
  const { coverageNote } = await import(`${process.cwd()}/dist/coverage.js`);
  const base = {
    indexed: 1, decoded: 1, stalenessSeconds: 0, recovering: false, stalled: false,
    behindSeconds: 10, lagBlocks: 0, behindHead: false,
    trustNegatives: { collision: true, deployerHistory: true, taxBaseline: true },
  };
  assert.equal(coverageNote(base), null);
  assert.equal(coverageNote({ ...base, behindHead: true, lagBlocks: 36000 }), 'index 36,000 blocks behind the chain');
  assert.equal(coverageNote({ ...base, stalled: true, behindSeconds: 7200, behindHead: true, lagBlocks: 36000 }),
    'index stalled 2h ago, counts may be behind');
  assert.equal(coverageNote({ ...base, stalled: true, behindSeconds: null }), 'index has never advanced, counts incomplete');
  assert.equal(coverageNote({ ...base, recovering: true, stalled: true, behindSeconds: null }), 'index rebuilding, counts incomplete');
});
