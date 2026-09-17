import { db } from './db.js';
import { client } from './chain.js';
import { api as atApiPriority } from './ratelimit.js';
import { liveSeats, totalShares, TIERS, type Seat, type Tier } from './roster.js';

/**
 * The ledger.
 *
 * Ten percent of what the fee wallet has taken in and not yet paid out, split
 * by shares. The bot computes it, prints it and records it. It never holds a
 * key and never sends anything: the transfers are made by tools/pay.mjs from a
 * laptop, and the hashes come back in by hand.
 *
 * Two rules the arithmetic follows, both so that the table a person reads is
 * the amount that actually arrives:
 *
 *   Everything is wei. A payout is not a float, and a table that adds up in
 *   ETH and not in wei is a table somebody will one day reconcile against a
 *   block explorer and find short.
 *
 *   The pool is a tenth of CUMULATIVE GROSS INCOME, less what has already
 *   gone to the room. Fees arrive in the same wallet the payouts leave from,
 *   so the balance alone cannot tell new income from a remainder nobody has
 *   distributed yet: a tenth of the balance pays the room a second time for
 *   income it has already been paid for, every run, forever. Gross income is
 *   reconstructed from what is there plus everything that ever left:
 *
 *     gross = balance + paid out to date + swept to date
 *     pool  = 10% of gross, less paid out to date
 *
 *   Both subtractions are of the same figure, which is the point: the room is
 *   owed a tenth of everything the wallet has ever taken in, and has already
 *   had whatever it has had. Gas counts on both sides, so the room bears the
 *   cost of being paid.
 *
 *   The per-share amount is rounded DOWN to four decimal places of ETH, which
 *   is the precision the table is printed at. Every payout is then exactly
 *   what is shown, and what is left over stays in the wallet. It is not lost:
 *   the next run reads the same wallet, so the dust is inside the next
 *   balance and goes out with the next pool.
 */

/** The share of the unpaid remainder that is distributed. */
export const LEDGER_SHARE_PCT = 10;

/** Payouts are whole multiples of this, so the printed figure is the paid one. */
export const PAYOUT_PRECISION_WEI = 10n ** 14n; // 0.0001 ETH

