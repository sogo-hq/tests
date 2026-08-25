import type { ScanResult } from './scan.js';
import type { TractionMetrics } from './metrics/traction.js';
import type { FlagResult } from './metrics/flags.js';
import { DISCLAIMER, EXPLORER_URL } from './config.js';

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
  const quote = k.pairSymbol ?? 'quote';
  const sym = k.symbol ? esc(k.symbol) : '?';
  const name = k.name ? esc(k.name) : 'unknown';

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
  return L.join('\n');
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
