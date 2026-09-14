/**
 * /scout: the week's graduated launches against four stated checks.
 *
 * What is pinned here is the difference between a launch that failed a check
 * and a launch whose figure was never read. The first is left out and that is
 * the end of it; the second is left out AND counted on the withheld line,
 * because "3 of 20 match" is a claim about twenty launches only if all twenty
 * were measured. The exemption count is the sharpest case: the logs count
 * includes the deployer and the calldata count does not, and a NULL in either
 * is not a zero.
 *
 * No chain is reached. Socials are written straight into the row with a read
 * timestamp, and the one test that needs an unreadable launch makes the
 * client throw and counts how many times it was asked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('scout');
process.env.CREW_CHAT_ID = '-100777';
delete process.env.SCOUT_DAILY_HOUR;
delete process.env.SCOUT_TZ;

const { db } = await import('../dist/db.js');
const { client } = await import('../dist/chain.js');
const R = await import('../dist/ready.js');
const S = await import('../dist/scout.js');
const { age } = await import('../dist/card.js');
const { InputFile } = await import('grammy');

// ---- chain stub. The only read scout can cause is getTokenInfo, and here it
// always fails, so any launch whose socials were not stored is "unreadable".
const reads = { count: 0 };
client.readContract = async () => {
  reads.count++;
  throw new Error('rpc down');
};

const A = (n) => '0x' + String(n).padStart(40, '0');
const DAY = 86_400;
const NOW = Math.floor(Date.parse('2026-09-14T12:00:00Z') / 1000);
const CREW = -100777;
const EM = String.fromCharCode(0x2014);

let seq = 0;
const reset = () => {
  db.prepare('DELETE FROM launches').run();
  db.prepare('DELETE FROM holder_snapshots').run();
  db.prepare('DELETE FROM ready_settings').run();
  reads.count = 0;
};

/**
 * A launch that passes every check unless an override says otherwise.
 *
 * `socialsRead: false` leaves socials_read_at NULL, which is the one case that
 * reaches the (failing) chain stub. `holders: null` writes no snapshot.
 */
function launch(o = {}) {
  const token = o.token ?? A(++seq);
  const row = {
    deployer: A(9000), symbol: 'GOOD', launchedAt: NOW - 3 * DAY, phase: 2, graduatedAt: NOW - 2 * DAY,
    source: 'logs', exemptions: 1, openPct: 2.5, holders: 150,
    x: 'https://x.com/good', tg: '', web: '', socialsRead: true,
    ...o,
  };
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id, graduation_threshold,
       block_number, tx_hash, launched_at, symbol, phase, graduated_at,
       snipe_exemption_count, exemption_source, creator_open_pct,
       social_x, social_tg, social_web, socials_read_at)
     VALUES (?,?,?,?,0,'0',1,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    // graduated_at is a BLOCK, as the lifecycle indexer stores it. The helper
    // takes a timestamp because that is what a test reasons in, and converts
    // at the chain's block time from the row's own launch block (1).
    token, A(1), row.deployer, A(0), '0xtx' + token, row.launchedAt, row.symbol, row.phase,
    row.graduatedAt === null ? null : 1 + Math.round((row.graduatedAt - row.launchedAt) / 0.1),
    row.exemptions, row.source, row.openPct,
    row.x, row.tg, row.web, row.socialsRead ? NOW - DAY : null,
  );
  if (row.holders !== null) {
    db.prepare('INSERT INTO holder_snapshots (token, top5_share, holders, excess, measured_at) VALUES (?,?,?,?,?)')
      .run(token, 30, row.holders, 0.2, NOW - DAY);
  }
  return token;
}

const withheldSum = (w) => w.exemptionsUndetermined + w.devBuyUndetermined + w.holdersNotRead + w.socialsUnreadable;
const NONE = { exemptionsUndetermined: 0, devBuyUndetermined: 0, holdersNotRead: 0, socialsUnreadable: 0 };

// ------------------------------------------------------------------ selection

