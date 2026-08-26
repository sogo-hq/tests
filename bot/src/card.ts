import type { ScanResult } from './scan.js';
import type { TractionMetrics } from './metrics/traction.js';
import type { FlagResult } from './metrics/flags.js';
import { DISCLAIMER, EXPLORER_URL } from './config.js';
import { clamp, clampMessage, MAX_NAME, MAX_TICKER, TELEGRAM_MAX_MESSAGE } from './text.js';

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
function strongestSignal(t: TractionMetrics, quote: string): string {
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
      text: `median buy ${fmtUnits(t.medianBuySize)} ${quote} across ${t.buyTxCount} buys`,
    });

  if (!cands.length) return 'no buying activity recorded in the measured window';
  return cands.sort((a, b) => b.weight - a.weight)[0]!.text;
}

export function renderCard(r: ScanResult): string {
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
  L.push(`  median buy: ${fmtUnits(t.medianBuySize)} ${esc(quote)}`);
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
    `<b>Strongest signal:</b> ${esc(strongestSignal(t, quote))}. ` +
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
// Compact card — for groups and inline results
// ---------------------------------------------------------------------------

/** Short disclaimer used in the compact footer, where the full one will not fit. */
export const COMPACT_DISCLAIMER = 'signals only, not financial advice';

export interface CompactMeta {
  symbol: string | null;
  traction: string;
  flagsRaised: number;
  flagsTotal: number;
  flagsUnknown: number;
  /** Compact phrasing of the highest-signal raised flag, or null if none. */
  topFlag: string | null;
  notFound: boolean;
}

function ticker(r: ScanResult): string {
  const s = r.reads.symbol?.trim();
  if (s) return `$${clamp(s, MAX_TICKER).toUpperCase()}`;
  return `${r.reads.token.slice(0, 6)}…${r.reads.token.slice(-4)}`;
}

/**
 * Compact card: seven lines, sized for a group message or an inline result
 * where the full DM card would dominate the conversation.
 *
 * Only two flag lines fit, so they are the two highest-severity *raised* flags.
 * Undetermined flags are never promoted into those slots -- they are counted in
 * the header instead, because "we could not determine this" must never occupy
 * the space where a reader expects a finding, and must never read as clean.
 *
 * Traction and round-trippers are always present: round-trippers is the line
 * that most often contradicts a healthy-looking buyer count, so dropping it to
 * save space would make the compact card systematically rosier than the full
 * one.
 */
export function renderCompactCard(r: ScanResult, botUsername?: string): string {
  const { reads: k, traction: t, flags: f } = r;
  const L: string[] = [];

  L.push(`<b>VITALS</b>  <b>${esc(ticker(r))}</b>`);

  const mins = num(t.windowMinutes, 0);
  L.push(
    `traction ${esc(t.label)} · ${t.uniqueBuyers30m} buyer${t.uniqueBuyers30m === 1 ? '' : 's'}/${mins}m · progress ${num(k.progressPct, 2)}%`,
  );

  L.push(
    `flags ${f.raised} of ${f.total}${f.unknown ? ` · ${f.unknown} undetermined` : ''}`,
  );

  for (const fl of topRaisedFlags(r, 2)) {
    L.push(`🚩 ${esc(fl.compactDetail)}`);
  }

  L.push(
    t.uniqueBuyers30m > 0
      ? `round-trippers ${t.roundTrippers} of ${t.uniqueBuyers30m} buyer${t.uniqueBuyers30m === 1 ? '' : 's'} also sold`
      : 'round-trippers — no buyers in the window',
  );

  const via = botUsername ? `via @${esc(botUsername)} · ` : '';
  L.push(`<i>${via}${COMPACT_DISCLAIMER}</i>`);
  return clampMessage(L.join('\n'));
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
    traction: r.traction.label,
    flagsRaised: r.flags.raised,
    flagsTotal: r.flags.total,
    flagsUnknown: r.flags.unknown,
    topFlag: top ? top.compactDetail : null,
    notFound: false,
  };
}

/** One-line summary for an inline result's description field. */
export function inlineDescription(m: CompactMeta): string {
  if (m.notFound) return 'not a pons v2 launch on this chain';
  const parts = [
    `traction ${m.traction}`,
    `${m.flagsRaised} flag${m.flagsRaised === 1 ? '' : 's'}`,
  ];
  if (m.topFlag) parts.push(m.topFlag);
  else if (m.flagsUnknown) parts.push(`${m.flagsUnknown} undetermined`);
  const s = parts.join(' · ');
  // Telegram truncates long descriptions; keep it inside a sane width.
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** Compact card for an address that the factory has no record of. */
export function renderCompactNotFound(token: string, botUsername?: string): string {
  const via = botUsername ? `via @${esc(botUsername)} · ` : '';
  return [
    `<b>VITALS</b>  <code>${esc(token.slice(0, 6))}…${esc(token.slice(-4))}</code>`,
    'not a pons v2 launch — the factory has no record of this token',
    `<i>${via}${COMPACT_DISCLAIMER}</i>`,
  ].join('\n');
}

/** Plain-text compact card, for tests and CLI. */
export function renderCompactText(r: ScanResult, botUsername?: string): string {
  return renderCompactCard(r, botUsername)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
