/**
 * The daily numbers.
 *
 * Six counts, and what is pinned is the definition behind each one: a scan is
 * one token that finished, a day is a Bratislava day, an exempt wallet is one
 * the logs named besides the deployer, a group can leave, and a count from an
 * index that did not finish arrives with the reason attached. The card and the
 * caption say the same six things, and neither says the word "score".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('numbers');
const N = await import('../dist/numbers.js');
const { db, setCursor } = await import('../dist/db.js');
const { recordBotChat } = await import('../dist/chats.js');
const { setSetting } = await import('../dist/ready.js');
const { clearLaunchPlan } = await import('../dist/launch.js');
const { recordIndexAdvance } = await import('../dist/indexer/health.js');
const { markRecovering } = await import('../dist/coverage.js');
const { BLOCKS_PER_MINUTE } = await import('../dist/config.js');
const { SANS_FILE } = await import('../dist/image.js');
const { measure } = await import('../dist/fontmetrics.js');

const EM = String.fromCharCode(0x2014);
const A = (n) => '0x' + String(n).padStart(40, '0');
const sec = (...ymdhm) => Math.floor(Date.UTC(...ymdhm) / 1000);

/**
 * 23:30 UTC on 10 September 2026 is 01:30 CEST on the 11th. Every scan seeded
 * below lands on 10 September by the UTC clock, so a count taken by UTC day
 * would give a different answer from the one this bot promises.
 */
const NOW = Date.UTC(2026, 8, 10, 23, 30);

const scan = (ts, token, outcome = 'ok') => db.prepare(
  `INSERT INTO scan_events (ts, source, chat_id, user_id, token, cache_hit, duration_ms, outcome)
   VALUES (?, 'dm', NULL, 1, ?, 0, 1, ?)`,
).run(ts, token, outcome);

const launch = (token, source, exemptions) => db.prepare(
  `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id, graduation_threshold,
     block_number, tx_hash, launched_at, snipe_exemption_count, exemption_source)
   VALUES (?,?,?,?,0,'0',1000,?,?,?,?)`,
).run(token, A(99), A(98), A(0), '0xtx' + token, sec(2026, 8, 1), exemptions, source);