test('nothing graduated: nothing matched, nothing withheld, and the message still says so', async () => {
  reset();
  const r = await S.scout(NOW);
  assert.deepEqual(r, { rows: [], graduatedInWindow: 0, withheld: NONE, now: NOW });
  const lines = S.scoutMessage(r).split('\n');
  assert.equal(lines[0], 'scout · 0 of 0 launches graduated in 7d match');
  assert.equal(lines.at(-1), 'not checked: 0 exemptions undetermined, 0 dev buy unread, 0 holders unread, 0 socials unreadable');
  assert.equal(lines.length, 3);
});

test('a launch that passes all four checks is a row carrying its facts, with no chain read', async () => {
  reset();
  const token = launch();
  const r = await S.scout(NOW);
  assert.equal(r.graduatedInWindow, 1);
  assert.deepEqual(r.withheld, NONE);
  assert.deepEqual(r.rows, [{
    token, symbol: 'GOOD', deployer: A(9000), x: 'https://x.com/good', tg: '', holders: 150,
    ageSeconds: 3 * DAY, launchedAt: NOW - 3 * DAY, graduatedAt: NOW - 2 * DAY,
  }]);
  assert.equal(reads.count, 0, 'stored socials are not read again');
});

test('the window: phase 2, a graduation time, and inside the last seven days', async () => {
  reset();
  const edge = launch({ graduatedAt: NOW - 7 * DAY });
  launch({ graduatedAt: NOW - 7 * DAY - 1 });
  launch({ phase: 0, graduatedAt: null });
  launch({ phase: 1, graduatedAt: NOW - DAY });
  launch({ phase: 2, graduatedAt: null });
  const r = await S.scout(NOW);
  assert.equal(r.graduatedInWindow, 1, 'only the launch on the edge is in the window');
  assert.deepEqual(r.rows.map((x) => x.token), [edge]);
});

test('exemptions: the logs count includes the deployer, the calldata count does not', async () => {
  reset();
  const logsOnly = launch({ source: 'logs', exemptions: 1 });
  launch({ source: 'logs', exemptions: 2 });
  const calldataOnly = launch({ source: 'calldata', exemptions: 0 });
  launch({ source: 'calldata', exemptions: 1 });
  const r = await S.scout(NOW);
  assert.equal(r.graduatedInWindow, 4);
  assert.deepEqual(new Set(r.rows.map((x) => x.token)), new Set([logsOnly, calldataOnly]));
  assert.deepEqual(r.withheld, NONE, 'one wallet beyond the deployer is a fact, not an unread figure');
});

test('an exemption count the bot could not decode is withheld, never passed and never failed', async () => {
  reset();
  // A NULL source with a stored 0 is the calldata-only decoder's answer, which
  // the index itself marks as measurably wrong; it must not read as "none".
  launch({ source: null, exemptions: 0 });
  launch({ source: 'logs', exemptions: null });
  launch({ source: 'calldata', exemptions: null });
  const r = await S.scout(NOW);
  assert.equal(r.rows.length, 0);
  assert.deepEqual(r.withheld, { ...NONE, exemptionsUndetermined: 3 });
  assert.match(S.scoutMessage(r), /\nnot checked: 3 exemptions undetermined, 0 dev buy unread/);
});

test('dev buy: at or under 5% passes, over fails, unread is withheld', async () => {
  reset();
  const atLimit = launch({ openPct: 5 });
  const zero = launch({ openPct: 0 });
  launch({ openPct: 5.01 });
  launch({ openPct: null });
  const r = await S.scout(NOW);
  assert.deepEqual(new Set(r.rows.map((x) => x.token)), new Set([atLimit, zero]));
  assert.deepEqual(r.withheld, { ...NONE, devBuyUndetermined: 1 });
});

test('holders: 100 passes, 99 fails, no snapshot is withheld', async () => {
  reset();
  const hundred = launch({ holders: 100 });
  launch({ holders: 99 });
  launch({ holders: null });
  const r = await S.scout(NOW);
  assert.deepEqual(r.rows.map((x) => x.token), [hundred]);
  assert.deepEqual(r.withheld, { ...NONE, holdersNotRead: 1 });
});

