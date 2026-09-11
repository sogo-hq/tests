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
