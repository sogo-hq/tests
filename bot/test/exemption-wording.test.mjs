/**
 * What the card says about tax-free wallets.
 *
 * "0 of 32 exempt slots used" was never true of any launch. The curve exempts
 * its deployer automatically and never mentions it in the calldata, so a count
 * decoded from calldata is always one short: measured, the two disagreed on 61
 * of 64 launches where both were readable, and in 19 of 19 inspected the extra
 * wallet was the deployer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('exwording');
const { db } = await import('../dist/db.js');
const { computeFlags } = await import('../dist/metrics/flags.js');
const { recordIndexAdvance } = await import('../dist/indexer/health.js');

const NOW = 1_757_000_000;
const TOKEN = '0x' + '11'.repeat(20);
const DEP = '0x' + 'd'.repeat(40);

const insert = db.prepare(
  `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
     graduation_threshold, block_number, tx_hash, launched_at, name, symbol,
     snipe_exemption_count, exemption_source, creator_tax_bps)
   VALUES (?,?,?,?,1,'4200000000000000000',?,?,?,?,?,?,?,0)`,
);
// Enough rows that negatives are not withheld for a thin index.
for (let i = 0; i < 1200; i++) {
  insert.run('0x' + i.toString(16).padStart(40, '0'), '0x' + 'c'.repeat(40),
    '0x' + i.toString(16).padStart(40, '0'), '0x' + '0'.repeat(40),
    1000 + i, '0x' + i.toString(16).padStart(64, '0'), NOW - 3600, 'n' + i, 's' + i, 1, 'logs');
}
recordIndexAdvance(1n);

const flagFor = (count, source) => {
  insert.run(TOKEN, '0x' + 'c'.repeat(40), DEP, '0x' + '0'.repeat(40),
    1, '0x' + 'f'.repeat(64), NOW, 'NEW', 'NEW', count, source);
  return computeFlags({
    token: TOKEN, deployer: DEP, name: 'NEW', symbol: 'NEW',
    creatorTaxBps: 0, buybackEnabled: false, snipeExemptions: [],
    pairToken: '0x' + '0'.repeat(40), pairSymbol: 'ETH',
    scannedAt: NOW, launchedAt: NOW, mcapInQuote: 0n, isEarly: false,
  }).flags.find((f) => f.key === 'snipe_exemptions');
};

test('the deployer alone is named for what it is', () => {
  const f = flagFor(1, 'logs');
  assert.equal(f.state, 'clean');
  assert.equal(f.plain, 'tax-free at launch: the deployer only (the wallet that launched it)');
  // Measured 116 of 116: when a launch exempts anyone, the deployer is among
  // them. NOT that every launch exempts its deployer, which is false: 33% of
  // 420 sampled launches exempted nobody at all.
  assert.ok(!/every pons launch/.test(f.plain), 'a claim about all launches that is not true of a third of them');
});

test('more than one says how many, and how many are not the deployer', () => {
  assert.equal(flagFor(4, 'logs').plain, '4 wallets tax-free at launch, 1 of them the deployer');
  assert.equal(flagFor(2, 'logs').plain, '2 wallets tax-free at launch, 1 of them the deployer');
  assert.equal(flagFor(4, 'logs').state, 'raised');
  assert.match(flagFor(4, 'logs').compactDetail, /3 beyond the deployer/);
});

test('a count from calldata is not printed as a number at all', () => {
  // It counts a different thing, and two meanings under one name is worse than
  // waiting for the re-read.
  const f = flagFor(3, null);
  assert.equal(f.state, 'unknown');
  assert.match(f.plain, /being re-counted from the launch itself/);
  assert.ok(!/\b3\b/.test(f.plain), 'a number that means something else must not be shown');
});

test('an undecodable creation is still undetermined, and never clean', () => {
  const f = flagFor(null, null);
  assert.equal(f.state, 'unknown');
  assert.match(f.plain, /tax-free wallets unknown/);
});

test('a zero from the events is a real zero, and common', () => {
  // 139 of 420 sampled launches exempted nobody at all, so this is a third of
  // the chain, not an anomaly worth flagging.
  const f = flagFor(0, 'logs');
  assert.equal(f.state, 'clean');
  assert.equal(f.plain, 'nobody got in tax-free at launch');
});

test('"0 of 32" can never be produced, at any count or source', () => {
  const seen = [];
  for (const source of ['logs', 'calldata', null]) {
    for (const count of [null, 0, 1, 2, 3, 8, 31, 32, 33]) {
      const f = flagFor(count, source);
      seen.push(f.plain, f.detail, f.compactDetail);
    }
  }
  for (const s of seen) {
    assert.ok(!/\bof 32\b/.test(s), `"of 32" survives in: ${s}`);
    assert.ok(!/\b0 of\b/.test(s), `a zero denominator phrasing survives in: ${s}`);
  }
  assert.ok(seen.length > 20, 'the sweep actually covered the branches');
});

test('the phrase is gone from the source, not just from these outputs', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  for (const file of walk('src')) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/of 32 exempt slots/.test(src), `${file} still builds the old phrase`);
  }
});