export function feeWallet(): string | null {
  const raw = (process.env.FEE_WALLET ?? '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
}

/** What the fee wallet holds now. Null when it is not configured or not readable. */
export async function feeWalletBalance(): Promise<bigint | null> {
  const w = feeWallet();
  if (!w) return null;
  try {
    return await atApiPriority(() => client.getBalance({ address: w as `0x${string}` }));
  } catch (err) {
    console.warn('[ledger] fee wallet balance unreadable:', String((err as Error)?.message ?? err).slice(0, 120));
    return null;
  }
}

/**
 * What has already gone out, from this table's record of it.
 *
 * Counted only where a transaction hash was recorded. A run that was computed
 * and never paid is not money that left, and a run that was paid and whose
 * hashes were never entered is money this cannot see: the preview says so
 * rather than quietly distributing it a second time.
 */
export function paidOutWei(): bigint {
  // Summed in JS rather than by SQLite: SUM over a TEXT column goes through a
  // double, and wei does not survive that. Gas is included: it left the wallet
  // with the payment, so gross income cannot be reconstructed without it.
  const rows = db.prepare('SELECT amount_wei, gas_wei FROM ledger_payments WHERE tx_hash IS NOT NULL').all() as { amount_wei: string; gas_wei: string | null }[];
  return rows.reduce((a, x) => a + BigInt(x.amount_wei) + BigInt(x.gas_wei ?? '0'), 0n);
}

/** Payouts whose receipt was never read, so their gas is missing from the sum. */
export function paymentsWithUnknownGas(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM ledger_payments WHERE tx_hash IS NOT NULL AND gas_wei IS NULL').get() as { n: number }).n;
}

export interface Sweep {
  txHash: string;
  to: string;
  valueWei: bigint;
  gasWei: bigint;
  block: number;
  at: number;
}

/** Everything manually moved out of the fee wallet, value and gas both. */
export function sweptWei(): bigint {
  const rows = db.prepare('SELECT value_wei, gas_wei FROM ledger_sweeps').all() as { value_wei: string; gas_wei: string }[];
  return rows.reduce((a, x) => a + BigInt(x.value_wei) + BigInt(x.gas_wei), 0n);
}

export function sweeps(): Sweep[] {
  return (db.prepare('SELECT * FROM ledger_sweeps ORDER BY block, tx_hash').all() as any[]).map((r) => ({
    txHash: r.tx_hash, to: r.to_address, valueWei: BigInt(r.value_wei),
    gasWei: BigInt(r.gas_wei), block: r.block, at: r.at,
  }));
}

/**
 * Record a transfer out of the fee wallet, after checking it is one.
 *
 * Verified against the chain rather than taken on trust: the sender has to be
 * the fee wallet, the recipient has to be somebody else, and a hash this
 * ledger already counts as a payout is refused, because counting it twice
 * would inflate gross income and pay the room for money it never earned.
 */
export async function recordSweep(txHash: string, opts: { by?: number; now?: number } = {}):
  Promise<{ ok: true; sweep: Sweep } | { ok: false; reason: string }> {
  const wallet = feeWallet();
  if (!wallet) return { ok: false, reason: 'FEE_WALLET is not set, so there is nothing to check the transfer against' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: `${txHash} is not a transaction hash` };
  if (db.prepare('SELECT 1 FROM ledger_sweeps WHERE tx_hash = ?').get(txHash.toLowerCase())) {
    return { ok: false, reason: 'that transfer is already recorded' };
  }
  if (db.prepare('SELECT 1 FROM ledger_payments WHERE lower(tx_hash) = ?').get(txHash.toLowerCase())) {
    return { ok: false, reason: 'that hash is a payout this ledger already counts. recording it as a sweep would count it twice' };
  }
  let tx: any;
  let receipt: any;
  try {
    [tx, receipt] = await Promise.all([
      atApiPriority(() => client.getTransaction({ hash: txHash as `0x${string}` })),
      atApiPriority(() => client.getTransactionReceipt({ hash: txHash as `0x${string}` })),
    ]);
  } catch (err) {
    return { ok: false, reason: `that transaction could not be read: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
  if (receipt.status !== 'success') return { ok: false, reason: 'that transaction reverted, so nothing left the wallet' };
  if (String(tx.from).toLowerCase() !== wallet.toLowerCase()) {
    return { ok: false, reason: `that transfer was sent by ${tx.from}, not by the fee wallet` };
  }
  if (!tx.to || String(tx.to).toLowerCase() === wallet.toLowerCase()) {
    return { ok: false, reason: 'that transfer went nowhere, or back to the fee wallet' };
  }
  const gas = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? tx.gasPrice ?? 0n);
  let at = opts.now ?? Math.floor(Date.now() / 1000);
  try {
    const block = await atApiPriority(() => client.getBlock({ blockNumber: receipt.blockNumber }));
    at = Number(block.timestamp);
  } catch (err) {
    console.warn('[ledger] sweep block time unreadable, using now:', String((err as Error)?.message ?? err).slice(0, 80));
  }
  const sweep: Sweep = {
    txHash: txHash.toLowerCase(), to: String(tx.to), valueWei: BigInt(tx.value),
    gasWei: gas, block: Number(receipt.blockNumber), at,
  };
  db.prepare(
    `INSERT INTO ledger_sweeps (tx_hash, to_address, value_wei, gas_wei, block, at, recorded_at, by_user)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sweep.txHash, sweep.to, String(sweep.valueWei), String(sweep.gasWei), sweep.block, sweep.at,
    Math.floor(Date.now() / 1000), opts.by ?? null);
  return { ok: true, sweep };
}

/**
 * Fill in the gas of payouts recorded without it.
 *
 * The hash comes back from the payer by hand and the receipt is what says what
 * it cost, so the two are read separately. A receipt that will not read leaves
 * the gas null and the preview says how many, rather than counting it as zero.
 */
export async function fillPaymentGas(): Promise<{ filled: number; failed: number }> {
  const rows = db.prepare('SELECT run_id, seat, tx_hash FROM ledger_payments WHERE tx_hash IS NOT NULL AND gas_wei IS NULL').all() as any[];
  let filled = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const receipt = await atApiPriority(() => client.getTransactionReceipt({ hash: r.tx_hash }));
      const gas = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? 0n);
      db.prepare('UPDATE ledger_payments SET gas_wei = ? WHERE run_id = ? AND seat = ?').run(String(gas), r.run_id, r.seat);
      filled++;
    } catch (err) {
      failed++;
      console.warn(`[ledger] receipt for ${String(r.tx_hash).slice(0, 12)} unreadable:`, String((err as Error)?.message ?? err).slice(0, 80));
    }
  }
  return { filled, failed };
}

