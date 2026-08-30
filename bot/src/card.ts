import type { ScanResult } from './scan.js';
import type { TractionMetrics } from './metrics/traction.js';
import type { FlagResult } from './metrics/flags.js';
import { DISCLAIMER, EXPLORER_URL } from './config.js';
import { clamp, clampMessage, MAX_NAME, MAX_TICKER, TELEGRAM_MAX_MESSAGE } from './text.js';
import { EARLY_WINDOW_SECONDS } from './config.js';
import { MIN_HOLDERS_FOR_SHARE } from './metrics/concentration.js';
import { MIN_BENCHMARK_SAMPLES } from './metrics/benchmark.js';

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

function age(seconds: number): string {
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
 */
function strongestSignal(t: TractionMetrics, quote: string, quoteDecimals: number): string {
  const cands: { weight: number; text: string }[] = [];

  if (t.uniqueBuyers30m > 0)
    cands.push({
      weight: t.uniqueBuyers30m,
      text: `${t.uniqueBuyers30m} unique buyer${t.uniqueBuyers30m === 1 ? '' : 's'} in the first ${num(t.windowMinutes, 0)} min`,
    });
  if (t.buyerGrowthRatio !== null && t.buyerGrowthRatio > 1)
    cands.push({
      weight: t.buyerGrowthRatio * 12,
      text: `buyer count grew ${ratioStr(t.buyerGrowthRatio)}x between +10 min and +${num(t.windowMinutes, 0)} min`,
    });
  if (t.buySellRatio !== null && t.buySellRatio > 1)
    cands.push({ weight: t.buySellRatio * 8, text: `buys outnumber sells ${ratioStr(t.buySellRatio)} to 1` });
  if (t.progressAt30m > 0)
    cands.push({ weight: t.progressAt30m * 2.5, text: `curve at ${num(t.progressAt30m, 2)}% of graduation` });
  if (t.progressVelocityPer10m > 0)
    cands.push({
      weight: t.progressVelocityPer10m * 2,
      text: `progress accruing at ${num(t.progressVelocityPer10m, 2)}% per 10 min`,
    });
  if (t.medianBuySize > 0n && t.uniqueBuyers30m >= 5)
    cands.push({
      weight: t.uniqueBuyers30m * 0.8,
      text: `median buy ${fmtUnits(t.medianBuySize, quoteDecimals)} ${quote} across ${t.buyTxCount} buys`,
    });

  if (!cands.length) return 'no buying activity recorded in the measured window';
  return cands.sort((a, b) => b.weight - a.weight)[0]!.text;
}


// ---------------------------------------------------------------------------
// Early mode — under EARLY_WINDOW_SECONDS old
// ---------------------------------------------------------------------------

/** Exact seconds, because at this age "1m" would throw away the useful part. */
function earlySeconds(r: ScanResult): string {
  return `${Math.max(0, Math.floor(r.ageSeconds))}s`;
}

export const EARLY_TRACTION_LINE =
  'traction unavailable — the snipe tax window is still open. re-scan in 2 minutes.';

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
function renderEarlyCard(r: ScanResult): string {
  const { reads: k, flags: f } = r;
  const quote = clamp(k.pairSymbol ?? 'quote', MAX_TICKER);
  const sym = k.symbol ? esc(clamp(k.symbol, MAX_TICKER)) : '?';
  const name = k.name ? esc(clamp(k.name, MAX_NAME)) : 'unknown';

  const L: string[] = [];
  L.push(`<b>${sym}</b> — ${name}`);
  L.push(`<code>${k.token}</code>`);
  L.push(`<b>launched ${earlySeconds(r)} ago — too early for traction</b>`);
  L.push(`phase ${esc(k.phaseName)} · pair ${esc(quote)}`);
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
      ? '  ❔ snipe-tax exemptions: creation transaction not decoded — not confirmed clean'
      : n > 0
        ? `  🚩 snipe-tax exemptions: ${n} wallet${n === 1 ? '' : 's'} pre-exempted from the opening tax`
        : '  · snipe-tax exemptions: none — no wallets pre-exempted at creation',
  );
  // launchBuyAmount is null both when there was genuinely no buy and when the
  // creation transaction could not be decoded at all. Those must not render
  // alike: claiming "none" about a transaction we just said we could not read
  // is precisely the undetermined-as-clean error the card exists to avoid.
  L.push(
    hasCreatorLaunchBuy(r)
      ? `  🚩 creator opening buy: ${fmtUnits(r.creation.launchBuyAmount!, k.pairDecimals)} ${esc(quote)} bought in the launch transaction`
      : creationUndecoded(r)
        ? '  ❔ creator opening buy: unknown — the creation transaction could not be decoded'
        : '  · creator opening buy: none in the launch transaction',
  );
  L.push('');

  L.push(`<b>FLAGS  ${f.raised} of ${f.total}</b>${f.unknown ? ` · ${f.unknown} undetermined` : ''}`);
  for (const fl of f.flags) {
    if (fl.key === 'snipe_exemptions') continue; // already stated above
    const mark = fl.state === 'raised' ? '🚩' : fl.state === 'unknown' ? '❔' : '·';
    L.push(`  ${mark} ${esc(fl.label)}: ${esc(fl.detail)}`);
  }
  L.push(`  ${f.buyback.enabled ? '✅' : '·'} ${esc(f.buyback.detail)}`);
  L.push('');

  // Worst flag only. The spec replaces the traction block with a single line and
  // it is already above; a second traction statement here just restates it.
  const worst = f.worst ? `${f.worst.label.toLowerCase()} — ${f.worst.detail}` : 'no flags raised';
  L.push(`<b>Worst flag:</b> ${esc(worst)}.`);
  L.push('');
  L.push(`<a href="${EXPLORER_URL}/address/${k.token}">token</a> · <a href="${EXPLORER_URL}/address/${k.curve}">curve</a> · <a href="${EXPLORER_URL}/address/${k.deployer}">deployer</a>`);
  L.push(`<i>${DISCLAIMER}</i>`);
  return clampMessage(L.join('\n'));
}

