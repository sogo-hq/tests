/**
 * The leaderboard, and the line it must not cross.
 *
 * A multiple is a fact about the token: it reads the same whoever posted the
 * address, and whether anyone bought or sold is not in it. A profit would be a
 * claim about a person's trading, which this tool has no way to know and no
 * business asserting. These tests hold that line and the arithmetic underneath
 * it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('leaderboard');
const F = await import('../dist/firstcall.js');
const { db } = await import('../dist/db.js');

const CHAT = -1001;
const NOW = 1_789_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);
const E = 1_000_000_000_000_000_000n;

const token = (n) => '0x' + String(n).repeat(40).slice(0, 40);

let seq = 0;
function launch(tok, symbol) {
  db.prepare(
    `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at, symbol)
     VALUES (?,?,?,?,1,'1',?,?,?,?)`,
  ).run(tok, '0x' + 'c'.repeat(40), '0x' + 'd'.repeat(40), '0x' + 'e'.repeat(40),
    ++seq, '0x' + String(seq).padStart(64, '0'), NOW_SEC - 86_400, symbol);
}

function trade(tok, agoSec, quote, amount) {
  db.prepare(
    `INSERT OR REPLACE INTO trades (tx_hash, log_index, token, curve, side, trader, recipient,
       quote_amount, token_amount, fee, creator_tax, block_number, block_time)
     VALUES (?,?,?,?,'buy',?,?,?,?,'0','0',?,?)`,
  ).run('0x' + String(++seq).padStart(64, '0'), seq, tok, '0x' + 'c'.repeat(40),
    '0x' + '9'.repeat(40), '0x' + '9'.repeat(40),
    String(quote), String(amount), 1000 + seq, NOW_SEC - agoSec);
}

test('the multiple is from the call to the peak AFTER it', () => {
  const t = token(1);
  launch(t, 'MIKA');
  // The token ran to 10x BEFORE the call and 2x after it. A caller who posted
  // it on the way down has not called a 10x, and ranking them by a high that
  // happened before they spoke would say they had.
  trade(t, 7200, 10n * E, 1n * E);   // price 10, two hours ago
  trade(t, 3600, 1n * E, 1n * E);    // price 1, an hour ago: the call moment
  trade(t, 1800, 2n * E, 1n * E);    // price 2, half an hour ago
  F.recordFirstCall({
    chatId: CHAT, token: t, userId: 11, username: 'alice',
    mcapQuote: 5, blockNumber: 1, now: NOW - 3_600_000,
  });

  const rows = F.leaderboard(CHAT, 7, NOW);
  assert.equal(rows.length, 1);
  assert.equal(Math.round(rows[0].multiple * 10) / 10, 2, `got ${rows[0].multiple}x`);
  assert.equal(rows[0].mcapQuote, 5);
  assert.equal(rows[0].peakQuote, 10);
  assert.equal(rows[0].symbol, 'MIKA');
});

test('a caller is ranked by their best call, not by all of them', () => {
  const a = token(2);
  const b = token(3);
  launch(a, 'AAA');
  launch(b, 'BBB');
  for (const [t, mult] of [[a, 3n], [b, 8n]]) {
    trade(t, 3600, 1n * E, 1n * E);
    trade(t, 1800, mult * E, 1n * E);
    F.recordFirstCall({
      chatId: CHAT, token: t, userId: 22, username: 'bob',
      mcapQuote: 1, blockNumber: 1, now: NOW - 3_600_000,
    });
  }
  const mine = F.leaderboard(CHAT, 7, NOW).filter((r) => r.userId === 22);
  assert.equal(mine.length, 1, 'one caller appeared twice');
  assert.equal(Math.round(mine[0].multiple), 8);
  assert.equal(mine[0].symbol, 'BBB');
});

test('the ranking is by multiple, descending, and capped at ten', () => {
  for (let i = 0; i < 14; i++) {
    const t = token(4 + i % 6) + String(i).padStart(2, '0').slice(0, 0) || token(4);
    const tok = '0x' + (100 + i).toString(16).padStart(40, '0');
    launch(tok, `T${i}`);
    trade(tok, 3600, 1n * E, 1n * E);
    trade(tok, 1800, BigInt(i + 2) * E, 1n * E);
    F.recordFirstCall({
      chatId: CHAT, token: tok, userId: 1000 + i, username: `u${i}`,
      mcapQuote: 1, blockNumber: 1, now: NOW - 3_600_000,
    });
  }
  const rows = F.leaderboard(CHAT, 7, NOW);
  assert.equal(rows.length, 10, 'the list is top ten');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].multiple >= rows[i].multiple, 'the list is not sorted by multiple');
  }
});

test('the window is the window', () => {
  const t = '0x' + 'f'.repeat(40);
  launch(t, 'OLD');
  trade(t, 3600, 1n * E, 1n * E);
  trade(t, 1800, 9n * E, 1n * E);
  F.recordFirstCall({
    chatId: CHAT, token: t, userId: 77, username: 'old',
    mcapQuote: 1, blockNumber: 1, now: NOW - 20 * 86_400_000,
  });
  assert.ok(!F.leaderboard(CHAT, 7, NOW).some((r) => r.userId === 77), '7d included a 20-day-old call');
  assert.ok(F.leaderboard(CHAT, 30, NOW).some((r) => r.userId === 77), '30d excluded a 20-day-old call');
});

test('a call with nothing traded after it is left out, not ranked at zero', () => {
  const t = '0x' + '8'.repeat(40);
  launch(t, 'QUIET');
  F.recordFirstCall({
    chatId: CHAT, token: t, userId: 88, username: 'quiet',
    mcapQuote: 1, blockNumber: 1, now: NOW - 3_600_000,
  });
  assert.ok(!F.leaderboard(CHAT, 7, NOW).some((r) => r.userId === 88));
});

test('a call with no recorded market cap cannot be ranked and is not', () => {
  const t = '0x' + '7'.repeat(40);
  launch(t, 'NOMC');
  trade(t, 1800, 5n * E, 1n * E);
  F.recordFirstCall({
    chatId: CHAT, token: t, userId: 99, username: 'nomc',
    mcapQuote: null, blockNumber: 1, now: NOW - 3_600_000,
  });
  assert.ok(!F.leaderboard(CHAT, 7, NOW).some((r) => r.userId === 99),
    'a call with no market cap was ranked, which means it was ranked against a zero');
});

test('the board is per group', () => {
  assert.equal(F.leaderboard(-9999, 30, NOW).length, 0);
});

// ---------------------------------------------------------------- rendering

test('it states multiples and never a profit', () => {
  const text = F.renderLeaderboard(CHAT, 7, 'ETH', NOW);
  assert.match(text, /calls in this group, last 7 days/);
  assert.match(text, /^1\. @\w+, \$\w+, [\d.]+x, called at [\d.KM]+ ETH$/m);
  assert.match(text, /calls are records, not advice/);
  for (const banned of [/\bprofit\b/i, /\bpnl\b/i, /\bmade\b/i, /\bgain/i, /\bearn/i]) {
    assert.doesNotMatch(text, banned, `the board reads as a profit: ${text}`);
  }
  // No dollar figures: there is no oracle for one here.
  assert.doesNotMatch(text.replace(/\$[A-Z]/g, ''), /\$/);
});

test('an empty board says what it is waiting for', () => {
  const text = F.renderLeaderboard(-4242, 7, 'ETH', NOW);
  assert.match(text, /nothing to rank yet/);
  assert.match(text, /calls are records, not advice/);
});

// ------------------------------------------------------------- the picture

test('the call card states two market caps and the ratio, and nothing else', async () => {
  const { callCardSvg } = await import('../dist/image.js');
  const svg = callCardSvg({
    symbol: 'MIKA', token: '0x147bbaa458ab7cd11e1e478b87f08fe5a42a9e67',
    username: 'alice', calledAt: NOW_SEC, mcapQuote: 0.067, athQuote: 1.68,
    multiple: 25.1, quote: 'ETH', botUsername: 'vitalscheck_bot',
  }, new Date(Date.UTC(2026, 8, 11, 14, 32)));

  const bodies = [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.ok(bodies.includes('25.1x'));
  assert.ok(bodies.includes('0.067 ETH'));
  assert.ok(bodies.includes('1.68 ETH'));
  assert.ok(bodies.some((b) => b.includes('startgroup=true')), 'no add-to-group link');
  assert.ok(bodies.some((b) => /not advice, and not a profit/.test(b)));
  for (const banned of [/\bprofit of\b/i, /\bpnl\b/i, /\bmade\b/i]) {
    assert.ok(!bodies.some((b) => banned.test(b)), `the card reads as a profit: ${bodies.join(' | ')}`);
  }
});

test('nothing on the call card is drawn over anything else', async () => {
  const { callCardSvg, SANS_FILE } = await import('../dist/image.js');
  const { measure } = await import('../dist/fontmetrics.js');
  const svg = callCardSvg({
    symbol: 'MIKA', token: '0x147bbaa458ab7cd11e1e478b87f08fe5a42a9e67',
    username: 'alice', calledAt: NOW_SEC, mcapQuote: 0.067, athQuote: 1.68,
    multiple: 25.1, quote: 'ETH', botUsername: 'vitalscheck_bot',
  }, new Date(Date.UTC(2026, 8, 11, 14, 32)));
  const H = Number(/<svg[^>]*height="(\d+)"/.exec(svg)[1]);

  const rows = [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const attr = (n) => (new RegExp(`${n}="([^"]*)"`).exec(m[1]) ?? [])[1];
    return {
      y: Number(attr('y')), x: Number(attr('x')),
      size: Number(attr('font-size')), anchor: attr('text-anchor') ?? 'start',
      body: m[2],
    };
  }).sort((a, b) => a.y - b.y);

  for (const r of rows) assert.ok(r.y <= H - 40, `"${r.body}" sits below the card`);
  for (let i = 1; i < rows.length; i++) {
    const above = rows[i - 1];
    const below = rows[i];
    if (below.y - above.y > above.size * 0.9) continue;
    if (Math.abs(below.y - above.y) < 0.01) continue;
    const aRight = above.anchor === 'end' ? above.x : above.x + measure(above.body, above.size, SANS_FILE);
    const bLeft = below.anchor === 'end' ? below.x - measure(below.body, below.size, SANS_FILE) : below.x;
    assert.ok(bLeft >= aRight - 1,
      `"${below.body}" at y=${below.y} collides with "${above.body}" at y=${above.y}`);
  }
});
