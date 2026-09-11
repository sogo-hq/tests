import { db } from './db.js';

/**
 * Who put an address in front of a group first.
 *
 * A record, and only a record. The leaderboard states a multiple from the call
 * to the peak that followed it, which is a fact about the token: it would be
 * the same number whoever had posted it, and whether anyone bought or sold is
 * not in it. It never states a profit, because a profit is a claim about a
 * person's trading, and this tool does not make claims about people.
 *
 * The market cap is in the QUOTE asset, not in dollars. There is no price
 * oracle here and there is not going to be one: every figure in this product is
 * read from the chain, and a dollar figure would mean trusting a third party
 * for the one number the whole leaderboard is ranked on.
 */

export interface FirstCall {
  chatId: number;
  token: string;
  userId: number;
  username: string | null;
  calledAt: number;
  /** Market cap in the quote asset, in whole units, as the card showed it. */
  mcapQuote: number | null;
  blockNumber: number | null;
}

function rowToCall(row: any): FirstCall {
  return {
    chatId: row.chat_id,
    token: row.token,
    userId: row.user_id,
    username: row.username ?? null,
    calledAt: row.called_at,
    mcapQuote: row.mcap_quote === null ? null : Number(row.mcap_quote),
    blockNumber: row.block_number ?? null,
  };
}

export function firstCallOf(chatId: number, token: string): FirstCall | null {
  const row = db
    .prepare('SELECT * FROM first_calls WHERE chat_id = ? AND token = ?')
    .get(chatId, token.toLowerCase());
  return row ? rowToCall(row) : null;
}

/**
 * Record a call, or return the one already there.
 *
 * First writer wins and nothing ever overwrites it: the whole value of the line
 * is that it names who was first, and a record that can be replaced by posting
 * the address again is not a record of anything.
 */
