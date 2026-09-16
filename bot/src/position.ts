import { db } from './db.js';
import { BLOCK_TIME_SECONDS, WINDOW_30_MIN_BLOCKS } from './config.js';
import { MAX_LAG_BLOCKS_FOR_NEGATIVE } from './coverage.js';

/**
 * Where one wallet stood in one launch.
 *
 * The question people actually ask after a launch goes badly is not "was this
 * token fine", it is "was I early or was I the exit". /full holds the answer
 * already, spread across the opening window and the first-buyer list, and
 * reading it by hand means counting rows. This counts them.
 *
 * Everything here is arithmetic over rows the indexer already wrote. The one
 * thing it cannot get from the index is total supply, and without it the share
 * is undetermined rather than zero.
 */

/** Sells this far past the launch are the ones the phrase "inside 30 min" means. */
export const SELL_WINDOW_SECONDS = 30 * 60;
export const SELL_WINDOW_BLOCKS = WINDOW_30_MIN_BLOCKS;

export interface PositionTrade {
  side: 'buy' | 'sell';
  /** Who sent the transaction. For a launchAndBuy this is the forwarder. */
  trader: string;
  /** Who received the tokens. This is the buyer's identity, as everywhere else. */
  recipient: string;
  tokenAmount: bigint;
  blockNumber: number;
  blockTime: number;
}

export interface PositionInput {
  wallet: string;
  token: string;
  symbol: string | null;
  launchBlock: number;
  launchedAt: number;
  /** The wallets the launch transaction pre-exempted, lowercased. */
  exemptWallets: string[];
  /** False when the launch transaction could not be decoded: not the same as none. */
  exemptionsKnown: boolean;
  /** Buys and sells for this token from the launch block on, in order. */
  trades: PositionTrade[];
  /** The block the trade indexer has read this token through. */
  indexedTo: number | null;
  /** The chain head last seen, or null when none has been recorded. */
  headBlock: number | null;
  totalSupply: bigint | null;
}

export interface PositionResult {
  /** found: the wallet bought and the index covers it. */
  status: 'found' | 'absent' | 'undetermined';
  reason: string | null;
  rank: number | null;
  secondsAfterLaunch: number | null;
  /** Of the buyers ahead of it, how many the launch transaction exempted. */
  exemptBefore: number | null;
  /** What those wallets held at that moment, as a share of supply. */
  exemptSharePct: number | null;
  /** Of the first `rank` buyers, how many sold inside thirty minutes. */
  soldInside30m: number | null;
  /** Null when the index has not read far enough to count sells. */
  sellWindowCovered: boolean;
  buyersRead: number;
}

