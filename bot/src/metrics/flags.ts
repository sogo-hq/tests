import { db, normaliseKey } from '../db.js';
import { isNativePair } from '../reads.js';
import { clamp, MAX_TICKER, MAX_SAMPLE } from '../text.js';
import { indexCoverage, coverageReason } from '../coverage.js';

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
}

export interface FlagResult {
  flags: Flag[];
  raised: number;
  total: number;
  unknown: number;
  /** buybackEnabled is a positive signal, reported separately from the flags. */
  buyback: { enabled: boolean; detail: string; plain: string };
  worst: Flag | null;
  snipeExemptionCount: number | null;
  creatorTaxMedianBps: number | null;
  deployerLaunches7d: number;
  deployerMedianPeakMcap: number | null;
  deployerSurvival24h: number | null;
  nameCollision: boolean;
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
    .prepare('SELECT snipe_exemption_count, snipe_exemptions, entry_point, launch_buy_amount FROM launches WHERE token = ?')
    .get(token) as
    | { snipe_exemption_count: number | null; snipe_exemptions: string | null; entry_point: string; launch_buy_amount: string | null }
    | undefined;

  const exCount = launchRow?.snipe_exemption_count ?? null;
  if (exCount === null) {
    flags.push({
      key: 'snipe_exemptions',
      label: 'Snipe-tax exemptions',
      state: 'unknown',
      detail: 'creation transaction could not be decoded — not confirmed clean',
      compactDetail: 'creation tx not decoded — exemptions unconfirmed',
      plain: "couldn't read the launch — tax-free wallets unknown",
      severity: 60,
    });
  } else if (exCount > 0) {
    const viaBuy = launchRow?.entry_point === 'launchAndBuy' && launchRow.launch_buy_amount;
    flags.push({
      key: 'snipe_exemptions',
      label: 'Snipe-tax exemptions',
      state: 'raised',
      detail:
        `${exCount} wallet${exCount === 1 ? '' : 's'} pre-exempted from the opening tax` +
        (viaBuy ? ', alongside a creator buy in the same transaction' : ''),
      compactDetail:
        `${exCount} wallet${exCount === 1 ? '' : 's'} pre-exempted from the opening tax` +
        (viaBuy ? ' + creator buy same tx' : ''),
      plain: `${exCount} wallet${exCount === 1 ? '' : 's'} got in tax-free before you could`,
      severity: 100 + exCount,
    });
  } else {
    flags.push({
      key: 'snipe_exemptions',
      label: 'Snipe-tax exemptions',
      state: 'clean',
      detail: 'none — no wallets pre-exempted at creation',
      compactDetail: 'no pre-exempted wallets',
      plain: 'nobody got in tax-free at launch',
      severity: 0,
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
      severity: 10,
    });
  } else if (opts.creatorTaxBps > taxMedian) {
    flags.push({
      key: 'creator_tax',
      label: 'Creator tax',
      state: 'raised',
      detail: `${opts.creatorTaxBps} bps vs ${taxMedian} bps median across ${taxRows.length} indexed launches`,
      compactDetail: `creator tax ${opts.creatorTaxBps} bps vs ${taxMedian} bps median`,
      plain: `creator takes ${pctOfBps(opts.creatorTaxBps)}% of every trade`,
      severity: 40 + Math.min(40, opts.creatorTaxBps - taxMedian),
    });
  } else {
    flags.push({
      key: 'creator_tax',
      label: 'Creator tax',
      state: 'clean',
      detail: `${opts.creatorTaxBps} bps, at or below the ${taxMedian} bps median`,
      compactDetail: `creator tax ${opts.creatorTaxBps} bps, at or below median`,
      plain: opts.creatorTaxBps === 0
        ? 'creator takes nothing per trade'
        : `creator takes ${pctOfBps(opts.creatorTaxBps)}% of every trade`,
      severity: 0,
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
      severity: 15,
    });
  } else if (launches7d > 2) {
    flags.push({
      key: 'deployer_rate',
      label: 'Deployer launch rate',
      state: 'raised',
      detail: `${launches7d} other launches by this deployer in the last 7 days`,
      compactDetail: `deployer launched ${launches7d} other tokens in 7d`,
      plain: `deployer launched ${launches7d} tokens this week`,
      severity: 50 + Math.min(40, launches7d),
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
        : `deployer launched ${launches7d} tokens this week`,
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
          : `only ${priorPeaks.length} prior launch with outcome data — too few to judge`,
      compactDetail: 'no prior outcomes for this deployer yet',
      plain: "no history yet on this deployer's past tokens",
      severity: 5,
    });
  } else if (deployerMedianPeak < globalMedianPeak) {
    flags.push({
      key: 'deployer_peaks',
      label: 'Deployer prior peaks',
      state: 'raised',
      detail: `median peak mcap ${deployerMedianPeak.toFixed(3)} across ${priorPeaks.length} priors, below the ${globalMedianPeak.toFixed(3)} median of all tracked tokens`,
      compactDetail: `deployer's ${priorPeaks.length} prior tokens peaked below median`,
      plain: `deployer's last ${priorPeaks.length} tokens all stayed small`,
      severity: 45,
    });
  } else {
    flags.push({
      key: 'deployer_peaks',
      label: 'Deployer prior peaks',
      state: 'clean',
      detail: `median peak mcap ${deployerMedianPeak.toFixed(3)} across ${priorPeaks.length} priors, at or above the tracked median`,
      compactDetail: `deployer's priors peaked at or above median`,
      plain: `deployer's past tokens did as well as most`,
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
          : `only ${withData.length} prior with +24h data — too few to judge`,
      compactDetail: 'no +24h history for this deployer yet',
      plain: "no 24h history on this deployer's past tokens",
      severity: 5,
    });
  } else if (survival < 0.5) {
    flags.push({
      key: 'deployer_survival',
      label: 'Deployer prior survival',
      state: 'raised',
      detail: `${(survival * 100).toFixed(0)}% of ${withData.length} prior launches were still trading at +24h`,
      compactDetail: `only ${(survival * 100).toFixed(0)}% of deployer's priors alive at +24h`,
      plain: `${withData.length - Math.round(survival * withData.length)} of deployer's last ${withData.length} tokens died in 24h`,
      severity: 55,
    });
  } else {
    flags.push({
      key: 'deployer_survival',
      label: 'Deployer prior survival',
      state: 'clean',
      detail: `${(survival * 100).toFixed(0)}% of ${withData.length} prior launches were still trading at +24h`,
      compactDetail: `${(survival * 100).toFixed(0)}% of deployer's priors alive at +24h`,
      plain: `${Math.round(survival * withData.length)} of deployer's last ${withData.length} still alive at 24h`,
      severity: 0,
    });
  }