/** Runs computed but never paid, which is what would make a preview double count. */
export function unrecordedRuns(): { id: number; createdAt: number; distributedWei: bigint; payments: number }[] {
  return (db.prepare(
    `SELECT r.id, r.created_at, r.distributed_wei,
            (SELECT COUNT(*) FROM ledger_payments p WHERE p.run_id = r.id AND p.tx_hash IS NULL) AS unpaid
       FROM ledger_runs r
      WHERE r.status = 'preview'
        -- A hypothetical was computed against a figure somebody typed, so it
        -- was never payable and cannot be an unpaid run. Counting them turned
        -- "/ledger preview 10" into a warning that a real run might pay twice,
        -- which is the one warning here that must not become noise.
        AND r.hypothetical = 0
        AND EXISTS (SELECT 1 FROM ledger_payments p WHERE p.run_id = r.id AND p.tx_hash IS NULL)
      ORDER BY r.id`,
  ).all() as any[]).map((r) => ({
    id: r.id, createdAt: r.created_at, distributedWei: BigInt(r.distributed_wei), payments: r.unpaid,
  }));
}

export interface PayoutRow {
  seat: number;
  handle: string;
  tier: Tier;
  shares: number;
  wallet: string;
  amountWei: bigint;
}

export interface LedgerRun {
  id: number | null;
  balanceWei: bigint;
  /** Payout values and their gas, over every run whose hashes are in. */
  paidToDateWei: bigint;
  /** Manual transfers out of the fee wallet, value and gas. */
  sweptToDateWei: bigint;
  /** balance + paid + swept: everything the wallet has ever taken in. */
  grossIncomeWei: bigint;
  /** A tenth of gross income: what the room is owed in total, ever. */
  poolTargetWei: bigint;
  /** That target less what it has already had. */
  poolWei: bigint;
  /** Set when the pool exceeds the balance, which is when nothing is sent. */
  refusal: string | null;
  totalShares: number;
  perShareWei: bigint;
  distributedWei: bigint;
  dustWei: bigint;
  rows: PayoutRow[];
  hypothetical: boolean;
  createdAt: number;
}

/**
 * The arithmetic, with no side effects.
 *
 * Takes the balance rather than reading it, so the same function answers for a
 * wallet on chain and for a figure typed in to check the table.
 */
