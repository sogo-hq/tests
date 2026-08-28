import type { ScanResult } from './scan.js';
import type { TractionMetrics } from './metrics/traction.js';
import type { FlagResult } from './metrics/flags.js';
import { DISCLAIMER, EXPLORER_URL } from './config.js';
import { clamp, clampMessage, MAX_NAME, MAX_TICKER, TELEGRAM_MAX_MESSAGE } from './text.js';
import { EARLY_WINDOW_SECONDS } from './config.js';

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
  const s = m.flagsRaised > 0
    ? [
        `${m.flagsRaised} concern${m.flagsRaised === 1 ? '' : 's'}`,
        ...(m.topFlag ? [m.topFlag] : []),
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

  L.push(`VITALS  ${defaultTicker(r)} \u00b7 ${headerAge(r.ageSeconds)}`);
  L.push('');

  const raised = f.flags
    .filter((fl) => fl.state === 'raised')
    .sort((a, b) => b.severity - a.severity);

  if (raised.length) {
    for (const fl of raised.slice(0, MAX_DEFAULT_FLAGS)) {
      L.push(`\ud83d\udea9 ${plainField(fl.plain, 70)}`);
    }
    const hidden = raised.length - MAX_DEFAULT_FLAGS;
    const extras: string[] = [];
    if (hidden > 0) extras.push(`+${hidden} more`);
    // Undetermined is never dropped, even when the flag slots are full.
    if (f.unknown > 0) extras.push(`${f.unknown} undetermined`);
    if (extras.length) L.push(`${extras.join(' \u00b7 ')} \u00b7 /full`);
  } else {
    const parts = [`no concerns raised \u00b7 ${f.total - f.unknown} of ${f.total} checked`];
    if (f.unknown > 0) parts.push(`${f.unknown} undetermined`);
    L.push(parts.join(' \u00b7 '));
  }

  L.push('');
  L.push(activityLine(r));
  const growth = growthLine(r);
  if (growth) L.push(growth);

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
