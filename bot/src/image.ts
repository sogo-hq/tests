import { Resvg } from '@resvg/resvg-js';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ScanResult } from './scan.js';
import { measure, wrap, fitSize, hasGlyph } from './fontmetrics.js';
import { sponsorLine } from './sponsor.js';
import { isDeclared } from './declare.js';
import { db } from './db.js';

/**
 * The card as an image.
 *
 * Text stays the default everywhere. This exists because text forwards well
 * inside Telegram but does not cross to X or Discord and cannot be read in a
 * preview: people screenshot the card anyway, and this makes that deliberate.
 *
 * Nothing here may say something the text card would not. There is no score and
 * no grade. Colour carries exactly two meanings, both structural: red marks a
 * finding, green marks a reference point. A card with three findings is laid
 * out identically to one with none; only the words differ.
 */

export type CardSize = 'portrait' | 'wide';

/** 1080x1350 is the shape a phone shows whole, which is where these are read. */
const SIZES: Record<CardSize, { w: number; h: number; pad: number }> = {
  portrait: { w: 1080, h: 1350, pad: 72 },
  wide: { w: 1200, h: 675, pad: 64 },
};

const BG = '#080B09';
const INK = '#E8F0DE';
const DIM = '#6E7A66';
/** Reference points only. Never a verdict, never "good". */
const REF = '#C6F73A';
/** A finding. Never anything else. */
const FLAG = '#FF5A47';
const RULE = '#1B241A';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FONT_DIR = join(HERE, '..', 'assets', 'fonts');
const SANS = 'Inter';
const MONO = 'IBM Plex Mono';
const SANS_FILE = join(FONT_DIR, 'inter-latin-400-normal.ttf');
const SANS_BOLD_FILE = join(FONT_DIR, 'inter-latin-700-normal.ttf');
const MONO_FILE = join(FONT_DIR, 'ibm-plex-mono-latin-400-normal.ttf');

/**
 * Drop anything the shipped font cannot draw.
 *
 * Asked of the font FILE rather than of a hand-maintained character range,
 * because a list drifts from what is actually installed. The previous one
 * claimed Cyrillic, and the subsets that would have drawn it were fighting each
 * other for the family name and rendered nothing at all.
 *
 * Emoji are deliberately absent from the fonts: every marker on this card is a
 * drawn shape, which is why it looks the same on every platform.
 */
export function drawable(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === ' ' || hasGlyph(cp, SANS_FILE)) out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface TextOpts {
  size: number;
  fill?: string;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  mono?: boolean;
  spacing?: number;
}

function text(x: number, y: number, s: string, o: TextOpts): string {
  const family = o.mono ? MONO : SANS;
  const attrs = [
    `x="${x}"`, `y="${y}"`,
    `font-family="${family}"`,
    `font-size="${o.size}"`,
    `fill="${o.fill ?? INK}"`,
    o.weight && o.weight !== 400 ? `font-weight="${o.weight}"` : '',
    o.anchor && o.anchor !== 'start' ? `text-anchor="${o.anchor}"` : '',
    o.spacing ? `letter-spacing="${o.spacing}"` : '',
  ].filter(Boolean).join(' ');
  return `<text ${attrs}>${esc(s)}</text>`;
}

/**
 * The markers, drawn rather than typed.
 *
 * The font subsets cannot draw a flag or a dotted circle, and a card whose
 * markers depend on the reader's emoji font is a card that says different
 * things on different phones.
 */
function flagMark(x: number, y: number, h: number): string {
  const pole = 2;
  const w = h * 0.72;
  return (
    `<rect x="${x}" y="${y - h}" width="${pole}" height="${h}" fill="${FLAG}"/>` +
    `<path d="M ${x + pole} ${y - h} L ${x + pole + w} ${y - h + h * 0.22} ` +
    `L ${x + pole} ${y - h + h * 0.44} Z" fill="${FLAG}"/>`
  );
}

function undeterminedMark(x: number, y: number, h: number): string {
  const r = h * 0.32;
  return `<circle cx="${x + r}" cy="${y - h * 0.38}" r="${r}" fill="none" stroke="${DIM}" stroke-width="2.5"/>`;
}

export type Mark = 'finding' | 'undetermined' | 'none';

function mark(kind: Mark, x: number, y: number, h: number): string {
  if (kind === 'finding') return flagMark(x, y, h);
  if (kind === 'undetermined') return undeterminedMark(x, y, h);
  return '';
}

