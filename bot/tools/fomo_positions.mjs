#!/usr/bin/env node
/**
 * What the scored traders are actually holding, joined to our index.
 *
 * Keyless and read-only. The leaderboard and the per-trader book are both
 * public on fomoradar; the join side is our own sqlite index. Nothing here
 * spends a wallet, signs anything or writes to the index.
 *
 *   node tools/fomo_positions.mjs
 *
 * Writes tools/out/fomo_positions.csv and prints the three summaries.
 *
 * The handle list is rebuilt from the leaderboard rather than read from
 * tools/out/fomo_top.csv: that file is written by a laptop and is not in the
 * repository, and a run that cannot be reproduced from the API alone is a run
 * nobody can check.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'out');

const F = await import(join(ROOT, 'dist/fomo.js'));
const Database = (await import('better-sqlite3')).default;

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

const TOP_N = Number(arg('--top', '125'));
const HOURS = Number(arg('--hours', '8760'));
const PACE_MS = Number(arg('--pace', '520'));
const DB_PATH = arg('--db', join(ROOT, 'pons.db'));

/** Whole tokens per launch on this factory: supply 1e27 wei at 18 decimals. */
const WHOLE_SUPPLY = 1e9;

/** The utility rule, as specified: a website in OUR index and tax at or under 1%. */
const UTILITY_MAX_TAX_BPS = 100;

/** Held by this many of the sampled traders is a shared bag. */
const SHARED_MIN_HOLDERS = 3;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const die = (m) => { console.error(`\n  ${red(m)}\n`); process.exit(1); };
const h = (t) => { console.log(`\n${bold('  ' + t)}`); console.log(dim('  ' + '-'.repeat(74))); };

