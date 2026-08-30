/**
 * Early mode against a genuinely fresh launch, including what it writes to the
 * database. Column alignment in a 37-column INSERT is not something a renderer
 * test can catch. Needs network. Run: node test/early-live.mjs
 */
import assert from 'node:assert/strict';
import { client, logsClient } from '../dist/chain.js';
import { FACTORY, EARLY_WINDOW_SECONDS } from '../dist/config.js';
import { TokenLaunched } from '../dist/abi.js';
import { scanToken } from '../dist/scan.js';
import { renderCardText, renderDefaultCard, compactMeta, inlineDescription } from '../dist/card.js';
import { db } from '../dist/db.js';

const ok = (m) => console.log(`  PASS  ${m}`);

const head = await client.getBlockNumber();
const logs = await logsClient.getLogs({
  address: FACTORY, event: TokenLaunched,
  fromBlock: head - BigInt(EARLY_WINDOW_SECONDS * 10), toBlock: head,
});
if (!logs.length) {
  console.log('  SKIP  no launch inside the early window right now');
  process.exit(0);
}

// newest first, so we get the youngest token available
let result = null;
for (const l of [...logs].reverse()) {
  const r = await scanToken(l.args.token);
  if (r && r.isEarly) { result = r; break; }
}
if (!result) {
  console.log('  SKIP  no scannable launch still inside the early window');
  process.exit(0);
}

const r = result;
console.log(`  token ${r.reads.token} age ${r.ageSeconds}s`);
assert.ok(r.ageSeconds < EARLY_WINDOW_SECONDS, 'fixture must actually be early');
assert.equal(r.isEarly, true);
ok(`live launch at ${r.ageSeconds}s is in early mode`);

// ---- the rendered output ---------------------------------------------------
const full = renderCardText(r);
const compact = renderDefaultCard(r, 'vitalscheck_bot');
// /full keeps early mode: no traction verdict, none of the undefined metrics
assert.doesNotMatch(full, /TRACTION\s+none/i, '/full printed TRACTION none');
assert.doesNotMatch(full, /round-trippers/i, '/full printed round-trippers');
assert.doesNotMatch(full, /buyer growth/i, '/full printed buyer growth');
assert.doesNotMatch(full, /progress velocity/i, '/full printed progress velocity');
// the default card carries no traction verdict at any age -- the label was the
// problem, and it is gone from this shape entirely
assert.doesNotMatch(compact, /traction/i, 'the default card names traction at all');
assert.match(full, new RegExp(`launched ${r.ageSeconds}s ago — too early for traction`));
assert.match(full, /traction unavailable — the snipe tax window is still open\. re-scan in 2 minutes\./);
// The header carries the market cap after the age when the curve can be read,
// and nothing when it cannot -- so the age is no longer the last field.
assert.match(
  compact,
  new RegExp(`^VITALS .* · ${r.ageSeconds}s( · [0-9.KM]+ [A-Za-z0-9]+ mc)?$`, 'm'),
  `default header was: ${compact.split('\n')[0]}`,
);
ok('/full renders early mode; the default card carries no traction verdict');

// ---- inline ----------------------------------------------------------------
const m = compactMeta(r);
assert.equal(m.early, true);
assert.equal(m.traction, 'early');
// the inline preview carries no traction verdict at any age -- the language
// moved to concerns-and-checks along with the card it previews
const d = inlineDescription(m);
assert.doesNotMatch(d, /traction/i, `inline description carried a verdict: ${d}`);
// The subtitle leads with the worst finding in its own words now, so the
// vocabulary check is against that or the no-concerns line -- "1 concern" put a
// count where the finding should be.
assert.ok(
  /concern/.test(d) || (m.topFlag && d.startsWith(m.topFlag)),
  `subtitle carries neither a finding nor a concerns summary: ${d}`,
);
ok(`inline description carries no traction verdict: "${d}"`);

// ---- what it stored --------------------------------------------------------
const row = db.prepare('SELECT * FROM scans WHERE id = ?').get(r.scanId);
assert.ok(row, 'scan row written');
assert.equal(row.traction, 'early', `traction column was ${JSON.stringify(row.traction)} — check INSERT column alignment`);
for (const col of [
  'unique_buyers_30m', 'unique_buyers_10m', 'buyer_growth_ratio', 'buy_tx_count',
  'sell_tx_count', 'buy_sell_ratio', 'median_buy_size', 'progress_pct',
  'progress_velocity_per_10m', 'unique_buyers_at_scan',
]) {
  assert.equal(row[col], null, `${col} must be NULL for an early scan, was ${JSON.stringify(row[col])}`);
}
ok('every traction column stored NULL, label stored "early" — not a measured-looking zero');