test('socials: X or Telegram passes, read-and-empty fails as a fact, a failed read is withheld', async () => {
  reset();
  const xOnly = launch({ x: 'https://x.com/a', tg: '' });
  const tgOnly = launch({ x: '', tg: 't.me/b' });
  launch({ x: '', tg: '', web: 'c.xyz' });
  launch({ x: '', tg: '', web: '' });
  launch({ socialsRead: false });
  const r = await S.scout(NOW);
  assert.deepEqual(new Set(r.rows.map((x) => x.token)), new Set([xOnly, tgOnly]));
  assert.deepEqual(r.withheld, { ...NONE, socialsUnreadable: 1 });
  assert.equal(reads.count, 1, 'one launch had no stored socials, one read was attempted');
});

test('the chain is asked only for launches that passed the three index-side checks', async () => {
  reset();
  launch({ socialsRead: false, holders: 5 });
  launch({ socialsRead: false, openPct: 40 });
  launch({ socialsRead: false, source: 'logs', exemptions: 7 });
  const r = await S.scout(NOW);
  assert.equal(r.rows.length, 0);
  assert.deepEqual(r.withheld, NONE, 'each failed a check the index answers; none is unread');
  assert.equal(reads.count, 0);
});

test('a launch is withheld once, under the first figure it lacks, and a fail is never withheld', async () => {
  reset();
  launch({ source: null, openPct: null, holders: null, socialsRead: false });
  launch({ source: 'logs', exemptions: 3, openPct: null, holders: null });
  launch({ openPct: 9, holders: null });
  const r = await S.scout(NOW);
  assert.deepEqual(r.withheld, { ...NONE, exemptionsUndetermined: 1 });
  assert.equal(r.rows.length + withheldSum(r.withheld), 1);
  assert.ok(r.rows.length + withheldSum(r.withheld) <= r.graduatedInWindow, 'matched plus withheld never exceeds the window');
});

test('rows are ordered by holders, most first', async () => {
  reset();
  const mid = launch({ holders: 500 });
  const top = launch({ holders: 9000 });
  const low = launch({ holders: 120 });
  const r = await S.scout(NOW);
  assert.deepEqual(r.rows.map((x) => x.token), [top, mid, low]);
});

// ---------------------------------------------------------------------- csv

test('the csv: the header, quoted strings, bare addresses, age as the cards print it', async () => {
  reset();
  const token = launch({ symbol: 'A,B', x: 'https://x.com/a,b', tg: '' });
  const csv = S.scoutCsv(await S.scout(NOW));
  const lines = csv.split('\n');
  assert.equal(lines[0], 'token,ticker,deployer,x,tg,holders,age');
  assert.equal(lines[1], `${token},"A,B",${A(9000)},"https://x.com/a,b","",150,${age(3 * DAY)}`);
  assert.equal(lines.length, 2);
});

test('the csv writes a missing symbol as an empty quoted string, not the word null', async () => {
  reset();
  launch({ symbol: null });
  const line = S.scoutCsv(await S.scout(NOW)).split('\n')[1];
  assert.match(line, /^0x[0-9a-f]{40},"",0x/);
  assert.doesNotMatch(line, /null/);
});

// ------------------------------------------------------------------ message

test('the message: header, one line per match, and the withheld line with all four numbers', async () => {
  reset();
  launch();
  const lines = S.scoutMessage(await S.scout(NOW)).split('\n');
  assert.deepEqual(lines, [
    'scout · 1 of 1 launches graduated in 7d match',
    'no exempt wallets beyond the deployer, dev buy at or under 5%, 100+ holders, socials given',
    '$GOOD · 150 holders · 3.0d · https://x.com/good',
    'not checked: 0 exemptions undetermined, 0 dev buy unread, 0 holders unread, 0 socials unreadable',
  ]);
});

test('the message carries no deployer address; the csv does', async () => {
  reset();
  launch({ deployer: A(4242) });
  const r = await S.scout(NOW);
  assert.doesNotMatch(S.scoutMessage(r), /0x[0-9a-fA-F]{40}/);
  assert.ok(S.scoutCsv(r).includes(A(4242)));
});

test('a launch with no symbol is named by its token, without a dollar sign', async () => {
  reset();
  launch({ token: A(42), symbol: null });
  launch({ token: A(43), symbol: '' });
  const lines = S.scoutMessage(await S.scout(NOW)).split('\n');
  assert.ok(lines.some((l) => l.startsWith('0x0000…0042 · ')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('0x0000…0043 · ')), 'an empty symbol is no symbol');
  assert.ok(!lines.some((l) => l.startsWith('$0x')));
});