const lower = (s: string) => s.trim().toLowerCase();

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${n % 10 <= 3 ? suffix : 'th'}`;
}

/** 0x447c…ED93. Used in groups, where a full wallet is never printed. */
export function shortWallet(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function computePosition(input: PositionInput): PositionResult {
  const wallet = lower(input.wallet);
  const exempt = new Set(input.exemptWallets.map(lower));
  const empty: PositionResult = {
    status: 'undetermined', reason: null, rank: null, secondsAfterLaunch: null,
    exemptBefore: null, exemptSharePct: null, soldInside30m: null,
    sellWindowCovered: false, buyersRead: 0,
  };

  // Order is the whole answer, so a trade list that is not ordered is not an
  // input this can work from.
  const trades = [...input.trades].sort((a, b) =>
    a.blockNumber - b.blockNumber || a.blockTime - b.blockTime);

  // First appearance per buyer, by recipient: a launchAndBuy is sent by the
  // forwarder, so ranking senders would make the forwarder the first buyer of
  // most launches on this chain.
  const order: string[] = [];
  const firstBuy = new Map<string, PositionTrade>();
  for (const t of trades) {
    if (t.side !== 'buy') continue;
    const who = lower(t.recipient);
    if (firstBuy.has(who)) continue;
    firstBuy.set(who, t);
    order.push(who);
  }
  const buyersRead = order.length;

  const lag = input.headBlock !== null && input.indexedTo !== null
    ? Math.max(0, input.headBlock - input.indexedTo)
    : null;
  const behind = lag === null || lag > MAX_LAG_BLOCKS_FOR_NEGATIVE;

  const rank = order.indexOf(wallet) + 1;
  if (rank === 0) {
    // Not in the rows that were read. Whether that means "did not buy" depends
    // entirely on whether the rows are all the rows.
    if (input.indexedTo === null || input.indexedTo < input.launchBlock) {
      return { ...empty, buyersRead, reason: 'the index has not read this launch yet' };
    }
    if (behind) {
      return {
        ...empty, buyersRead,
        reason: lag === null
          ? 'the index is behind the chain by an unknown amount'
          : `the index is ${lag.toLocaleString()} blocks behind the chain`,
      };
    }
    return {
      ...empty, status: 'absent', buyersRead,
      reason: `no buy from this wallet in the ${buyersRead} buyer${buyersRead === 1 ? '' : 's'} read for this launch`,
    };
  }

  const mine = firstBuy.get(wallet)!;
  const secondsAfterLaunch = Math.max(0, mine.blockTime - input.launchedAt);

  // The wallets ahead of it that were exempt, and what they were holding when
  // this wallet bought. Holdings are reconstructed from the trades themselves:
  // everything they received minus everything they sent, up to that trade.
  const ahead = order.slice(0, rank - 1);
  const exemptAhead = ahead.filter((a) => exempt.has(a));
  let heldByExemptAhead = 0n;
  if (exemptAhead.length) {
    const set = new Set(exemptAhead);
    for (const t of trades) {
      if (t.blockNumber > mine.blockNumber) break;
      if (t.blockNumber === mine.blockNumber && t === mine) break;
      if (t.side === 'buy' && set.has(lower(t.recipient))) heldByExemptAhead += t.tokenAmount;
      if (t.side === 'sell' && set.has(lower(t.trader))) heldByExemptAhead -= t.tokenAmount;
    }
    if (heldByExemptAhead < 0n) heldByExemptAhead = 0n;
  }
  const exemptSharePct = input.totalSupply && input.totalSupply > 0n
    ? Number((heldByExemptAhead * 1_000_000n) / input.totalSupply) / 10_000
    : null;

  // Of the first `rank` buyers, how many sold inside the window. The count is
  // only a count if the index read the whole window; a half-read window returns
  // a smaller number that looks exactly like a calmer launch.
  const windowEndBlock = input.launchBlock + SELL_WINDOW_BLOCKS;
  const sellWindowCovered = input.indexedTo !== null && input.indexedTo >= windowEndBlock;
  let soldInside30m: number | null = null;
  if (sellWindowCovered) {
    const firstN = new Set(order.slice(0, rank));
    const sold = new Set<string>();
    for (const t of trades) {
      if (t.side !== 'sell') continue;
      if (t.blockTime - input.launchedAt > SELL_WINDOW_SECONDS) continue;
      const who = lower(t.trader);
      if (firstN.has(who)) sold.add(who);
    }
    soldInside30m = sold.size;
  }

  return {
    status: 'found',
    reason: input.exemptionsKnown ? null : 'the launch transaction could not be decoded, so the exempt list is unknown',
    rank,
    secondsAfterLaunch,
    exemptBefore: input.exemptionsKnown ? exemptAhead.length : null,
    exemptSharePct: input.exemptionsKnown ? exemptSharePct : null,
    soldInside30m,
    sellWindowCovered,
    buyersRead,
  };
}

/** The message. `full` prints the wallet in full, which only a DM does. */
export function positionText(
  input: Pick<PositionInput, 'wallet' | 'token' | 'symbol'>,
  r: PositionResult,
  full: boolean,
): string {
  const who = full ? input.wallet : shortWallet(input.wallet);
  const what = input.symbol ? `$${input.symbol}` : input.token;
  const lines: string[] = [];

  if (r.status === 'undetermined') {
    lines.push(`${who} in ${what}: undetermined`);
    if (r.reason) lines.push(r.reason);
    lines.push('undetermined is not none. ask again once the index has caught up.');
    return lines.join('\n');
  }
  if (r.status === 'absent') {
    lines.push(`${who} in ${what}`);
    lines.push(r.reason!);
    lines.push('that is what was read, not proof it never held the token: a wallet can receive tokens without buying on the curve.');
    return lines.join('\n');
  }

  lines.push(`${who} was the ${ordinal(r.rank!)} buyer in ${what} at +${r.secondsAfterLaunch}s`);

  if (r.exemptBefore === null) {
    lines.push('tax-exempt wallets ahead of it: undetermined, the launch transaction could not be decoded');
  } else if (r.exemptBefore === 0) {
    lines.push('0 wallets tax-exempt before it');
  } else {
    const share = r.exemptSharePct === null
      ? 'holding an undetermined share, total supply could not be read'
      : `holding ${r.exemptSharePct.toFixed(2)}% of supply at that point`;
    lines.push(`${r.exemptBefore} wallet${r.exemptBefore === 1 ? '' : 's'} tax-exempt before it, ${share}`);
  }

  if (r.soldInside30m === null) {
    lines.push(`sells inside 30 min: undetermined, the index has not read the first 30 minutes yet`);
  } else {
    lines.push(`${r.soldInside30m} of the first ${r.rank} sold inside 30 min`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------- the reads

export interface PositionRow {
  token: string;
  symbol: string | null;
  launchBlock: number;
  launchedAt: number;
  exemptWallets: string[];
  exemptionsKnown: boolean;
  trades: PositionTrade[];
  indexedTo: number | null;
}

/** Everything /position needs from the index for one launch, or null. */
export function readLaunchForPosition(token: string): PositionRow | null {
  const t = lower(token);
  const row = db
    .prepare(
      `SELECT token, symbol, block_number, launched_at, snipe_exemptions,
              snipe_exemption_count, trades_indexed_to
         FROM launches WHERE token = ?`,
    )
    .get(t) as {
      token: string; symbol: string | null; block_number: number; launched_at: number;
      snipe_exemptions: string | null; snipe_exemption_count: number | null;
      trades_indexed_to: number | null;
    } | undefined;
  if (!row) return null;

  // The count and the list are separate columns and can disagree. Saying "0
  // wallets exempt before it" needs the list, not the count: a row that knows
  // nine wallets were exempted but not which ones cannot place any of them.
  let exemptWallets: string[] = [];
  let listUsable = false;
  try {
    const parsed = row.snipe_exemptions ? JSON.parse(row.snipe_exemptions) : null;
    if (Array.isArray(parsed)) {
      exemptWallets = parsed.filter((a) => typeof a === 'string').map(lower);
      listUsable = true;
    }
  } catch (err) {
    // A list that does not parse is not a list of none.
    void err;
    exemptWallets = [];
  }
  const count = row.snipe_exemption_count;
  // A count of nine against a list of two is a row that cannot answer this.
  const consistent = count === null ? false : count === exemptWallets.length;

  const trades = db
    .prepare(
      `SELECT side, trader, recipient, token_amount, block_number, block_time
         FROM trades WHERE token = ? AND block_number >= ?
         ORDER BY block_number, log_index`,
    )
    .all(t, row.block_number) as Array<{
      side: 'buy' | 'sell'; trader: string; recipient: string;
      token_amount: string; block_number: number; block_time: number;
    }>;

  return {
    token: row.token,
    symbol: row.symbol,
    launchBlock: row.block_number,
    launchedAt: row.launched_at,
    exemptWallets,
    exemptionsKnown: listUsable && consistent,
    indexedTo: row.trades_indexed_to,
    trades: trades.map((r) => ({
      side: r.side,
      trader: lower(r.trader),
      recipient: lower(r.recipient),
      tokenAmount: BigInt(r.token_amount),
      blockNumber: r.block_number,
      // Older rows can carry a zero block time; derive it rather than reporting
      // a launch that happened before itself.
      blockTime: r.block_time > 0
        ? r.block_time
        : row.launched_at + Math.round((r.block_number - row.block_number) * BLOCK_TIME_SECONDS),
    })),
  };
}

/**
 * The whole answer for one wallet in one launch.
 *
 * Total supply is the only thing not in the index, and it is read live. A read
 * that fails leaves the share undetermined and the rest of the answer standing.
 */
export async function buildPosition(
  token: string,
  wallet: string,
): Promise<{ row: PositionRow | null; result: PositionResult }> {
  const row = readLaunchForPosition(token);
  if (!row) {
    return {
      row: null,
      result: {
        status: 'undetermined', reason: 'this launch is not in the index', rank: null,
        secondsAfterLaunch: null, exemptBefore: null, exemptSharePct: null,
        soldInside30m: null, sellWindowCovered: false, buyersRead: 0,
      },
    };
  }

  const { lastSeenHead } = await import('./indexer/health.js');
  let totalSupply: bigint | null = null;
  try {
    const { client } = await import('./chain.js');
    const { erc20Abi } = await import('./abi.js');
    totalSupply = await client.readContract({
      address: row.token as `0x${string}`, abi: erc20Abi, functionName: 'totalSupply',
    });
  } catch (err) {
    // A supply that could not be read makes the share undetermined. It does
    // not make it zero, and it does not stop the rest of the answer.
    void err;
    totalSupply = null;
  }

  return {
    row,
    result: computePosition({
      wallet,
      token: row.token,
      symbol: row.symbol,
      launchBlock: row.launchBlock,
      launchedAt: row.launchedAt,
      exemptWallets: row.exemptWallets,
      exemptionsKnown: row.exemptionsKnown,
      trades: row.trades,
      indexedTo: row.indexedTo,
      headBlock: lastSeenHead(),
      totalSupply,
    }),
  };
}