// columns that ARE known at this age must still be populated, which also proves
// the INSERT did not shift
assert.equal(row.token, r.reads.token.toLowerCase(), 'token column intact (no column shift)');
assert.equal(row.deployer, r.reads.deployer.toLowerCase(), 'deployer column intact');
assert.equal(row.flags_total, r.flags.total, 'flags_total intact');
assert.equal(row.flags_raised, r.flags.raised, 'flags_raised intact');
assert.equal(row.creator_tax_bps, r.reads.creatorTaxBps, 'creator_tax_bps intact');
assert.ok(row.scanned_at > 0 && row.launched_at > 0, 'timestamps intact');
assert.equal(row.age_seconds, r.ageSeconds, 'age_seconds intact');
ok('all creation- and index-derived columns intact — no column shift in the 37-column INSERT');

// ---- rechecks were still scheduled ----------------------------------------
const rechecks = db.prepare('SELECT COUNT(*) n FROM rechecks WHERE scan_id = ?').get(r.scanId).n;
assert.equal(rechecks, 4, `expected 4 rechecks queued, got ${rechecks}`);
ok('an early scan still queues its +1h/+6h/+24h/+7d rechecks');

// ---- inline: Telegram's own answer cache must not outlive early mode -------
{
  const { createBot } = await import('../dist/bot.js');
  const { EARLY_CACHE_TTL_MS } = await import('../dist/config.js');
  const bot = createBot('123456:FAKE');
  bot.botInfo = {
    id: 42, is_bot: true, first_name: 'VITALS', username: 'vitalscheck_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true,
  };
  const calls = [];
  bot.api.config.use(async (_p, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: true };
  });

  // Warm the shared cache first. Inline carries a 10s deadline, and under a busy
  // RPC an uncached scan can exceed it -- the handler then correctly answers on
  // the transient path with cache_time 0, which is a different assertion than
  // the one this test is making. Warming removes the race without weakening it.
  const { performScan } = await import('../dist/service.js');
  const warm = await performScan({ token: r.reads.token, source: 'inline', botUsername: 'vitalscheck_bot' });
  assert.equal(warm.kind, 'ok', `could not warm the cache: ${warm.kind}`);
  assert.equal(warm.meta.early, true, 'the token must still be inside the early window');

  await bot.handleUpdate({
    update_id: 1,
    inline_query: { id: 'q1', from: { id: 8801, is_bot: false, first_name: 'U' }, query: r.reads.token, offset: '' },
  });
  const answer = calls.find((c) => c.method === 'answerInlineQuery');
  assert.ok(answer, 'inline query was not answered');
  const expected = Math.max(1, Math.floor(EARLY_CACHE_TTL_MS / 1000));
  assert.equal(answer.payload.cache_time, expected,
    `early inline answer cache_time was ${answer.payload.cache_time}s, expected ${expected}s — 60s would keep serving a stale "launched Ns ago" to every user`);
  const text = answer.payload.results[0].input_message_content.message_text;
  // inline sends the same default card as every other surface
  assert.match(text, /^VITALS  /, `inline message_text was: ${text.split('\n')[0]}`);
  assert.ok(!/<[a-z/]/i.test(text), 'inline message_text is plain text');
  ok(`inline answer for an early token caches for ${answer.payload.cache_time}s, not 60s`);
}

// ---- repeated early scans must not multiply rows or rechecks --------------
{
  const { scanCache } = await import('../dist/cache.js');
  const before = db.prepare('SELECT COUNT(*) n FROM scans').get().n;
  const beforeRechecks = db.prepare('SELECT COUNT(*) n FROM rechecks WHERE token = ?').get(r.reads.token.toLowerCase()).n;
  const ids = new Set();
  for (let i = 0; i < 5; i++) {
    scanCache.sweep();               // force a real re-scan, as "re-scan in 2 min" invites
    const again = await scanToken(r.reads.token);
    if (again && again.isEarly) ids.add(again.scanId);
  }
  const added = db.prepare('SELECT COUNT(*) n FROM scans').get().n - before;
  const addedRechecks = db.prepare('SELECT COUNT(*) n FROM rechecks WHERE token = ?').get(r.reads.token.toLowerCase()).n - beforeRechecks;
  assert.equal(added, 0, `5 early re-scans added ${added} extra scans rows — the table this product is built on must not fill with all-NULL duplicates`);
  assert.equal(addedRechecks, 0, `5 early re-scans queued ${addedRechecks} extra rechecks`);
  assert.equal(ids.size, 1, 'every early re-scan reuses the first row');
  ok('5 early re-scans reused one row and queued no extra rechecks');
}

// ---- the clock cross-check must not misfire on a settled token -------------
{
  const settled = await scanToken('0xd384722f6adfe7d79E8e6623896DF199afD31B76');
  if (settled) {
    const wall = Math.floor(Date.now() / 1000) - settled.launchedAt;
    assert.ok(Math.abs(settled.ageSeconds - wall) < 60,
      `a settled token's age (${settled.ageSeconds}s) should track the wall clock (${wall}s); ` +
      'a large gap means the block-derived estimate was substituted, which drifts about a percent over long spans');
    assert.equal(settled.isEarly, false);
    ok(`settled token age tracks the wall clock (${settled.ageSeconds}s vs ${wall}s)`);
  }
}

console.log('\nAll early-mode live checks passed.');
process.exit(0);
