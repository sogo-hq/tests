import type { ScanResult } from './scan.js';
import type { TractionMetrics, WindowMetrics } from './metrics/traction.js';
import type { FlagResult } from './metrics/flags.js';
import { DISCLAIMER, EXPLORER_URL } from './config.js';
import { sponsorLine } from './sponsor.js';
import { launchNotice } from './launchnotice.js';
import { deployerSummary } from './deployerlookup.js';
import { clamp, clampWords, clampMessage, count, MAX_NAME, MAX_TICKER, TELEGRAM_MAX_MESSAGE } from './text.js';
import { EARLY_WINDOW_SECONDS } from './config.js';
import { MIN_HOLDERS_FOR_SHARE } from './metrics/concentration.js';
import { MIN_BENCHMARK_SAMPLES, BENCHMARK_LADDER_MINUTES } from './metrics/benchmark.js';
import { deployerActivityLine } from './metrics/deployer.js';

export { TELEGRAM_MAX_MESSAGE };

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Format a base-unit amount as a readable decimal string. */
export function fmtUnits(v: bigint, decimals = 18, sig = 4): string {
  if (v === 0n) return '0';
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let out: string;
  if (whole > 0n) {
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, sig).replace(/0+$/, '');
    out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  } else {
    const fracStr = frac.toString().padStart(decimals, '0');
    const firstSig = fracStr.search(/[1-9]/);
    if (firstSig === -1) return '0';
    out = `0.${fracStr.slice(0, firstSig + sig).replace(/0+$/, '')}`;
  }
  return neg ? `-${out}` : out;
}

const num = (n: number, dp = 2) =>
  Number.isFinite(n) ? n.toFixed(dp) : 'n/a';

function ratioStr(r: number | null, dp = 2): string {
  if (r === null) return 'n/a';
  if (!Number.isFinite(r)) return '∞';
  return r.toFixed(dp);
}

