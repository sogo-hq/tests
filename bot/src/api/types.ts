/**
 * The v1 response contract.
 *
 * This shape is committed to a partner who is building against it, so it is
 * defined once, here, and everything else derives from it: the handlers return
 * these types, the OpenAPI document is generated from the same descriptors, and
 * the tests assert against them. A hand-written schema beside a hand-written
 * handler is two things that drift.
 *
 * Two guarantees are load-bearing and are tested rather than trusted:
 *
 *   `state` is one of three words and never a score. There is no grade, no risk
 *   level, no "safe" boolean, and there never will be. A consumer that wants to
 *   rank launches has to decide for themselves what matters, which is the whole
 *   point of publishing the checks instead of a number.
 *
 *   `state: "none"` is never described as clean, and `state: "undetermined"`
 *   never carries a value. A check that could not be answered has no number to
 *   give, and a check that found nothing has not cleared anything.
 */

export const API_VERSION = 'v1';
export const CHAIN_ID = 4663;
export const LAUNCHPAD = 'pons_v2';

/**
 * The three states, and only three.
 *
 * "finding": the chain shows this, stated as a fact.
 * "undetermined": the check could not be answered from the data available.
 * "none": the check ran and found nothing. NOT an all-clear, and never
 *         described as one anywhere in this API or its documentation.
 */
export type CheckState = 'finding' | 'undetermined' | 'none';

/**
 * Check ids are permanent.
 *
 * A consumer keys their own logic off these. Adding an id is a compatible
 * change; renaming or removing one is not, and this list is the record of what
 * has been promised. The nine below are committed. Anything after them was
 * added later and may be ignored safely by a client written against the nine.
 */
export const COMMITTED_CHECK_IDS = [
  'snipe_tax_exemptions',
  'creator_opening_buy',
  'deployer_history',
  'ticker_collision',
  'ticker_vs_pair',
  'creator_tax',
  'buyback_vesting',
  'pair_asset',
  'holder_concentration',
] as const;

/** Added after the committed set. Safe for a client to ignore. */
export const ADDITIONAL_CHECK_IDS = [
  'deployer_prior_peaks',
  'deployer_prior_survival',
  'launch_vs_declaration',
] as const;

export type CheckId =
  | (typeof COMMITTED_CHECK_IDS)[number]
  | (typeof ADDITIONAL_CHECK_IDS)[number];

export interface ApiCheck {
  /** Stable forever. See COMMITTED_CHECK_IDS. */
  id: CheckId;
  state: CheckState;
  /** One sentence a person can read. Never a verdict about the launch. */
  headline: string;
  /**
   * The measured quantity, as an OBJECT, or null.
   *
   * Never a scalar and never prose. A consumer that has to parse "9" out of one
   * check and "400 bps" out of the next has no contract, and a bare number
   * cannot gain a second field later without breaking every client. The keys
   * are per check id and are part of this contract:
   *
   *   snipe_tax_exemptions  {wallets, beyond_deployer, supply_share, slots}
   *   creator_opening_buy   {supply_share}
   *   creator_tax           {bps}
   *   deployer_history      {launches_7d}
   *   ticker_collision      {matches}
   *   ticker_vs_pair        {differs}
   *   pair_asset            {asset, address}
   *   buyback_vesting       {enabled}
   *   holder_concentration  {top5_share, largest_share, holders}
   *   deployer_prior_peaks  {median_peak_mcap, priors}
   *   deployer_prior_survival {still_trading_share, priors}
   *   launch_vs_declaration {mismatches, fields}
   *
   * Shares are FRACTIONS, not percentages: 0.174 is 17.4% of supply. Null
   * whenever state is "undetermined", and whenever the check has nothing to
   * measure.
   */
  value: Record<string, unknown> | null;
  /**
   * What the value is measured against, as an object, or null.
   *
   *   creator_tax           {median_bps, n}
   *   creator_opening_buy   {median_share, n}
   *   ticker_collision      {indexed, flag_at_or_above}
   *   deployer_history      {flag_above}
   *   ticker_vs_pair        {pair_symbol}
   *   holder_concentration  {flag_at_share, percentile, n}
   *
   * Null when the check is categorical, when no index baseline exists yet, and
   * always when the check is undetermined.
   */
  reference: Record<string, unknown> | null;
  /**
   * Ordering weight, higher first. NOT a score and not comparable between
   * launches: it exists so a consumer can render the same order the cards do.
   */
  severity: number;
  /** What this check was read from, in one phrase. */
  source: string;
}

export interface ApiPair {
  asset: string | null;
  address: string;
}

export interface ApiSummary {
  checks_run: number;
  findings: number;
  undetermined: number;
}

export interface ApiLaunch {
  token: string;
  chain: typeof CHAIN_ID;
  launchpad: typeof LAUNCHPAD;
  symbol: string | null;
  launch_block: number | null;
  launch_tx: string | null;
  age_seconds: number;
  pair: ApiPair;
  checks: ApiCheck[];
  summary: ApiSummary;
  /** RFC3339, when this answer was computed. */
  as_of: string;
  index: { launches: number };
}

export interface ApiError {
  error: string;
  /**
   * What the address turned out to be, when it was something.
   *
   * A deployer address and a curve address are both things people paste
   * expecting a token, and telling them which one they have is the difference
   * between a useful 404 and a dead end.
   */
  resolved_as?: 'deployer' | 'curve' | null;
  [key: string]: unknown;
}

/** One entry of POST /v1/launches: an answer, or why there is not one. */
export type ApiBatchItem =
  | { address: string; ok: true; launch: ApiLaunch }
  | { address: string; ok: false; error: ApiError };

export interface ApiStats {
  index: {
    launches: number;
    decoded: number;
    read_from_curve_events: number;
  };
  exemptions: {
    with_any: number;
    beyond_deployer: number;
    beyond_deployer_pct: number;
    /** Null below the publishing floor. A median of four is an anecdote. */
    median_count_beyond_deployer: number | null;
    median_sample: number;
  };
  declarations: number;
  as_of: string;
}

export interface ApiHealth {
  ok: boolean;
  head_block: number | null;
  indexed_to_block: number | null;
  lag_blocks: number | null;
  as_of: string;
}

/** Past this, the index is too far behind to answer for a launch. */
export const MAX_LAG_BLOCKS = Number(process.env.API_MAX_LAG_BLOCKS || 500) || 500;

/** Batch ceiling, stated in the error when it is exceeded. */
export const MAX_BATCH = Number(process.env.API_MAX_BATCH || 50) || 50;