const declare = (deployer) => db.prepare(
  `INSERT INTO launch_declarations (deployer, declared_by, declared_at, block_number,
     dev_buy_pct, exempt_list, exempt_count, creator_tax_bps, tax_split, vesting,
     docs_url, canonical, signature, free_slot)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
).run(deployer, 7, 1_789_000_000, 100, 2.5, '[]', 1, 400, 'x', 'y',
  'https://docs.checkvitals.xyz', 'c', '0xsig', null);

const LABELS = [
  'scans today', 'exempt wallets caught', 'groups',
  'launch rooms live', 'declared launches', 'launches indexed',
];

// ------------------------------------------------------------- the numbers

test('a fresh database counts nothing, and says its index has never advanced', () => {
  const n = N.dailyNumbers(NOW);
  assert.equal(n.day, '2026-09-11');
  assert.equal(n.tz, N.NUMBERS_TZ);
  assert.equal(n.scansToday, 0);
  assert.equal(n.exemptWalletsCaught, 0, 'a NULL sum is zero, not NULL');
  assert.equal(n.groups, 0);
  assert.equal(n.launchRoomsLive, 0);
  assert.equal(n.declared, 0);
  assert.equal(n.indexSize, 0);
  // Never having advanced is a stall by design: a database that has indexed
  // nothing cannot vouch for a count any more than one that stopped.
  assert.equal(n.indexNote, 'index has never advanced, counts incomplete');
});

test('the day is the Bratislava day, and a scan at 23:30 UTC belongs to tomorrow', () => {
  // Local midnight on the 11th is 22:00 UTC on the 10th.
  scan(sec(2026, 8, 10, 22, 0), A(1));            // exactly midnight local: today
  scan(sec(2026, 8, 10, 23, 0), A(1));            // the same token again
  scan(sec(2026, 8, 10, 23, 0), A(2));
  scan(sec(2026, 8, 10, 23, 0), A(3), 'failed');  // did not finish
  scan(sec(2026, 8, 10, 23, 0), null);            // not a scan of anything
  scan(sec(2026, 8, 10, 21, 59), A(4));           // 23:59 local on the 10th
  scan(sec(2026, 8, 10, 12, 0), A(5));

  const n = N.dailyNumbers(NOW);
  assert.equal(n.day, '2026-09-11', 'now is 01:30 local on the 11th');
  assert.equal(n.scansToday, 2, 'two distinct tokens finished since local midnight');

  // Noon local on the same day: the same day, the same count.
  assert.equal(N.dailyNumbers(Date.UTC(2026, 8, 11, 10, 0)).scansToday, 2);
  // Two hours earlier by the same UTC clock it is still the 10th locally.
  assert.equal(N.dailyNumbers(Date.UTC(2026, 8, 10, 21, 30)).day, '2026-09-10');
});

test('exempt wallets are counted on one scale: logs less the deployer, calldata as is', () => {
  launch(A(11), 'logs', 4);        // deployer and three others -> 3
  launch(A(12), 'logs', 1);        // deployer only, the floor -> 0
  launch(A(13), 'logs', 2);        // deployer and one other -> 1
  launch(A(14), 'calldata', 2);    // omits the deployer already -> 2
  launch(A(15), null, null);       // could not be decoded: not zero
  launch(A(16), null, 3);          // decoded before the source was recorded: scale unknown, not summed
  const n = N.dailyNumbers(NOW);
  assert.equal(n.exemptWalletsCaught, 6);
  assert.equal(n.indexSize, 6, 'every launch is indexed whatever its exemption count');
});

test('groups are what Telegram last said, so a group that removed the bot is not counted', () => {
  recordBotChat(-1001, 'supergroup', 'alpha', 'member');
  recordBotChat(-1002, 'group', 'beta', 'administrator');
  recordBotChat(-1003, 'supergroup', 'gamma', 'kicked');
  recordBotChat(777, 'private', null, 'member');
  assert.equal(N.dailyNumbers(NOW).groups, 2);
});

test('launch rooms live is the guard window: scheduled and the CA not yet pinned', () => {
  setSetting('launch_at', String(Math.floor(NOW / 1000) + 3600));
  assert.equal(N.dailyNumbers(NOW).launchRoomsLive, 1);
  // Landed and pinned: the window is closed.
  setSetting('launch_at', String(Math.floor(NOW / 1000) - 60));
  setSetting('launch_ca', A(42));
  assert.equal(N.dailyNumbers(NOW).launchRoomsLive, 0);
  clearLaunchPlan();
  assert.equal(N.dailyNumbers(NOW).launchRoomsLive, 0);
});

test('declared launches is the number of declarations stored', () => {
  declare(A(21));
  declare(A(22));
  assert.equal(N.dailyNumbers(NOW).declared, 2);
});

// ------------------------------------------------------------- the index note

test('an index that advanced and is current carries no note', () => {
  recordIndexAdvance(1n);
  assert.equal(N.dailyNumbers(NOW).indexNote, null);
});

test('an index far behind the head says how far, and a rebuild says it is rebuilding', () => {
  const lag = BLOCKS_PER_MINUTE * 60;
  setCursor('launches', 1n);
  recordIndexAdvance(1n, BigInt(1 + lag));
  assert.equal(N.dailyNumbers(NOW).indexNote, `index ${lag.toLocaleString()} blocks behind the chain`);

  // Caught up: the note goes away.
  setCursor('launches', BigInt(1 + lag));
  assert.equal(N.dailyNumbers(NOW).indexNote, null);

  markRecovering(true);
  try {
    assert.equal(N.dailyNumbers(NOW).indexNote, 'index rebuilding, counts incomplete');
  } finally {
    markRecovering(false);
  }
  assert.equal(N.dailyNumbers(NOW).indexNote, null);
});

// ------------------------------------------------------------- the picture

const AT = new Date(Date.UTC(2026, 8, 11, 6, 0));
const bodies = (svg) => [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

test('the card carries every label, the day, and the line that says what it is not', () => {
  const n = N.dailyNumbers(NOW);
  const svg = N.numbersCardSvg(n, AT, 'vitalscheck_bot');
  const b = bodies(svg);
  for (const label of LABELS) assert.ok(b.includes(label), `missing label: ${label}`);
  assert.ok(b.includes('2026-09-11 · daily numbers'));
  assert.ok(b.includes('PONS V2, ROBINHOOD CHAIN'));
  assert.ok(b.includes('2026-09-11 06:00 UTC'));
  assert.ok(b.includes('via @vitalscheck_bot'));
  assert.ok(b.includes('t.me/vitalscheck_bot?startgroup=true'));
  assert.ok(b.includes("counts from this bot's own index. not a score, and not advice."));
  assert.ok(!svg.includes(EM) && !svg.includes('\\u2014'), 'em dash on the card');
  for (const banned of [/\bscore\b/i, /\bgrade\b/i, /\bclean\b/i, /\bsafe\b/i, /!/]) {
    const hits = b.filter((s) => banned.test(s) && !/not a score/.test(s));
    assert.deepEqual(hits, [], `the card reads as a verdict: ${hits.join(' | ')}`);
  }
});

test('the six values are on the card, formatted, and the note only when there is one', () => {
  const n = {
    day: '2026-09-11', tz: 'Europe/Bratislava', scansToday: 1234, exemptWalletsCaught: 56,
    groups: 7, launchRoomsLive: 1, declared: 89, indexSize: 1234567, exemptionsRead: 400, indexNote: null,
  };
  const b = bodies(N.numbersCardSvg(n, AT));
  for (const v of [1234, 56, 7, 1, 89, 1234567]) {
    assert.ok(b.includes(v.toLocaleString()), `missing value ${v}`);
  }
  assert.ok(!b.some((s) => /counts may be behind|counts incomplete|blocks behind/.test(s)));

  const noted = bodies(N.numbersCardSvg({ ...n, indexNote: 'index has never advanced, counts incomplete' }, AT));
  assert.ok(noted.includes('index has never advanced, counts incomplete'));
});

test('nothing on the card is drawn over anything else, even with seven figures in every cell', () => {
  const n = {
    day: '2026-09-11', tz: 'Europe/Bratislava', scansToday: 1234567, exemptWalletsCaught: 1234567,
    groups: 1234567, launchRoomsLive: 1, declared: 1234567, indexSize: 1234567,
    exemptionsRead: 1234567,
    indexNote: 'index 1,234,567 blocks behind the chain',
  };
  const svg = N.numbersCardSvg(n, AT, 'vitalscheck_bot');
  const H = Number(/<svg[^>]*height="(\d+)"/.exec(svg)[1]);
  const rows = [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const attr = (k) => (new RegExp(`${k}="([^"]*)"`).exec(m[1]) ?? [])[1];
    return {
      y: Number(attr('y')), x: Number(attr('x')),
      size: Number(attr('font-size')), anchor: attr('text-anchor') ?? 'start',
      body: m[2],
    };
  }).sort((a, b) => a.y - b.y || a.x - b.x);

  for (const r of rows) assert.ok(r.y <= H - 40, `"${r.body}" sits below the card`);
  for (let i = 1; i < rows.length; i++) {
    const above = rows[i - 1];
    const below = rows[i];
    if (below.y - above.y > above.size * 0.9) continue;
    const aRight = above.anchor === 'end' ? above.x : above.x + measure(above.body, above.size, SANS_FILE);
    const bLeft = below.anchor === 'end' ? below.x - measure(below.body, below.size, SANS_FILE) : below.x;
    assert.ok(bLeft >= aRight - 1,
      `"${below.body}" at y=${below.y} collides with "${above.body}" at y=${above.y}`);
  }
});

test('the picture is a PNG', () => {
  const png = N.renderNumbersPng(N.dailyNumbers(NOW), AT, 'vitalscheck_bot');
  assert.ok(Buffer.isBuffer(png));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
});

// ------------------------------------------------------------- the caption

test('the caption says the same six things as the card, and nothing the card does not', () => {
  const n = N.dailyNumbers(NOW);
  const lines = N.numbersText(n).split('\n');
  assert.equal(lines[0], '2026-09-11 · daily numbers');
  assert.deepEqual(lines.slice(1, 7), [
    'scans today: 2',
    'exempt wallets caught: 6',
    'groups: 2',
    'launch rooms live: 0',
    'declared launches: 2',
    'launches indexed: 6',
  ]);
  assert.equal(lines.at(-1), "counts from this bot's own index. not a score, and not advice.");
  assert.ok(!lines.some((l) => l.includes(EM)), 'em dash in the caption');

  const noted = N.numbersText({ ...n, indexNote: 'index has never advanced, counts incomplete' }).split('\n');
  assert.equal(noted.at(-2), 'index has never advanced, counts incomplete');
});