test('x first, telegram when there is no x, and the ticker in capitals', async () => {
  reset();
  launch({ symbol: 'both', x: 'https://x.com/x', tg: 't.me/tg', holders: 300 });
  launch({ symbol: 'tgonly', x: '', tg: 't.me/only', holders: 200 });
  const lines = S.scoutMessage(await S.scout(NOW)).split('\n');
  assert.equal(lines[2], '$BOTH · 300 holders · 3.0d · https://x.com/x');
  assert.equal(lines[3], '$TGONLY · 200 holders · 3.0d · t.me/only');
});

test('a control character in a symbol or a link cannot add a line to the message', async () => {
  reset();
  launch({ symbol: 'A\nB', x: 'https://x.com/a\nb' });
  const lines = S.scoutMessage(await S.scout(NOW)).split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[2], '$A B · 150 holders · 3.0d · https://x.com/a b');
});

test('forty matches: twenty lines, sixteen rows, the rest pointed at the csv, and no word the bot does not say', async () => {
  reset();
  for (let i = 0; i < 40; i++) launch({ symbol: `T${i}`, holders: 100 + i });
  const r = await S.scout(NOW);
  assert.equal(r.rows.length, 40);
  const lines = S.scoutMessage(r).split('\n');
  assert.equal(lines.length, 20);
  assert.equal(lines[0], 'scout · 40 of 40 launches graduated in 7d match');
  assert.equal(lines[2], '$T39 · 139 holders · 3.0d · https://x.com/good', 'most holders first');
  assert.equal(lines[17], '$T24 · 124 holders · 3.0d · https://x.com/good', 'sixteenth row');
  assert.equal(lines[18], '+24 more in the csv');
  assert.match(lines[19], /^not checked: /);
  for (const l of lines) {
    assert.doesNotMatch(l, /clean|safe/i, l);
    assert.ok(!l.includes(EM), `em dash in: ${l}`);
  }
  assert.equal(S.scoutCsv(r).split('\n').length, 41, 'every match is in the csv');
});

test('sixteen matches fit without a pointer line; seventeen need one', async () => {
  reset();
  for (let i = 0; i < 16; i++) launch({ holders: 100 + i });
  assert.equal(S.scoutMessage(await S.scout(NOW)).split('\n').length, 19);
  launch({ holders: 99_999 });
  const lines = S.scoutMessage(await S.scout(NOW)).split('\n');
  assert.equal(lines.length, 20);
  assert.equal(lines[18], '+1 more in the csv');
});

// ------------------------------------------------------------------- serial

test('serial: three launches and one graduation is the floor on both counts', () => {
  reset();
  const grad = (deployer, o = {}) => launch({ deployer, phase: 2, graduatedAt: NOW - 30 * DAY, ...o });
  const curve = (deployer, o = {}) => launch({ deployer, phase: 0, graduatedAt: null, ...o });
  // two launches, both graduated: not serial
  grad(A(1)); grad(A(1));
  // three launches, none graduated: not serial
  curve(A(2)); curve(A(2)); curve(A(2));
  // three launches, one graduated: in
  grad(A(3), { launchedAt: NOW - 40 * DAY }); curve(A(3), { launchedAt: NOW - 20 * DAY }); curve(A(3), { launchedAt: NOW - 10 * DAY });
  // four launches, two graduated: in, and first
  grad(A(4)); grad(A(4)); curve(A(4)); curve(A(4), { launchedAt: NOW - DAY });
  // three launches, two graduated: between the two
  grad(A(5)); grad(A(5)); curve(A(5));
  const rows = S.scoutSerial(NOW);
  assert.deepEqual(rows.map((r) => [r.deployer, r.launches, r.graduated]), [
    [A(4), 4, 2],
    [A(5), 3, 2],
    [A(3), 3, 1],
  ]);
  assert.equal(rows[2].latestAt, NOW - 10 * DAY, 'latest is the most recent launch, graduated or not');
  assert.equal(rows[0].latestAt, NOW - DAY);
});