export function computeRun(opts: {
  balanceWei: bigint;
  seats?: Seat[];
  paidToDateWei?: bigint;
  sweptToDateWei?: bigint;
  now?: number;
  hypothetical?: boolean;
}): LedgerRun {
  const seats = opts.seats ?? liveSeats();
  const paidToDate = opts.paidToDateWei ?? paidOutWei();
  const swept = opts.sweptToDateWei ?? sweptWei();
  // Everything the wallet has ever taken in: what is in it, plus everything
  // that has ever left it. Fees and payouts share the wallet, so this is the
  // only figure that separates new income from a remainder already accounted
  // for.
  const gross = opts.balanceWei + paidToDate + swept;
  const target = (gross * BigInt(LEDGER_SHARE_PCT)) / 100n;
  // What the room is owed in total, less what it has had. Negative would mean
  // it has had more than its share, which is not a debt anyone collects back.
  const raw = target - paidToDate;
  const pool = raw > 0n ? raw : 0n;
  // The pool is paid out of the wallet, so it cannot exceed what is in it.
  // Reaching here means income has been moved out that the room was owed a
  // share of, and the fix is a transfer back rather than a smaller table.
  const refusal = pool > opts.balanceWei
    ? `the pool is ${eth(pool)} ETH and the fee wallet holds ${eth(opts.balanceWei)} ETH. `
      + `${eth(pool - opts.balanceWei)} ETH more is owed than is there, because income was moved out `
      + 'before the room was paid its share of it. move it back, or record what it was spent on.'
    : null;
  const shares = totalShares(seats);
  const perShare = shares > 0 && !refusal
    ? ((pool / BigInt(shares)) / PAYOUT_PRECISION_WEI) * PAYOUT_PRECISION_WEI
    : 0n;
  const rows: PayoutRow[] = seats.map((s) => ({
    seat: s.seat, handle: s.handle, tier: s.tier, shares: s.shares,
    wallet: s.wallet, amountWei: perShare * BigInt(s.shares),
  }));
  const distributed = rows.reduce((a, r) => a + r.amountWei, 0n);
  return {
    id: null,
    balanceWei: opts.balanceWei,
    paidToDateWei: paidToDate,
    sweptToDateWei: swept,
    grossIncomeWei: gross,
    poolTargetWei: target,
    poolWei: pool,
    refusal,
    totalShares: shares,
    perShareWei: perShare,
    distributedWei: distributed,
    dustWei: pool - distributed,
    rows,
    hypothetical: opts.hypothetical ?? false,
    createdAt: opts.now ?? Math.floor(Date.now() / 1000),
  };
}

