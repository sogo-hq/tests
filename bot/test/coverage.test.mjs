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
      db.prepare("UPDATE cursors SET updated_at = ? WHERE name = 'launches'")
        .run(Math.floor(Date.now() / 1000));
      db.prepare("INSERT OR IGNORE INTO cursors (name, block_number, updated_at) VALUES ('launches', 1, ?)")
        .run(Math.floor(Date.now() / 1000));
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
      const now = Math.floor(Date.now() / 1000);
      db.prepare("INSERT INTO cursors (name, block_number, updated_at) VALUES ('launches', 1, ?) " +
                 "ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at").run(now);
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