test('serial: a launch after the instant asked about is not counted', () => {
  reset();
  for (let i = 0; i < 3; i++) launch({ deployer: A(6), launchedAt: NOW - DAY });
  assert.equal(S.scoutSerial(NOW).length, 1);
  assert.equal(S.scoutSerial(NOW - 2 * DAY).length, 0);
});

test('serial message: the header names both thresholds, twenty lines at most, no verdicts', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    deployer: A(100 + i), launches: 5, graduated: 2, latestAt: NOW - i * DAY,
  }));
  const lines = S.scoutSerialMessage(rows).split('\n');
  assert.equal(lines.length, 20);
  assert.equal(lines[0], 'scout serial · 30 deployers with 3+ launches and 1+ graduated, all-time');
  assert.equal(lines[1], `${A(100)} · 5 launches · 2 graduated · latest 2026-09-14`);
  assert.equal(lines[19], '+12 more');
  for (const l of lines) {
    assert.doesNotMatch(l, /clean|safe/i, l);
    assert.ok(!l.includes(EM), `em dash in: ${l}`);
  }
  assert.equal(S.scoutSerialMessage([]).split('\n').length, 1);
  assert.match(S.scoutSerialMessage(rows.slice(0, 1)), /^scout serial · 1 deployer with/);
});

// --------------------------------------------------------------- daily post

test('the digest is due at 10:00 local, by the zone and not by a fixed offset', () => {
  reset();
  assert.equal(S.SCOUT_DAILY_HOUR, 10);
  assert.equal(S.SCOUT_TZ, 'Europe/Bratislava');
  // 08:00Z is 10:00 in Bratislava under CEST, in September.
  assert.equal(S.scoutDailyDue(Date.parse('2026-09-14T07:59:00Z')), false, 'not before the hour');
  assert.equal(R.getSetting('scout_day'), null, 'and nothing is adopted before the hour either');
  assert.equal(S.scoutDailyDue(Date.parse('2026-09-14T08:00:00Z')), false, 'the first run adopts today');
  assert.equal(R.getSetting('scout_day'), '2026-09-14');
  assert.equal(S.scoutDailyDue(Date.parse('2026-09-14T15:00:00Z')), false, 'and stays adopted');
  assert.equal(S.scoutDailyDue(Date.parse('2026-09-15T08:00:00Z')), true, 'due tomorrow');
  S.markScoutPosted(Date.parse('2026-09-15T08:00:30Z'));
  assert.equal(R.getSetting('scout_day'), '2026-09-15');
  assert.equal(S.scoutDailyDue(Date.parse('2026-09-15T20:00:00Z')), false, 'once a day');
  // 09:00Z is 10:00 in Bratislava under CET, in January; 08:00Z is not.
  R.setSetting('scout_day', '2026-01-14');
  assert.equal(S.scoutDailyDue(Date.parse('2026-01-15T08:00:00Z')), false);
  assert.equal(S.scoutDailyDue(Date.parse('2026-01-15T09:00:00Z')), true);
});

/** A Telegram api that records what it was asked and fails on request. */
function fakeApi() {
  const calls = [];
  const failing = { message: false, document: false };
  const api = {
    sendMessage: async (chat, text, opts) => {
      calls.push({ method: 'sendMessage', chat, text, opts });
      if (failing.message) throw new Error('telegram: 502');
      return { message_id: calls.length };
    },
    sendDocument: async (chat, file) => {
      calls.push({ method: 'sendDocument', chat, file });
      if (failing.document) throw new Error('telegram: 502');
      return { message_id: calls.length };
    },
  };
  return { api, calls, failing, drain: () => calls.splice(0) };
}

