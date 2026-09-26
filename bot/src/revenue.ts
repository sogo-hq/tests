import { db } from './db.js';
import { computeRun, eth, feeWallet, LEDGER_SHARE_PCT, type LedgerRun } from './ledger.js';

/**
 * The public revenue page, in ETH and nothing else.
 *
 * Read-only in the strict sense: it reads the same rows /ledger reads and the
 * same balance, computes nothing new, and writes nothing. The owed figure IS
 * /ledger's, because it comes out of computeRun rather than out of a second
 * implementation of the same arithmetic. Two functions that both work out what
 * the room is owed is one more than can ever agree.
 *
 * What it does NOT have, and says so rather than guessing:
 *
 *   Per-claim transaction hashes. Creator fees arrive as plain ETH transfers
 *   into the fee wallet, and a plain transfer emits no log, so eth_getLogs
 *   cannot see one. Listing them needs a block scan or a trace API, which is
 *   an indexer rather than an endpoint. The total claimed is still exact,
 *   because it is reconstructed from the wallet and everything that has left
 *   it, which is the same reconstruction /ledger has always used.
 *
 *   Unclaimed fees. The factory names a feeEscrow and this build has no ABI
 *   for it, so what is accrued and unclaimed cannot be read. Undetermined, not
 *   zero: a zero here would read as "nothing is waiting", which is a claim
 *   about money made from nothing.
 *
 * No USD anywhere, no price, no projection, and no wallet address of any
 * seat: the room's payouts are listed by transaction, which is public, and
 * never by who received them.
 */

/** The declared split, as signed. Percentages of gross, not of each other. */
export const SPLIT = {
  blockZero: LEDGER_SHARE_PCT,
  ecosystem: 10,
  build: 80,
} as const;

export interface RevenueClaim {
  txHash: string;
  at: number;
  eth: string;
}

export interface RevenuePayout {
  txHash: string;
  at: number;
  eth: string;
}

export interface Revenue {
  token: 'VITALS';
  /** Everything the fee wallet has ever taken in, in ETH. */
  claimed_eth: string;
  /**
   * The individual claims, when they can be listed.
   *
   * Empty with a reason rather than absent: a caller has to be able to tell
   * "there were none" from "we cannot see them", and those are different
   * answers about the same field.
   */
  claims: RevenueClaim[];
  claims_note: string;
  /** Accrued and not yet claimed, or null when it cannot be read. */
  unclaimed_eth: string | null;
  unclaimed_note: string;
  split: {
    block_zero_pct: number;
    ecosystem_pct: number;
    build_pct: number;
    block_zero_eth: string;
    ecosystem_eth: string;
    build_eth: string;
  };
  block_zero: {
    /** Every payout that has a transaction hash, oldest first. */
    payouts: RevenuePayout[];
    paid_eth: string;
    /** 10% of gross less what has been paid. The number /ledger prints. */
    owed_eth: string;
  };
  as_of: {
    block: number | null;
    time: string;
    /** True before anything has been claimed, which the page renders on its own. */
    empty: boolean;
  };
  fee_wallet: string | null;
}

/** Payouts with a hash, which is the only kind that has left the wallet. */
export function blockZeroPayouts(): RevenuePayout[] {
  return (db
    .prepare(
      `SELECT tx_hash, amount_wei, sent_at FROM ledger_payments
        WHERE tx_hash IS NOT NULL ORDER BY sent_at, tx_hash`,
    )
    .all() as { tx_hash: string; amount_wei: string; sent_at: number | null }[])
    .map((r) => ({ txHash: r.tx_hash, at: r.sent_at ?? 0, eth: eth(BigInt(r.amount_wei)) }));
}

/**
 * The payload.
 *
 * The balance and the chain head are passed in rather than read here, so the
 * shape can be tested against figures without a node, exactly the way
 * computeRun takes a balance rather than reading one.
 */
export function buildRevenue(opts: {
  balanceWei: bigint | null;
  /** Credited in the escrow and unclaimed, or null when it could not be read. */
  escrowWei: bigint | null;
  headBlock: number | null;
  now?: number;
  run?: LedgerRun;
}): Revenue {
  const now = opts.now ?? Date.now();
  // A balance that could not be read is treated as zero for the arithmetic and
  // said to be undetermined by the block field, rather than failing the whole
  // page: the payouts and the split are still true.
  const run = opts.run ?? computeRun({ balanceWei: opts.balanceWei ?? 0n, escrowWei: opts.escrowWei, now });

  const gross = run.grossIncomeWei;
  const payouts = blockZeroPayouts();
  const share = (pct: number) => eth((gross * BigInt(pct)) / 100n);

  return {
    token: 'VITALS',
    claimed_eth: eth(gross),
    claims: [],
    claims_note:
      'creator fees arrive as plain ETH transfers, which emit no log, so the individual '
      + 'claims cannot be listed from the chain without a block scan. the total is exact: '
      + 'it is what the wallet holds plus everything that has ever left it.',
    unclaimed_eth: run.escrowWei === null ? null : eth(run.escrowWei),
    unclaimed_note: run.escrowWei === null
      ? 'the escrow balance could not be read, so what is accrued and unclaimed is '
        + 'undetermined rather than zero, and claimed_eth is missing that term.'
      : 'read from PonsV2FeeEscrow, which the factory names: curve and hook revenue is '
        + 'credited there per recipient and the wallet does not move until claim() is called. '
        + 'claimed_eth includes it, because the room is owed a tenth of what was earned.',
    split: {
      block_zero_pct: SPLIT.blockZero,
      ecosystem_pct: SPLIT.ecosystem,
      build_pct: SPLIT.build,
      block_zero_eth: share(SPLIT.blockZero),
      ecosystem_eth: share(SPLIT.ecosystem),
      build_eth: share(SPLIT.build),
    },
    block_zero: {
      payouts,
      paid_eth: eth(run.paidToDateWei),
      owed_eth: eth(run.poolWei),
    },
    as_of: {
      block: opts.headBlock,
      time: new Date(now).toISOString(),
      // Nothing has come in and nothing has gone out. The page says so in one
      // sentence rather than showing a table of zeros.
      empty: gross === 0n && payouts.length === 0,
    },
    fee_wallet: feeWallet(),
  };
}
