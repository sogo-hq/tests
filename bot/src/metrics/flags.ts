import { db, normaliseKey } from '../db.js';
import { collisionKeys, countCollisions, collisionSymbols, MIN_COLLISION_MATCHES } from '../collision.js';
import { isNativePair } from '../reads.js';
import { clamp, clampWords, MAX_TICKER, MAX_SAMPLE } from '../text.js';
import { indexCoverage, coverageReason } from '../coverage.js';
import {
  concentrationThreshold,
  excessConcentration,
  arithmeticFloor,
  MIN_HOLDERS_FOR_SHARE,
  MIN_CONCENTRATION_SAMPLES,
  type Concentration,
} from './concentration.js';
import { MIN_BENCHMARK_SAMPLES } from './benchmark.js';
import { OPENING_BUY_BLOCKS } from './opening.js';
import { declarationFor, MAX_DECLARED_LINE, type Declaration } from '../declare.js';

export type FlagState = 'clean' | 'raised' | 'unknown';

export interface Flag {
  key: string;
  label: string;
  state: FlagState;
  detail: string;
  /**
   * Short phrasing for the compact card, which has room for two flag lines.
   * Reads as a standalone fragment without the label prefix.
   */
  compactDetail: string;
  /**
   * One line of plain English, under 60 characters, for the default card.
   *
   * The default card is read in the first minute of a launch and then forwarded
   * into a group, so it has to make sense to someone who has never heard of a
   * snipe tax. The technical wording stays in `detail` and still appears in
   * /full -- this is an additional register, not a replacement.
   */
  plain: string;
  /** Ranking weight used only to pick the single worst flag for the summary. */
  severity: number;
  /**
   * What the deployer said this check would show, before they launched.
   *
   * An extra line under the finding, never a replacement for it and never a
   * reason to soften it. A declaration that matches adds context; one that does
   * not becomes its own finding, and the check it contradicts still stands.
   */
  declared?: string | null;
  /**
   * What this check was read from, in one phrase.
   *
   * Carried on the flag rather than looked up by whatever renders it, because
   * for one check it genuinely varies: the exemption count read from the
   * curve's own events and the same count decoded from calldata are different
   * quantities, and a consumer has to be able to tell which they were given.
   * The API publishes this on every check.
   */
  source: string;
  /**
   * The measured quantity, and what it is measured against, kept apart.
   *
   * A card wants them joined into one sentence, because a reader needs them
   * together. A consumer building their own sentence needs them apart, and
   * splitting `plain` back up with a regex would make a published contract
   * depend on the punctuation of a card.
   *
   * OBJECTS, never scalars and never prose. A consumer that has to parse "9" out
   * of one check and "400 bps" out of the next has no contract at all, and a
   * bare number cannot gain a second field later without breaking everyone. The
   * shapes are per check and are part of the published v1 contract: see
   * api/types.ts. Null where the check is categorical or has nothing to
   * measure; ALWAYS null where the check is undetermined, which is enforced
   * where it is published rather than trusted here.
   *
   * Read only by the API. The cards render `plain` and `detail`, as they did
   * before these existed.
   */
  value?: Record<string, unknown> | null;
  reference?: Record<string, unknown> | null;
  /**
   * Where a number in this finding comes from, for /full only.
   *
   * Not on the quick card and not on the picture: both have a line budget and
   * neither is the place to explain a measurement. /full is, and a reader who
   * wants to check a figure against the chain themselves needs to know which
   * blocks it was read over.
   */
  note?: string | null;
}

export interface FlagResult {
  flags: Flag[];
  raised: number;
  total: number;
  unknown: number;
  /** buybackEnabled is a positive signal, reported separately from the flags. */
  buyback: {
    enabled: boolean; detail: string; plain: string;
    /** What the deployer said would happen to any team tokens. */
    declared?: string | null;
  };
  worst: Flag | null;
  snipeExemptionCount: number | null;
  creatorTaxMedianBps: number | null;
  deployerLaunches7d: number;
  deployerMedianPeakMcap: number | null;
  deployerSurvival24h: number | null;
  nameCollision: boolean;
  /** The concentration reading this result was built from, for the card. */
  concentration: Concentration | null;
  /** The declaration covering this launch, when there is one. */
  declaration: Declaration | null;
}

/**
 * Where each finding starts, before its own size is added.
 *
 * The order is a policy, not an accident of which check runs first: findings
 * rank by what a buyer cannot get anywhere else, and then by how large a claim
 * on supply they describe. The pre-exempted wallets are first on both counts --
 * no view function in the protocol exposes them and no explorer reconstructs
 * them, and they are the only wallets that could take supply before anyone else
 * could bid for it. The pair asset is last: it is printed on every page that
 * shows the token at all.
 *
 * Bands are spaced so a finding never overtakes a higher-ranked one on size
 * alone; the magnitude added inside a band is what orders two findings of the
 * same kind. Holder concentration is not in the stated order, because it is a
 * large claim on supply that any explorer already shows: it sits below the
 * creator's cut and above the deployer's history.
 */
const RAISED_BAND = {
  // A signed statement contradicted by the transaction it describes. Above the
  // exemption set because it is the only line on the card that is not about
  // what happened but about what was promised, and because it is the single
  // thing here that a buyer could not arrive at from the chain alone. It never
  // takes the place of the check it contradicts; both are printed.
  declaration_mismatch: 950,
  snipe_exemptions: 900,
  creator_open_buy: 800,
  creator_tax: 700,
  holder_concentration: 600,
  deployer_survival: 560,
  deployer_peaks: 530,
  deployer_rate: 500,
  pair_ticker: 400,
  collision: 300,
  custom_pair: 200,
} as const;

/**
 * An unreadable launch transaction outranks everything but a measured claim on
 * supply.
 *
 * Every other undetermined check sits below every finding: "no baseline yet" is
 * not a reason to look away from a custom pair asset. The exemption read is the
 * exception, and deliberately so. It is the one thing here a buyer cannot go
 * and look up, so not having it is itself a useful sentence, and the
 * alternative -- leading with the pair asset while the biggest question goes
 * unmentioned -- is the false all-clear this tool exists to avoid.
 *
 * It sits at 599: directly under the holder-concentration band, so a measured
 * share of supply still leads over a missing one, and above the deployer's
 * history and everything below it. Placed at a band edge rather than inside
 * one, so which of the two leads never depends on the data.
 */