export function age(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const m = seconds / 60;
  if (m < 90) return `${m.toFixed(0)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/**
 * The single strongest observed signal. This describes what the measured window
 * contains -- it is never a projection.
 *
 * `onCurve` decides whether progress toward graduation is a candidate at all.
 * It is not, once the token has graduated: the opening window's progress is a
 * true statement about a half hour that has since been overtaken, and offering
 * it as the strongest signal put "curve at 11.29% of graduation" directly
 * beside a header reading "graduated". Both were correct and together they read
 * as a contradiction, which is the only thing a reader takes from them. The
 * TRACTION block already refuses to print progress after graduation for the
 * same reason; this line was the one place that did not.
 */
function strongestSignal(
  t: TractionMetrics,
  w: WindowMetrics,
  quote: string,
  quoteDecimals: number,
  onCurve: boolean,
): string {
  const cands: { weight: number; text: string }[] = [];

  if (w.uniqueBuyers30m > 0)
    cands.push({
      weight: w.uniqueBuyers30m,
      text: `${w.uniqueBuyers30m} unique buyer${w.uniqueBuyers30m === 1 ? '' : 's'} in the first ${num(t.windowMinutes, 0)} min`,
    });
  if (w.buyerGrowthRatio !== null && w.buyerGrowthRatio > 1)
    cands.push({
      weight: w.buyerGrowthRatio * 12,
      text: `buyer count grew ${ratioStr(w.buyerGrowthRatio)}x between +10 min and +${num(t.windowMinutes, 0)} min`,
    });
  if (w.buySellRatio !== null && w.buySellRatio > 1)
    cands.push({ weight: w.buySellRatio * 8, text: `buys outnumber sells ${ratioStr(w.buySellRatio)} to 1` });
  // Only while there is a curve to be making progress along.
  if (onCurve && w.progressAt30m > 0)
    cands.push({ weight: w.progressAt30m * 2.5, text: `curve at ${num(w.progressAt30m, 2)}% of graduation` });
  if (onCurve && w.progressVelocityPer10m > 0)
    cands.push({
      weight: w.progressVelocityPer10m * 2,
      text: `progress accruing at ${num(w.progressVelocityPer10m, 2)}% per 10 min`,
    });
  if (w.medianBuySize > 0n && w.uniqueBuyers30m >= 5)
    cands.push({
      weight: w.uniqueBuyers30m * 0.8,
      text: `median buy ${fmtUnits(w.medianBuySize, quoteDecimals)} ${quote} across ${w.buyTxCount} buys`,
    });

  if (!cands.length) return 'no buying activity recorded in the measured window';
  return cands.sort((a, b) => b.weight - a.weight)[0]!.text;
}


// ---------------------------------------------------------------------------
// Early mode: under EARLY_WINDOW_SECONDS old
// ---------------------------------------------------------------------------

/** Exact seconds, because at this age "1m" would throw away the useful part. */
function earlySeconds(r: ScanResult): string {
  return `${Math.max(0, Math.floor(r.ageSeconds))}s`;
}

export const EARLY_TRACTION_LINE =
  'traction unavailable: the snipe tax window is still open. re-scan in 2 minutes.';

/**
 * Was the creation transaction decoded at all?
 *
 * Keyed on the entry point rather than the exemption count. Those two are
 * written by the same decode but were not always persisted together, so a row
 * could carry a fresh exemption count beside a stale NULL buy amount -- and a
 * guard reading the count would then wave through a confident "creator opening
 * buy: none" for a launch that opened with a creator buy.
 */
export function creationUndecoded(r: ScanResult): boolean {
  const e = r.creation.entryPoint;
  return r.creation.snipeExemptionCount === null || e === null || e === 'unknown';
}

/** Did the creator buy their own token inside the launch transaction? */
export function hasCreatorLaunchBuy(r: ScanResult): boolean {
  return r.creation.launchBuyAmount !== null && r.creation.launchBuyAmount > 0n;
}

/**
 * Findings that are legitimately available seconds after launch.
 *
 * Everything here is fixed in the creation transaction or derived from the
 * index of *other* launches, so none of it depends on trading having happened.
 * Ordered so the highest-value signal leads: the exemption count first -- no
 * view function anywhere exposes it -- then the creator's own opening buy, then
 * the remaining raised flags by severity.
 *
 * Undetermined flags are deliberately excluded, exactly as in the normal
 * compact card: "we could not determine this" must never occupy a slot the
 * reader will parse as a finding.
 */
export function earlyFindings(r: ScanResult): string[] {
  const out: string[] = [];
  const n = r.creation.snipeExemptionCount;
  if (n !== null && n > 0) {
    out.push(`${n} wallet${n === 1 ? '' : 's'} pre-exempted from the opening tax`);
  }
  if (hasCreatorLaunchBuy(r)) out.push('creator bought in the launch tx');
  for (const fl of r.flags.flags
    .filter((f) => f.state === 'raised' && f.key !== 'snipe_exemptions')
    .sort((a, b) => b.severity - a.severity)) {
    out.push(fl.compactDetail);
  }
  return out;
}

/**
 * Full card for a launch that is too young to have measurable traction.
 *
 * Shows only what is fixed at creation or comes from the index. There is no
 * TRACTION block at all -- not a zeroed one -- because at this age every metric
 * in it is undefined rather than small, and a reader who sees "TRACTION none"
 * takes it as a finding about the token instead of an absence of data.
 */
function renderEarlyCard(r: ScanResult, now = Date.now()): string {
  const { reads: k, flags: f } = r;
  const quote = clamp(k.pairSymbol ?? 'quote', MAX_TICKER);
  const sym = k.symbol ? esc(clamp(k.symbol, MAX_TICKER)) : '?';
  const name = k.name ? esc(clamp(k.name, MAX_NAME)) : 'unknown';

  const L: string[] = [];
  L.push(`<b>${sym}</b>: ${name}`);
  L.push(`<code>${k.token}</code>`);
  L.push(`<b>launched ${earlySeconds(r)} ago, too early for traction</b>`);
  L.push(`${esc(phaseLabel(k.phaseName))} · pair ${esc(quote)}`);
  L.push('');
  L.push(EARLY_TRACTION_LINE);
  // What IS measurable this early, stated so the two renderings of one scan
  // cannot contradict each other: the default card shows this buyer count, and
  // a /full that said only "traction unavailable" read as though nothing at all
  // had been measured. The traction *label* is what the line above withholds.
  L.push(`  ${esc(buyerLine(r))}`);
  const earlyConc = concentrationLine(r);
  if (earlyConc) L.push(`  ${esc(earlyConc)}`);
  L.push('');

  L.push(`<b>FIXED AT CREATION</b>`);
  const n = r.creation.snipeExemptionCount;
  L.push(
    n === null
      ? `  ${MARK_GLYPH.undetermined} snipe-tax exemptions: creation transaction not decoded, not confirmed clean`
      : n > 0
        ? `  🚩 snipe-tax exemptions: ${n} wallet${n === 1 ? '' : 's'} pre-exempted from the opening tax`
        : '  · snipe-tax exemptions: none, no wallets pre-exempted at creation',
  );
  // launchBuyAmount is null both when there was genuinely no buy and when the
  // creation transaction could not be decoded at all. Those must not render
  // alike: claiming "none" about a transaction we just said we could not read
  // is precisely the undetermined-as-clean error the card exists to avoid.
  L.push(
    hasCreatorLaunchBuy(r)
      ? `  🚩 creator opening buy: ${fmtUnits(r.creation.launchBuyAmount!, k.pairDecimals)} ${esc(quote)} bought in the launch transaction`
      : creationUndecoded(r)
        ? `  ${MARK_GLYPH.undetermined} creator opening buy: unknown, the creation transaction could not be decoded`
        : '  · creator opening buy: none in the launch transaction',
  );
  L.push('');

  L.push(`<b>FLAGS  ${f.raised} of ${f.total}</b>${f.unknown ? ` · ${f.unknown} undetermined` : ''}`);
  for (const fl of f.flags) {
    if (fl.key === 'snipe_exemptions') continue; // already stated above
    // The same three states the quick card uses: a finding, an undetermined
    // check, or no marker at all. /full had its own vocabulary -- a question
    // mark for undetermined and a bullet for "nothing found" -- and a bullet on
    // a passing check reads as a mark of approval, which is the one thing this
    // may not do.
    const mark = fl.state === 'raised'
      ? MARK_GLYPH.finding
      : fl.state === 'unknown'
        ? MARK_GLYPH.undetermined
        : ' ';
    L.push(`  ${mark} ${esc(fl.label)}: ${esc(fl.detail)}`);
    // Under the finding, never instead of it. A declaration is a claim about
    // the launch; the line above it is what the launch did.
    if (fl.declared) L.push(`      ${esc(fl.declared)}`);
    // /full only: where a figure was read from, so it can be checked.
    if (fl.note) L.push(`      <i>${esc(fl.note)}</i>`);
  }
  // No marker either way. A green tick on "buyback enabled" renders a fact as
  // an endorsement -- it is a property of the launch, not a finding in its
  // favour, and the card does not hand out approval.
  L.push(`    ${esc(f.buyback.detail)}`);
  if (f.buyback.declared) L.push(`      ${esc(f.buyback.declared)}`);
  if (f.declaration) {
    L.push(`    <a href="${esc(f.declaration.docsUrl)}">declaration ${f.declaration.id}</a>, signed by the deployer before the launch`);
  }
  L.push('');

  // Worst flag only. The spec replaces the traction block with a single line and
  // it is already above; a second traction statement here just restates it.
  const worst = f.worst ? `${f.worst.label.toLowerCase()}, ${f.worst.detail}` : 'no flags raised';
  L.push(`<b>Worst flag:</b> ${esc(worst)}.`);
  L.push('');
  L.push(`<a href="${EXPLORER_URL}/address/${k.token}">token</a> · <a href="${EXPLORER_URL}/address/${k.curve}">curve</a> · <a href="${EXPLORER_URL}/address/${k.deployer}">deployer</a>`);
  L.push(`<i>${DISCLAIMER}</i>`);
  const notice = launchNotice(now);
  if (notice) L.push(esc(notice));
  return clampMessage(L.join('\n'));
}

/**
 * The phase, in words a reader knows.
 *
 * "phase PoolCreated" is the enum member: it names an internal state machine,
 * not the thing that happened. Everything past NotGraduated means the curve was
 * swept into the v4 pool, which is what "graduated" means to anyone reading.
 */
export function phaseLabel(phaseName: string): string {
  return phaseName === 'NotGraduated' ? 'on the curve' : 'graduated';
}

/** How long after launch it graduated, when both times are known. */
export function graduatedAtLine(r: ScanResult): string | null {
  const { sweptAt, phaseName } = r.reads;
  if (phaseName === 'NotGraduated' || !sweptAt) return null;
  const after = sweptAt - Math.floor(r.launchedAt ?? 0);
  if (!Number.isFinite(after) || after <= 0) return '  graduated';
  return `  graduated at +${age(after)}`;
}

/**
 * The instant a card is rendered at.
 *
 * Threaded rather than read, because the launch notice expires on a date and a
 * renderer that reaches for Date.now() decides that for itself. Two things went
 * wrong with that. A card rendered from a queue or edited in later carried
 * whatever the notice said when the render ran rather than when the card was
 * timed, and the picture already took a renderedAt and then ignored it for this
 * one line. And every test of the notice on a card was pinned to a wall-clock
 * date, so the suite went red on its own the morning the date passed, which is
 * the one thing a suite must not do on a launch day.
 *
 * Optional and defaulted, so every existing caller is unchanged.
 */
export function renderCard(r: ScanResult, now = Date.now()): string {
  if (r.isEarly) return renderEarlyCard(r, now);

  const { reads: k, traction: t, flags: f } = r;
  const quote = clamp(k.pairSymbol ?? 'quote', MAX_TICKER);
  const sym = k.symbol ? esc(clamp(k.symbol, MAX_TICKER)) : '?';
  const name = k.name ? esc(clamp(k.name, MAX_NAME)) : 'unknown';

  const L: string[] = [];
  L.push(`<b>${sym}</b>: ${name}`);
  L.push(`<code>${k.token}</code>`);
  L.push(`launched ${age(r.ageSeconds)} ago · ${esc(phaseLabel(k.phaseName))} · pair ${esc(quote)}`);
  L.push('');

  const windowNote = t.windowTruncated
    ? ` (token is ${age(r.ageSeconds)} old, window truncated to ${num(t.windowMinutes, 0)} min)`
    : '';
  L.push(`<b>TRACTION  ${t.label}</b>${windowNote}`);
  const w = t.window;
  if (!w) {
    // Every line below reads the window. Printing them from an unread one is
    // how "no buyers yet" reached a graduated launch, so the block says what is
    // true -- that nobody has looked -- and stops.
    L.push('  the first 30 minutes of this launch have not been indexed,');
    L.push('  so buyers, sells, growth and round-trippers are all undetermined.');
    L.push('');
  } else {
  L.push(`  unique buyers, first ${num(t.windowMinutes, 0)} min: <b>${w.uniqueBuyers30m}</b>`);
  // The reference point, with the sample behind it, so the comparison on the
  // default card can be audited rather than taken on trust.
  const b = r.benchmark;
  // Says what was actually measured and over what population. The age band
  // describes this token; the median describes every launch whose first
  // ${window} minutes the index has seen, which is not the same set and must
  // not be labelled as though it were.
  L.push(
    b.median === null
      ? `  buyer benchmark: not enough data yet (n=${b.n}, need ${MIN_BENCHMARK_SAMPLES})`
      : `  buyer benchmark: ${b.median}, median over the same first ${windowLabel(b.windowMinutes)}, across ${count(b.n, 'indexed launch', 'indexed launches')} that reached it`,
  );
  L.push(`  age band: ${esc(b.bucket.label)}${b.measuredAtAge ? '' : ` (buyers counted over the first ${windowLabel(b.windowMinutes)}, not the full age)`}`);
  L.push(`  buyer growth: ${w.uniqueBuyers10m} at +10 min → ${w.uniqueBuyers30m} at +${num(t.windowMinutes, 0)} min${w.buyerGrowthRatio !== null ? ` (${ratioStr(w.buyerGrowthRatio)}x)` : ''}`);
  L.push(`  buy/sell tx: ${w.buyTxCount}/${w.sellTxCount}${w.buySellRatio !== null ? ` (${ratioStr(w.buySellRatio)}:1)` : w.buyTxCount ? ' (no sells)' : ''}`);
  L.push(`  median buy: ${fmtUnits(w.medianBuySize, k.pairDecimals)} ${esc(quote)}`);
  /**
   * Progress toward a threshold that has already been crossed is not a
   * measurement of anything.
   *
   * A graduated token read "graduation progress 0.000%" directly under "curve
   * at 100% of graduation": the reserve is zero because the curve was swept
   * into the pool, so the ratio collapses. Both numbers were arithmetically
   * correct and together they said nothing true. After graduation the fact that
   * matters is when it happened.
   */
  const graduated = k.phaseName !== 'NotGraduated';
  if (graduated) {
    const when = graduatedAtLine(r);
    if (when) L.push(when);
  } else {
    L.push(`  graduation progress: ${num(k.progressPct, 3)}%`);
    L.push(`  progress velocity: ${num(w.progressVelocityPer10m, 3)}% per 10 min`);
    if (w.peakProgressPct > k.progressPct + 0.01)
      L.push(`  peak progress in window: ${num(w.peakProgressPct, 3)}% (now lower)`);
  }
  if (w.roundTrippers > 0)
    L.push(`  round-trippers: ${w.roundTrippers} of ${count(w.uniqueBuyers30m, 'buyer')} also sold`);
  if (w.forwarderBuys > 0)
    L.push(`  creator opening buy present in the launch transaction`);
  L.push('');
  }

  // What the deployer did with its own supply. /full only: it is context
  // rather than a decision input, and the default card is read in the first
  // seconds of a launch. Unreadable transfers render as undetermined here,
  // never as "unchanged" -- not having looked is not the same as nothing
  // having moved.
  L.push(`  ${esc(deployerActivityLine(r.deployerActivity, r.holderWalkComplete))}`);
  L.push('');

  L.push(`<b>FLAGS  ${f.raised} of ${f.total}</b>${f.unknown ? ` · ${f.unknown} undetermined` : ''}`);
  for (const fl of f.flags) {
    // The same three states the quick card uses: a finding, an undetermined
    // check, or no marker at all. /full had its own vocabulary -- a question
    // mark for undetermined and a bullet for "nothing found" -- and a bullet on
    // a passing check reads as a mark of approval, which is the one thing this
    // may not do.
    const mark = fl.state === 'raised'
      ? MARK_GLYPH.finding
      : fl.state === 'unknown'
        ? MARK_GLYPH.undetermined
        : ' ';
    L.push(`  ${mark} ${esc(fl.label)}: ${esc(fl.detail)}`);
    // Under the finding, never instead of it. A declaration is a claim about
    // the launch; the line above it is what the launch did.
    if (fl.declared) L.push(`      ${esc(fl.declared)}`);
    // /full only: where a figure was read from, so it can be checked.
    if (fl.note) L.push(`      <i>${esc(fl.note)}</i>`);
  }
  // No marker either way. A green tick on "buyback enabled" renders a fact as
  // an endorsement -- it is a property of the launch, not a finding in its
  // favour, and the card does not hand out approval.
  L.push(`    ${esc(f.buyback.detail)}`);
  if (f.buyback.declared) L.push(`      ${esc(f.buyback.declared)}`);
  if (f.declaration) {
    L.push(`    <a href="${esc(f.declaration.docsUrl)}">declaration ${f.declaration.id}</a>, signed by the deployer before the launch`);
  }
  L.push('');

  const worst = f.worst
    ? `${f.worst.label.toLowerCase()}, ${f.worst.detail}`
    : 'no flags raised';
  L.push(
    `<b>Strongest signal:</b> ${esc(
      t.window
        ? strongestSignal(t, t.window, quote, k.pairDecimals, k.phaseName === 'NotGraduated')
        : 'undetermined, the opening window has not been indexed',
    )}. ` +
      `<b>Worst flag:</b> ${esc(worst)}.`,
  );
  L.push('');
  L.push(`<a href="${EXPLORER_URL}/address/${k.token}">token</a> · <a href="${EXPLORER_URL}/address/${k.curve}">curve</a> · <a href="${EXPLORER_URL}/address/${k.deployer}">deployer</a>`);
  L.push(`<i>${DISCLAIMER}</i>`);
  const notice = launchNotice(now);
  if (notice) L.push(esc(notice));
  return clampMessage(L.join('\n'));
}

/** Plain-text card, for CLI output. */
export function renderCardText(r: ScanResult, now = Date.now()): string {
  return renderCard(r, now)
    .replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Inline result metadata
// ---------------------------------------------------------------------------

/** Enough structure to build an inline result without re-scanning. */
export interface CompactMeta {
  symbol: string | null;
  traction: string;
  flagsRaised: number;
  flagsTotal: number;
  flagsUnknown: number;
  /** Compact phrasing of the highest-signal raised flag, or null if none. */
  topFlag: string | null;
  notFound: boolean;
  /** Younger than EARLY_WINDOW_SECONDS: traction is undefined, not zero. */
  early: boolean;
  ageSeconds: number;
  /** The threshold that decided `early`, carried so cache lifetimes can match it. */
  earlyThresholdSeconds: number;
  /**
   * Market cap in the QUOTE asset, as a wei string, and the block it was read
   * at. Carried so a first call can be recorded against what the token was
   * worth at that moment without a second read, and so the number a
   * leaderboard ranks on is the one the card showed.
   */
  mcapQuote: string;
  blockNumber: number;
}

/** The N highest-severity raised flags. Undetermined flags are excluded. */
export function topRaisedFlags(r: ScanResult, n: number) {
  return r.flags.flags
    .filter((fl) => fl.state === 'raised')
    .sort((a, b) => b.severity - a.severity)
    .slice(0, n);
}

export function compactMeta(r: ScanResult): CompactMeta {
  const top = topRaisedFlags(r, 1)[0] ?? null;
  return {
    mcapQuote: String(r.reads.mcapInQuote ?? 0n),
    blockNumber: r.currentBlock,
    symbol: r.reads.symbol ? clamp(r.reads.symbol, MAX_TICKER) : null,
    // 'early' rather than the computed label: reporting 'none' for a token
    // nobody has had time to buy is the false negative this mode removes.
    traction: r.isEarly ? 'early' : r.traction.label,
    flagsRaised: r.flags.raised,
    flagsTotal: r.flags.total,
    flagsUnknown: r.flags.unknown,
    // plain wording, as on the card this previews
    topFlag: top ? top.plain : null,
    notFound: false,
    early: r.isEarly,
    ageSeconds: Math.max(0, Math.floor(r.ageSeconds)),
    earlyThresholdSeconds: r.earlyThresholdSeconds,
  };
}

/**
 * One-line summary for an inline result's description field.
 *
 * The same language as the card it previews: what was raised, or how much was
 * checked. No traction verdict -- a subtitle reading "traction none" would put
 * back the judgement the card deliberately stopped making.
 */
export function inlineDescription(m: CompactMeta): string {
  if (m.notFound) return 'not a pons v2 launch on this chain';
  // Same shape as the card in the space of one line: the worst concern first,
  // in its own words, and the rest as a count behind it. Leading with "3
  // concerns" put a number where the finding should be, and a number is the
  // part a reader can least act on.
  const others = m.flagsRaised - 1;
  const s = m.flagsRaised > 0
    ? [
        ...(m.topFlag ? [m.topFlag] : [`${m.flagsRaised} concern${m.flagsRaised === 1 ? '' : 's'}`]),
        ...(m.topFlag && others > 0 ? [`+${others} more`] : []),
        ...(m.flagsUnknown ? [`${m.flagsUnknown} undetermined`] : []),
      ].join(' \u00b7 ')
    : [
        `no concerns raised \u00b7 ${m.flagsTotal - m.flagsUnknown} of ${m.flagsTotal} checked`,
        ...(m.flagsUnknown ? [`${m.flagsUnknown} undetermined`] : []),
      ].join(' \u00b7 ');
  // Telegram truncates long descriptions; keep it inside a sane width.
  return s.length > 120 ? `${s.slice(0, 117)}\u2026` : s;
}

/** The one sentence used for an unknown token, on every surface. */
export const NOT_A_PONS_LAUNCH =
  'not a pons v2 launch. this bot only covers pons v2 on Robinhood Chain.';

// ---------------------------------------------------------------------------
// Default card - what every surface shows unless /full is asked for
// ---------------------------------------------------------------------------

/**
 * Plain text, deliberately.
 *
 * The card is the unit of distribution: someone reads it and forwards it into a
 * group. It is sent with no parse_mode, so there are no tags to strip and no
 * entities to leak -- a copy-paste of what is on screen is exactly what was
 * rendered. That also removes the injection surface entirely, because there is
 * no markup for an attacker-controlled ticker to break out of.
 */
const PLAIN_FOOTER = 'not financial advice';

/** The project's group. Telegram autolinks a bare @handle, so no parse_mode. */
export const GROUP_HANDLE = 'vitals_official';

/**
 * The footer, built once for every surface that has one.
 *
 * Plain text on purpose: Telegram turns a bare @handle into a link by itself,
 * so the card needs no parse_mode and survives copy-paste exactly as rendered.
 * That also keeps the injection surface at zero, which is why the ticker is
 * escaped rather than the card being marked up.
 */
export function footerLine(botUsername?: string): string {
  const bot = botUsername ? `@${plainField(botUsername, 40)} \u00b7 ` : '';
  return `${bot}@${GROUP_HANDLE} \u00b7 ${PLAIN_FOOTER}`;
}

/**
 * The same footer for the image.
 *
 * A picture cannot be clicked, so a bare @handle in it is a dead end -- it
 * renders the address someone can actually type instead.
 */
export function imageFooterLine(botUsername?: string): string {
  const bot = botUsername ? `@${plainField(botUsername, 40)} \u00b7 ` : '';
  return `${bot}t.me/${GROUP_HANDLE} \u00b7 ${PLAIN_FOOTER}`;
}

/**
 * Strip anything that could break the layout out of attacker-controlled text.
 * A newline inside a token symbol would add lines to a card specified to stay
 * under twelve.
 */
/**
 * A finding, as the card prints it. The one field on a card that never cuts.
 *
 * It used to go through plainField at 70 characters, which is a hard truncation
 * of the sentence the whole product is for. Live, in a group:
 *
 *   🚩 2 wallets tax-free at launch, 1 of them the deployer, together 2.8% o…
 *
 * The share is the size of the claim, and it was the part that got cut. 70 was
 * doing no work either: this card is plain text in a Telegram message, and the
 * client soft-wraps at whatever width the reader's screen actually is. Hard
 * wrapping it here would be worse than both, because a break chosen at 70 is
 * wrong on a desktop and breaks twice on a phone.
 *
 * So the bound goes up to somewhere no real sentence reaches, and it becomes a
 * word-boundary clamp rather than a mid-word one: if a generator ever does emit
 * something pathological the card says a cut happened at a word rather than
 * stopping in the middle of "of". The whole message is still bounded by
 * clampMessage, which drops whole lines and keeps the disclaimer.
 */
export const CONCERN_MAX = 300;

function concernField(s: string): string {
  return clampWords(String(s).replace(STRIP_RE, ' ').replace(/[<>]/g, ''), CONCERN_MAX);
}

function plainField(s: string, max: number): string {
  // Angle brackets go too. Nothing here is parsed as markup, so they are not a
  // security problem -- but a ticker literally called "<b>" would render as what
  // looks like a tag in a card people forward, and the card should not appear to
  // contain formatting it does not have.
  return clamp(String(s).replace(STRIP_RE, ' ').replace(/[<>]/g, ''), max);
}
const STRIP_RE = /[\u0000-\u001F\u007F]/g;

/**
 * Progress, trimmed. Zero keeps both decimals so it reads as a measurement
 * rather than a rounding, while 12.40 reads better as 12.4.
 */
function formatProgress(pct: number): string {
  if (!Number.isFinite(pct)) return '0.00';
  if (pct === 0) return '0.00';
  return pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Market cap for the header, in the asset the launch is actually priced in.
 *
 * Read from the curve's own state, so it is verifiable like everything else
 * here -- and therefore denominated in the pair asset, because that is what the
 * curve holds. On this chain 70% of launches are paired against native ETH and
 * the rest against tokenised equities (SPCX, DJT, TTWO, RDDT, NVDA); there is
 * no stablecoin pair, so no launch has a dollar figure to read. Printing one
 * would mean a price feed, which is both a third-party dependency and price
 * data -- two things this bot does not carry.
 *
 * Returns null rather than a zero. A graduated token's curve reports 0 because
 * it no longer holds the supply, and "0 mc" in a header would be read as a
 * worthless token rather than a finished one.
 */
export function headerMcap(r: ScanResult): string | null {
  return mcapLabel(r);
}

/**
 * The market cap, the reason there isn't one, or nothing. Never a zero.
 *
 * One function, used by the text card, the group card and the picture, because
 * three renderers each deciding when a market cap is real is three chances for
 * one of them to print a zero. That is exactly what happened: two guarded on
 * the figure being positive and the group card did not, so a graduated launch
 * went out as "0 ETH mc" while other tools priced it in the tens of millions.
 *
 * Three answers, because there are three situations:
 *
 *   a figure    the curve priced it, or the pool did after it graduated.
 *   undetermined  it graduated and the pool could not be read. Said out loud,
 *                 because a graduated launch with no market cap looks like an
 *                 oversight and this is a statement about our reach.
 *   nothing     anything else, which is a read that gave no price on a launch
 *                 still on its curve. Omitted, as it always has been.
 */
export function mcapLabel(r: ScanResult): string | null {
  const v = r.reads.mcapInQuote;
  if (r.reads.mcapSource === null) return 'mc undetermined after graduation';
  if (!Number.isFinite(v) || v <= 0) return null;
  const unit = clamp(r.reads.pairSymbol ?? 'ETH', MAX_TICKER);
  return `${compactAmount(v)} ${unit} mc`;
}

/** 0.42, 1.7, 12, 340, 5.2K, 1.1M: two significant figures of scale, no more. */
export function compactAmount(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${trimZeros((v / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${trimZeros((v / 1_000).toFixed(1))}K`;
  if (abs >= 100) return String(Math.round(v));
  if (abs >= 10) return trimZeros(v.toFixed(1));
  if (abs >= 1) return trimZeros(v.toFixed(2));
  return trimZeros(v.toFixed(3));
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * The receipt line: what this token was worth the first time anyone looked.
 *
 * Absent on a first scan -- there is nothing to report, and a badge for being
 * first would be the kind of framing this card does not do.
 */
export function firstScanLine(r: ScanResult): string | null {
  const f = r.firstScan;
  if (!f) return null;
  const unit = clamp(r.reads.pairSymbol ?? 'ETH', MAX_TICKER);
  const since = f.since > 0 ? ` \u00b7 ${f.since.toLocaleString()} scan${f.since === 1 ? '' : 's'} since` : '';
  return `first scanned here at ${compactAmount(f.mcap)} ${unit}${since}`;
}

/** Compact age for the header: 47s, 2m, 3h, 5d. */
export function headerAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 172800) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** How many raised flags the default card shows before summarising the rest. */
export const MAX_DEFAULT_FLAGS = 3;