export function recordFirstCall(call: {
  chatId: number; token: string; userId: number; username?: string | null;
  mcapQuote?: number | null; blockNumber?: number | null; now?: number;
}): FirstCall {
  const token = call.token.toLowerCase();
  const existing = firstCallOf(call.chatId, token);
  if (existing) return existing;

  db.prepare(
    `INSERT OR IGNORE INTO first_calls
       (chat_id, token, user_id, username, called_at, mcap_quote, block_number)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    call.chatId, token, call.userId, call.username ?? null,
    Math.floor((call.now ?? Date.now()) / 1000),
    call.mcapQuote === undefined || call.mcapQuote === null ? null : String(call.mcapQuote),
    call.blockNumber ?? null,
  );
  return firstCallOf(call.chatId, token)!;
}

// -------------------------------------------------------------- leaderboard

export interface LeaderRow {
  userId: number;
  username: string | null;
  token: string;
  symbol: string | null;
  calledAt: number;
  mcapQuote: number;
  peakQuote: number;
  multiple: number;
}

/**
 * The best multiple each caller reached, over a window.
 *
 * The peak is taken from the trades AFTER the call, never the token's all-time
 * peak: a caller who posted an address on its way down has not called a 25x,
 * and ranking them by a high that happened before they spoke would say they
 * had. Market cap moves with price and supply is fixed, so the ratio of two
 * market caps is the ratio of two prices, and the multiple comes straight out
 * of the trade log with no supply read at all.
 *
 * A call with no recorded market cap is left out rather than assumed. It cannot
 * be ranked, and a zero would rank it first.
 */
export function leaderboard(chatId: number, days: number, now = Date.now()): LeaderRow[] {
  const since = Math.floor(now / 1000) - days * 86_400;
  const calls = db
    .prepare(
      `SELECT c.*, l.symbol AS symbol FROM first_calls c
       LEFT JOIN launches l ON l.token = c.token
       WHERE c.chat_id = ? AND c.called_at >= ? AND c.mcap_quote IS NOT NULL`,
    )
    .all(chatId, since) as any[];

  const best = new Map<number, LeaderRow>();
  for (const row of calls) {
    const call = rowToCall(row);
    if (call.mcapQuote === null || call.mcapQuote <= 0) continue;
    const peak = peakAfter(call.token, call.calledAt, call.mcapQuote);
    if (peak === null) continue;
    const multiple = ratio(peak, call.mcapQuote);
    const entry: LeaderRow = {
      userId: call.userId,
      username: call.username,
      token: call.token,
      symbol: row.symbol ?? null,
      calledAt: call.calledAt,
      mcapQuote: call.mcapQuote,
      peakQuote: peak,
      multiple,
    };
    const held = best.get(call.userId);
    if (!held || entry.multiple > held.multiple) best.set(call.userId, entry);
  }

  return [...best.values()].sort((a, b) => b.multiple - a.multiple).slice(0, 10);
}

/**
 * The highest market cap the token reached after a call.
 *
 * Derived from the trade log rather than from the stored peak, because the
 * stored peak has no time attached that can be compared with a call. Price per
 * token is quote/token on each trade; scaled by the market cap at the call and
 * the price at the call, it gives the peak market cap in the same unit.
 */
function peakAfter(token: string, calledAt: number, mcapAtCall: number): number | null {
  const rows = db
    .prepare(
      `SELECT quote_amount AS q, token_amount AS t, block_time AS bt FROM trades
        WHERE token = ? AND block_time >= ? ORDER BY block_time ASC`,
    )
    .all(token.toLowerCase(), calledAt) as { q: string; t: string; bt: number }[];
  if (!rows.length) return null;

  // Price as a rational, compared without floating point: q1/t1 > q2/t2 when
  // q1*t2 > q2*t1. Amounts are wei-scale, so this stays exact.
  let bestQ: bigint | null = null;
  let bestT: bigint | null = null;
  let firstQ: bigint | null = null;
  let firstT: bigint | null = null;
  for (const r of rows) {
    let q: bigint;
    let t: bigint;
    try {
      q = BigInt(r.q);
      t = BigInt(r.t);
    } catch (err) {
      continue;
    }
    if (t <= 0n || q <= 0n) continue;
    if (firstQ === null) { firstQ = q; firstT = t; }
    if (bestQ === null || q * bestT! > bestQ * t) { bestQ = q; bestT = t; }
  }
  if (bestQ === null || firstQ === null) return null;
  // peak = mcapAtCall * (bestPrice / firstPriceAfterCall). The ratio is taken
  // in bigint, exactly, and only then becomes a number.
  return mcapAtCall * (Number((bestQ * firstT! * 1_000_000n) / (bestT! * firstQ)) / 1_000_000);
}

/** A multiple, for ordering and for printing to one decimal. */
export function ratio(peak: number, call: number): number {
  return call <= 0 ? 0 : peak / call;
}

// -------------------------------------------------------------- rendering

/** The windows the leaderboard offers, in days. */
export const LEADERBOARD_WINDOWS = [7, 30] as const;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The leaderboard, as it is posted.
 *
 * Multiples and nothing else. There is no profit column and there is not going
 * to be one: a multiple is a fact about the token that would read the same
 * whoever had posted it, and a profit is a claim about somebody's trading that
 * this tool has no way to know and no business asserting. The footer says what
 * the list is, because a ranked list of people beside big numbers reads as
 * advice unless it is told not to.
 */
export function renderLeaderboard(
  chatId: number, days: number, quote: string, now = Date.now(),
): string {
  const rows = leaderboard(chatId, days, now);
  const head = `calls in this group, last ${days} days`;
  if (!rows.length) {
    return [
      head,
      '',
      'nothing to rank yet. a call is recorded the first time somebody posts an',
      'address here, and it needs a market cap at that moment and trades after it.',
      '',
      'calls are records, not advice',
    ].join('\n');
  }
  const lines = rows.map((r, i) => {
    const who = r.username ? `@${esc(clampName(r.username))}` : 'a member';
    const sym = r.symbol ? `$${esc(clampName(r.symbol))}` : `${r.token.slice(0, 8)}\u2026`;
    return `${i + 1}. ${who}, ${sym}, ${r.multiple.toFixed(1)}x, called at ${short(r.mcapQuote)} ${esc(quote)}`;
  });
  return [head, '', ...lines, '', 'calls are records, not advice'].join('\n');
}

function clampName(s: string): string {
  return s.length > 32 ? `${s.slice(0, 31)}\u2026` : s;
}

/** The same scale the cards use, so one number does not read two ways. */
function short(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  if (a >= 100) return String(Math.round(v));
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
