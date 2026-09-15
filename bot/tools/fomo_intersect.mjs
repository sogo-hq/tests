#!/usr/bin/env node
/**
 * Scored traders who hold our tokens.
 *
 * Two sources. The fomoradar leaderboard, which is public and keyless, gives
 * a handle, a score, a style and a wallet for every scored trader. robinx's
 * smart_holders, which is paid and settles over x402, gives the wallets
 * holding a token. The overlap is the list.
 *
 *   ROBINX_WALLET_KEY=0x... node tools/fomo_intersect.mjs
 *
 * Writes tools/out/t1_candidates.csv and tools/out/fomo_top.csv.
 *
 * Nothing about this touches the bot. It runs on a laptop, it spends the
 * wallet in ROBINX_WALLET_KEY, and it says what each call cost before making
 * it. --dry does everything except the paid calls.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'out');

const F = await import(join(ROOT, 'dist/fomo.js'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const all = (f) => argv.reduce((a, x, i) => (x === f && argv[i + 1] ? [...a, argv[i + 1]] : a), []);

const DRY = has('--dry');
const LIMIT = arg('--limit', '400');
const MIN_SCORE = Number(arg('--min-score', String(F.FOMO_TOP_SCORE)));
const ROBINX_CMD = arg('--robinx-cmd', 'npx -y robinx-mcp');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const die = (m, code = 1) => { console.error(`\n  ${m}\n`); process.exit(code); };
const h = (t) => { console.log(`\n${bold('  ' + t)}`); console.log(dim('  ' + '-'.repeat(72))); };

if (has('--help')) {
  console.log(`
  node tools/fomo_intersect.mjs [options]

  --dry                 the leaderboard and the CSVs, no paid calls
  --token <SYMBOL:0x..> a token to check, repeatable. overrides the defaults
  --limit <n>           leaderboard page size (default 400)
  --min-score <n>       the cut for fomo_top.csv (default ${F.FOMO_TOP_SCORE})
  --robinx-cmd <cmd>    how to reach robinx (default "npx -y robinx-mcp")
`);
  process.exit(0);
}

// --------------------------------------------------------------- the tokens

/** ZZZ and CHIPPER are fixed. The third is the newest graduated launch. */
const FIXED = [
  { symbol: 'ZZZ', address: '0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a' },
  { symbol: 'CHIPPER', address: '0xd384722f6adfe7d79e8e6623896df199afd31b76' },
];

function parseTokenArg(s) {
  const m = /^([^:]+):(0x[0-9a-fA-F]{40})$/.exec(s.trim());
  if (!m) die(`--token wants SYMBOL:0xADDRESS, got ${JSON.stringify(s)}`);
  return { symbol: m[1].toUpperCase(), address: m[2].toLowerCase() };
}

/**
 * The newest graduated launch, from the bot's own index.
 *
 * Only reached when no --token was given. The index lives with the bot, so a
 * machine that does not have one is told to name the token rather than being
 * handed a silent default.
 */
async function newestGraduated() {
  try {
    const { db } = await import(join(ROOT, 'dist/db.js'));
    const { BLOCK_TIME_SECONDS } = await import(join(ROOT, 'dist/config.js'));
    const row = db.prepare(
      `SELECT token, symbol,
              launched_at + (graduated_at - block_number) * ? AS graduated_ts
         FROM launches
        WHERE phase = 2 AND graduated_at IS NOT NULL AND symbol IS NOT NULL
        ORDER BY graduated_ts DESC LIMIT 1`,
    ).get(BLOCK_TIME_SECONDS);
    if (!row) return null;
    return { symbol: String(row.symbol).toUpperCase(), address: String(row.token).toLowerCase(), at: row.graduated_ts };
  } catch (err) {
    console.warn(dim(`  the index could not be read: ${String(err?.message ?? err).slice(0, 100)}`));
    return null;
  }
}

// ---------------------------------------------------------------- the fetch