/** Store a computed run and its rows, so hashes have something to attach to. */
export function saveRun(run: LedgerRun): number {
  const insert = db.transaction((r: LedgerRun) => {
    const res = db.prepare(
      `INSERT INTO ledger_runs (created_at, balance_wei, paid_before_wei, remainder_wei, pool_wei,
         total_shares, per_share_wei, distributed_wei, dust_wei, status, hypothetical)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preview', ?)`,
    ).run(r.createdAt, String(r.balanceWei), String(r.paidToDateWei), String(r.balanceWei),
      String(r.poolWei), r.totalShares, String(r.perShareWei), String(r.distributedWei),
      String(r.dustWei), r.hypothetical ? 1 : 0);
    db.prepare('UPDATE ledger_runs SET gross_income_wei = ?, swept_to_date_wei = ? WHERE id = last_insert_rowid()')
      .run(String(r.grossIncomeWei), String(r.sweptToDateWei));
    const id = Number(res.lastInsertRowid);
    const p = db.prepare(
      `INSERT INTO ledger_payments (run_id, seat, handle, wallet, tier, shares, amount_wei)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of r.rows) p.run(id, row.seat, row.handle, row.wallet, row.tier, row.shares, String(row.amountWei));
    return id;
  });
  return insert(run);
}

export function loadRun(id: number): LedgerRun | null {
  const r = db.prepare('SELECT * FROM ledger_runs WHERE id = ?').get(id) as any;
  if (!r) return null;
  const rows = (db.prepare('SELECT * FROM ledger_payments WHERE run_id = ? ORDER BY seat').all(id) as any[])
    .map((p) => ({ seat: p.seat, handle: p.handle, tier: p.tier as Tier, shares: p.shares, wallet: p.wallet, amountWei: BigInt(p.amount_wei) }));
  return {
    id, balanceWei: BigInt(r.balance_wei), paidToDateWei: BigInt(r.paid_before_wei),
    sweptToDateWei: BigInt(r.swept_to_date_wei ?? '0'),
    grossIncomeWei: BigInt(r.gross_income_wei ?? r.balance_wei),
    poolTargetWei: BigInt(r.pool_wei) + BigInt(r.paid_before_wei),
    poolWei: BigInt(r.pool_wei), refusal: null, totalShares: r.total_shares,
    perShareWei: BigInt(r.per_share_wei), distributedWei: BigInt(r.distributed_wei),
    dustWei: BigInt(r.dust_wei), rows, hypothetical: !!r.hypothetical, createdAt: r.created_at,
  };
}

export function latestRun(): LedgerRun | null {
  const r = db.prepare('SELECT id FROM ledger_runs ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
  return r ? loadRun(r.id) : null;
}

/**
 * The latest run that was computed against the wallet rather than a figure.
 *
 * What feeds the payer resolves through this one. A hypothetical names real
 * wallets and real-looking amounts that were never owed, and exploring a
 * number with /ledger preview <eth> leaves one as the latest run, so anything
 * that reaches for "the run" without saying which would reach for that.
 */
export function latestRealRun(): LedgerRun | null {
  const r = db.prepare('SELECT id FROM ledger_runs WHERE hypothetical = 0 ORDER BY id DESC LIMIT 1')
    .get() as { id: number } | undefined;
  return r ? loadRun(r.id) : null;
}

export interface TxRecord { seat: number; txHash: string }

/**
 * Attach the hashes that came back from the payer.
 *
 * A row that already has one is left alone and reported, never overwritten: two
 * hashes against one seat is either a double payment or a typo, and quietly
 * taking the second would hide both.
 */
export function recordTxs(runId: number, txs: TxRecord[], now = Math.floor(Date.now() / 1000)):
  { recorded: number; already: TxRecord[]; unknown: number[] } {
  const run = loadRun(runId);
  if (!run) return { recorded: 0, already: [], unknown: txs.map((t) => t.seat) };
  const already: TxRecord[] = [];
  const unknown: number[] = [];
  let recorded = 0;
  const apply = db.transaction(() => {
    for (const t of txs) {
      const row = db.prepare('SELECT tx_hash FROM ledger_payments WHERE run_id = ? AND seat = ?').get(runId, t.seat) as { tx_hash: string | null } | undefined;
      if (!row) { unknown.push(t.seat); continue; }
      if (row.tx_hash) { already.push({ seat: t.seat, txHash: row.tx_hash }); continue; }
      db.prepare('UPDATE ledger_payments SET tx_hash = ?, sent_at = ? WHERE run_id = ? AND seat = ?')
        .run(t.txHash, now, runId, t.seat);
      recorded++;
    }
    const left = (db.prepare('SELECT COUNT(*) AS n FROM ledger_payments WHERE run_id = ? AND tx_hash IS NULL').get(runId) as { n: number }).n;
    if (left === 0) db.prepare("UPDATE ledger_runs SET status = 'sent' WHERE id = ?").run(runId);
  });
  apply();
  return { recorded, already, unknown };
}

/**
 * The arguments of /ledger tx, resolved to seats.
 *
 * Keyed by seat or by wallet. The payer only ever sees a wallet, because that
 * is all the CSV carries, so it is resolved back to a seat here rather than
 * asking anybody to look one up. A wallet no seat in this run holds is
 * reported rather than dropped: it means the CSV and the run have drifted
 * apart, which is the one thing this join exists to catch.
 */
export function parseTxArgs(run: LedgerRun, args: string[]):
  { txs: TxRecord[]; unmatched: string[] } {
  const txs: TxRecord[] = [];
  const unmatched: string[] = [];
  for (const p of args) {
    const bySeat = /^(\d+):(0x[0-9a-fA-F]{64})$/.exec(p);
    if (bySeat) { txs.push({ seat: Number(bySeat[1]), txHash: bySeat[2]! }); continue; }
    const byWallet = /^(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{64})$/.exec(p);
    if (byWallet) {
      const row = run.rows.find((r) => r.wallet.toLowerCase() === byWallet[1]!.toLowerCase());
      if (row) txs.push({ seat: row.seat, txHash: byWallet[2]! });
      else unmatched.push(byWallet[1]!);
    }
  }
  return { txs, unmatched };
}

// ------------------------------------------------------------------ rendering

/** Wei as ETH to four places, the precision every payout is a multiple of. */
export function eth(wei: bigint, places = 4): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, places);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * The preview: every term of the arithmetic, then the table.
 *
 * The terms are printed because the pool is 10% of a number that is itself a
 * subtraction, and a payout table whose total nobody can derive is a table
 * that gets argued about.
 *
 * Wallets are in this one. It is the admin view and it is DM only.
 */
export function previewText(run: LedgerRun, opts: { warnings?: string[] } = {}): string {
  const L: string[] = [];
  if (run.hypothetical) L.push('HYPOTHETICAL: the balance below was typed in, not read from the fee wallet');
  L.push(`fee wallet balance   ${eth(run.balanceWei)} ETH`);
  L.push(`paid out to date   + ${eth(run.paidToDateWei)} ETH, payout values and their gas`);
  L.push(`swept to date      + ${eth(run.sweptToDateWei)} ETH, moved out by hand and recorded`);
  L.push(`gross income       = ${eth(run.grossIncomeWei)} ETH, everything this wallet has ever taken in`);
  L.push(`the room's ${LEDGER_SHARE_PCT}%        ${eth(run.poolTargetWei)} ETH of it, in total, ever`);
  L.push(`less what it has had - ${eth(run.paidToDateWei)} ETH`);
  L.push(`pool now           = ${eth(run.poolWei)} ETH`);
  const unknownGas = paymentsWithUnknownGas();
  if (unknownGas) {
    L.push(`  ${unknownGas} payout${unknownGas === 1 ? '' : 's'} had no readable receipt, so their gas is missing from the sum above`);
  }
  if (run.refusal) {
    L.push('');
    L.push(`REFUSED: ${run.refusal}`);
    L.push('nothing is payable until that is settled.');
    return L.join('\n');
  }
  L.push(`total shares         ${run.totalShares}`);
  L.push(`per share            ${eth(run.perShareWei)} ETH`);
  L.push('');
  if (run.perShareWei === 0n && run.poolWei > 0n) {
    L.push(`the pool is ${eth(run.poolWei, 18).replace(/0+$/, '')} ETH over ${run.totalShares} shares, which is under the `
      + `${eth(PAYOUT_PRECISION_WEI)} ETH a payout is rounded to. nothing is sent; it stays in the wallet.`);
    L.push('');
  }
  if (!run.rows.length) {
    L.push('no seats, so nothing to divide. /seat add <handle> <tier> <wallet>');
    return L.join('\n');
  }
  L.push('seat  handle           tier sh  amount ETH  wallet');
  for (const r of run.rows) {
    L.push(`${String(r.seat).padStart(3)}   ${r.handle.padEnd(16)} ${r.tier}  ${String(r.shares).padStart(2)}  ${eth(r.amountWei).padStart(10)}  ${r.wallet}`);
  }
  L.push('');
  L.push(`distributed          ${eth(run.distributedWei)} ETH to ${run.rows.length} wallet${run.rows.length === 1 ? '' : 's'}`);
  L.push(`dust, stays in the wallet and goes out with the next run: ${eth(run.dustWei, 18).replace(/0+$/, '')} ETH`);
  if (run.id !== null) L.push(`\nrun ${run.id}. /ledger csv ${run.id} · /ledger send ${run.id}`);
  for (const w of opts.warnings ?? []) L.push(`\n${w}`);
  return L.join('\n');
}

/** wallet,amount for a batch sender. Amounts in ETH, exactly as printed. */
/** The first line of a csv exported from a hypothetical run. */
export const CSV_HYPOTHETICAL_MARK = '# HYPOTHETICAL';

export function csvText(run: LedgerRun): string {
  const L: string[] = [];
  // Said at the top of the file, because the file outlives the message it
  // arrived in and is opened again on the machine that holds the key. Whoever
  // is about to send twenty transfers should not have to remember which
  // balance the table was built from.
  if (run.hypothetical) {
    L.push(`${CSV_HYPOTHETICAL_MARK}: run ${run.id ?? '?'} was computed against a balance typed into /ledger preview`);
    L.push('# not read from the fee wallet. these amounts were never owed.');
  }
  L.push('wallet,amount');
  for (const r of run.rows) L.push(`${r.wallet},${eth(r.amountWei)}`);
  return L.join('\n');
}

/** The command to run on the machine that holds the key. */
export function sendCommand(run: LedgerRun, csvName: string): string {
  return [
    'the bot holds no key and sends nothing. from the machine that does:',
    '',
    `  FEE_WALLET_PRIVATE_KEY=0x... node tools/pay.mjs --csv ${csvName} --run ${run.id ?? '?'}`,
    '',
    `it will print ${run.rows.length} transfer${run.rows.length === 1 ? '' : 's'} totalling ${eth(run.distributedWei)} ETH and ask you to type the total before sending.`,
    'when it is done it prints a line to paste back here, which records the hashes.',
  ].join('\n');
}

/**
 * The public message.
 *
 * Grouped by tier, never by person, and with no wallet anywhere. What a room
 * needs to check is that the pool was a tenth, that the shares add up and that
 * the money moved; who holds which address is not part of that.
 */
export function postText(run: LedgerRun): string {
  const L: string[] = [];
  L.push(`ledger, ${day(run.createdAt)}`);
  L.push('');
  L.push(`gross income      ${eth(run.grossIncomeWei)} ETH, everything the fee wallet has taken in`);
  L.push(`the room's ${LEDGER_SHARE_PCT}%       ${eth(run.poolTargetWei)} ETH of it, in total`);
  L.push(`already paid      ${eth(run.paidToDateWei)} ETH`);
  L.push(`this run          ${eth(run.poolWei)} ETH`);
  L.push(`total shares      ${run.totalShares}`);
  L.push('');
  for (const t of TIERS) {
    const rows = run.rows.filter((r) => r.tier === t);
    if (!rows.length) continue;
    const each = rows[0]!.amountWei;
    L.push(`${t}  ${rows.length} seat${rows.length === 1 ? '' : 's'} · ${eth(each)} ETH each · ${eth(each * BigInt(rows.length))} ETH`);
  }
  L.push('');
  L.push(`paid out          ${eth(run.distributedWei)} ETH`);
  L.push(`undistributed     ${eth(run.dustWei, 18).replace(/0+$/, '')} ETH, left in the wallet for the next run`);

  // The hashes, and deliberately not who they went to.
  //
  // A hash next to a handle is that handle's wallet: anyone can open the
  // transaction and read the recipient. Listing them bare keeps the room able
  // to check that the money moved and that it adds up, which is the point,
  // without turning the post into the wallet table it is careful not to be.
  const hashes = run.id === null ? [] : txHashesOf(run.id);
  if (hashes.length) {
    L.push('');
    L.push(`${hashes.length} transfer${hashes.length === 1 ? '' : 's'}:`);
    for (const h of [...hashes].sort((a, b) => (a.txHash < b.txHash ? -1 : 1))) L.push(`  ${h.txHash}`);
  } else {
    L.push('');
    L.push('no transaction hashes recorded yet');
  }
  return L.join('\n');
}

/** Every run, with what it paid and whether the hashes are in. */
export function historyText(limit = 20): string {
  const runs = db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM ledger_payments p WHERE p.run_id = r.id) AS n,
            (SELECT COUNT(*) FROM ledger_payments p WHERE p.run_id = r.id AND p.tx_hash IS NOT NULL) AS sent
       FROM ledger_runs r ORDER BY r.id DESC LIMIT ?`,
  ).all(limit) as any[];
  if (!runs.length) return 'no ledger runs yet. /ledger preview';
  const L = ['run  date        pool ETH    paid ETH    seats  state'];
  for (const r of runs) {
    const state = r.status === 'sent' ? 'sent' : `${r.sent}/${r.n} recorded`;
    L.push(`${String(r.id).padStart(3)}  ${day(r.created_at)}  ${eth(BigInt(r.pool_wei)).padStart(10)}  ${eth(BigInt(r.distributed_wei)).padStart(10)}  ${String(r.n).padStart(5)}  ${state}${r.hypothetical ? ' (hypothetical)' : ''}`);
  }
  return L.join('\n');
}

/** The hashes recorded against a run, for the public message. */
export function txHashesOf(runId: number): { seat: number; handle: string; txHash: string }[] {
  return (db.prepare(
    'SELECT seat, handle, tx_hash FROM ledger_payments WHERE run_id = ? AND tx_hash IS NOT NULL ORDER BY seat',
  ).all(runId) as any[]).map((r) => ({ seat: r.seat, handle: r.handle, txHash: r.tx_hash }));
}
