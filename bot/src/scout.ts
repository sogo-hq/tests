import { InputFile, type Api } from 'grammy';
import { db } from './db.js';
import { CREW_CHAT_ID } from './config.js';
import { envNumber } from './launch.js';
import { getSetting, setSetting } from './ready.js';
import { localDayHour } from './tge.js';
import { socialsFor, socialsPresent } from './socials.js';
import { age } from './card.js';

/**
 * /scout: the launches that graduated this week and pass four stated checks,
 * and the count of those the bot could not check.
 *
 * Four facts, each against a stated reference point, and nothing else: no
 * wallet exempt from the opening tax beyond the deployer, a dev buy at or
 * under a stated share of supply, a stated holder count, and socials the
 * deployer gave. A launch that fails one is left out, and that is a fact
 * about the launch. A launch whose figure was never READ is left out too, and
 * that is a fact about the index, so it is counted on its own line rather
 * than folded in with the fails: "3 of 20 match" with twelve unread would
 * otherwise say something about seventeen launches nobody measured.
 *
 * The list is not a recommendation and never says so in either direction.
 * The reader has the four facts and the CSV, and decides.
 */

export const SCOUT_DAYS = 7;
export const SCOUT_MAX_DEV_BUY_PCT = 5;
export const SCOUT_MIN_HOLDERS = 100;
export const SCOUT_DAILY_HOUR = envNumber('SCOUT_DAILY_HOUR', 10);
export const SCOUT_TZ = process.env.SCOUT_TZ || 'Europe/Bratislava';

/** Rows the message carries before it points at the CSV for the rest. */
const MESSAGE_ROWS = 16;
/** Longest ticker a message line will carry; the card clamps at the same point. */
const MAX_TICKER = 16;

export interface ScoutRow {
  token: string;
  symbol: string | null;
  deployer: string;
  x: string;
  tg: string;
  holders: number;
  ageSeconds: number;
  launchedAt: number;
  graduatedAt: number;
}

/** Launches in the window that were left out because a figure was not read. */
export interface ScoutWithheld {
  exemptionsUndetermined: number;
  devBuyUndetermined: number;
  holdersNotRead: number;
  socialsUnreadable: number;
}

export interface ScoutResult {
  rows: ScoutRow[];
  /** Every launch that graduated inside the window, matched or not. */
  graduatedInWindow: number;
  withheld: ScoutWithheld;
  /** Unix seconds: the instant the window and every age were measured against. */
  now: number;
}

interface Candidate {
  token: string;
  symbol: string | null;
  deployer: string;
  launched_at: number;
  graduated_at: number;
  snipe_exemption_count: number | null;
  exemption_source: string | null;
  creator_open_pct: number | null;
  holders: number | null;
}

type Passed = Omit<Candidate, 'holders'> & { holders: number };

/**
 * Everything that graduated since the window opened, with the figures the
 * three index-side checks need. Holders come from the snapshot table by a
 * LEFT JOIN so that "no snapshot" arrives as NULL and can be withheld, rather
 * than dropping the row before anyone counts it.
 */
const candidates = db.prepare(
  `SELECT l.token, l.symbol, l.deployer, l.launched_at, l.graduated_at,
          l.snipe_exemption_count, l.exemption_source, l.creator_open_pct,
          h.holders
     FROM launches l
     LEFT JOIN holder_snapshots h ON h.token = l.token
    WHERE l.phase = 2 AND l.graduated_at IS NOT NULL AND l.graduated_at >= ?
    ORDER BY l.graduated_at DESC, l.token`,
);

type Check = 'pass' | 'fail' | 'unread';

/**
 * Wallets exempt from the opening tax beyond the deployer.
 *
 * The two sources count differently and the difference is exactly one wallet:
 * the curve's events include the deployer it auto-exempts, the calldata array
 * never mentions it. So "nobody but the deployer" is 1 from logs and 0 from
 * calldata. A row with no source, or no count, is a row the bot has not
 * decoded, which is not a row with none.
 */
function exemptionsCheck(c: Candidate): Check {
  if (c.snipe_exemption_count === null) return 'unread';
  if (c.exemption_source === 'logs') return c.snipe_exemption_count === 1 ? 'pass' : 'fail';
  if (c.exemption_source === 'calldata') return c.snipe_exemption_count === 0 ? 'pass' : 'fail';
  return 'unread';
}

/**
 * The week's graduated launches against the four checks.
 *
 * `now` is unix seconds. The three checks the index answers on its own run
 * first, in order, and a launch is counted under the FIRST one it cannot
 * answer. Counting it under every unread figure would make the four withheld
 * numbers add up to more launches than exist; this way matched, failed and
 * withheld partition the window, and the reader can add them back up.
 */