export function renderCard(r: ScanResult): string {
  if (r.isEarly) return renderEarlyCard(r);

  const { reads: k, traction: t, flags: f } = r;
  const quote = clamp(k.pairSymbol ?? 'quote', MAX_TICKER);
  const sym = k.symbol ? esc(clamp(k.symbol, MAX_TICKER)) : '?';
  const name = k.name ? esc(clamp(k.name, MAX_NAME)) : 'unknown';

  const L: string[] = [];
  L.push(`<b>${sym}</b> — ${name}`);
  L.push(`<code>${k.token}</code>`);
  L.push(`launched ${age(r.ageSeconds)} ago · phase ${esc(k.phaseName)} · pair ${esc(quote)}`);
  L.push('');

  const windowNote = t.windowTruncated
    ? ` (token is ${age(r.ageSeconds)} old — window truncated to ${num(t.windowMinutes, 0)} min)`
    : '';
  L.push(`<b>TRACTION  ${t.label}</b>${windowNote}`);
  L.push(`  unique buyers, first ${num(t.windowMinutes, 0)} min: <b>${t.uniqueBuyers30m}</b>`);
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
      : `  buyer benchmark: ${b.median} — median over the same first ${windowLabel(b.windowMinutes)}, across ${b.n.toLocaleString()} indexed launches that reached it`,
  );
  L.push(`  age band: ${esc(b.bucket.label)}${b.measuredAtAge ? '' : ` (buyers counted over the first ${windowLabel(b.windowMinutes)}, not the full age)`}`);
  L.push(`  buyer growth: ${t.uniqueBuyers10m} at +10 min → ${t.uniqueBuyers30m} at +${num(t.windowMinutes, 0)} min${t.buyerGrowthRatio !== null ? ` (${ratioStr(t.buyerGrowthRatio)}x)` : ''}`);
  L.push(`  buy/sell tx: ${t.buyTxCount}/${t.sellTxCount}${t.buySellRatio !== null ? ` (${ratioStr(t.buySellRatio)}:1)` : t.buyTxCount ? ' (no sells)' : ''}`);
  L.push(`  median buy: ${fmtUnits(t.medianBuySize, k.pairDecimals)} ${esc(quote)}`);
  L.push(`  graduation progress: ${num(k.progressPct, 3)}%`);
  L.push(`  progress velocity: ${num(t.progressVelocityPer10m, 3)}% per 10 min`);
  if (t.peakProgressPct > k.progressPct + 0.01)
    L.push(`  peak progress in window: ${num(t.peakProgressPct, 3)}% (since retraced)`);
  if (t.roundTrippers > 0)
    L.push(`  round-trippers: ${t.roundTrippers} of ${t.uniqueBuyers30m} buyers also sold`);
  if (t.forwarderBuys > 0)
    L.push(`  creator opening buy present in the launch transaction`);
  L.push('');

  L.push(`<b>FLAGS  ${f.raised} of ${f.total}</b>${f.unknown ? ` · ${f.unknown} undetermined` : ''}`);
  for (const fl of f.flags) {
    const mark = fl.state === 'raised' ? '🚩' : fl.state === 'unknown' ? '❔' : '·';
    L.push(`  ${mark} ${esc(fl.label)}: ${esc(fl.detail)}`);
  }
  L.push(`  ${f.buyback.enabled ? '✅' : '·'} ${esc(f.buyback.detail)}`);
  L.push('');

  const worst = f.worst
    ? `${f.worst.label.toLowerCase()} — ${f.worst.detail}`
    : 'no flags raised';
  L.push(
    `<b>Strongest signal:</b> ${esc(strongestSignal(t, quote, k.pairDecimals))}. ` +
      `<b>Worst flag:</b> ${esc(worst)}.`,
  );
  L.push('');
  L.push(`<a href="${EXPLORER_URL}/address/${k.token}">token</a> · <a href="${EXPLORER_URL}/address/${k.curve}">curve</a> · <a href="${EXPLORER_URL}/address/${k.deployer}">deployer</a>`);
  L.push(`<i>${DISCLAIMER}</i>`);
  return clampMessage(L.join('\n'));
}

