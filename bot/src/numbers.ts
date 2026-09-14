import { db } from './db.js';
import { localDayHour } from './tge.js';
import { zonedToUtcMs } from './launch.js';
import { groupsBotIsIn } from './chats.js';
import { guardActive } from './launchday.js';
import { indexCoverage } from './coverage.js';
import { BRAND, text, utcStamp, rasterise, drawable } from './image.js';

/**
 * The daily numbers.
 *
 * Six counts from this bot's own tables, once a day, as a picture and as the
 * caption under it. Every one is a count of something the bot did or recorded:
 * tokens it scanned, wallets the exemption logs named, groups it sits in,
 * whether a launch guard is up, declarations it holds, launches it indexed.
 * None of them is an opinion about anything on the chain, and the last line of
 * the card says so, because six big numbers on a dark card read as a
 * scoreboard unless they are told not to.
 *
 * The one place a count can mislead is the index behind it. A launch count
 * taken while the index is rebuilding or stalled is a fact about the rebuild,
 * not about the chain, so the card carries the coverage note whenever there is
 * one, for the same reason the scan card withholds its negatives.
 */

export const NUMBERS_TZ = process.env.NUMBERS_TZ || 'Europe/Bratislava';

export interface DailyNumbers {
  /** The local calendar day the scan count covers, YYYY-MM-DD in `tz`. */
  day: string;
  tz: string;
  scansToday: number;
  exemptWalletsCaught: number;
  groups: number;
  launchRoomsLive: number;
  declared: number;
  indexSize: number;
  /** Why an index-derived count may be behind, or null when the index is current. */
  indexNote: string | null;
}

function count(sql: string, ...args: unknown[]): number {
  const row = db.prepare(sql).get(...args) as { n: number | null } | undefined;
  return Number(row?.n ?? 0);
}

export function dailyNumbers(now = Date.now()): DailyNumbers {
  const tz = NUMBERS_TZ;

  // day: the local calendar day, by zone name rather than offset. Bratislava is
  // UTC+2 in September and UTC+1 in January, and a scan at 23:30 UTC belongs to
  // tomorrow for seven months of the year.
  const { day } = localDayHour(now, tz);
  const [y, m, d] = day.split('-').map(Number);
  // Local midnight as an instant. scan_events.ts is unix seconds, the zone
  // helper answers in milliseconds.
  const dayStart = Math.floor(zonedToUtcMs(y, m, d, 0, 0, tz) / 1000);

  // scansToday: distinct tokens scanned to completion since local midnight.
  // Distinct, because a token scanned nine times in one group is one token the
  // bot looked at. Only 'ok', because a scan that did not finish read nothing,
  // and only rows with a token, because one without is not a scan of anything.
  const scansToday = count(
    `SELECT COUNT(DISTINCT token) AS n FROM scan_events
      WHERE outcome = 'ok' AND token IS NOT NULL AND ts >= ?`,
    dayStart,
  );

  // exemptWalletsCaught: wallets exempted from the opening tax besides the
  // deployer, all time. The two sources count on different scales and are
  // brought to one: a 'logs' count INCLUDES the deployer, so 1 is the floor
  // and the count less one is the other wallets; a 'calldata' count OMITS the
  // deployer and is the other wallets as it stands. A NULL source is a row
  // decoded before the source was recorded, whose scale is not known, and NULL
  // count means the launch could not be decoded: neither is zero, neither is
  // summed. The same rule /scout applies when it asks "nobody beyond the
  // deployer".
  const exemptWalletsCaught = count(
    `SELECT COALESCE(SUM(CASE
              WHEN exemption_source = 'logs' AND snipe_exemption_count > 1 THEN snipe_exemption_count - 1
              WHEN exemption_source = 'calldata' AND snipe_exemption_count > 0 THEN snipe_exemption_count
              ELSE 0 END), 0) AS n
       FROM launches`,
  );

  // groups: what Telegram last said about the bot's membership. It can fall,
  // which is the property that keeps it from being a vanity number.
  const groups = groupsBotIsIn();

  // launchRoomsLive: the fake-CA guard is up while a launch is scheduled and
  // its CA not yet pinned. There is one launch chat at most, so this is 0 or 1.
  const launchRoomsLive = guardActive(now) ? 1 : 0;

  // declared: signed declarations stored, all time.
  const declared = count('SELECT COUNT(*) AS n FROM launch_declarations');

  // indexSize: launches the index holds. How many the chain holds is a
  // different number whenever the note below is set.
  const indexSize = count('SELECT COUNT(*) AS n FROM launches');

  return {
    day, tz, scansToday, exemptWalletsCaught, groups, launchRoomsLive, declared, indexSize,
    indexNote: indexNote(),
  };
}

