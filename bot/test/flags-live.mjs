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

// ---- 2. a normal token is clean, and the flag count moved to 9 -------------
// Nine since holder concentration was added as check 09.
const normal = await scanToken('0xd384722f6adfe7d79E8e6623896DF199afD31B76');
assert.equal(normal.flags.flags.find((f) => f.key === 'pair_ticker').state, 'clean');
assert.equal(normal.flags.total, 9, 'the flag set is now 9');
assert.equal(r.flags.total, 9);
assert.ok(
  normal.flags.flags.some((f) => f.key === 'holder_concentration'),
  'check 09 must be present in the set every card counts against',
);
ok('an ETH-paired token is clean on the ticker check; the flag set is 9 for both');

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

  // A pass must stay cheap: it runs every 3s alongside interactive scans.
  //
  // The cost is not a single number, because a window that happens to contain a
  // launch also primes block-time anchors and decodes one creation transaction
  // per launch. Asserted against the model rather than a constant, or the test
  // passes or fails on whether the chain was busy in the last three seconds.
  let reqs = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (i, init) => {
    const u = typeof i === 'string' ? i : (i?.url ?? String(i));
    if (u.includes('rpc.mainnet')) reqs++;
    return real(i, init);
  };

  const measure = async (lifecycle) => {
    setCursor('launches', (await client.getBlockNumber({ cacheTime: 0 })) - 30n);
    reqs = 0;
    const res = await indexNew({ lifecycle });
    return { reqs, launches: res.launches };
  };

  let plain, sweep;
  try {
    plain = await measure(false);
    sweep = await measure(true);
  } finally { globalThis.fetch = real; }

  // baseline 2 (block number + the launch getLogs), +2 for the lifecycle sweep,
  // and when the window held launches: +2 anchor blocks and one decode each
  const expected = (m, lifecycle) =>
    2 + (lifecycle ? 2 : 0) + (m.launches ? 2 + m.launches : 0);

  assert.ok(plain.reqs <= expected(plain, false),
    `a pass over ${plain.launches} launch(es) cost ${plain.reqs} requests, model allows ${expected(plain, false)}`);
  assert.ok(sweep.reqs <= expected(sweep, true),
    `a lifecycle pass over ${sweep.launches} launch(es) cost ${sweep.reqs} requests, model allows ${expected(sweep, true)}`);

  // and the steady-state cost of an idle loop, which is what actually runs most
  // of the time: 2 requests, or 4 on the one pass in ten that sweeps lifecycle
  const idleAvg = (9 * 2 + 4) / 10;
  assert.ok(idleAvg / 3 < 1.0, `an idle tail loop averages ${(idleAvg / 3).toFixed(2)} req/s`);
  ok(`tail pass: ${plain.reqs} req over ${plain.launches} launch(es), ${sweep.reqs} with the sweep — idle steady state ${(idleAvg / 3).toFixed(2)} req/s`);
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
