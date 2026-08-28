/**
 * The pair-ticker flag against the real launch that motivated it, plus the
 * index tail loop and scan logging. Needs network.
 * Run: node test/flags-live.mjs
 */
import assert from 'node:assert/strict';
import { scanToken } from '../dist/scan.js';
import { renderCardText, renderDefaultCard } from '../dist/card.js';
import { normaliseKey, setCursor } from '../dist/db.js';
import { indexNew } from '../dist/indexer/launches.js';
import { client } from '../dist/chain.js';

const ok = (m) => console.log(`  PASS  ${m}`);

// ---- 1. the flag, on the launch that motivated it --------------------------
// $NVDA "No Value Dog Agent", paired against the tokenised NVIDIA stock whose
// symbol is also NVDA
const IMPOSTOR = '0xAa0C11715A509b6C0afb5D897bE54fA6536860B6';
const r = await scanToken(IMPOSTOR);
assert.ok(r, 'the example token must resolve');
assert.equal(r.reads.symbol, 'NVDA');
assert.equal(r.reads.pairSymbol, 'NVDA');
assert.notEqual(r.reads.token.toLowerCase(), r.reads.pairToken.toLowerCase(), 'different contracts');

const flag = r.flags.flags.find((f) => f.key === 'pair_ticker');
assert.ok(flag, 'pair_ticker flag must exist');
assert.equal(flag.state, 'raised', 'the flag must fire on the live example');
assert.match(flag.detail, /same as the pair asset/);
ok(`live example flagged: ${flag.detail.slice(0, 70)}…`);

assert.equal(r.flags.worst.key, 'pair_ticker',
  'wearing the ticker of the asset on the other side of your own pool should outrank a plain name collision');
ok('ranked as the worst flag on this token');

assert.match(renderCardText(r), /Ticker vs pair asset/);
assert.match(renderDefaultCard(r, 'b'), /same ticker as the asset it trades against/);
ok('appears on both the full card (technical) and the default card (plain English)');

// ---- 2. a normal token is clean, and the flag count moved to 8 -------------
const normal = await scanToken('0xd384722f6adfe7d79E8e6623896DF199afD31B76');
assert.equal(normal.flags.flags.find((f) => f.key === 'pair_ticker').state, 'clean');
assert.equal(normal.flags.total, 8, 'the flag set is now 8');
assert.equal(r.flags.total, 8);
ok('an ETH-paired token is clean; the flag set is 8 for both');

// ---- 3. the comparison is homoglyph-normalised, like the collision flag ----
assert.equal(normaliseKey('NVDA'), normaliseKey('NVDА'), 'Cyrillic А must fold onto Latin A');
assert.notEqual(normaliseKey('NVDA'), normaliseKey('AAPL'));
ok('pair-ticker comparison folds homoglyphs');

// ---- 4. the tail loop actually advances the cursor -------------------------
{
  const head = await client.getBlockNumber({ cacheTime: 0 });
  setCursor('launches', head - 120n);      // ~12s of blocks
  const before = Date.now();
  const res = await indexNew();
  assert.ok(res.toBlock >= head, `tail pass should reach the head, stopped at ${res.toBlock} vs ${head}`);
  ok(`tail pass covered ${res.toBlock - res.fromBlock + 1n} blocks in ${Date.now() - before}ms, ${res.launches} launch(es)`);

  // an empty pass must be cheap: this runs every 3s alongside interactive scans
  let reqs = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (i, init) => {
    const u = typeof i === 'string' ? i : (i?.url ?? String(i));
    if (u.includes('rpc.mainnet')) reqs++;
    return real(i, init);
  };
  try {
    setCursor('launches', await client.getBlockNumber({ cacheTime: 0 }));
    await indexNew();
  } finally { globalThis.fetch = real; }
  assert.ok(reqs <= 2, `an empty tail pass cost ${reqs} RPC requests; at a 3s interval that is ${(reqs / 3).toFixed(2)}/s against a 10/s budget`);
  ok(`an empty tail pass costs ${reqs} RPC request(s) — ${(reqs / 3).toFixed(2)}/s at a 3s interval`);
}

// ---- 5. a cursor far behind is bounded, not one giant blocking pass --------
{
  const head = await client.getBlockNumber({ cacheTime: 0 });
  setCursor('launches', head - 500_000n);
  const res = await indexNew();
  const covered = res.toBlock - res.fromBlock + 1n;
  assert.ok(covered <= 30_001n, `a catch-up pass covered ${covered} blocks; it must stay bounded so new launches keep arriving promptly`);
  assert.ok(res.toBlock < head, 'and it should still be behind, to be closed by later passes');
  ok(`a 500k-block gap is capped to ${covered} blocks per pass`);
}

console.log('\nAll flag and index-loop live checks passed.');
process.exit(0);
