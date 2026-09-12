import type { ScanResult } from '../scan.js';
import type { Flag } from '../metrics/flags.js';
import { indexCoverage } from '../coverage.js';
import { db } from '../db.js';
import {
  CHAIN_ID, LAUNCHPAD, type ApiCheck, type ApiLaunch, type CheckId, type CheckState,
} from './types.js';

/**
 * Turning a scan into the committed shape.
 *
 * The mapping is explicit and one-way: a flag key the API has never published
 * is dropped rather than guessed at, because an id is a promise and inventing
 * one from an internal name would publish whatever the next refactor renames
 * it to.
 */

/**
 * Internal flag key to published check id.
 *
 * The three deployer checks are separate internally and only one of them,
 * deployer_history, was committed. Rather than merge three different questions
 * into one answer, the committed id keeps its meaning -- how often this wallet
 * launches -- and the other two are published beside it as additions a client
 * written against the nine may ignore.
 */
const ID_BY_FLAG: Record<string, CheckId> = {
  snipe_exemptions: 'snipe_tax_exemptions',
  creator_open_buy: 'creator_opening_buy',
  creator_tax: 'creator_tax',
  deployer_rate: 'deployer_history',
  deployer_peaks: 'deployer_prior_peaks',
  deployer_survival: 'deployer_prior_survival',
  collision: 'ticker_collision',
  pair_ticker: 'ticker_vs_pair',
  custom_pair: 'pair_asset',
  holder_concentration: 'holder_concentration',
  declaration_mismatch: 'launch_vs_declaration',
};

function stateOf(f: Flag): CheckState {
  if (f.state === 'raised') return 'finding';
  if (f.state === 'unknown') return 'undetermined';
  return 'none';
}

/**
 * The headline: the card's sentence, with the reference clause taken off.
 *
 * The card joins the measurement and the thing it is measured against with a
 * middle dot, because a reader needs both in one line. A consumer building
 * their own sentence needs the first half alone, and gets the second half as a
 * structured `reference` rather than by cutting a string up.
 *
 * Only when there IS a structured reference, though. When there is none, the
 * clause after the dot is not a restatement of `reference`, it is the sentence
 * saying why `reference` is null -- "no index median yet, n=12, needs 30" --
 * and cutting it leaves a bare measured number with nothing to read it against.
 * That is the half the partner complained about.
 */
function headlineOf(plain: string, hasReference: boolean): string {
  if (!hasReference) return plain;
  const i = plain.indexOf(' \u00b7 ');
  return i === -1 ? plain : plain.slice(0, i);
}

function checkFrom(f: Flag): ApiCheck | null {
  const id = ID_BY_FLAG[f.key];
  if (!id) return null;
  const state = stateOf(f);
  const reference = state === 'undetermined' ? null : (f.reference ?? null);
  return {
    id,
    state,
    headline: headlineOf(f.plain || f.compactDetail, reference !== null),
    // Null whenever the check is undetermined, without exception and whatever
    // the flag happens to carry. That is one of the two guarantees this API
    // makes, and enforcing it in the one place every check passes through is
    // what makes it true of all of them rather than of the ones somebody
    // remembered.
    value: state === 'undetermined' ? null : (f.value ?? null),
    reference,
    severity: f.severity,
    source: f.source,
  };
}

/**
 * The buyback vest, which is a property rather than a finding.
 *
 * It has no flag because the cards do not treat it as one: a creator locking
 * fees into a five-year vest is a fact about the launch, and its absence is the
 * ordinary case rather than a finding against anyone. So it is published with
 * state "none" either way and the headline says which, and a consumer who cares
 * reads the value rather than the state.
 */
function buybackCheck(r: ScanResult): ApiCheck {
  const on = r.flags.buyback.enabled;
  return {
    id: 'buyback_vesting',
    state: 'none',
    headline: on
      ? 'creator fees locked into a 5-year linear vest'
      : 'no buyback vest on this launch',
    value: { enabled: on },
    reference: null,
    severity: 0,
    source: 'buybackEnabled from the launch configuration',
  };
}

function launchTxOf(token: string): string | null {
  const row = db.prepare('SELECT tx_hash FROM launches WHERE token = ?')
    .get(token.toLowerCase()) as { tx_hash: string | null } | undefined;
  return row?.tx_hash ?? null;
}

export function toApiLaunch(r: ScanResult, asOf = new Date()): ApiLaunch {
  const built = r.flags.flags
    .map(checkFrom)
    .filter((c): c is ApiCheck => c !== null);
  built.push(buybackCheck(r));

  /**
   * Ordered on the exact severity, then published as an integer.
   *
   * The fraction used to carry the supply share, which is now a field of its
   * own: a consumer sorting on severity needs an order, not a second copy of a
   * measurement hidden in a decimal. Sorting first and rounding second means
   * two neighbours that round to the same integer keep the order the cards
   * would show them in, rather than whichever way a stable sort happened to
   * leave them.
   */
  const checks = built
    .sort((a, b) => b.severity - a.severity)
    .map((c) => ({ ...c, severity: Math.round(c.severity) }));

  return {
    token: r.reads.token.toLowerCase(),
    chain: CHAIN_ID,
    launchpad: LAUNCHPAD,
    symbol: r.reads.symbol ?? null,
    launch_block: r.launchBlock || null,
    // Read from the index rather than from the scan: the scan carries the
    // decoded facts of the creation, not the hash it decoded them from.
    launch_tx: launchTxOf(r.reads.token),
    age_seconds: r.ageSeconds,
    pair: {
      asset: r.reads.pairSymbol ?? null,
      address: r.reads.pairToken.toLowerCase(),
    },
    checks,
    summary: {
      checks_run: checks.length,
      findings: checks.filter((c) => c.state === 'finding').length,
      undetermined: checks.filter((c) => c.state === 'undetermined').length,
    },
    as_of: asOf.toISOString(),
    index: { launches: indexCoverage().indexed },
  };
}