// --------------------------------------------------------------- the content

function age(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  if (a >= 100) return String(Math.round(v));
  return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function stateOf(r: ScanResult): string {
  const phase = r.reads.phaseName;
  if (phase === 'NotGraduated') return 'on the curve';
  if (phase === 'Rescued') return 'rescued';
  return 'graduated';
}

export interface HeroContent {
  headline: string;
  reference: string | null;
  marked: Mark;
}

/**
 * The one line a reader sees first.
 *
 * The worst finding when anything is flagged, because that is what a scan is
 * for. Otherwise the most extreme traction number WITH the thing it is extreme
 * against: a buyer count on its own says nothing about whether a launch is
 * early or already over.
 */
export function heroOf(r: ScanResult): HeroContent {
  const worst = r.flags.worst;
  if (worst) {
    return { headline: drawable(worst.plain || worst.compactDetail), reference: null, marked: 'finding' };
  }
  const w = r.traction.window;
  const median = r.benchmark.median;
  if (w && median !== null && median > 0) {
    const label = r.benchmark.measuredAtAge ? 'at this age' : `in the first ${r.benchmark.windowMinutes} min`;
    return {
      headline: `${w.uniqueBuyers30m.toLocaleString()} buyers ${label}`,
      reference: `index median ${median.toLocaleString()} over ${r.benchmark.n.toLocaleString()} launches`,
      marked: 'none',
    };
  }
  if (w) {
    return {
      headline: `${w.uniqueBuyers30m.toLocaleString()} buyers in the first ${Math.round(r.traction.windowMinutes)} min`,
      reference: 'no index median yet at this age',
      marked: 'none',
    };
  }
  return {
    headline: 'traction not measured yet',
    reference: 'the opening window has not been indexed',
    marked: 'undetermined',
  };
}

export interface Secondary { label: string; marked: Mark }

/**
 * Up to three findings below the hero, worst first, the hero's own excluded.
 *
 * Returns what did NOT fit as well. A renderer that drops the fourth finding
 * still produces a perfectly good-looking card, which is exactly how the old
 * image quietly lost three features: nothing fails, the picture is just
 * smaller. The count goes on the card so a reader knows there is more.
 */
export function secondariesOf(r: ScanResult, limit = 3): { shown: Secondary[]; more: number } {
  const worstKey = r.flags.worst?.key;
  const all: Secondary[] = [];
  for (const f of r.flags.flags) {
    if (f.key === worstKey) continue;
    if (f.state === 'raised') all.push({ label: drawable(f.plain || f.compactDetail), marked: 'finding' });
    else if (f.state === 'unknown') all.push({ label: drawable(f.plain || f.compactDetail), marked: 'undetermined' });
  }
  return { shown: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

export interface Measure { label: string; value: string; reference: string | null }

/** The traction lines, each beside what it is measured against. */
export function measuresOf(r: ScanResult): Measure[] {
  const out: Measure[] = [];
  const w = r.traction.window;
  if (!w) return out;
  out.push({
    label: 'buyers',
    value: w.uniqueBuyers30m.toLocaleString(),
    reference: r.benchmark.median === null
      ? null
      : `index median ${r.benchmark.median.toLocaleString()} (n=${r.benchmark.n.toLocaleString()})`,
  });
  if (w.buySellRatio !== null) {
    out.push({ label: 'buys per sell', value: w.buySellRatio.toFixed(1), reference: null });
  }
  if (r.reads.phaseName === 'NotGraduated') {
    out.push({
      label: 'curve progress',
      value: `${r.reads.progressPct.toFixed(1)}%`,
      reference: w.progressVelocityPer10m > 0 ? `${w.progressVelocityPer10m.toFixed(1)}% per 10 min` : null,
    });
  }
  return out;
}

export interface Cell { label: string; value: string }

/** MC, ATH with how long it took, holders, largest wallet. Only what is known. */
export function marketOf(r: ScanResult): Cell[] {
  const out: Cell[] = [];
  const unit = drawable(r.reads.pairSymbol ?? 'ETH');
  if (r.reads.mcapInQuote > 0) out.push({ label: 'mcap', value: `${compact(r.reads.mcapInQuote)} ${unit}` });

  const peak = db.prepare('SELECT peak_mcap, peak_at FROM token_peaks WHERE token = ?')
    .get(r.reads.token.toLowerCase()) as { peak_mcap: string; peak_at: number } | undefined;
  if (peak) {
    const v = Number(peak.peak_mcap);
    if (Number.isFinite(v) && v > 0) {
      const mins = Math.max(0, Math.round((peak.peak_at - r.launchedAt) / 60));
      out.push({ label: `ath, +${mins} min`, value: `${compact(v)} ${unit}` });
    }
  }
  const c = r.flags.concentration;
  if (c) {
    out.push({ label: 'holders', value: c.holders.toLocaleString() });
    if (c.top1Share > 0) out.push({ label: 'largest wallet', value: `${c.top1Share.toFixed(1)}%` });
  }
  return out;
}

// ----------------------------------------------------------------- the render

function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function indexSize(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM launches').get() as { n: number };
  return row?.n ?? 0;
}

export function cardSvg(r: ScanResult, renderedAt = new Date(), size: CardSize = 'portrait'): string {
  const { w: W, h: H, pad: PAD } = SIZES[size];
  const wide = size === 'wide';
  const CW = W - PAD * 2;
  const p: string[] = [`<rect width="${W}" height="${H}" fill="${BG}"/>`];

  // -- header -----------------------------------------------------------
  let y = PAD + 22;
  p.push(text(PAD, y, 'PONS V2, ROBINHOOD CHAIN', { size: 20, fill: DIM, weight: 600, spacing: 1.6 }));
  const tagW = measure('PONS V2, ROBINHOOD CHAIN', 20, SANS_BOLD_FILE) + 1.6 * 24;
  if (isDeclared(r.reads.token)) {
    const bx = PAD + tagW + 20;
    const label = 'DECLARED';
    const bw = measure(label, 18, SANS_BOLD_FILE) + 24;
    p.push(`<rect x="${bx}" y="${y - 19}" width="${bw}" height="26" rx="4" fill="none" stroke="${DIM}" stroke-width="1.5"/>`);
    p.push(text(bx + 12, y, label, { size: 18, fill: DIM, weight: 600, spacing: 1.2 }));
  }
  p.push(text(W - PAD, y, utcStamp(renderedAt), { size: 20, fill: DIM, anchor: 'end' }));

  y += 26;
  p.push(`<rect x="${PAD}" y="${y}" width="${CW}" height="1" fill="${RULE}"/>`);

  // -- what is below, reserved before anything above it is drawn ---------
  //
  // The footer and the market strip are anchored to the bottom, so the body has
  // a budget rather than a hope. Written the other way first, and the wide card
  // drew its findings straight through the strip and out the bottom: every line
  // was inside the left and right margins, which is what the overflow test
  // checked, and the card was still unreadable.
  const cells = marketOf(r);
  const ad = sponsorLine();
  const footTop = H - PAD - 52 - 24;
  const adH = ad ? 44 : 0;
  const stripH = cells.length ? 96 : 0;
  const limitY = footTop - adH - stripH - 24;

  // -- identity ---------------------------------------------------------
  y += wide ? 52 : 86;
  const ticker = drawable(r.reads.symbol ?? '?') || '?';
  const tickerSize = wide ? 48 : 60;
  p.push(text(PAD, y, ticker, { size: tickerSize, weight: 700 }));
  const tickerW = measure(ticker, tickerSize, SANS_BOLD_FILE);
  const facts = [age(r.ageSeconds), drawable(r.reads.pairSymbol ?? 'ETH'), stateOf(r)].join('  ·  ');
  p.push(text(PAD + tickerW + 24, y, facts, { size: wide ? 25 : 28, fill: DIM }));

  y += wide ? 32 : 40;
  p.push(text(PAD, y, shortAddress(r.reads.token), { size: wide ? 22 : 24, fill: DIM, mono: true }));

  // -- hero -------------------------------------------------------------
  const hero = heroOf(r);
  y += wide ? 44 : 92;
  const markW = 40;
  const heroMax = CW - (hero.marked === 'none' ? 0 : markW);
  const { size: heroSize, lines } = fitSize(hero.headline, wide ? 42 : 68, 30, heroMax, wide ? 2 : 3, SANS_BOLD_FILE);
  const heroX = PAD + (hero.marked === 'none' ? 0 : markW);
  if (hero.marked !== 'none') p.push(mark(hero.marked, PAD, y, heroSize * 0.72));
  for (const line of lines) {
    p.push(text(heroX, y, line, { size: heroSize, weight: 700 }));
    y += heroSize * 1.18;
  }
  if (hero.reference) {
    y += 6;
    p.push(text(heroX, y, hero.reference, { size: wide ? 23 : 26, fill: REF }));
    y += 26;
  }

  // -- secondary findings, then traction, while there is room ------------
  let omitted = 0;
  const secondaries = secondariesOf(r, wide ? 2 : 3);
  omitted += secondaries.more;

  const sSize = wide ? 26 : 30;
  let first = true;
  for (const sec of secondaries.shown) {
    const sLines = wrap(sec.label, sSize, CW - markW, SANS_FILE).slice(0, 2);
    const need = sLines.length * sSize * 1.3 + 8 + (first ? (wide ? 18 : 44) : 0);
    if (y + need > limitY) { omitted++; continue; }
    if (first) { y += wide ? 26 : 44; first = false; }
    p.push(mark(sec.marked, PAD, y, sSize * 0.72));
    for (const line of sLines) {
      p.push(text(PAD + markW, y, line, { size: sSize, fill: INK }));
      y += sSize * 1.3;
    }
    y += 8;
  }

  const measures = measuresOf(r);
  if (measures.length && y + 46 + measures.length * 44 <= limitY) {
    y += 20;
    p.push(`<rect x="${PAD}" y="${y}" width="${CW}" height="1" fill="${RULE}"/>`);
    y += 46;
    for (const m of measures) {
      p.push(text(PAD, y, m.label, { size: 26, fill: DIM }));
      p.push(text(PAD + 300, y, m.value, { size: 30, weight: 600 }));
      if (m.reference) {
        p.push(text(PAD + 300 + measure(m.value, 30, SANS_BOLD_FILE) + 22, y, m.reference, { size: 24, fill: REF }));
      }
      y += 44;
    }
  } else if (measures.length) {
    omitted += measures.length;
  }

  // Anchored, not flowed. Flowed, it was the first thing to run out of room on
  // the wide card, so the one line whose whole job is to say "there is more"
  // disappeared exactly when there was more.
  if (omitted > 0) {
    p.push(text(PAD + markW, footTop - adH - stripH - 12, `+${omitted} more on /full`,
      { size: 24, fill: DIM }));
  }

  // -- market strip -------------------------------------------------------
  if (cells.length) {
    const stripY = footTop - adH - stripH + 40;
    p.push(`<rect x="${PAD}" y="${stripY - 36}" width="${CW}" height="1" fill="${RULE}"/>`);
    const cw = CW / cells.length;
    cells.forEach((c, i) => {
      const cx = PAD + i * cw;
      p.push(text(cx, stripY, c.label, { size: 22, fill: DIM, spacing: 0.8 }));
      p.push(text(cx, stripY + 36, c.value, { size: wide ? 30 : 34, weight: 600 }));
    });
  }

  // -- sponsor, then footer ----------------------------------------------
  const footY = H - PAD - 52;
  if (ad) {
    const adSize = 22;
    const fitted = wrap(drawable(ad), adSize, CW, SANS_FILE)[0] ?? '';
    if (fitted) p.push(text(PAD, footY - 44, fitted, { size: adSize, fill: DIM }));
  }
  p.push(`<rect x="${PAD}" y="${footY - 24}" width="${CW}" height="1" fill="${RULE}"/>`);
  p.push(text(PAD, footY + 16, '@vitalscheck_bot, paste any CA', { size: 26, fill: INK, weight: 600 }));
  p.push(text(W - PAD, footY + 16, 'checkvitals.xyz', { size: 26, fill: DIM, anchor: 'end' }));
  p.push(text(PAD, footY + 46, `${utcStamp(renderedAt)}  ·  ${indexSize().toLocaleString()} launches indexed`,
    { size: 19, fill: DIM }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${p.join('')}</svg>`;
}

export function renderCardPng(r: ScanResult, renderedAt = new Date(), size: CardSize = 'portrait'): Buffer {
  const svg = cardSvg(r, renderedAt, size);
  const resvg = new Resvg(svg, {
    background: BG,
    font: {
      fontFiles: readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf')).map((f) => join(FONT_DIR, f)),
      loadSystemFonts: false,
      defaultFontFamily: SANS,
    },
    fitTo: { mode: 'width', value: SIZES[size].w },
  });
  return resvg.render().asPng();
}

export { SIZES, SANS_FILE, SANS_BOLD_FILE, MONO_FILE };