/**
 * Why the index-derived counts may be behind, in one line, or null.
 *
 * Same precedence as coverageReason: a rebuild explains a stall and a stall
 * explains a lag, so the earliest cause is the one named. A never-advanced
 * index reads as stalled, which is right: a fresh database has not counted
 * anything either.
 */
function indexNote(): string | null {
  const c = indexCoverage();
  if (c.recovering) return 'index rebuilding, counts incomplete';
  if (c.stalled) return 'index stalled, counts may be behind';
  if (c.behindHead) return `index ${c.lagBlocks!.toLocaleString()} blocks behind the chain`;
  return null;
}

// ----------------------------------------------------------------- the render

/**
 * The six cells in reading order, each with the label it carries.
 *
 * One list for the picture and the caption both: a caption that says "scans"
 * under a card that says "scans today" is two claims.
 */
function cells(n: DailyNumbers): [string, number][] {
  return [
    ['scans today', n.scansToday],
    ['exempt wallets caught', n.exemptWalletsCaught],
    ['groups', n.groups],
    ['launch rooms live', n.launchRoomsLive],
    ['declared launches', n.declared],
    ['launches indexed', n.indexSize],
  ];
}

/** What this card is, and what it is not. The last line, like every card here. */
const NOT_A_SCORE = "counts from this bot's own index. not a score, and not advice.";

function rule(x: number, y: number, w: number): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${BRAND.RULE}"/>`;
}

/**
 * The numbers, as something somebody can post.
 *
 * Same skeleton as the call card: header, rule, title, cells, rule, footer.
 * Label over value, the label dim and the value heavy, so what a number IS is
 * read before the number. Nothing is coloured: there is no finding here and no
 * reference point, and the two colours that carry those meanings on the scan
 * card would carry them here too.
 */
export function numbersCardSvg(n: DailyNumbers, renderedAt = new Date(), botUsername = 'vitalscheck_bot'): string {
  const W = 1200;
  const H = 720;
  const PAD = 64;
  const CW = W - PAD * 2;
  const { BG, INK, DIM } = BRAND;
  const p: string[] = [];

  let y = PAD + 22;
  p.push(text(PAD, y, 'PONS V2, ROBINHOOD CHAIN', { size: 20, fill: DIM, weight: 600, spacing: 1.6 }));
  p.push(text(W - PAD, y, utcStamp(renderedAt), { size: 20, fill: DIM, anchor: 'end' }));
  y += 26;
  p.push(rule(PAD, y, CW));

  y = 186;
  p.push(text(PAD, y, drawable(`${n.day} · daily numbers`), { size: 34, fill: DIM }));

  // Three across, two down. A third of the content width holds a seven figure
  // value at this size, which is more than any of these counts has.
  const colW = Math.floor(CW / 3);
  cells(n).forEach(([label, value], i) => {
    const cx = PAD + (i % 3) * colW;
    const cy = 268 + Math.floor(i / 3) * 150;
    p.push(text(cx, cy, label, { size: 24, fill: DIM, spacing: 0.8 }));
    p.push(text(cx, cy + 62, drawable(value.toLocaleString()), { size: 56, weight: 700 }));
  });

  // A count from an index that did not finish is not a fact about the chain,
  // so the reason sits under the counts whenever there is one.
  if (n.indexNote) p.push(text(PAD, 546, drawable(n.indexNote), { size: 22, fill: DIM }));

  const footY = H - PAD - 52;
  p.push(rule(PAD, footY - 24, CW));
  const bot = drawable(botUsername);
  p.push(text(PAD, footY + 16, `via @${bot}`, { size: 26, fill: INK, weight: 600 }));
  p.push(text(W - PAD, footY + 16, `t.me/${bot}?startgroup=true`, { size: 24, fill: DIM, anchor: 'end' }));
  p.push(text(PAD, footY + 46, NOT_A_SCORE, { size: 19, fill: DIM }));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>${p.join('')}</svg>`
  );
}

export function renderNumbersPng(n: DailyNumbers, renderedAt = new Date(), botUsername?: string): Buffer {
  return rasterise(numbersCardSvg(n, renderedAt, botUsername), 1200);
}

/**
 * The same six numbers as lines, for the caption under the picture.
 *
 * Plain text with no parse mode, so it forwards intact. The index note and the
 * last line travel with it: a caption is what survives when the picture is
 * cropped out of a screenshot, and it must not say less than the card.
 */
export function numbersText(n: DailyNumbers): string {
  const lines = [`${n.day} · daily numbers`];
  for (const [label, value] of cells(n)) lines.push(`${label}: ${value.toLocaleString()}`);
  if (n.indexNote) lines.push(n.indexNote);
  lines.push(NOT_A_SCORE);
  return lines.join('\n');
}