export async function scout(now = Math.floor(Date.now() / 1000)): Promise<ScoutResult> {
  const all = candidates.all(now - SCOUT_DAYS * 86_400) as Candidate[];
  const withheld: ScoutWithheld = {
    exemptionsUndetermined: 0, devBuyUndetermined: 0, holdersNotRead: 0, socialsUnreadable: 0,
  };

  const passed: Passed[] = [];
  for (const c of all) {
    const ex = exemptionsCheck(c);
    if (ex === 'unread') { withheld.exemptionsUndetermined++; continue; }
    if (ex === 'fail') continue;
    if (c.creator_open_pct === null) { withheld.devBuyUndetermined++; continue; }
    if (c.creator_open_pct > SCOUT_MAX_DEV_BUY_PCT) continue;
    if (c.holders === null) { withheld.holdersNotRead++; continue; }
    if (c.holders < SCOUT_MIN_HOLDERS) continue;
    passed.push({ ...c, holders: c.holders });
  }

  // Socials last, and one at a time. It is the only check that can cost a
  // chain read, so only a launch that passed the other three pays for it, and
  // the reads go out in sequence rather than fanned out: they run at bulk
  // priority behind every interactive scan, and a burst of twenty would take
  // the reserve that exists to keep those scans quick. A failed read is
  // withheld; socials that were read and are empty are a fact about the launch.
  const rows: ScoutRow[] = [];
  for (const c of passed) {
    const s = await socialsFor(c.token);
    if (s === null) { withheld.socialsUnreadable++; continue; }
    if (!socialsPresent(s)) continue;
    rows.push({
      token: c.token, symbol: c.symbol, deployer: c.deployer, x: s.x, tg: s.tg,
      holders: c.holders, ageSeconds: now - c.launched_at,
      launchedAt: c.launched_at, graduatedAt: c.graduated_at,
    });
  }
  rows.sort((a, b) => b.holders - a.holders || b.graduatedAt - a.graduatedAt || a.token.localeCompare(b.token));
  return { rows, graduatedInWindow: all.length, withheld, now };
}

// ------------------------------------------------------------------ output

/**
 * The CSV: one row per match, the deployer included.
 *
 * Strings a deployer wrote are quoted by JSON.stringify, as the index export
 * does, because a ticker with a comma in it would otherwise shift every column
 * after it. Addresses are hex and go bare.
 */
export function scoutCsv(r: ScoutResult): string {
  return [
    'token,ticker,deployer,x,tg,holders,age',
    ...r.rows.map((row) => [
      row.token, JSON.stringify(row.symbol ?? ''), row.deployer,
      JSON.stringify(row.x), JSON.stringify(row.tg), row.holders, age(row.ageSeconds),
    ].join(',')),
  ].join('\n');
}

/**
 * Strip what could break a line out of a string the deployer wrote.
 *
 * A newline in a symbol would add a line to a message specified to stay under
 * twenty, so control characters become spaces and runs collapse. Nothing else
 * is touched: a link with a character changed is a different link.
 */