async function leaderboard() {
  const url = `${F.FOMORADAR_HOST}/api/leaderboard?status=active&limit=${encodeURIComponent(LIMIT)}`;
  console.log(`  GET ${url}`);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) die(`the leaderboard answered ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * One paid call, over MCP on stdin and stdout.
 *
 * The full handshake, not a bare tools/call: an MCP server is entitled to
 * refuse anything before initialize, and a server that happens not to is not
 * something to depend on. The three messages go in together and the answer to
 * the third is picked out of whatever comes back by its id.
 */
function robinxSmartHolders(token) {
  return new Promise((resolve) => {
    const [cmd, ...args] = ROBINX_CMD.split(/\s+/);
    const child = spawn(cmd, args, {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, reason: `${cmd} could not be started: ${e.message}` }));
    child.on('close', () => {
      // Line-delimited JSON on the way back. The one that matters carries id 2.
      let answer = null;
      for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const m = JSON.parse(t);
          if (m.id === 2) answer = m;
        } catch (e) { /* a line that is not a message */ }
      }
      if (!answer) {
        return resolve({ ok: false, reason: `no answer from robinx${err ? `: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 200)}` : ''}` });
      }
      if (answer.error) return resolve({ ok: false, reason: `robinx: ${answer.error.message ?? JSON.stringify(answer.error).slice(0, 160)}` });
      const parsed = F.parseSmartHolders(answer);
      if (!parsed.wallets.length) {
        return resolve({ ok: false, reason: 'robinx answered, and no holder addresses could be read out of it', raw: answer });
      }
      resolve({ ok: true, ...parsed, raw: answer });
    });
    const msg = (o) => `${JSON.stringify(o)}\n`;
    child.stdin.write(msg({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'vitals-fomo-intersect', version: '1' },
      },
    }));
    child.stdin.write(msg({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    child.stdin.write(msg({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'robinx_smart_holders', arguments: { token } },
    }));
    child.stdin.end();
  });
}

// ------------------------------------------------------------------- the run

console.log(`\n${bold('  fomo intersect')}${DRY ? dim('  (dry: no paid calls)') : ''}`);
mkdirSync(OUT, { recursive: true });

h('the tokens');
const named = all('--token').map(parseTokenArg);
let tokens;
if (named.length) {
  tokens = named;
} else {
  const newest = await newestGraduated();
  if (!newest) {
    die('the third token is the newest graduated launch, and the index here has none.\n'
      + '  name the tokens instead:  --token ZZZ:0x… --token CHIPPER:0x… --token FOO:0x…');
  }
  tokens = [...FIXED, newest];
  console.log(dim(`  the third is the newest graduated launch in the index, ${new Date((newest.at ?? 0) * 1000).toISOString().slice(0, 10)}`));
}
for (const t of tokens) console.log(`  ${t.symbol.padEnd(12)} ${t.address}`);

h('the leaderboard');
const { traders, skipped } = F.parseLeaderboard(await leaderboard());
if (!traders.length) die('the leaderboard returned no traders with an address');
console.log(`  ${traders.length} scored trader${traders.length === 1 ? '' : 's'}${skipped ? `, ${skipped} with no address, dropped` : ''}`);
const scores = traders.map((t) => t.score);
console.log(dim(`  scores ${Math.min(...scores)} to ${Math.max(...scores)}`));

const top = F.topTraders(traders, MIN_SCORE);
const topPath = join(OUT, 'fomo_top.csv');
writeFileSync(topPath, F.topCsv(top));
console.log(`  ${top.length} at or above ${MIN_SCORE}, written to ${topPath}`);

h(DRY ? 'smart holders (skipped)' : 'smart holders, paid, one call per token');
const held = [];
if (DRY) {
  console.log(dim('  --dry: no paid calls made, so the candidates file would be empty. run without --dry.'));
} else {
  if (!(process.env.ROBINX_WALLET_KEY ?? '').trim()) {
    die('ROBINX_WALLET_KEY is not set in this shell.\n'
      + '  the smart holders call is paid and settles over x402 from that wallet.\n'
      + '  ROBINX_WALLET_KEY=0x... node tools/fomo_intersect.mjs');
  }
  for (const f of readdirSync(ROOT).filter((x) => x === '.env' || x.startsWith('.env.'))) {
    if (/^\s*(export\s+)?ROBINX_WALLET_KEY\s*=/m.test(readFileSync(join(ROOT, f), 'utf8'))) {
      die(red(`ROBINX_WALLET_KEY is set in ${f}.`) + '\n  a key that spends money never lives in a file next to the code.');
    }
  }
  console.log(dim(`  via: ${ROBINX_CMD}`));
  for (const t of tokens) {
    process.stdout.write(`  ${t.symbol.padEnd(12)} `);
    const r = await robinxSmartHolders(t.address);
    if (!r.ok) {
      console.log(red(`no holders: ${r.reason}`));
      if (r.raw) writeFileSync(join(OUT, `robinx-${t.symbol.toLowerCase()}-unparsed.json`), JSON.stringify(r.raw, null, 2));
      held.push({ ...t, holders: [], receipt: null });
      continue;
    }
    console.log(`${r.wallets.length} holder${r.wallets.length === 1 ? '' : 's'}${r.receipt ? dim(`  receipt ${r.receipt.slice(0, 18)}`) : ''}`);
    writeFileSync(join(OUT, `robinx-${t.symbol.toLowerCase()}.json`), JSON.stringify(r.raw, null, 2));
    held.push({ ...t, holders: r.wallets, receipt: r.receipt });
  }
}

h('the overlap');
const candidates = F.intersect(traders, held);
const candPath = join(OUT, 't1_candidates.csv');
writeFileSync(candPath, F.candidatesCsv(candidates));
if (!candidates.length) {
  console.log(`  no scored trader holds any of the three. ${candPath} has its header and nothing else.`);
} else {
  console.log(`  ${candidates.length} scored trader${candidates.length === 1 ? '' : 's'} hold at least one\n`);
  console.log(`  ${'score'.padStart(5)}  ${'username'.padEnd(18)} ${'style'.padEnd(18)} holds`);
  for (const c of candidates.slice(0, 25)) {
    console.log(`  ${String(c.score).padStart(5)}  ${c.handle.padEnd(18)} ${c.style.join(' ').padEnd(18)} ${c.tokens.join(' ')}`);
  }
  if (candidates.length > 25) console.log(dim(`  and ${candidates.length - 25} more in the csv`));
}
console.log(`\n  ${candPath}`);
console.log(`  ${topPath}\n`);