const UNKNOWN_BAND: Record<string, number> = {
  snipe_exemptions: 599,
  creator_open_buy: 150,
  creator_tax: 140,
  holder_concentration: 130,
  deployer_survival: 124,
  deployer_peaks: 122,
  deployer_rate: 120,
  collision: 110,
};

/**
 * What each check was read from, in one phrase, published by the API.
 *
 * Here rather than in the API module so the phrase lives beside the code that
 * does the reading: a check whose source changes and whose phrase does not is
 * a check that lies about its provenance.
 */
const SOURCE = {
  snipe_exemptions_logs: "the curve's own SnipeTaxExempted events, from the launch transaction receipt",
  snipe_exemptions_calldata: 'the launch calldata, which omits the deployer the curve exempts itself',
  snipe_exemptions_none: 'the launch transaction could not be read',
  creator_open_buy: 'CurveBuy events over the first 40 blocks, against the index median',
  creator_tax: 'the launch calldata, against the median of the indexed launches',
  deployer_rate: 'the index of launches by this deployer',
  deployer_peaks: "recorded peak market caps of this deployer's prior launches",
  deployer_survival: "this bot's own +24h rechecks of prior launches",
  collision: 'indexed launch symbols and names, homoglyph-normalised',
  pair_ticker: 'the token symbol and the pair asset symbol, both read from the chain',
  custom_pair: 'pairToken from the TokenLaunched event',
  holder_concentration: "the token's Transfer log, excluding the curve and the protocol",
  declaration_mismatch: 'the signed declaration, against the launch transaction',
} as const;

/**
 * The protocol's ceiling on pre-exempted wallets.
 *
 * Published in the exemption check's value so a consumer can size a count
 * against what was possible: nine of a possible thirty-two is a different
 * sentence from nine of a possible nine. Measured on chain, and stated here
 * rather than read per scan because it is a property of the factory, not of a
 * launch.
 */
const EXEMPT_SLOTS = 32;

/**
 * How many other launches sharing a ticker make it a collision.
 *
 * One other launch out of hundreds of thousands is ticker reuse, which on this
 * chain is ordinary; the finding is for a ticker being worn by a crowd. The
 * count never includes the token being scanned -- it is excluded in SQL -- so
 * this threshold is about other launches only.
 */

/**
 * How far past a declared dev buy counts as a different dev buy.
 *
 * A plan stated in advance against a figure measured from the chain, so an
 * exact comparison would fire on rounding. Half a percentage point, and only
 * upward.
 */
const DEV_BUY_TOLERANCE_PP = 0.5;

/** A band plus a size inside it, with the size clamped so bands cannot cross. */
function sev(band: number, magnitude = 0, width = 99): number {
  return band + Math.max(0, Math.min(width, magnitude));
}