/** Plain-text card, for CLI output. */
export function renderCardText(r: ScanResult): string {
  return renderCard(r)
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

/**
 * Strip anything that could break the layout out of attacker-controlled text.
 * A newline inside a token symbol would add lines to a card specified to stay
 * under twelve.
 */
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
  const v = r.reads.mcapInQuote;
  if (!Number.isFinite(v) || v <= 0) return null;
  const unit = clamp(r.reads.pairSymbol ?? 'ETH', MAX_TICKER);
  return `${compactAmount(v)} ${unit} mc`;
}

/** 0.42, 1.7, 12, 340, 5.2K, 1.1M — two significant figures of scale, no more. */
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
export function activityLine(r: ScanResult): string {
  const t = r.traction;
  const buyers = t.uniqueBuyers30m;
  const progress = `${formatProgress(r.reads.progressPct)}%`;
  if (buyers === 0) return `no buyers yet \u00b7 ${progress}`;

  const sold =
    t.roundTrippers >= buyers
      ? buyers === 2
        ? 'both already sold'
        : 'all already sold'
      : `${t.roundTrippers} sold`;
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
function windowLabel(minutes: number): string {
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))}s`;
  return `${Math.round(minutes)} min`;
}

export function buyerLine(r: ScanResult): string {
  const buyers = r.traction.uniqueBuyers30m;
  const head = buyers === 0 ? 'no buyers yet' : `${buyers} buyer${buyers === 1 ? '' : 's'}`;
  const b = r.benchmark;
  if (b.median === null) return head;
  // "at this age" is only true while the window IS the token's life. Past the
  // 30-minute cap the count -- and so the median beside it -- is a measurement
  // of the first 30 minutes, and saying "at this age" would describe a
  // comparison that was never made.
  const ref = b.measuredAtAge
    ? 'median at this age'
    : `median in the first ${windowLabel(b.windowMinutes)}`;
  return `${head} \u2014 ${ref} is ${b.median}`;
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
  const t = r.traction;
  const buyers = t.uniqueBuyers30m;
  const progress = graduationProgress(r);
  if (buyers === 0) return progress ?? 'no buyers and no reserve read yet';
  const sold =
    t.roundTrippers === 0
      ? 'none sold yet'
      : t.roundTrippers >= buyers
        ? buyers === 2
          ? 'both already sold'
          : 'all already sold'
        : `${t.roundTrippers} of ${buyers} sold`;
  return progress ? `${sold} \u00b7 ${progress}` : sold;
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
  const largest = c.top1Share > 0 ? ` \u2014 largest ${c.top1Share.toFixed(0)}%` : '';
  return `top 5 hold ${c.top5Share.toFixed(0)}%${largest} \u00b7 ${c.holders} holders`;
}

/**
 * Buyer growth, only once there is a second point in time to compare against.
 *
 * Below ten minutes there is no +10min reading to grow from, so the line is
 * absent rather than showing a change that was never measured.
 */
export function growthLine(r: ScanResult): string | null {
  const t = r.traction;
  if (t.windowMinutes < 10 || t.uniqueBuyers30m === 0) return null;
  return `buyers ${t.uniqueBuyers10m} \u2192 ${t.uniqueBuyers30m} in ${Math.round(t.windowMinutes)} min`;
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
export function renderDefaultCard(r: ScanResult, botUsername?: string): string {
  const f = r.flags;
  const L: string[] = [];

  const mc = headerMcap(r);
  L.push(`VITALS  ${defaultTicker(r)} \u00b7 ${headerAge(r.ageSeconds)}${mc ? ` \u00b7 ${mc}` : ''}`);
  L.push('');

  const raised = f.flags
    .filter((fl) => fl.state === 'raised')
    .sort((a, b) => b.severity - a.severity);

  if (raised.length) {
    // The worst one, alone, with room around it.
    //
    // Every concern used to render at the same weight behind the same marker,
    // so three of them competed and none of them landed -- two testers
    // independently said the worst one did not stand out. The ordering that
    // picks it has always been here; this only makes it visible. It is
    // emphasis and nothing more: no new judgement, no second opinion, and the
    // ones below are still there to be read.
    L.push(`\u26a0\ufe0f ${plainField(raised[0]!.plain, 70)}`);

    const rest: string[] = raised
      .slice(1, MAX_DEFAULT_FLAGS)
      .map((fl) => `\u00b7 ${plainField(fl.plain, 70)}`);

    const hidden = raised.length - MAX_DEFAULT_FLAGS;
    const extras: string[] = [];
    if (hidden > 0) extras.push(`+${hidden} more`);
    // Undetermined is never dropped, even when the flag slots are full.
    if (f.unknown > 0) extras.push(`${f.unknown} undetermined`);
    if (extras.length) rest.push(`${extras.join(' \u00b7 ')} \u00b7 /full`);

    // The blank line belongs to the top concern, so it is only spent when
    // something follows. One concern and nothing else leaves a single break
    // before the measurements rather than two.
    if (rest.length) L.push('', ...rest);
  } else {
    const parts = [`no concerns raised \u00b7 ${f.total - f.unknown} of ${f.total} checked`];
    if (f.unknown > 0) parts.push(`${f.unknown} undetermined`);
    L.push(parts.join(' \u00b7 '));
  }

  // Concerns, then the one number a reader can act on, then who holds it, then
  // the rest. The first line after the flags is the most decision-relevant fact
  // available: a buyer count that finally means something next to its peers.
  L.push('');
  L.push(buyerLine(r));
  const conc = concentrationLine(r);
  if (conc) L.push(conc);
  L.push(sellingLine(r));
  const growth = growthLine(r);
  if (growth) L.push(growth);
  const first = firstScanLine(r);
  if (first) L.push(first);

  L.push('');
  L.push(botUsername ? `@${plainField(botUsername, 40)} \u00b7 ${PLAIN_FOOTER}` : PLAIN_FOOTER);
  return L.join('\n');
}

/** Default card for an address the factory has no record of. */
export function renderDefaultNotFound(token: string, botUsername?: string): string {
  return [
    `VITALS  ${token.slice(0, 6)}\u2026${token.slice(-4)}`,
    '',
    NOT_A_PONS_LAUNCH,
    '',
    botUsername ? `@${plainField(botUsername, 40)} \u00b7 ${PLAIN_FOOTER}` : PLAIN_FOOTER,
  ].join('\n');
}