test('the tick: not due before the hour, adopts on first run, posts once, and a throw leaves it due', async () => {
  reset();
  launch({ deployer: A(4242) });
  const { api, failing, drain } = fakeApi();

  R.setSetting('scout_day', '2026-09-13');
  assert.equal(await S.scoutDailyTick(api, { now: Date.parse('2026-09-14T07:59:00Z') }), false);
  assert.deepEqual(drain(), [], 'nothing is sent before the hour');

  db.prepare('DELETE FROM ready_settings').run();
  assert.equal(await S.scoutDailyTick(api, { now: Date.parse('2026-09-14T08:00:00Z') }), false);
  assert.deepEqual(drain(), [], 'the first run adopts today rather than posting');
  assert.equal(R.getSetting('scout_day'), '2026-09-14');

  R.setSetting('scout_day', '2026-09-13');
  assert.equal(await S.scoutDailyTick(api, { now: Date.parse('2026-09-14T08:00:00Z') }), true);
  let c = drain();
  assert.deepEqual(c.map((x) => [x.method, x.chat]), [['sendMessage', CREW], ['sendDocument', CREW]]);
  assert.match(c[0].text, /^scout · 1 of 1 launches graduated in 7d match\n/);
  assert.ok(c[0].text.includes('$GOOD'));
  assert.doesNotMatch(c[0].text, /0x[0-9a-fA-F]{40}/, 'no address in the group message');
  assert.equal(c[0].opts?.link_preview_options?.is_disabled, true);
  assert.ok(c[1].file instanceof InputFile);
  assert.equal(c[1].file.filename, 'vitals-scout-2026-09-14.csv');
  const csv = Buffer.from(c[1].file.fileData).toString('utf8');
  assert.match(csv, /^token,ticker,deployer,x,tg,holders,age\n/);
  assert.ok(csv.includes(A(4242)), 'the deployer is in the csv');
  assert.equal(R.getSetting('scout_day'), '2026-09-14', 'marked after both sends');

  assert.equal(await S.scoutDailyTick(api, { now: Date.parse('2026-09-14T09:00:00Z') }), false);
  assert.deepEqual(drain(), [], 'not again the same day');

  // Tomorrow, the document fails to send: not marked, still due.
  failing.document = true;
  assert.equal(await S.scoutDailyTick(api, { now: Date.parse('2026-09-15T08:00:00Z') }), false);
  c = drain();
  assert.deepEqual(c.map((x) => x.method), ['sendMessage', 'sendDocument']);
  assert.equal(R.getSetting('scout_day'), '2026-09-14', 'a post that did not fully arrive is not a sent one');
  failing.document = false;
  assert.equal(await S.scoutDailyTick(api, { now: Date.parse('2026-09-15T08:01:00Z') }), true);
  assert.deepEqual(drain().map((x) => x.method), ['sendMessage', 'sendDocument']);
  assert.equal(R.getSetting('scout_day'), '2026-09-15');

  // The message itself failing sends no document and marks nothing.
  failing.message = true;
  assert.equal(await S.scoutDailyTick(api, { now: Date.parse('2026-09-16T08:00:00Z') }), false);
  assert.deepEqual(drain().map((x) => x.method), ['sendMessage']);
  assert.equal(R.getSetting('scout_day'), '2026-09-15');
});

test('without CREW_CHAT_ID the tick does nothing, and does not touch the mark', () => {
  // CREW_CHAT_ID is read once when config.js is imported, so the unset case
  // has to run in its own process.
  const CWD = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'vitals-scout-'));
  const { CREW_CHAT_ID: _unset, ...env } = process.env;
  let out;
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const S = await import('${CWD}/dist/scout.js');
      const R = await import('${CWD}/dist/ready.js');
      const { CREW_CHAT_ID } = await import('${CWD}/dist/config.js');
      R.setSetting('scout_day', '2026-09-13');
      const calls = [];
      const api = {
        sendMessage: async () => { calls.push('m'); return {}; },
        sendDocument: async () => { calls.push('d'); return {}; },
      };
      const posted = await S.scoutDailyTick(api, { now: Date.parse('2026-09-14T08:00:00Z') });
      console.log(JSON.stringify({ posted, calls, mark: R.getSetting('scout_day'), crew: CREW_CHAT_ID }));
    `], { cwd: CWD, env: { ...env, DB_PATH: join(dir, 's.db') }, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const res = JSON.parse(out.trim().split('\n').at(-1));
  assert.deepEqual(res, { posted: false, calls: [], mark: '2026-09-13', crew: null });
});

test('the loop ticks on its interval, never overlaps itself, and does not hold the process open', async () => {
  reset();
  R.setSetting('scout_day', '2026-09-13');
  const { api } = fakeApi();
  const t = S.startScoutLoop(api, 5);
  assert.ok(t.hasRef ? !t.hasRef() : true, 'the timer is unref-ed');
  await new Promise((resolve) => setTimeout(resolve, 30));
  clearInterval(t);
});