function plain(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The row's name in the message: its ticker, or the token when it has none. */
function ticker(row: ScoutRow): string {
  const s = row.symbol ? plain(row.symbol).slice(0, MAX_TICKER) : '';
  return s ? `$${s.toUpperCase()}` : `${row.token.slice(0, 6)}…${row.token.slice(-4)}`;
}

/**
 * The message: twenty lines at most, whatever the week held.
 *
 * Two lines of header, sixteen rows, one line pointing at the CSV for the
 * rest, and the withheld line, which is always present and always carries all
 * four numbers. "0 holders unread" is a statement that every holder count was
 * read; leaving the line out when they are all zero would make a week with
 * nothing withheld indistinguishable from a message that forgot to say.
 *
 * No deployer address here. The message goes to a group; the CSV has them.
 */
export function scoutMessage(r: ScoutResult): string {
  const k = r.rows.length;
  const lines = [
    `scout · ${k} of ${r.graduatedInWindow} launches graduated in ${SCOUT_DAYS}d match`,
    `no exempt wallets beyond the deployer, dev buy at or under ${SCOUT_MAX_DEV_BUY_PCT}%, ` +
      `${SCOUT_MIN_HOLDERS}+ holders, socials given`,
  ];
  for (const row of r.rows.slice(0, MESSAGE_ROWS)) {
    lines.push(
      `${ticker(row)} · ${row.holders} holders · ${age(row.ageSeconds)} · ${plain(row.x) || plain(row.tg)}`,
    );
  }
  if (k > MESSAGE_ROWS) lines.push(`+${k - MESSAGE_ROWS} more in the csv`);
  const w = r.withheld;
  lines.push(
    `not checked: ${w.exemptionsUndetermined} exemptions undetermined, ${w.devBuyUndetermined} dev buy unread, ` +
      `${w.holdersNotRead} holders unread, ${w.socialsUnreadable} socials unreadable`,
  );
  return lines.join('\n');
}

// ------------------------------------------------------------------ serial

/**
 * Deployers who keep launching, and how many of those launches graduated.
 *
 * Two thresholds, both low and both stated in the message: three launches
 * separates a repeat deployer from somebody who tried twice, and one
 * graduation separates a record from a run of curves that went nowhere. Both
 * counts are facts; neither is a reason to buy or to avoid, and the line does
 * not say which.
 */
const SERIAL_MIN_LAUNCHES = 3;
const SERIAL_MIN_GRADUATED = 1;
/** Rows the serial message carries under its header before it counts the rest. */
const SERIAL_ROWS = 18;

export interface SerialRow {
  deployer: string;
  launches: number;
  graduated: number;
  /** When the deployer's most recent launch went out, unix seconds. */
  latestAt: number;
}

const serialQuery = db.prepare(
  `SELECT deployer,
          COUNT(*) AS launches,
          SUM(CASE WHEN phase = 2 AND graduated_at IS NOT NULL AND graduated_at <= ? THEN 1 ELSE 0 END) AS graduated,
          MAX(launched_at) AS latestAt
     FROM launches
    WHERE launched_at <= ?
    GROUP BY deployer
   HAVING launches >= ? AND graduated >= ?
    ORDER BY graduated DESC, launches DESC, latestAt DESC, deployer`,
);

/**
 * All-time, as the index stood at `now` (unix seconds): a launch or a
 * graduation after that instant is not counted, so a fixed clock sees the
 * same list production would have seen then.
 */
export function scoutSerial(now = Math.floor(Date.now() / 1000)): SerialRow[] {
  return serialQuery.all(now, now, SERIAL_MIN_LAUNCHES, SERIAL_MIN_GRADUATED) as SerialRow[];
}

function utcDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The serial list, twenty lines at most.
 *
 * The deployer is the subject of every line, so the address is printed in
 * full: a list of repeat deployers without the deployers would name nobody.
 * That makes this a reply for a DM or an admin, not a group post.
 */
export function scoutSerialMessage(rows: SerialRow[]): string {
  const n = rows.length;
  const lines = [
    `scout serial · ${n} deployer${n === 1 ? '' : 's'} with ${SERIAL_MIN_LAUNCHES}+ launches ` +
      `and ${SERIAL_MIN_GRADUATED}+ graduated, all-time`,
  ];
  for (const r of rows.slice(0, SERIAL_ROWS)) {
    lines.push(
      `${r.deployer} · ${r.launches} launches · ${r.graduated} graduated · latest ${utcDay(r.latestAt)}`,
    );
  }
  if (n > SERIAL_ROWS) lines.push(`+${n - SERIAL_ROWS} more`);
  return lines.join('\n');
}

// -------------------------------------------------------------- daily post

/**
 * Is the daily digest due?
 *
 * The same shape as dailyDue in tge.ts, on its own mark and its own hour, so
 * the ready block and the digest can never mark each other as sent. First run
 * adopts today rather than posting: a bot restarted at 14:00 would otherwise
 * send the crew a digest they read at 10:00.
 */
export function scoutDailyDue(now: number): boolean {
  const { day, hour } = localDayHour(now, SCOUT_TZ);
  if (hour < SCOUT_DAILY_HOUR) return false;
  const mark = getSetting('scout_day');
  if (mark === day) return false;
  if (!mark) {
    setSetting('scout_day', day);
    return false;
  }
  return true;
}

/** Record that the digest went out. Called only after every send succeeded. */
export function markScoutPosted(now: number): void {
  setSetting('scout_day', localDayHour(now, SCOUT_TZ).day);
}

/**
 * One tick of the daily digest.
 *
 * Idempotent the way readyAutoPostTick is: scoutDailyDue() decides from a
 * stored mark, and the mark is written only after BOTH the message and the CSV
 * went out. A crash or a Telegram error between the two leaves the digest due,
 * and the next tick sends the whole thing again. A repeated message is the
 * cheaper failure than a day whose CSV never arrived.
 *
 * `now` is milliseconds, as the interval loop and the ready tick pass it.
 */
export async function scoutDailyTick(api: Api, opts: { now?: number } = {}): Promise<boolean> {
  if (CREW_CHAT_ID === null) return false;
  const now = opts.now ?? Date.now();
  // Decided before any chain read: a tick that answers "no" 1,439 times a
  // day must cost nothing to answer.
  if (!scoutDailyDue(now)) return false;

  const r = await scout(Math.floor(now / 1000));
  const { day } = localDayHour(now, SCOUT_TZ);
  try {
    await api.sendMessage(CREW_CHAT_ID, scoutMessage(r), { link_preview_options: { is_disabled: true } });
    await api.sendDocument(CREW_CHAT_ID, new InputFile(Buffer.from(scoutCsv(r), 'utf8'), `vitals-scout-${day}.csv`));
  } catch (err) {
    console.warn('[scout] daily post failed:', String((err as Error)?.message ?? err).slice(0, 160));
    return false;
  }
  markScoutPosted(now);
  console.log(`[scout] daily posted · ${r.rows.length} of ${r.graduatedInWindow}`);
  return true;
}

export function startScoutLoop(api: Api, intervalMs = 60_000): NodeJS.Timeout {
  // An in-flight flag, as in startReadyAutoPost: a tick that reads socials
  // from chain can outlast its interval, and two overlapping ticks would both
  // see the mark unset and both post. Single process, so the flag is the fix.
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    void scoutDailyTick(api)
      .catch((err) => console.warn('[scout] tick failed:', String((err as Error)?.message ?? err).slice(0, 160)))
      .finally(() => { running = false; });
  }, intervalMs);
  t.unref?.();
  return t;
}
