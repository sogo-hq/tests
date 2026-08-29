import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Opening an existing database must not throw.
 *
 * This container has no persistent volume, so a fresh schema is the usual case
 * and the upgrade path is the one nobody exercises. It broke twice in one
 * change: an index in the schema block named a column a later migration adds,
 * and dropping a stale column failed while its index still referenced it. Both
 * threw at module load, which takes the whole bot down on a database that
 * happened to survive a restart.
 */
const CWD = process.cwd();

function openWith(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-mig-'));
  const path = join(dir, 'legacy.db');
  const legacy = new Database(path);
  seed(legacy);
  legacy.close();
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { db } = await import('${CWD}/dist/db.js');
      const cols = (t) => db.prepare(\`PRAGMA table_info(\${t})\`).all().map((c) => c.name);
      console.log(JSON.stringify({
        holder: cols('holder_snapshots'),
        rechecks: cols('rechecks'),
        indexes: db.prepare('PRAGMA index_list(holder_snapshots)').all().map((i) => i.name),
        rows: db.prepare('SELECT COUNT(*) n FROM holder_snapshots').get().n,
      }));
    `], { cwd: CWD, env: { ...process.env, DB_PATH: path }, encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a database from before holder concentration opens and gains the column', () => {
  const r = openWith((db) => {
    db.exec(`CREATE TABLE rechecks (id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id INTEGER NOT NULL,
      token TEXT NOT NULL, offset_hours INTEGER NOT NULL, due_at INTEGER NOT NULL, completed_at INTEGER,
      UNIQUE (scan_id, offset_hours));`);
  });
  assert.ok(r.holder.includes('excess'));
  assert.ok(r.rechecks.includes('attempts'), 'the earlier migration still applies too');
  assert.ok(r.indexes.includes('idx_holder_snapshots_excess'));
});

test('a database from the banded-threshold build opens, and loses the dead column', () => {
  // The exact intermediate shape: band NOT NULL with no default, plus an index
  // over it. Leaving either in place makes every insert or the drop itself fail.
  const r = openWith((db) => {
    db.exec(`CREATE TABLE holder_snapshots (
      token TEXT PRIMARY KEY, top5_share REAL NOT NULL, holders INTEGER NOT NULL,
      band TEXT NOT NULL, measured_at INTEGER NOT NULL);
      CREATE INDEX idx_holder_snapshots_band ON holder_snapshots(band, top5_share);`);
    db.prepare('INSERT INTO holder_snapshots VALUES (?,?,?,?,?)')
      .run('0x' + '11'.repeat(20), 44.2, 23, '21-100', 1);
  });
  assert.ok(r.holder.includes('excess'), 'the new column is added');
  assert.ok(!r.holder.includes('band'), 'the dead NOT NULL column is dropped, or inserts fail forever');
  assert.ok(!r.indexes.includes('idx_holder_snapshots_band'), 'and its index with it');
  assert.equal(r.rows, 1, 'existing observations survive the upgrade');
});

test('opening twice is a no-op the second time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-mig2-'));
  const path = join(dir, 'twice.db');
  try {
    for (let i = 0; i < 2; i++) {
      execFileSync(process.execPath, ['--input-type=module', '-e',
        `await import('${CWD}/dist/db.js'); console.log('ok');`],
        { cwd: CWD, env: { ...process.env, DB_PATH: path }, encoding: 'utf8' });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