  // ---------------------------------------------------------------- flag 6
  // Collisions here are homoglyphs, not exact duplicates, so both sides are
  // compared on a normalised key.
  const symKey = normaliseKey(opts.symbol);
  const nameKey = normaliseKey(opts.name);
  const where =
    `token != ? AND ((symbol_key = ? AND ? != '') OR (name_key = ? AND ? != ''))`;
  const args = [token, symKey, symKey, nameKey, nameKey];
  const collisionCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM launches WHERE ${where}`)
    .get(...args) as { n: number }).n;

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
      severity: 20,
    });
  } else if (collisionCount > 0) {
    // Colliding tokens frequently share the same rendered symbol, so show
    // distinct spellings rather than the same glyph three times.
    const samples = db
      .prepare(`SELECT DISTINCT symbol FROM launches WHERE ${where} AND symbol IS NOT NULL LIMIT 25`)
      .all(...args) as { symbol: string }[];
    const ex = [...new Set(samples.map((c) => c.symbol).filter(Boolean))]
      .slice(0, 3)
      .map((sym) => clamp(sym, MAX_SAMPLE))
      .join(', ');
    flags.push({
      key: 'collision',
      label: 'Name/ticker collision',
      state: 'raised',
      detail: `matches ${collisionCount} existing pons token${collisionCount === 1 ? '' : 's'}${ex ? ` (${ex})` : ''} after homoglyph normalisation`,
      compactDetail: `name collides with ${collisionCount} token${collisionCount === 1 ? '' : 's'} after homoglyph normalisation`,
      plain: collisionCount === 1
        ? '1 other token uses this exact ticker'
        : `${collisionCount} other tokens use this exact ticker`,
      severity: 70,
    });
  } else {
    flags.push({
      key: 'collision',
      label: 'Name/ticker collision',
      state: 'clean',
      detail: 'no match against indexed pons tokens',
      compactDetail: 'no name or ticker collision',
      plain: 'no other token uses this ticker',
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
  const impersonatesPair = symKey !== '' && pairKey !== '' && symKey === pairKey;
  flags.push({
    key: 'pair_ticker',
    label: 'Ticker vs pair asset',
    state: impersonatesPair ? 'raised' : 'clean',
    detail: impersonatesPair
      ? `ticker ${clamp(opts.symbol ?? '?', MAX_TICKER)} is the same as the pair asset ${clamp(opts.pairSymbol ?? '?', MAX_TICKER)} — different contracts, identical ticker`
      : 'ticker differs from the pair asset',
    compactDetail: impersonatesPair
      ? `ticker matches its pair asset ${clamp(opts.pairSymbol ?? '?', MAX_TICKER)} — different contract`
      : 'ticker differs from the pair asset',
    plain: impersonatesPair
      ? 'same ticker as the asset it trades against'
      : 'ticker differs from what it trades against',
    // Above a plain name collision: colliding with some other launch is common
    // noise, whereas wearing the ticker of the asset on the other side of your
    // own pool is targeted at the person about to trade it.
    severity: impersonatesPair ? 80 : 0,
  });

  // ---------------------------------------------------------------- flag 8
  const custom = !isNativePair(opts.pairToken);
  flags.push({
    key: 'custom_pair',
    label: 'Pair asset',
    state: custom ? 'raised' : 'clean',
    detail: custom
      ? `custom pair ${clamp(opts.pairSymbol ?? opts.pairToken, MAX_TICKER)} — the launch inherits that asset's risk`
      : 'native ETH pair',
    compactDetail: custom
      ? `custom pair ${clamp(opts.pairSymbol ?? 'token', MAX_TICKER)} — inherits that asset's risk`
      : 'native ETH pair',
    plain: custom
      ? `priced in ${clamp(opts.pairSymbol ?? 'a token', 12)}, not ETH — inherits its risk`
      : 'priced in ETH',
    severity: custom ? 35 : 0,
  });

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
        ? 'buyback enabled — creator locked into a 5-year linear vest'
        : 'buyback not enabled',
      plain: opts.buybackEnabled
        ? 'creator locked fees into a 5-year buyback'
        : 'no buyback lock',
    },
    worst,
    snipeExemptionCount: exCount,
    creatorTaxMedianBps: taxMedian,
    deployerLaunches7d: launches7d,
    deployerMedianPeakMcap: deployerMedianPeak,
    deployerSurvival24h: survival,
    nameCollision: collisionCount > 0,
  };
}