export function defaultTicker(r: ScanResult): string {
  const s = r.reads.symbol?.trim();
  if (s) return `$${plainField(s, MAX_TICKER).toUpperCase()}`;
  return `${r.reads.token.slice(0, 6)}\u2026${r.reads.token.slice(-4)}`;
}

/**
 * The one-line summary of what was measured.
 *
 * Counts only - no traction verdict. The label was what made a seconds-old
 * launch read as a judgement ("TRACTION none") when it was really an absence of
 * data; raw counts carry the same information without pretending to a
 * conclusion.
 */
/**
 * How to say "nobody bought" without implying the window is over.
 *
 * A token twelve minutes old genuinely has not had its thirty minutes yet, so
 * "yet" is the true word. A twenty-three-day-old launch has had them, and "yet"
 * quietly reads as "still early" on a token whose story finished weeks ago.
 */
function noBuyersPhrase(t: TractionMetrics): string {
  return t.windowTruncated
    ? 'no buyers yet'
    : `no buyers in the first ${Math.round(t.windowMinutes)} min`;
}

export function activityLine(r: ScanResult): string {
  const w = r.traction.window;
  const progress = `${formatProgress(r.reads.progressPct)}%`;
  // Progress comes off the curve's own reserve, so it stands whether or not the
  // window was read. The buyer count does not.
  if (!w) return `buyers undetermined \u00b7 ${progress}`;
  const buyers = w.uniqueBuyers30m;
  if (buyers === 0) return `${noBuyersPhrase(r.traction)} \u00b7 ${progress}`;

  const sold =
    w.roundTrippers >= buyers
      ? buyers === 2
        ? 'both already sold'
        : 'all already sold'
      : `${w.roundTrippers} sold`;
  return `${buyers} buyer${buyers === 1 ? '' : 's'} \u00b7 ${sold} \u00b7 ${progress}`;
}