if (has('--help')) {
  console.log(`
  node tools/fomo_positions.mjs [options]

  --top <n>     how many traders, by score (default ${TOP_N})
  --hours <n>   window asked of the trader endpoint (default ${HOURS}, the API max)
  --pace <ms>   gap between requests (default ${PACE_MS}; the free tier is 120/min)
  --db <path>   the index to join against (default bot/pons.db)
`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One GET, with the User-Agent the free tier requires.
 *
 * The host is the pinned constant from src/fomo.ts and is never taken from a
 * redirect: a lookalike radar is the same class of problem as a lookalike RPC.
 */
async function getJson(path, { tries = 3 } = {}) {
  const url = `${F.FOMORADAR_HOST}${path}`;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'vitals-research/1.0' },
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status}`);
        await sleep(2000 * (i + 1));
        continue;
      }
      if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
      return { ok: true, body: await res.json() };
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (i + 1));
    }
  }
  return { ok: false, status: 0, reason: String(lastErr?.message ?? lastErr).slice(0, 80) };
}

// ------------------------------------------------------------- the handles

h('the traders');
const lb = await getJson('/api/leaderboard?status=all&limit=400');
if (!lb.ok) die(`the leaderboard could not be read: ${lb.reason}`);
const { traders, skipped } = F.parseLeaderboard(lb.body);
if (skipped) console.log(dim(`  ${skipped} board rows carried no address and were dropped`));

// Score descending, then handle, so the same board gives the same 125 twice.
const ranked = [...traders].sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
const picked = ranked.slice(0, TOP_N);
if (picked.length < TOP_N) die(`the board returned ${picked.length} traders, fewer than the ${TOP_N} asked for`);
const cut = picked[picked.length - 1].score;
const atCut = ranked.filter((t) => t.score === cut).length;
console.log(`  ${traders.length} on the board, top ${picked.length} taken by score`);
console.log(dim(`  scores ${picked[0].score} down to ${cut}. ${atCut} traders sit on ${cut}, so the last places are decided by handle order.`));

// ------------------------------------------------------------ the positions

h('the books');
const rows = [];
const failed = [];
let done = 0;
for (const t of picked) {
  const r = await getJson(`/api/trader/${encodeURIComponent(t.handle)}?hours=${HOURS}`);
  done++;
  if (!r.ok) {
    failed.push({ handle: t.handle, reason: r.reason });
  } else {
    const body = r.body ?? {};
    // Both books. The open one carries cost and unrealised and never a
    // realised figure; the closed one carries realised and never a cost. One
    // array would have silently dropped half of what was asked for.
    for (const [book, arr] of [['open', body.positions], ['closed', body.closed]]) {
      if (!Array.isArray(arr)) continue;
      for (const p of arr) rows.push({ trader: t, book, p });
    }
  }
  if (done % 25 === 0 || done === picked.length) {
    process.stdout.write(dim(`\r  ${done}/${picked.length} read, ${rows.length} position rows, ${failed.length} failed   `));
  }
  if (done < picked.length) await sleep(PACE_MS);
}
console.log('');
for (const f of failed) console.log(dim(`  ${f.handle}: ${f.reason}`));

// ---------------------------------------------------------------- the join

h('the index');
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (err) {
  die(`${DB_PATH} could not be opened read-only: ${String(err.message).slice(0, 120)}`);
}
const indexed = db.prepare('SELECT COUNT(*) n FROM launches').get().n;
const lookup = db.prepare(
  `SELECT token, name, symbol, social_web, social_x, social_tg, creator_tax_bps, launched_at
     FROM launches WHERE token = ?`,
);
console.log(`  ${DB_PATH}, ${indexed.toLocaleString('en-US')} launches`);
console.log(dim('  description is not a column on launches and is not decoded from the calldata,'));
console.log(dim('  so the join cannot supply it and the classification uses the rule instead.'));

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const out = [];
for (const { trader, book, p } of rows) {
  const ca = typeof p.token === 'string' ? p.token.toLowerCase() : '';
  const chain = typeof p.chain === 'string' ? p.chain : '';
  const idx = /^0x[0-9a-f]{40}$/.test(ca) ? lookup.get(ca) : undefined;

  const boughtUsd = num(p.bought_usd);
  const boughtAmt = num(p.bought_amt);
  // Entry price is the average paid across the buys, which is what the two
  // totals give. It is not the first fill's price and is not labelled as one.
  const entryPrice = boughtUsd !== null && boughtAmt ? boughtUsd / boughtAmt : null;
  const entryMcap = entryPrice === null ? null : entryPrice * WHOLE_SUPPLY;

  const web = idx?.social_web?.trim() || '';
  const tax = idx?.creator_tax_bps ?? null;
  // The rule as given. A token our index has never seen cannot satisfy the
  // website half of it, so it falls to meme, and the column below says which
  // rows were decided without an index row behind them.
  const utility = Boolean(web) && tax !== null && tax <= UTILITY_MAX_TAX_BPS;

  out.push({
    handle: trader.handle,
    wallet: trader.address,
    fomo_score: trader.score,
    style: trader.style.join(' '),
    book,
    state: p.state ?? '',
    chain,
    symbol: p.sym ?? '',
    ca,
    in_index: idx ? 1 : 0,
    index_name: idx?.name ?? '',
    index_symbol: idx?.symbol ?? '',
    website: web,
    tax_bps: tax,
    launched_at: idx?.launched_at ?? null,
    class: utility ? 'utility' : 'meme',
    cost_usd: num(p.cost),
    realized_usd: num(p.realized),
    unrealized_usd: num(p.unrealized),
    bought_usd: boughtUsd,
    bought_amt: boughtAmt,
    entry_price_usd: entryPrice,
    entry_mcap_usd: entryMcap,
    value_usd: num(p.value) ?? num(p.worth),
    first_buy_ts: num(p.first_ts),
    src: p.src ?? '',
  });
}

const HEAD = [
  'handle', 'wallet', 'fomo_score', 'style', 'book', 'state', 'chain', 'symbol', 'ca',
  'in_index', 'index_name', 'index_symbol', 'website', 'tax_bps', 'launched_at', 'class',
  'cost_usd', 'realized_usd', 'unrealized_usd', 'bought_usd', 'bought_amt',
  'entry_price_usd', 'entry_mcap_usd', 'value_usd', 'first_buy_ts', 'src',
];
mkdirSync(OUT, { recursive: true });
const csvPath = join(OUT, 'fomo_positions.csv');
writeFileSync(csvPath, [
  F.csvRow(HEAD),
  ...out.map((r) => F.csvRow(HEAD.map((k) => r[k] ?? ''))),
].join('\n') + '\n');
console.log(`\n  ${csvPath}`);
console.log(`  ${out.length.toLocaleString('en-US')} rows, ${new Set(out.map((r) => r.ca)).size.toLocaleString('en-US')} distinct tokens`);

// ------------------------------------------------------------ the summaries

const usd = (n) => (n === null ? 'n/a' : `$${Math.round(n).toLocaleString('en-US')}`);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

/** One row per (token, trader): the unit for "held by N traders". */
const onIndexChain = out.filter((r) => r.chain === 'robinhood');

h('1. meme vs utility, by the rule (website in our index AND tax <= 1%)');
{
  const coverage = onIndexChain.filter((r) => r.in_index === 1).length;
  console.log(`  ${onIndexChain.length.toLocaleString('en-US')} position rows on this chain, ${coverage.toLocaleString('en-US')} of them matched a row in our index (${pct(coverage, onIndexChain.length)})`);
  console.log(dim('  a token our index has not seen cannot satisfy the website half, so it counts as meme'));

  // By count, the unit is the position row. By dollars, the unit is money at
  // risk: cost for an open bag, and what was bought for a closed one, because
  // a closed position has no cost figure at all.
  const dollarsOf = (r) => (r.book === 'open' ? r.cost_usd : null) ?? r.bought_usd;
  for (const [label, set] of [['every row', out], ['this chain only', onIndexChain]]) {
    const u = set.filter((r) => r.class === 'utility');
    const m = set.filter((r) => r.class === 'meme');
    const sum = (rs) => rs.reduce((a, r) => a + (dollarsOf(r) ?? 0), 0);
    const su = sum(u), sm = sum(m);
    const missing = set.filter((r) => dollarsOf(r) === null).length;
    console.log(`\n  ${label}`);
    console.log(`    by count   utility ${u.length.toLocaleString('en-US')} (${pct(u.length, set.length)})   meme ${m.length.toLocaleString('en-US')} (${pct(m.length, set.length)})`);
    console.log(`    by dollars utility ${usd(su)} (${pct(su, su + sm)})   meme ${usd(sm)} (${pct(sm, su + sm)})`);
    if (missing) console.log(dim(`    ${missing} rows carried no cost and no bought figure and are in the counts but not the dollars`));
  }
}

h('   the borderline: rows that satisfy one half of the rule and not the other');
{
  const near = new Map();
  for (const r of out) {
    if (r.in_index !== 1) continue;
    const hasWeb = Boolean(r.website);
    const lowTax = r.tax_bps !== null && r.tax_bps <= UTILITY_MAX_TAX_BPS;
    if (hasWeb === lowTax) continue; // decided cleanly by both halves
    if (!near.has(r.ca)) {
      near.set(r.ca, {
        ca: r.ca, sym: r.symbol || r.index_symbol, web: r.website,
        tax: r.tax_bps, why: hasWeb ? 'website, tax over 1%' : 'tax under 1%, no website',
        holders: new Set(),
      });
    }
    near.get(r.ca).holders.add(r.handle);
  }
  const list = [...near.values()].sort((a, b) => b.holders.size - a.holders.size || a.sym.localeCompare(b.sym));
  if (!list.length) console.log('  none');
  for (const t of list.slice(0, 40)) {
    const taxPct = t.tax === null ? 'tax unread' : `${(t.tax / 100).toFixed(2)}%`;
    console.log(`  ${(t.sym || '(no symbol)').padEnd(12)} ${t.ca}  ${String(t.holders.size).padStart(3)} holders  ${taxPct.padEnd(11)} ${t.why}`);
    if (t.web) console.log(dim(`    ${t.web}`));
  }
  if (list.length > 40) console.log(dim(`  and ${list.length - 40} more, in the csv`));
}

h(`2. shared bags: tokens held by ${SHARED_MIN_HOLDERS}+ of the ${picked.length}`);
{
  const byToken = new Map();
  for (const r of out) {
    if (r.book !== 'open') continue; // held, not closed
    if (!byToken.has(r.ca)) byToken.set(r.ca, { ca: r.ca, sym: r.symbol, chain: r.chain, cls: r.class, inIndex: r.in_index, holders: new Set(), cost: 0 });
    const t = byToken.get(r.ca);
    t.holders.add(r.handle);
    t.cost += r.cost_usd ?? 0;
  }
  const shared = [...byToken.values()].filter((t) => t.holders.size >= SHARED_MIN_HOLDERS)
    .sort((a, b) => b.holders.size - a.holders.size || b.cost - a.cost);
  console.log(`  ${shared.length} of ${byToken.size} held tokens are in ${SHARED_MIN_HOLDERS}+ books`);
  console.log('');
  console.log(`  ${'symbol'.padEnd(12)} ${'holders'.padStart(7)}  ${'combined cost'.padStart(14)}  ${'class'.padEnd(8)} ca`);
  for (const t of shared.slice(0, 40)) {
    console.log(`  ${(t.sym || '(none)').padEnd(12)} ${String(t.holders.size).padStart(7)}  ${usd(t.cost).padStart(14)}  ${t.cls.padEnd(8)} ${t.ca}${t.inIndex ? '' : dim('  not in our index')}`);
  }
  if (shared.length > 40) console.log(dim(`  and ${shared.length - 40} more, in the csv`));
}

h('3. entry market cap: bought_usd / bought_amt, times 1e9 whole tokens');
{
  const withEntry = out.filter((r) => r.entry_mcap_usd !== null && r.entry_mcap_usd > 0);
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const report = (label, set) => {
    const v = set.map((r) => r.entry_mcap_usd);
    const med = median(v);
    console.log(`  ${label.padEnd(26)} ${med === null ? 'n/a' : usd(med).padStart(16)}   n=${set.length.toLocaleString('en-US')}`);
  };
  console.log(`  ${withEntry.length.toLocaleString('en-US')} of ${out.length.toLocaleString('en-US')} rows carry both totals, so the rest have no entry price`);
  console.log('');
  report('all rows', withEntry);
  const rh = withEntry.filter((r) => r.chain === 'robinhood');
  report('this chain only', rh);
  if (rh.length === withEntry.length) {
    console.log(dim('    the two lines match because only this chain\'s rows carry a bought amount'));
  }
  report('open bags', withEntry.filter((r) => r.book === 'open'));
  report('closed', withEntry.filter((r) => r.book === 'closed'));
  report('classed utility', withEntry.filter((r) => r.class === 'utility'));
  report('classed meme', withEntry.filter((r) => r.class === 'meme'));
  console.log('');
  console.log(dim('  the average paid across a position\'s buys, not the first fill. 1e9 whole tokens'));
  console.log(dim('  is this factory\'s fixed supply, so an entry on another chain is not comparable'));
  console.log(dim('  and the per-chain line is the one to read.'));
}

console.log('');
db.close();