/** Basis points as a percentage, trimmed: 100 -> "1", 250 -> "2.5". */
function pctOfBps(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

function medianOf(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function computeFlags(opts: {
  token: string;
  deployer: string;
  name: string | null;
  symbol: string | null;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  pairToken: string;
  pairSymbol: string | null;
  scannedAt: number;
  /** Read from the chain, so it is passed in rather than queried here. */
  concentration?: Concentration | null;
}): FlagResult {
  const token = opts.token.toLowerCase();
  const deployer = opts.deployer.toLowerCase();
  const flags: Flag[] = [];

  // What the index can currently support. A finding is always reported; it is
  // only the absence of one that needs enough rows behind it to mean anything.
  const cov = indexCoverage();

  // ---------------------------------------------------------------- flag 1
  // Snipe-tax exemptions fixed at creation. Cap is 32. No view function
  // anywhere in the protocol exposes this -- the creation transaction is the
  // only source, across four different entry points.
  const launchRow = db
    .prepare(
      `SELECT snipe_exemption_count, snipe_exemptions, entry_point, launch_buy_amount,
              exemption_source, exempt_open_pct, creator_open_pct, block_number
         FROM launches WHERE token = ?`,
    )
    .get(token) as
    | {
        snipe_exemption_count: number | null; snipe_exemptions: string | null; entry_point: string;
        launch_buy_amount: string | null; exemption_source: string | null;
        exempt_open_pct: number | null; creator_open_pct: number | null;
        block_number: number;
      }
    | undefined;

  const exCount = launchRow?.snipe_exemption_count ?? null;
  const exFromLogs = launchRow?.exemption_source === 'logs';
  const exShare = launchRow?.exempt_open_pct ?? null;
  const openShare = launchRow?.creator_open_pct ?? null;

  /** "22.3% of supply", or nothing when the window was never measured. */
  const shareClause = exShare === null ? '' : `, together ${exShare.toFixed(1)}% of supply`;

  /**
   * How many wallets skipped the opening tax, said in one quantity.
   *
   * The curve exempts the DEPLOYER automatically and never mentions it in the
   * calldata, so a count decoded from calldata and a count read from the
   * curve's own events are different numbers. Measured: they disagreed on 61 of
   * 64 launches where both were readable, the events always one higher, and in
   * 19 of 19 inspected the extra wallet was the deployer.
   *
   * So a count whose source is not the events is reported as undetermined
   * rather than printed. It is a real number of something, just not of the
   * thing this sentence names, and two meanings under one name is worse than
   * waiting for the re-read.
   */
  if (exCount === null || !exFromLogs) {
    flags.push({
      key: 'snipe_exemptions',
      label: 'Snipe-tax exemptions',
      state: 'unknown',
      detail: exCount === null
        ? 'creation transaction could not be decoded, not confirmed clean'
        : 'counted before the deployer\'s automatic exemption was known, being re-read from the curve\'s events',
      compactDetail: exCount === null ? 'creation tx not decoded, exemptions unconfirmed' : 'exemption count being re-read',
      plain: exCount === null
        ? "couldn't read the launch, tax-free wallets unknown"
        : 'tax-free wallets: being re-counted from the launch itself',
      source: exCount === null ? SOURCE.snipe_exemptions_none : SOURCE.snipe_exemptions_calldata,
      value: null,
      reference: null,
      severity: UNKNOWN_BAND.snipe_exemptions!,
    });
  } else if (exCount === 0) {
    // A zero here is impossible, so it is reported as a failed read.
    //
    // The factory exempts four slots: the transaction sender, the
    // creatorFeeRecipient, the opening-buy recipient and every entry of the
    // exemptions array. Measured through eth_simulateV1 with a distinct
    // address in each, and against fourteen real receipts the index had stored
    // as zero, all fourteen of which had exempted their deployer. The old
    // "33% exempted nobody" reading counted the calldata array alone, which
    // names none of the first three slots.
    flags.push({
      key: 'snipe_exemptions',
      label: 'Snipe-tax exemptions',
      state: 'unknown',
      detail: 'the curve emitted no exemption event, which it cannot do: the sender and the fee recipient are always exempt. this read did not finish',
      compactDetail: 'exemption read did not finish',
      plain: 'tax-free wallets: the read did not finish, undetermined',
      source: SOURCE.snipe_exemptions_logs,
      value: null,
      reference: null,
      severity: UNKNOWN_BAND.snipe_exemptions!,
    });
  } else if (exCount === 1) {
    // When a launch exempts anyone at all, the deployer is among them: measured
    // 116 of 116 at exactly one and 81 of 81 above one, with no counterexample.
    // It is NOT true that every launch exempts its deployer, so the line says
    // what this wallet is rather than what the protocol always does.
    flags.push({
      key: 'snipe_exemptions',
      label: 'Snipe-tax exemptions',
      state: 'clean',
      detail: 'the deployer only, and no other wallet',
      compactDetail: 'the deployer only',
      plain: 'tax-free at launch: the deployer only (the wallet that launched it)',
      source: SOURCE.snipe_exemptions_logs,
      value: { wallets: 1, beyond_deployer: 0, supply_share: exShare === null ? null : exShare / 100, slots: EXEMPT_SLOTS },
      reference: null,
      severity: 0,
    });
  } else {
    const viaBuy = launchRow?.entry_point === 'launchAndBuy' && launchRow.launch_buy_amount;
    const others = exCount - 1;
    flags.push({
      key: 'snipe_exemptions',
      label: 'Snipe-tax exemptions',
      state: 'raised',
      detail:
        `${exCount} wallets skipped the opening tax, ${others} of them besides the deployer` +
        (exShare === null ? '' : `, and took ${exShare.toFixed(1)}% of supply between them in the tax-free window`) +
        (viaBuy ? ', alongside a creator buy in the same transaction' : ''),
      compactDetail:
        `${exCount} tax-free at launch, ${others} beyond the deployer` +
        (exShare === null ? '' : `, ${exShare.toFixed(1)}% of supply`) +
        (viaBuy ? ' + creator buy same tx' : ''),
      // Says which wallets, and how much of the token they were able to take
      // before anyone else could bid. The count alone does not separate five
      // wallets that took 0.2% from five that took 40%.
      plain: `${exCount} wallets tax-free at launch, 1 of them the deployer${shareClause}`,
      // Where the share comes from, because the obvious place to look for it is
      // the wrong one. Measured on four launches, the launch receipt alone
      // reported 1.0% where the opening window reported 17.4%.
      note: exShare === null ? null
        : 'the exempted wallets do not buy in the launch transaction, they buy in the '
          + 'tax-free seconds after it, so this share is read from the opening window '
          + `(${Number(OPENING_BUY_BLOCKS)} blocks from the launch block) and not from the receipt`,
      // Ordered by the share of supply they took, which is the size of the
      // claim. A launch whose window was never measured falls back to its
      // count, which cannot overtake a measured share: an unmeasured 32 ranks
      // below a measured 40%.
      source: SOURCE.snipe_exemptions_logs,
      severity: exShare === null
        ? sev(RAISED_BAND.snipe_exemptions, exCount, 40)
        : sev(RAISED_BAND.snipe_exemptions, exShare),
      value: { wallets: exCount, beyond_deployer: others, supply_share: exShare === null ? null : exShare / 100, slots: EXEMPT_SLOTS },
      reference: null,
    });
  }

  // --------------------------------------------------------------- flag 1b
  // What the creator took for itself before anyone else could bid.
  //
  // Separate from the exemption count, and ranked directly below it, because
  // they answer different questions: how many wallets got in tax-free, and how
  // much of the token one of them walked away with. A launch can exempt only
  // its deployer -- the ordinary case -- and still have that deployer take a
  // third of supply in the first four seconds.
  //
  // Measured over the opening-buy window by metrics/opening.ts, not from the
  // launch receipt: the exempted wallets buy in the tax-free seconds after the
  // launch transaction, not inside it.
  const openRows = db
    .prepare('SELECT creator_open_pct AS p FROM launches WHERE creator_open_pct IS NOT NULL')
    .all() as { p: number }[];
  const openMedian = openRows.length >= MIN_BENCHMARK_SAMPLES ? medianOf(openRows.map((r) => r.p)) : null;

  if (openShare === null) {
    flags.push({
      key: 'creator_open_buy',
      label: 'Creator opening buy',
      state: 'unknown',
      detail: "the opening window was not read, the creator's own buy is not known",
      compactDetail: 'creator opening buy undetermined',
      plain: "creator's opening buy: not read",
      source: SOURCE.creator_open_buy,
      value: null,
      reference: null,
      severity: UNKNOWN_BAND.creator_open_buy!,
    });
  } else if (openMedian === null) {
    /**
     * A measurement with nothing to measure it against is not undetermined.
     *
     * This branch used to report "unknown" while printing the share it had
     * measured, which broke the guarantee the API publishes: an undetermined
     * check carries no value. It was also the wrong word. The window WAS read;
     * what is missing is an index median to compare it with, and a missing
     * comparison does not unmeasure the thing compared.
     *
     * So the state is what the check found -- nothing to flag, because there is
     * no threshold to clear -- and the missing baseline is said in the sentence
     * instead of swallowing the number. `undetermined` is reserved for a window
     * that was not read, which is the branch above.
     */
    flags.push({
      key: 'creator_open_buy',
      label: 'Creator opening buy',
      state: 'clean',
      detail:
        `creator took ${openShare.toFixed(2)}% of supply in the opening window, ` +
        `no index median yet, n=${openRows.length}, needs ${MIN_BENCHMARK_SAMPLES}`,
      compactDetail: `creator opened with ${openShare.toFixed(1)}%, no index median yet`,
      plain:
        `creator opened with ${openShare.toFixed(1)}% of supply \u00b7 `
        + `no index median yet, n=${openRows.length}, needs ${MIN_BENCHMARK_SAMPLES}`,
      source: SOURCE.creator_open_buy,
      value: { supply_share: openShare / 100 },
      reference: null,
      severity: 0,
    });
  } else {
    const raisedOpen = openShare > openMedian;
    const withBaseline =
      `creator opened with ${openShare.toFixed(1)}% of supply \u00b7 ` +
      `index median ${openMedian.toFixed(1)}% (n=${openRows.length.toLocaleString()})`;
    flags.push({
      key: 'creator_open_buy',
      label: 'Creator opening buy',
      state: raisedOpen ? 'raised' : 'clean',
      detail:
        `${openShare.toFixed(2)}% of supply in the opening window, ` +
        `${raisedOpen ? 'above' : 'at or below'} the ${openMedian.toFixed(2)}% median ` +
        `across ${openRows.length} measured launches`,
      compactDetail: raisedOpen
        ? `creator opened with ${openShare.toFixed(1)}% vs ${openMedian.toFixed(1)}% median`
        : `creator opened with ${openShare.toFixed(1)}%, at or below median`,
      plain: withBaseline,
      source: SOURCE.creator_open_buy,
      value: { supply_share: openShare / 100 },
      reference: { median_share: openMedian / 100, n: openRows.length },
      severity: raisedOpen ? sev(RAISED_BAND.creator_open_buy, openShare) : 0,
    });
  }

  // ---------------------------------------------------------------- flag 2
  const taxRows = db
    .prepare('SELECT creator_tax_bps AS t FROM launches WHERE creator_tax_bps IS NOT NULL')
    .all() as { t: number }[];
  const taxMedian = medianOf(taxRows.map((r) => r.t));
  if (taxMedian === null || !cov.trustNegatives.taxBaseline) {
    flags.push({
      key: 'creator_tax',
      label: 'Creator tax',
      state: 'unknown',
      detail: taxMedian === null ? 'no indexed baseline yet' : coverageReason(cov),
      compactDetail: 'no creator-tax baseline yet',
      plain: "no baseline yet for the creator's cut",
      source: SOURCE.creator_tax,
      value: { bps: opts.creatorTaxBps },
      reference: null,
      severity: UNKNOWN_BAND.creator_tax!,
    });
  } else {
    /**
     * The rate and the baseline it is measured against, in one line, in BOTH
     * states.
     *
     * These were two different strings that rendered identically: "creator
     * takes 3% of every trade" was the plain text whether the check had raised
     * or passed, so the card said the same words about a tax above the median
     * and a tax below it. The median that decided which was computed two lines
     * above and thrown away.
     *
     * A rate with no baseline is also unreadable on its own -- 3% is unusual
     * on one chain and ordinary on another -- so the reference point travels
     * with it, and the sample size travels with the reference point.
     */
    const rate = opts.creatorTaxBps === 0 ? 'creator takes nothing' : `creator takes ${pctOfBps(opts.creatorTaxBps)}%`;
    const withBaseline =
      `${rate} per trade \u00b7 index median ${pctOfBps(taxMedian)}% (n=${taxRows.length.toLocaleString()})`;
    const raised = opts.creatorTaxBps > taxMedian;
    flags.push({
      key: 'creator_tax',
      label: 'Creator tax',
      state: raised ? 'raised' : 'clean',
      detail: raised
        ? `${opts.creatorTaxBps} bps vs ${taxMedian} bps median across ${taxRows.length} indexed launches`
        : `${opts.creatorTaxBps} bps, at or below the ${taxMedian} bps median across ${taxRows.length} indexed launches`,
      compactDetail: raised
        ? `creator tax ${opts.creatorTaxBps} bps vs ${taxMedian} bps median`
        : `creator tax ${opts.creatorTaxBps} bps, at or below median`,
      plain: withBaseline,
      // Ranked by how many times the median it is, not by how many bps above.
      value: { bps: opts.creatorTaxBps },
      reference: { median_bps: taxMedian, n: taxRows.length },
      // A 50 bps gap means one thing against a 25 bps median and another
      // against a 500 bps one; the difference ranked those two the same.
      // 25x the median saturates the band, which no observed launch reaches.
      source: SOURCE.creator_tax,
      severity: raised
        ? sev(RAISED_BAND.creator_tax, taxMedian > 0 ? (opts.creatorTaxBps / taxMedian - 1) * 4 : 99)
        : 0,
    });
  }

  // ---------------------------------------------------------------- flag 3
  const weekAgo = opts.scannedAt - 7 * 24 * 3600;
  const launches7d = (db
    .prepare('SELECT COUNT(*) AS n FROM launches WHERE deployer = ? AND launched_at >= ? AND token != ?')
    .get(deployer, weekAgo, token) as { n: number }).n;
  if (launches7d === 0 && !cov.trustNegatives.deployerHistory) {
    // Zero rows for this deployer is meaningless when there are barely any rows
    // at all. A count above zero is still a real finding and falls through.
    flags.push({
      key: 'deployer_rate',
      label: 'Deployer launch rate',
      state: 'unknown',
      detail: coverageReason(cov),
      compactDetail: 'deployer history unavailable',
      plain: "can't check the deployer's other launches yet",
      source: SOURCE.deployer_rate,
      value: null,
      reference: null,
      severity: UNKNOWN_BAND.deployer_rate!,
    });
  } else if (launches7d > 2) {
    flags.push({
      key: 'deployer_rate',
      label: 'Deployer launch rate',
      state: 'raised',
      detail: `${launches7d} other launches by this deployer in the last 7 days`,
      compactDetail: `deployer launched ${launches7d} other tokens in 7d`,
      // The threshold that made this a finding. "7 tokens this week" is a
      // count; whether 7 is many is the question, and the rule answers it.
      plain: `deployer launched ${launches7d} tokens in 7d \u00b7 flag above 2`,
      source: SOURCE.deployer_rate,
      value: { launches_7d: launches7d },
      reference: { flag_above: 2 },
      severity: sev(RAISED_BAND.deployer_rate, launches7d, 29),
    });
  } else {
    flags.push({
      key: 'deployer_rate',
      label: 'Deployer launch rate',
      state: 'clean',
      detail: launches7d === 0 ? 'no other launches in the last 7 days' : `${launches7d} other launch${launches7d === 1 ? '' : 'es'} in the last 7 days`,
      compactDetail: launches7d === 0 ? 'no other launches by deployer in 7d' : `deployer launched ${launches7d} other in 7d`,
      plain: launches7d === 0
        ? "deployer's only launch this week"
        : `deployer launched ${launches7d} other token${launches7d === 1 ? '' : 's'} this week`,
      source: SOURCE.deployer_rate,
      value: { launches_7d: launches7d },
      reference: { flag_above: 2 },
      severity: 0,
    });
  }

  // ---------------------------------------------------------------- flag 4
  const priorPeaks = db
    .prepare(
      `SELECT p.peak_mcap AS m FROM launches l
       JOIN token_peaks p ON p.token = l.token
       WHERE l.deployer = ? AND l.token != ?`,
    )
    .all(deployer, token) as { m: string }[];
  const deployerMedianPeak = medianOf(priorPeaks.map((r) => Number(r.m)));
  const allPeaks = db.prepare('SELECT peak_mcap AS m FROM token_peaks').all() as { m: string }[];
  const globalMedianPeak = medianOf(allPeaks.map((r) => Number(r.m)));

  if (deployerMedianPeak === null || globalMedianPeak === null || priorPeaks.length < 2) {
    flags.push({
      key: 'deployer_peaks',
      label: 'Deployer prior peaks',
      state: 'unknown',
      detail:
        priorPeaks.length === 0
          ? 'no prior launches with recorded outcomes yet'
          : `only ${priorPeaks.length} prior launch with outcome data, too few to judge`,
      compactDetail: 'no prior outcomes for this deployer yet',
      plain: "no history yet on this deployer's past tokens",
      source: SOURCE.deployer_peaks,
      value: null,
      reference: null,
      severity: UNKNOWN_BAND.deployer_peaks!,
    });
  } else if (deployerMedianPeak < globalMedianPeak) {
    flags.push({
      key: 'deployer_peaks',
      label: 'Deployer prior peaks',
      state: 'raised',
      detail: `median peak mcap ${deployerMedianPeak.toFixed(3)} across ${priorPeaks.length} priors, below the ${globalMedianPeak.toFixed(3)} median of all tracked tokens`,
      compactDetail: `deployer's ${priorPeaks.length} prior tokens peaked below median`,
      plain: `deployer's last ${priorPeaks.length} tokens all stayed small`,
      source: SOURCE.deployer_peaks,
      value: { median_peak_mcap: deployerMedianPeak, priors: priorPeaks.length },
      reference: { index_median_peak_mcap: globalMedianPeak },
      severity: sev(RAISED_BAND.deployer_peaks, 0, 29),
    });
  } else {
    flags.push({
      key: 'deployer_peaks',
      label: 'Deployer prior peaks',
      state: 'clean',
      detail: `median peak mcap ${deployerMedianPeak.toFixed(3)} across ${priorPeaks.length} priors, at or above the tracked median`,
      compactDetail: `deployer's priors peaked at or above median`,
      plain: `deployer's past tokens did as well as most`,
      source: SOURCE.deployer_peaks,
      value: { median_peak_mcap: deployerMedianPeak, priors: priorPeaks.length },
      reference: { index_median_peak_mcap: globalMedianPeak },
      severity: 0,
    });
  }

  // ---------------------------------------------------------------- flag 5
  const survivalRows = db
    .prepare(
      `SELECT r.still_trading AS s FROM rechecks r
       JOIN launches l ON l.token = r.token
       WHERE l.deployer = ? AND r.offset_hours = 24 AND r.completed_at IS NOT NULL AND r.token != ?`,
    )
    .all(deployer, token) as { s: number | null }[];
  const withData = survivalRows.filter((r) => r.s !== null);
  const survival = withData.length ? withData.filter((r) => r.s === 1).length / withData.length : null;

  if (survival === null || withData.length < 2) {
    flags.push({
      key: 'deployer_survival',
      label: 'Deployer prior survival',
      state: 'unknown',
      detail:
        withData.length === 0
          ? 'no prior launches rechecked at +24h yet'
          : `only ${withData.length} prior with +24h data, too few to judge`,
      compactDetail: 'no +24h history for this deployer yet',
      plain: "no first-day history on this deployer's past tokens",
      source: SOURCE.deployer_survival,
      value: null,
      reference: null,
      severity: UNKNOWN_BAND.deployer_survival!,
    });
  } else if (survival < 0.5) {
    flags.push({
      key: 'deployer_survival',
      label: 'Deployer prior survival',
      state: 'raised',
      detail: `${(survival * 100).toFixed(0)}% of ${withData.length} prior launches were still trading at +24h`,
      compactDetail: `only ${(survival * 100).toFixed(0)}% of deployer's priors alive at +24h`,
      plain: `${withData.length - Math.round(survival * withData.length)} of deployer's last ${withData.length} tokens died in 24h`,
      // Within the band, the worse the survival rate the higher it ranks.
      source: SOURCE.deployer_survival,
      value: { still_trading_share: Math.round(survival * 1000) / 1000, priors: withData.length },
      reference: { flag_below: 0.5 },
      severity: sev(RAISED_BAND.deployer_survival, Math.round((0.5 - survival) * 58), 29),
    });
  } else {
    flags.push({
      key: 'deployer_survival',
      label: 'Deployer prior survival',
      state: 'clean',
      detail: `${(survival * 100).toFixed(0)}% of ${withData.length} prior launches were still trading at +24h`,
      compactDetail: `${(survival * 100).toFixed(0)}% of deployer's priors alive at +24h`,
      plain: `${Math.round(survival * withData.length)} of deployer's last ${withData.length} still alive at 24h`,
      source: SOURCE.deployer_survival,
      value: { still_trading_share: Math.round(survival * 1000) / 1000, priors: withData.length },
      reference: { flag_below: 0.5 },
      severity: 0,
    });
  }

  // ---------------------------------------------------------------- flag 6
  // Collisions here are homoglyphs, not exact duplicates, so both sides are
  // compared on a normalised key. The token being scanned is excluded in SQL,
  // so this counts OTHER launches only: a unique ticker counts zero.
  const keys = collisionKeys(opts.name, opts.symbol);
  const collisionCount = countCollisions(token, keys);

  if (collisionCount === 0 && !cov.trustNegatives.collision) {
    // "no match against indexed pons tokens" with an empty index is a confident
    // negative derived from nothing -- exactly the false all-clear this tool
    // exists to avoid.
    flags.push({
      key: 'collision',
      label: 'Name/ticker collision',
      state: 'unknown',
      detail: coverageReason(cov),
      compactDetail: 'ticker collisions not checkable yet',
      plain: "can't check this ticker against other launches yet",
      source: SOURCE.collision,
      value: null,
      reference: null,
      severity: UNKNOWN_BAND.collision!,
    });
  } else if (collisionCount >= MIN_COLLISION_MATCHES) {
    // Colliding tokens frequently share the same rendered symbol, so show
    // distinct spellings rather than the same glyph three times.
    const ex = collisionSymbols(token, keys)
      .slice(0, 3)
      .map((sym) => clamp(sym, MAX_SAMPLE))
      .join(', ');
    flags.push({
      key: 'collision',
      label: 'Name/ticker collision',
      state: 'raised',
      detail: `matches ${collisionCount} OTHER indexed pons token${collisionCount === 1 ? '' : 's'}${ex ? ` (${ex})` : ''} after homoglyph normalisation, out of ${cov.indexed.toLocaleString()}`,
      compactDetail: `ticker shared with ${collisionCount} other launch${collisionCount === 1 ? '' : 'es'}`,
      /**
       * Said as "shared with N OTHER launches", never as "N of M use it".
       *
       * "1 of 384,587 indexed launches use this ticker" was read by a partner
       * as "only one launch uses it, and it is this one" -- the opposite of
       * what it meant. The token being scanned is one of those 384,587, so any
       * sentence of that shape invites the reading. The count never included
       * it, but the sentence did.
       */
      plain: `ticker shared with ${collisionCount} other launch${collisionCount === 1 ? '' : 'es'} of ${cov.indexed.toLocaleString()} indexed`,
      source: SOURCE.collision,
      value: { matches: collisionCount },
      reference: { indexed: cov.indexed, flag_at_or_above: MIN_COLLISION_MATCHES },
      severity: sev(RAISED_BAND.collision, collisionCount),
    });
  } else {
    flags.push({
      key: 'collision',
      label: 'Name/ticker collision',
      state: 'clean',
      detail: collisionCount === 0
        ? 'no other indexed pons token uses this name or ticker'
        : `${collisionCount} other indexed token shares it, below the ${MIN_COLLISION_MATCHES} that make it a finding`,
      compactDetail: collisionCount === 0
        ? 'no other launch uses this ticker'
        : `ticker shared with ${collisionCount} other launch`,
      plain: collisionCount === 0
        ? 'no other indexed launch uses this ticker'
        : `ticker shared with ${collisionCount} other launch of ${cov.indexed.toLocaleString()} indexed`,
      source: SOURCE.collision,
      value: { matches: collisionCount },
      reference: { indexed: cov.indexed, flag_at_or_above: MIN_COLLISION_MATCHES },
      severity: 0,
    });
  }

  // ---------------------------------------------------------------- flag 7
  // A launch can take the ticker of the very asset it is paired against.
  //
  // Seen live: 0xAa0C1171... launches as $NVDA, name "No Value Dog Agent",
  // paired against 0xd0601CE1..., whose symbol is also NVDA and whose name is
  // "NVIDIA - Robinhood Token". Different contracts, identical ticker. A buyer
  // reading "$NVDA" in a group has no way to tell which one they are looking at,
  // and the pair asset is the one with a real price to anchor to.
  //
  // Compared after the same homoglyph normalisation the collision flag uses, so
  // a Cyrillic or mathematical-alphanumeric spelling of the pair's ticker is
  // caught too.
  const pairKey = normaliseKey(opts.pairSymbol);
  const impersonatesPair = keys.symbolKey !== '' && pairKey !== '' && keys.symbolKey === pairKey;
  flags.push({
    key: 'pair_ticker',
    label: 'Ticker vs pair asset',
    state: impersonatesPair ? 'raised' : 'clean',
    detail: impersonatesPair
      ? `ticker ${clamp(opts.symbol ?? '?', MAX_TICKER)} is the same as the pair asset ${clamp(opts.pairSymbol ?? '?', MAX_TICKER)}: different contracts, identical ticker`
      : 'ticker differs from the pair asset',
    compactDetail: impersonatesPair
      ? `ticker matches its pair asset ${clamp(opts.pairSymbol ?? '?', MAX_TICKER)}: different contract`
      : 'ticker differs from the pair asset',
    plain: impersonatesPair
      ? 'same ticker as the asset it trades against'
      : 'ticker differs from what it trades against',
    // Above a plain name collision: colliding with some other launch is common
    // noise, whereas wearing the ticker of the asset on the other side of your
    // own pool is targeted at the person about to trade it.
    source: SOURCE.pair_ticker,
    value: { differs: !impersonatesPair },
    reference: { pair_symbol: opts.pairSymbol ?? null },
    severity: impersonatesPair ? RAISED_BAND.pair_ticker : 0,
  });

  // ---------------------------------------------------------------- flag 8
  const custom = !isNativePair(opts.pairToken);
  flags.push({
    key: 'custom_pair',
    label: 'Pair asset',
    state: custom ? 'raised' : 'clean',
    detail: custom
      ? `custom pair ${clamp(opts.pairSymbol ?? opts.pairToken, MAX_TICKER)}: the launch inherits that asset's risk`
      : 'native ETH pair',
    compactDetail: custom
      ? `custom pair ${clamp(opts.pairSymbol ?? 'token', MAX_TICKER)}: inherits that asset's risk`
      : 'native ETH pair',
    plain: custom
      ? `priced in ${clamp(opts.pairSymbol ?? 'a token', 12)}, not ETH. inherits its risk`
      : 'priced in ETH',
    source: SOURCE.custom_pair,
    value: { asset: opts.pairSymbol ?? null, address: opts.pairToken.toLowerCase() },
    reference: { native: !custom },
    severity: custom ? RAISED_BAND.custom_pair : 0,
  });

  // ---------------------------------------------------------------- flag 9
  // How much of the circulating supply the top five wallets hold.
  //
  // Two things keep this from becoming noise. First, the top five of five or
  // fewer holders is 100% by arithmetic, so below six holders there is nothing
  // to measure and the answer is undetermined rather than a raised flag on
  // every young launch. Second, the threshold is a percentile of what the index
  // has actually recorded for tokens with a comparable holder count -- top-five
  // share falls mechanically as holders rise, so one pooled threshold would
  // flag every small token and no large one. Both the threshold and the sample
  // behind it are printed in /full so the reader can audit the rule rather than
  // trust it.
  // Normalised once. top1Share arrived after the first readings were stored, so
  // a row written before it exists carries undefined -- and a card that throws
  // on a missing optional field is worse than one that omits it.
  const rawConc = opts.concentration ?? null;
  const conc = rawConc ? { ...rawConc, top1Share: Number(rawConc.top1Share) || 0 } : null;
  /**
   * Whether the largest-holder share was actually read.
   *
   * The zero above is a rendering default so a row written before the column
   * existed does not crash a card, and the card already suppresses it. The
   * published value must not inherit it: `largest_share: 0` alongside a top-5
   * share of 92.9% states something impossible, and a consumer has no way to
   * tell that zero from a measured one. Null says "not read", which is true.
   *
   * A real zero cannot occur here -- if anyone holds anything, the largest
   * holder holds more than nothing -- so zero is unknown without ambiguity.
   */
  const top1Known = conc !== null && conc.top1Share > 0;
  const largestShare = top1Known ? conc!.top1Share / 100 : null;
  const thr = conc ? concentrationThreshold(conc.holders, opts.token) : null;
  const shareStr = conc ? `${conc.top5Share.toFixed(1)}%` : null;

  if (!conc) {
    flags.push({
      key: 'holder_concentration',
      label: 'Holder concentration',
      state: 'unknown',
      detail: 'top 5 holder share could not be read',
      compactDetail: 'top 5 holder share undetermined',
      plain: 'top five wallet share undetermined',
      source: SOURCE.holder_concentration,
      value: null,
      reference: null,
      severity: UNKNOWN_BAND.holder_concentration!,
    });
  } else if (conc.holders < MIN_HOLDERS_FOR_SHARE) {
    // Stated as arithmetic, not as a finding: with this many holders the top
    // five ARE the holders, so the ratio cannot distinguish anything.
    flags.push({
      key: 'holder_concentration',
      label: 'Holder concentration',
      state: 'unknown',
      detail: `${conc.holders} holder${conc.holders === 1 ? '' : 's'}, too few for a top-5 share to mean anything (it is 100% by arithmetic below ${MIN_HOLDERS_FOR_SHARE})`,
      compactDetail: `${conc.holders} holders, too few to measure concentration`,
      plain: 'too few holders to measure concentration',
      source: SOURCE.holder_concentration,
      value: null,
      reference: null,
      severity: UNKNOWN_BAND.holder_concentration!,
    });
  } else if (!thr || thr.threshold === null || thr.thresholdShare === null) {
    // The share is a real measurement, but there is no distribution to judge it
    // against yet. Reported as a number, never as an all-clear.
    const n = thr?.n ?? 0;
    flags.push({
      key: 'holder_concentration',
      label: 'Holder concentration',
      state: 'clean',
      detail: `top 5 hold ${shareStr} of circulating, largest single wallet ${conc.top1Share.toFixed(1)}% (${conc.holders} holders, ${arithmeticFloor(conc.holders).toFixed(1)}% is the least ${conc.holders} wallets can hold), no threshold yet (n=${n}, need ${MIN_CONCENTRATION_SAMPLES})`,
      compactDetail: `top 5 hold ${shareStr}, no threshold yet (n=${n})`,
      plain: `top 5 hold ${shareStr}${conc.top1Share > 0 ? `, largest ${conc.top1Share.toFixed(0)}%` : ''} (no reference yet)`,
      source: SOURCE.holder_concentration,
      value: { top5_share: conc.top5Share / 100, largest_share: largestShare, holders: conc.holders },
      reference: null,
      severity: 0,
    });
  } else {
    // Judged on the excess, not the raw share. Reported as a share, because
    // that is the number on the card and the one a reader can check.
    const excess = excessConcentration(conc) ?? 0;
    const over = excess >= thr.threshold;
    const floor = arithmeticFloor(conc.holders);
    const audit =
      `flagged at ${thr.thresholdShare.toFixed(1)}% for ${conc.holders} holders ` +
      `(${floor.toFixed(1)}% is the least ${conc.holders} wallets can hold; ` +
      `${thr.percentile}th percentile of ${thr.n.toLocaleString()} launches)`;
    flags.push({
      key: 'holder_concentration',
      label: 'Holder concentration',
      state: over ? 'raised' : 'clean',
      detail: `top 5 hold ${shareStr} of circulating, largest single wallet ${conc.top1Share.toFixed(1)}% (${conc.holders} holders), ${audit}`,
      compactDetail: over
        ? `top 5 hold ${shareStr}${conc.top1Share > 0 ? `, largest ${conc.top1Share.toFixed(0)}%` : ''} (over ${thr.thresholdShare.toFixed(1)}%)`
        : `top 5 hold ${shareStr}${conc.top1Share > 0 ? `, largest ${conc.top1Share.toFixed(0)}%` : ''}`,
      // Rounded as the card rounds, and carrying the holder count, because when
      // this is raised it is the only place the reader sees either.
      plain: over
        ? `top 5 hold ${conc.top5Share.toFixed(0)}% of supply${conc.top1Share > 0 ? `, largest ${conc.top1Share.toFixed(0)}%` : ''} \u00b7 ${conc.holders} holders`
        : `top 5 hold ${conc.top5Share.toFixed(0)}%${conc.top1Share > 0 ? `, largest ${conc.top1Share.toFixed(0)}%` : ''}`,
      source: SOURCE.holder_concentration,
      value: { top5_share: conc.top5Share / 100, largest_share: largestShare, holders: conc.holders },
      reference: { flag_at_share: thr.thresholdShare / 100, percentile: thr.percentile, n: thr.n },
      severity: over ? sev(RAISED_BAND.holder_concentration, conc.top5Share) : 0,
    });
  }

  // -------------------------------------------------------- the declaration
  //
  // Last, because it is about the checks above rather than about the chain. It
  // adds a line to each check it speaks to, and where it disagrees with one it
  // becomes a finding of its own. It never edits, softens or removes a finding:
  // the declaration is a claim, the transaction is the record, and a badge that
  // could quiet a check would be worth buying.
  const declaration = launchRow ? declarationFor(deployer, launchRow.block_number) : null;
  if (declaration) {
    const attach = (key: string, line: string) => {
      const f = flags.find((x) => x.key === key);
      // Word boundary, and marked as cut. A declared line that runs out of
      // room mid sentence used to keep whatever punctuation the knife landed
      // on, so "80% to the build: development, ..." rendered as
      // "80% to the build:", which reads as the whole of what was declared.
      if (f) f.declared = clampWords(line, MAX_DECLARED_LINE);
    };
    const others = declaration.exemptCount - 1;
    attach('snipe_exemptions', others === 0
      ? 'declared: the deployer only'
      : `declared: ${declaration.exemptCount} wallets, ${others} beyond the deployer`);
    attach('creator_open_buy', `declared: a dev buy of ${declaration.devBuyPct}% of supply`);
    attach('creator_tax', `declared: ${declaration.creatorTaxBps} bps, ${declaration.taxSplit}`);

    /**
     * What the launch did against what it said it would.
     *
     * The exemption count and the creator tax are exact quantities on both
     * sides, so any difference at all is a difference. The dev buy is a plan
     * against a measurement, so it is given half a percentage point, and it
     * only counts when the launch took MORE than it said: taking less than you
     * announced is not the thing anyone is worried about.
     */
    const diffs: string[] = [];
    if (exCount !== null && exFromLogs && exCount !== declaration.exemptCount) {
      diffs.push(`${exCount} exempt wallet${exCount === 1 ? '' : 's'}, declared ${declaration.exemptCount}`);
    }
    if (openShare !== null && openShare > declaration.devBuyPct + DEV_BUY_TOLERANCE_PP) {
      diffs.push(`dev buy ${openShare.toFixed(1)}%, declared ${declaration.devBuyPct}%`);
    }
    if (opts.creatorTaxBps !== declaration.creatorTaxBps) {
      diffs.push(`creator tax ${opts.creatorTaxBps} bps, declared ${declaration.creatorTaxBps}`);
    }

    flags.push({
      key: 'declaration_mismatch',
      label: 'Launch against declaration',
      state: diffs.length ? 'raised' : 'clean',
      detail: diffs.length
        ? `the launch transaction differs from the signed declaration: ${diffs.join('; ')}`
        : 'the launch transaction matches the signed declaration on every declared figure',
      compactDetail: diffs.length ? `differs from declaration: ${diffs[0]}` : 'matches its declaration',
      plain: diffs.length
        ? `launch differs from declaration: ${diffs[0]}`
        : 'the launch did what it said it would',
      source: SOURCE.declaration_mismatch,
      value: { mismatches: diffs.length, fields: diffs },
      reference: { declared_at_block: declaration.blockNumber },
      severity: diffs.length ? sev(RAISED_BAND.declaration_mismatch, diffs.length * 10) : 0,
    });
  }

  const raised = flags.filter((f) => f.state === 'raised').length;
  const unknown = flags.filter((f) => f.state === 'unknown').length;
  const worst = flags
    .filter((f) => f.state !== 'clean')
    .sort((a, b) => b.severity - a.severity)[0] ?? null;

  return {
    flags,
    raised,
    total: flags.length,
    unknown,
    buyback: {
      enabled: opts.buybackEnabled,
      detail: opts.buybackEnabled
        ? 'buyback enabled, creator locked into a 5-year linear vest'
        : 'buyback not enabled',
      plain: opts.buybackEnabled
        ? 'creator locked fees into a 5-year buyback'
        : 'no buyback lock',
      // The vesting answer goes here because it is the one line on the card
      // already about what the creator has tied up, and there is no vesting
      // check of its own to hang it under: nothing on chain states a team
      // allocation, which is exactly why a creator saying so is worth a line.
      declared: declaration ? clampWords(`declared: ${declaration.vesting}`, MAX_DECLARED_LINE) : null,
    },
    worst,
    snipeExemptionCount: exCount,
    creatorTaxMedianBps: taxMedian,
    deployerLaunches7d: launches7d,
    deployerMedianPeakMcap: deployerMedianPeak,
    deployerSurvival24h: survival,
    concentration: opts.concentration ?? null,
    declaration,
    nameCollision: collisionCount > 0,
  };
}