/**
 * The buyer count with something to measure it against.
 *
 * "5 buyers" is not actionable: a reader cannot tell whether that is a fast
 * start or a launch that is already over. The reference point is the median for
 * launches given the same amount of time, and it is stated as a comparison and
 * nothing more. No word here may read as a verdict -- not "above average", not
 * "strong", not "healthy". The two numbers sit side by side and the reader
 * decides what they mean.
 *
 * Below the sample floor the count prints alone. A median of four launches
 * would be an anecdote presented as a reference, which is worse than no
 * reference at all.
 */
/** A window as a reader would say it: "40s", "3 min", "30 min" -- never "0 min". */
export function windowLabel(minutes: number): string {
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))}s`;
  return `${Math.round(minutes)} min`;
}

export function buyerLine(r: ScanResult): string {
  const w = r.traction.window;
  // The one line that says why every other window figure is missing. Without a
  // count there is nothing for the benchmark to compare against either, so the
  // reference point goes with it rather than sitting beside a blank.
  const win = windowLabel(r.traction.windowMinutes);
  if (!w) return `buyers undetermined, first ${win} not indexed`;
  const buyers = w.uniqueBuyers30m;
  // The count carries its own window. "13 buyers" is not a fact anyone can use
  // without knowing 13 buyers IN WHAT.
  const head =
    buyers === 0 ? noBuyersPhrase(r.traction) : `${buyers} buyer${buyers === 1 ? '' : 's'} in first ${win}`;
  const b = r.benchmark;
  // Below the ladder's first rung there is no comparison yet, and the line
  // says from when there will be rather than printing an n of zero that reads
  // as an empty index.
  if (b.windowMinutes === 0) return `${head} \u00b7 index median from ${windowLabel(BENCHMARK_LADDER_MINUTES[0]!)}`;
  // Below the floor there is no median, and saying so beats printing the count
  // alone -- a reader cannot tell a missing reference point from an absent one.
  if (b.median === null) return `${head} \u00b7 no index median (n=${b.n})`;
  // The benchmark window is a rung of the ladder and the token's own window is
  // its exact age, so the two can differ by up to one rung. When they label
  // the same the head has named the window once; when they do not, the median
  // names its own, because "at this age" over a window the head did not state
  // would describe a comparison the reader cannot see. And "at this age" only
  // ever inside the 30-minute cap: past it the count is a measurement of the
  // first 30 minutes whatever the age.
  const sameLabel = windowLabel(b.windowMinutes) === windowLabel(r.traction.windowMinutes);
  const ref = !sameLabel
    ? ` over first ${windowLabel(b.windowMinutes)}`
    : b.measuredAtAge
      ? ' at this age'
      : '';
  // The sample size travels with the median. Without n it is a number the
  // reader has no way to weigh.
  return `${head} \u00b7 index median ${b.median}${ref} (n=${b.n.toLocaleString()})`;
}

/**
 * Top-five holder share, stated only when it is a measurement.
 *
 * With five holders or fewer the top five hold 100% by arithmetic, so the line
 * is absent rather than reporting a ratio that cannot distinguish anything. Its
 * absence is not an all-clear: the check still appears in the flag block as
 * undetermined, and /full says why.
 */
/**
 * What happened to the buyers, and how far the launch has come.
 *
 * The buyer count itself has moved up into its own benchmarked line, so this
 * carries only what is left: how many of them are already out, and progress
 * toward graduation. `activityLine` keeps the older combined phrasing for the
 * image, which renders one line rather than three.
 */
/**
 * How far the curve is from graduating, in the asset it is measured in.
 *
 * The absolute rather than the percentage: "0.19 of 4.2 ETH" says the same
 * thing as "4.4%" and also says what the finish line is, which the percentage
 * does not.
 *
 * Deliberately NOT the market cap. The threshold gates the curve's quote
 * RESERVE, and the two are far apart -- $CHIPPER carries a 1.68 ETH market cap
 * against a 0.0000 ETH reserve, so pairing the cap with the threshold would
 * have read "1.7 of 4.2" for a token that is 0.000% of the way there. Same
 * units, different quantities.
 */
export function graduationProgress(r: ScanResult): string | null {
  const dec = r.reads.pairDecimals ?? 18;
  const unit = clamp(r.reads.pairSymbol ?? 'ETH', MAX_TICKER);
  const threshold = Number(r.reads.graduationThreshold ?? 0n) / 10 ** dec;
  const reserve = Number(r.reads.realQuoteReserve ?? 0n) / 10 ** dec;
  // A graduated curve has handed its reserve to the pool; "0 of 4.2" would read
  // as a launch that never got anywhere rather than one that finished.
  if (r.reads.phaseName && r.reads.phaseName !== 'NotGraduated') return 'graduated';
  // No threshold means no distance to state. The percentage this used to fall
  // back to was derived from the same missing number, so it was always a
  // confident "0% to graduation" about a curve nothing had been read from.
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  return `${compactAmount(reserve)} of ${compactAmount(threshold)} ${unit} to graduation`;
}

export function sellingLine(r: ScanResult): string {
  const w = r.traction.window;
  const progress = graduationProgress(r);
  // With no window there is nothing to say about selling. The graduation
  // distance is a curve read and survives on its own; buyerLine has already
  // said why the rest is missing, so this does not repeat it.
  if (!w) return progress ?? '';
  const buyers = w.uniqueBuyers30m;
  if (buyers === 0) return progress ?? '';
  // "1 of 13 sold" never said what the 13 was, and the 13 is the opening
  // window's buyers -- the same population the exemption flag cares about.
  // Named here; earlySellLine says "has since sold" for the whole-life count,
  // so the two lines cannot be mistaken for each other.
  const win = windowLabel(r.traction.windowMinutes);
  const sold =
    w.roundTrippers === 0
      ? `none of ${buyers} sold in first ${win}`
      : w.roundTrippers >= buyers
        ? `all ${buyers} sold within first ${win}`
        : `${w.roundTrippers} of ${buyers} sold in first ${win}`;
  return progress ? `${sold} \u00b7 ${progress}` : sold;
}

/**
 * What became of the wallets that got in first.
 *
 * "1 of 13 early buyers sold" -- the opening window's population, and how many
 * of them have sold at any point since. The ratio and nothing else: no label,
 * no threshold, no word for whether one in thirteen is a lot. A reader who
 * knows the token decides that.
 *
 * Absent when the window holds no buyers, because a ratio out of nothing is
 * not a measurement.
 */
export function earlySellLine(r: ScanResult): string | null {
  // Absent, not "undetermined", when it cannot be measured: buyerLine states
  // the unread-window case once for the whole group, and four lines each saying
  // the same thing about the same unread window is noise rather than honesty.
  const e = r.earlySells;
  if (!e || !e.cohort) return null;
  // "early buyers" named no window. This is the opening window's buyers, and
  // "has since sold" is whole-life -- the distinction from sellingLine, which
  // counts only selling inside the window.
  const win = windowLabel(r.traction.windowMinutes);
  return `${e.sold} of ${count(e.cohort, 'buyer')} from first ${win} ${e.sold === 1 ? 'has' : 'have'} since sold`;
}

export function concentrationLine(r: ScanResult): string | null {
  const c = r.flags.concentration;
  if (!c || c.holders < MIN_HOLDERS_FOR_SHARE) return null;
  // When it is a concern the flag block above already states it, and printing it
  // again here put the same fact on the card twice with two different roundings
  // -- "top 5 wallets hold 44.2% of supply" over "top 5 wallets hold 44%".
  const raised = r.flags.flags.some((f) => f.key === 'holder_concentration' && f.state === 'raised');
  if (raised) return null;
  // The aggregate hides the shape: one wallet at 17% and five at 4% both read
  // as "top 5 hold 21%", and they are not the same situation. The largest
  // single share is stated beside it; the full breakdown stays in /full.
  const largest = c.top1Share > 0 ? `, largest ${c.top1Share.toFixed(0)}%` : '';
  return `top 5 hold ${c.top5Share.toFixed(0)}%${largest} \u00b7 ${count(c.holders, 'holder')}`;
}

/**
 * Buyer growth, only once there is a second point in time to compare against.
 *
 * Below ten minutes there is no +10min reading to grow from, so the line is
 * absent rather than showing a change that was never measured.
 */
export function growthLine(r: ScanResult): string | null {
  const t = r.traction;
  const w = t.window;
  if (!w || t.windowMinutes < 10 || w.uniqueBuyers30m === 0) return null;
  // Both ends carry the moment they were taken at. "2 -> 13 in 30 min" reads as
  // a change over 30 minutes; it is two readings, at +10 and at the window's
  // end, and the first one had its own 10 minutes behind it.
  return `buyers ${w.uniqueBuyers10m} at +10 min \u2192 ${w.uniqueBuyers30m} at +${Math.round(t.windowMinutes)} min`;
}

/**
 * The default card.
 *
 * Inverted from the original: concerns first, measurements last. A reader in the
 * first minute of a launch gets the part that is actually decidable that early
 * - what was fixed at creation - instead of scrolling past a traction block that
 * cannot say anything yet.
 *
 * It never says "clean", "safe" or "looks good". The absence of a raised flag is
 * not an all-clear: it means the checks that ran found nothing, which is why the
 * count of what ran, and of what could not be determined, is stated beside it.
 */
/**
 * One card, described once.
 *
 * The PNG has silently missed three features -- the growth line, the market
 * cap, the first-scan receipt -- because it built its own header and its own
 * list of body lines from the same ScanResult. Each time nothing failed,
 * because nothing asked: a renderer that forgets a line produces a perfectly
 * valid smaller card. Every assertion added after those was a patch on one
 * line at a time.
 *
 * So the card is a list of lines with roles, produced once. The text renderer
 * joins them; the image draws them by role. A line added here appears in both
 * or in neither, and "in neither" is a visible absence rather than a silent
 * one.
 */
export type CardRole =
  | 'header'
  | 'concern-top'
  | 'concern'
  | 'extras'
  | 'summary'
  | 'measure'
  | 'measure-dim'
  | 'spacer'
  | 'doctrine'
  | 'sponsor'
  | 'footer'
  // Last on every card, below the paid line and below the footer. About VITALS
  // rather than about the token, which is why it is never anywhere else.
  | 'launch';

/**
 * Three states, and only three. A finding, an undetermined check, or nothing.
 *
 * Carried on the line rather than baked into its text because the two renderers
 * cannot use the same representation: the bundled font subset in the PNG has no
 * glyph for U+1F6A9 or U+25CC, so the picture draws shapes. It used to strip
 * today's markers back off with a regex -- a second copy of the vocabulary, in
 * the one file whose whole purpose is not drifting from the card.
 */
export type CardMark = 'finding' | 'undetermined';

/** The glyphs the TEXT card uses. The PNG draws its own shapes for these. */
export const MARK_GLYPH: Record<CardMark, string> = {
  finding: '\u{1F6A9}',
  undetermined: '\u25cc',
};

export interface CardLine {
  text: string;
  role: CardRole;
  /** Which of the three states this line is in, if any. */
  mark?: CardMark;
  /**
   * What the image draws instead, when the two genuinely differ.
   *
   * The footer is the only case: a PNG cannot be clicked, so it carries
   * t.me/handle where the text card carries @handle. Stated here rather than
   * rebuilt in image.ts, because a second implementation of the footer is how
   * the image silently missed three features before.
   */
  imageText?: string;
}

/**
 * What each check is called when it has to be named in one or two words.
 *
 * "3 undetermined" tells a reader nothing they can act on -- not which checks,
 * not whether the ones that matter to them ran. The label is the check's own,
 * shortened only where the full one would not fit beside two others.
 */
const SHORT_CHECK: Record<string, string> = {
  collision: 'ticker index',
  deployer_rate: 'deployer history',
  deployer_peaks: 'deployer outcomes',
  deployer_survival: 'deployer survival',
  creator_tax: 'creator tax',
  snipe_exemptions: 'exempt wallets',
  holder_concentration: 'holder spread',
  buyback: 'buyback',
  pair_ticker: 'pair ticker',
  custom_pair: 'pair asset',
};

function shortCheck(key: string, label: string): string {
  return SHORT_CHECK[key] ?? label.toLowerCase();
}

/** "undetermined: a, b, c" with the same +n bound the findings use. */
export function undeterminedNames(flags: { key: string; label: string; state: string }[]): string | null {
  const names = flags.filter((f) => f.state === 'unknown').map((f) => shortCheck(f.key, f.label));
  if (!names.length) return null;
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length - 3;
  return `undetermined: ${shown}${rest > 0 ? ` +${rest}` : ''}`;
}

export function cardLines(r: ScanResult, botUsername?: string, now = Date.now()): CardLine[] {
  const f = r.flags;
  const L: CardLine[] = [];
  const push = (role: CardRole, text: string) => L.push({ role, text });

  const mc = headerMcap(r);
  push('header', `VITALS  ${defaultTicker(r)} \u00b7 ${headerAge(r.ageSeconds)}${mc ? ` \u00b7 ${mc}` : ''}`);
  push('spacer', '');

  const raised = f.flags
    .filter((fl) => fl.state === 'raised')
    .sort((a, b) => b.severity - a.severity);

  if (raised.length) {
    // The worst one, alone, with room around it. The ordering that picks it has
    // always been here; this only makes it visible. Emphasis and nothing more:
    // no new judgement, and the ones below are still there to be read.
    // One state, one marker, everywhere: a finding is a finding whether it is
    // the worst one or the third. The emphasis on the top one is its own line
    // and the room around it -- position, not a different symbol.
    L.push({
      role: 'concern-top',
      text: `${MARK_GLYPH.finding} ${concernField(raised[0]!.plain)}`,
      mark: 'finding',
    });

    const rest: CardLine[] = raised
      .slice(1, MAX_DEFAULT_FLAGS)
      .map((fl) => ({
        role: 'concern' as CardRole,
        text: `${MARK_GLYPH.finding} ${concernField(fl.plain)}`,
        mark: 'finding' as CardMark,
      }));

    // One extras line, not two: the overflow count and the undetermined checks
    // are both "what is not shown above", and the card has a ceiling.
    // Undetermined is never dropped, even when the flag slots are full -- and
    // it names the checks, because "1 undetermined" tells a reader nothing
    // about whether the check they care about ran.
    const hidden = raised.length - MAX_DEFAULT_FLAGS;
    const undet = undeterminedNames(f.flags);
    const extras: string[] = [];
    if (hidden > 0) extras.push(`+${hidden} more`);
    if (undet) extras.push(undet);
    if (extras.length) {
      rest.push({
        role: 'extras',
        // No "· /full" here: the fixed line at the bottom points at /full on
        // every card, and saying it twice costs characters on the line that is
        // already the most crowded.
        text: `${undet ? `${MARK_GLYPH.undetermined} ` : ''}${extras.join(' \u00b7 ')}`,
        ...(undet ? { mark: 'undetermined' as CardMark } : {}),
      });
    }

    // The blank belongs to the top concern, so it is only spent when something
    // follows. One concern and nothing else leaves a single break.
    if (rest.length) {
      push('spacer', '');
      L.push(...rest);
    }
  } else {
    push('summary', `no findings \u00b7 ${f.total - f.unknown} of ${count(f.total, 'check')} ran`);
    const undet = undeterminedNames(f.flags);
    if (undet) {
      L.push({ role: 'extras', text: `${MARK_GLYPH.undetermined} ${undet}`, mark: 'undetermined' });
    }
  }

  // Concerns, then the one number a reader can act on, then who holds it, then
  // the rest. The first line after the flags is the most decision-relevant fact
  // available.
  push('spacer', '');
  push('measure', buyerLine(r));
  for (const line of [
    concentrationLine(r),
    sellingLine(r),
    growthLine(r),
    earlySellLine(r),
    firstScanLine(r),
  ]) {
    if (line) push('measure-dim', line);
  }

  // Second to last, directly above the footer. The disclaimer is always the
  // last thing on the card: whatever was paid for, it does not get to be the
  // final word.
  // Fixed, on every card. It is the one thing a card cannot convey by showing
  // markers: that the checks which found nothing found nothing, and that this
  // is not the same as being told everything is fine.
  push('spacer', '');
  L.push({
    role: 'doctrine',
    text: 'no finding \u2260 clean \u00b7 /full for every metric',
    // The PNG's font subset has no U+2260, and an unrenderable glyph draws as
    // tofu -- the picture says it in words instead.
    imageText: 'no finding does not mean clean \u00b7 /full for every metric',
  });

  // No blank here: the doctrine line, the paid line and the disclaimer are one
  // block at the bottom of the card, with the single break above all three.
  // Every extra blank is a line, and the card has a ceiling.
  const ad = sponsorLine();
  if (ad) push('sponsor', ad);
  L.push({
    role: 'footer',
    text: footerLine(botUsername),
    imageText: imageFooterLine(botUsername),
  });
  // After the footer, and only ever here. It is the one line on a card that is
  // about this tool instead of about the launch being scanned, so a reader who
  // stops at the disclaimer has read the whole card.
  const notice = launchNotice(now);
  if (notice) push('launch', notice);
  return L;
}

export function renderDefaultCard(r: ScanResult, botUsername?: string, now = Date.now()): string {
  return cardLines(r, botUsername, now).map((l) => l.text).join('\n');
}

/** Default card for an address the factory has no record of. */
export function renderDefaultNotFound(token: string, botUsername?: string): string {
  return [
    `VITALS  ${token.slice(0, 6)}\u2026${token.slice(-4)}`,
    '',
    ...notALaunchLines(token),
    '',
    footerLine(botUsername),
  ].join('\n');
}

/**
 * What to say about an address that is not a launch.
 *
 * "Not a pons v2 launch" was true of the address a tester reported and told
 * them nothing they could act on. That address is a DEPLOYER: not a token
 * (name, symbol and totalSupply all revert), not a curve (every getter
 * reverts), and denied by the factory -- but squarely inside pons, answering
 * factory() with our factory and appearing in a TokenLaunched log.
 *
 * So when the index recognises the address as a deployer, the reply names it
 * and points at its most recent launch. It still does not claim the pasted
 * address is a launch, because it is not one.
 */
export function notALaunchLines(token: string): string[] {
  const d = deployerSummary(token);
  if (!d) return [NOT_A_PONS_LAUNCH];
  const ticker = d.latestSymbol ? `$${plainField(d.latestSymbol, MAX_TICKER).toUpperCase()}` : 'its latest launch';
  return [
    `that is a deployer, not a token. ${count(d.launches, 'launch', 'launches')} in the index`,
    '',
    `most recent: ${ticker}`,
    d.latestToken,
  ];
}
