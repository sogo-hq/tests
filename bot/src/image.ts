import { Resvg } from '@resvg/resvg-js';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ScanResult } from './scan.js';
import { measure, wrap, fitSize, hasGlyph } from './fontmetrics.js';
import { windowLabel } from './card.js';
import { shortAge as age } from './text.js';
import { sponsorLine } from './sponsor.js';
import { launchNotice } from './launchnotice.js';
import { type Declaration } from './declare.js';
import { db } from './db.js';
import { indexCoverage } from './coverage.js';

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

/**
 * 1080x1350 is the shape a phone shows whole, which is where these are read.
 *
 * `h` is a ceiling, not a height. A launch with one finding and no traction
 * window has perhaps a third of that to say, and the card used to pad the
 * difference into one empty band between the traction block and the market
 * strip: the more certain the card, the emptier it looked. It now ends where
 * the content ends.
 *
 * `minH` stops that becoming a letterbox. Telegram crops a photo past about
 * 2.5:1, so a card that shrank to fit two lines would arrive with its footer
 * cut off, which is worse than the empty band it replaced. Both floors sit well
 * inside that: 3:2 and 12:5.
 */
const SIZES: Record<CardSize, { w: number; h: number; pad: number; minH: number }> = {
  portrait: { w: 1080, h: 1350, pad: 72, minH: 720 },
  wide: { w: 1200, h: 675, pad: 64, minH: 500 },
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

/**
 * Space between a marker and the word it marks.
 *
 * The offset used to be one constant, 40px, for markers drawn at every size.
 * At hero size the flag is 37px wide and the gap came to under 3px: the flag
 * touched the first letter. A marker is a piece of punctuation, so it is
 * measured and spaced like one.
 */
const MARK_GAP = 14;

function markWidth(kind: Mark, h: number): number {
  // The flag is a 2px pole plus a pennant 0.72h wide.
  if (kind === 'finding') return 2 + h * 0.72;
  // The circle is 0.32h in radius, and the stroke straddles its edge.
  if (kind === 'undetermined') return h * 0.64 + 2;
  return 0;
}

function mark(kind: Mark, x: number, y: number, h: number): string {
  if (kind === 'finding') return flagMark(x, y, h);
  if (kind === 'undetermined') return undeterminedMark(x, y, h);
  return '';
}

// --------------------------------------------------------------- the content



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

/**
 * The state, said in a way that carries information.
 *
 * "graduated" on its own tells a reader nothing they can act on: a token that
 * graduated forty seconds ago and one that graduated last Tuesday are different
 * situations and the bare word rendered them identically. The header already
 * carries the launch age beside it, so the two read together.
 */
function stateOf(r: ScanResult): string {
  const phase = r.reads.phaseName;
  if (phase === 'NotGraduated') return 'on the curve';
  if (phase === 'Rescued') return 'rescued';
  const swept = r.reads.sweptAt;
  // The scan's own clock, which is what ageSeconds was measured from.
  const now = r.launchedAt + r.ageSeconds;
  if (!swept || swept <= 0 || now <= swept) return 'graduated';
  return `graduated ${age(now - swept)} ago`;
}

export interface HeroContent {
  headline: string;
  reference: string | null;
  marked: Mark;
  /** What the deployer said this check would show, when they said anything. */
  declared?: string | null;
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
    return {
      headline: drawable(worst.plain || worst.compactDetail),
      reference: null,
      marked: 'finding',
      declared: worst.declared ? drawable(worst.declared) : null,
    };
  }
  const w = r.traction.window;
  const median = r.benchmark.median;
  if (w && median !== null && median > 0) {
    // The benchmark window is a rung of the ladder, so it can be a fraction of
    // a minute; the label is shared with the text card so both say "30s".
    const label = r.benchmark.measuredAtAge ? 'at this age' : `in the first ${windowLabel(r.benchmark.windowMinutes)}`;
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

export interface Secondary { label: string; marked: Mark; declared?: string | null }

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
    const declared = f.declared ? drawable(f.declared) : null;
    if (f.state === 'raised') all.push({ label: drawable(f.plain || f.compactDetail), marked: 'finding', declared });
    else if (f.state === 'unknown') all.push({ label: drawable(f.plain || f.compactDetail), marked: 'undetermined', declared });
  }
  return { shown: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/** Below this many buyers, the buy/sell split is noise and is not shown. */
export const MIN_BUYERS_FOR_FLOW = 10;

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
  /**
   * The two counts, not their quotient.
   *
   * "buys per sell 1.0" is jargon, and at the sample sizes a young launch
   * produces it is jargon that means nothing: two buys and two sells is the
   * same 1.0 as two hundred and two hundred. Below ten buyers the row is
   * dropped rather than printed, because there is no reading of four trades
   * that tells anyone anything.
   */
  if (w.uniqueBuyers30m >= MIN_BUYERS_FOR_FLOW) {
    out.push({
      label: 'flow',
      value: `${w.buyTxCount.toLocaleString()} buys, ${w.sellTxCount.toLocaleString()} sells`,
      reference: null,
    });
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
  const { w: W, h: MAX_H, pad: PAD, minH: MIN_H } = SIZES[size];
  const wide = size === 'wide';
  const CW = W - PAD * 2;
  // The ground is painted last and prepended, because its height is not known
  // until the body has been laid out.
  // -- what is below, reserved before anything above it is drawn ---------
  //
  // The footer and the market strip are anchored to the bottom, so the body has
  // a budget rather than a hope. Written the other way first, and the wide card
  // drew its findings straight through the strip and out the bottom: every line
  // was inside the left and right margins, which is what the overflow test
  // checked, and the card was still unreadable.
  const cells = marketOf(r);
  const ad = sponsorLine();
  const adH = ad ? 44 : 0;
  const stripH = cells.length ? 96 : 0;
  // Below the footer, so it is reserved with the rest of the tail rather than
  // drawn into whatever happened to be left. Never above the paid line, and
  // never in the body: it is the one line here about this tool rather than
  // about the launch on the card.
  const notice = launchNotice();
  const noticeH = notice ? 26 : 0;
  // Everything below the body, measured once: the gap above the strip, the
  // strip, the sponsor line, the footer rule and its two lines, and the bottom
  // padding. The body's budget is the ceiling minus this, and the finished
  // card's height is where the body actually ended plus this.
  const TAIL = 100 + stripH + adH + noticeH + PAD;

  /**
   * The omission note's own line, reserved only on the pass that needs it.
   *
   * Wider than the line itself: the body cursor already sits some way past its
   * last baseline when the note is placed, and how far depends on which section
   * ended the card. The slack is what keeps the note off the strip rule.
   */
  const NOTE_H = 44;

  const sSize = wide ? 26 : 30;
  // One indent for every secondary, taken from the widest marker any of them
  // could carry, so their text lines up with each other whichever mark they got.
  const secIndent = markWidth('finding', sSize * 0.72) + MARK_GAP;

  /**
   * The body, laid out against a budget.
   *
   * Run twice when anything is dropped: the "+N more" line is content too, and
   * the first pass is what discovers whether there will be one. Anchoring it
   * above the strip instead left it floating a section away from the content it
   * refers to, now that the card no longer pads the gap.
   */
  const build = (noteH: number) => {
  const p: string[] = [];
  const limitY = MAX_H - TAIL - noteH;

  // -- header -----------------------------------------------------------
  let y = PAD + 22;
  p.push(text(PAD, y, 'PONS V2, ROBINHOOD CHAIN', { size: 20, fill: DIM, weight: 600, spacing: 1.6 }));
  const tagW = measure('PONS V2, ROBINHOOD CHAIN', 20, SANS_BOLD_FILE) + 1.6 * 24;
  const declaration = r.flags.declaration;
  if (declaration) {
    const bx = PAD + tagW + 20;
    const label = 'DECLARED';
    const bw = measure(label, 18, SANS_BOLD_FILE) + 24;
    p.push(`<rect x="${bx}" y="${y - 19}" width="${bw}" height="26" rx="4" fill="none" stroke="${DIM}" stroke-width="1.5"/>`);
    p.push(text(bx + 12, y, label, { size: 18, fill: DIM, weight: 600, spacing: 1.2 }));
    // Where the claim can be read, beside the badge that says one exists. A
    // card is screenshotted out of every context it was posted in, so the
    // badge without somewhere to check it is worth less than nothing.
    const host = drawable(declaration.docsUrl.replace(/^https?:\/\//, '').replace(/\/+$/, ''));
    const hx = bx + bw + 14;
    const room = (W - PAD) - hx - measure(utcStamp(renderedAt), 20, SANS_FILE) - 24;
    const fitted = wrap(host, 18, room, SANS_FILE)[0] ?? '';
    if (fitted === host) p.push(text(hx, y, host, { size: 18, fill: DIM }));
  }
  p.push(text(W - PAD, y, utcStamp(renderedAt), { size: 20, fill: DIM, anchor: 'end' }));

  y += 26;
  p.push(`<rect x="${PAD}" y="${y}" width="${CW}" height="1" fill="${RULE}"/>`);

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
  const heroTop = wide ? 42 : 68;
  // Budgeted at the largest the hero could be, so the fit never assumes room a
  // wider marker would take; drawn and offset at the size it actually got, so
  // the gap is the same whatever that turns out to be.
  const heroMax = CW - (markWidth(hero.marked, heroTop * 0.72) + (hero.marked === 'none' ? 0 : MARK_GAP));
  const { size: heroSize, lines } = fitSize(hero.headline, heroTop, 30, heroMax, wide ? 2 : 3, SANS_BOLD_FILE);
  const heroMarkH = heroSize * 0.72;
  const heroX = PAD + markWidth(hero.marked, heroMarkH) + (hero.marked === 'none' ? 0 : MARK_GAP);
  if (hero.marked !== 'none') p.push(mark(hero.marked, PAD, y, heroMarkH));
  // Leading BETWEEN the hero's lines, not after the last one. Added after it
  // too, a three-line hero left eighty points of empty card under the last
  // descender before the next section had even started.
  lines.forEach((line, i) => {
    if (i > 0) y += heroSize * 1.18;
    p.push(text(heroX, y, line, { size: heroSize, weight: 700 }));
  });
  y += heroSize * 0.38;
  if (hero.reference) {
    y += 6;
    p.push(text(heroX, y, hero.reference, { size: wide ? 23 : 26, fill: REF }));
    y += 26;
  }
  // What the deployer said this would be, under what it turned out to be. Set
  // in the dim ink the card uses for context, never in the green it uses for
  // reference points: a claim is not a measurement.
  if (hero.declared) {
    y += wide ? 24 : 30;
    p.push(text(heroX, y, hero.declared, { size: wide ? 22 : 24, fill: DIM }));
  }

  // -- secondary findings, then traction, while there is room ------------
  let omitted = 0;
  const secondaries = secondariesOf(r, wide ? 2 : 3);
  omitted += secondaries.more;

  let first = true;
  for (const sec of secondaries.shown) {
    const sLines = wrap(sec.label, sSize, CW - secIndent, SANS_FILE).slice(0, 2);
    // Measured to the LAST BASELINE, not past the trailing gap: a finding was
    // being dropped for eight points of air that nothing would have been drawn
    // in. The budget already keeps twenty-four points clear above the strip.
    const dSize = sSize - 5;
    const need = (sLines.length - 1) * sSize * 1.3
      + (sec.declared ? dSize * 1.25 : 0)
      + (first ? (wide ? 18 : 44) : 0);
    if (y + need > limitY) { omitted++; continue; }
    if (first) { y += wide ? 26 : 44; first = false; }
    p.push(mark(sec.marked, PAD, y, sSize * 0.72));
    sLines.forEach((line, i) => {
      if (i > 0) y += sSize * 1.3;
      p.push(text(PAD + secIndent, y, line, { size: sSize, fill: INK }));
    });
    if (sec.declared) {
      y += dSize * 1.25;
      p.push(text(PAD + secIndent, y, sec.declared, { size: dSize, fill: DIM }));
    }
    y += sSize * 1.3 + 8;
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

  return { p, y, omitted };
  };

  // The second pass only ever drops more, never fewer, so its note is never
  // too small for what it ends up counting.
  let body = build(0);
  if (body.omitted > 0) body = build(NOTE_H);
  const p = body.p;
  let omitted = body.omitted;
  let y = body.y;

  // Flowed with the content it refers to. The line whose whole job is to say
  // "there is more" now has room reserved for it rather than borrowing it.
  if (omitted > 0) {
    y += 10;
    p.push(text(PAD + secIndent, y, `+${omitted} more on /full`, { size: 24, fill: DIM }));
    y += 14;
  }

  // -- the height, now that the body has been laid out -------------------
  //
  // Decided here rather than up front: the body was budgeted against the
  // ceiling, so it either filled the card, in which case nothing shrinks, or it
  // ended early and the card ends with it. Everything below is anchored to the
  // bottom and so is positioned from this number.
  const H = Math.max(MIN_H, Math.min(MAX_H, Math.round(y + TAIL)));
  const footTop = H - PAD - noticeH - 52 - 24;

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
  const footY = H - PAD - noticeH - 52;
  if (ad) {
    const adSize = 22;
    const fitted = wrap(drawable(ad), adSize, CW, SANS_FILE)[0] ?? '';
    if (fitted) p.push(text(PAD, footY - 44, fitted, { size: adSize, fill: DIM }));
  }
  p.push(`<rect x="${PAD}" y="${footY - 24}" width="${CW}" height="1" fill="${RULE}"/>`);
  p.push(text(PAD, footY + 16, '@vitalscheck_bot, paste any CA', { size: 26, fill: INK, weight: 600 }));
  p.push(text(W - PAD, footY + 16, 'checkvitals.xyz', { size: 26, fill: DIM, anchor: 'end' }));
  const indexed = indexSize();
  p.push(text(PAD, footY + 46,
    indexed > 0
      ? `${utcStamp(renderedAt)}  ·  ${indexed.toLocaleString()} launches indexed`
      : utcStamp(renderedAt),
    { size: 19, fill: DIM }));
  // Dim, like every other line down here, and never REF: green on this card
  // means "a reference point the finding above was measured against", and a
  // notice about our own launch is not one.
  if (notice) p.push(text(PAD, footY + 72, drawable(notice), { size: 19, fill: DIM }));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>${p.join('')}</svg>`
  );
}

/**
 * The card a creator posts after declaring.
 *
 * It states what was claimed and says, in the one line that matters, that
 * nothing here was checked against a chain: the launch has not happened yet.
 * Deliberately plain. A declaration card that looked like a certificate would
 * be doing the opposite of what this whole feature is for.
 */
export function declarationCardSvg(d: Declaration, renderedAt = new Date()): string {
  const W = 1080;
  const PAD = 72;
  const CW = W - PAD * 2;
  const p: string[] = [];

  let y = PAD + 22;
  p.push(text(PAD, y, 'PONS V2, ROBINHOOD CHAIN', { size: 20, fill: DIM, weight: 600, spacing: 1.6 }));
  p.push(text(W - PAD, y, utcStamp(renderedAt), { size: 20, fill: DIM, anchor: 'end' }));
  y += 26;
  p.push(`<rect x="${PAD}" y="${y}" width="${CW}" height="1" fill="${RULE}"/>`);

  y += 90;
  p.push(text(PAD, y, 'DECLARED LAUNCH', { size: 58, weight: 700, spacing: 1 }));
  y += 44;
  p.push(text(PAD, y, d.freeSlot !== null
    ? `founding declared launch #${d.freeSlot}`
    : `declaration ${d.id}`, { size: 26, fill: REF }));

  y += 52;
  p.push(text(PAD, y, d.deployer, { size: 24, fill: DIM, mono: true }));

  const others = d.exemptCount - 1;
  const claims: [string, string][] = [
    ['dev buy', `${d.devBuyPct}% of supply`],
    ['tax-free at launch', others === 0
      ? 'the deployer only'
      : `the deployer and ${others} other${others === 1 ? '' : 's'}`],
    ['creator tax', `${d.creatorTaxBps} bps, ${d.taxSplit}`],
    ['team tokens', d.vesting],
  ];

  y += 40;
  p.push(`<rect x="${PAD}" y="${y}" width="${CW}" height="1" fill="${RULE}"/>`);
  y += 56;
  for (const [label, value] of claims) {
    p.push(text(PAD, y, label, { size: 25, fill: DIM }));
    const lines = wrap(drawable(value), 30, CW - 320, SANS_BOLD_FILE).slice(0, 2);
    lines.forEach((line, i) => {
      if (i > 0) y += 38;
      p.push(text(PAD + 320, y, line, { size: 30, weight: 600 }));
    });
    y += 56;
  }

  y += 8;
  p.push(text(PAD, y, drawable(d.docsUrl), { size: 24, fill: REF }));

  // The sentence the whole card exists to carry.
  y += 56;
  for (const line of wrap(
    'a claim made before the launch, signed by the wallet that will deploy it. '
    + 'nothing here has been checked against a chain. every scan reads the launch '
    + 'itself and says where the two differ.',
    23, CW, SANS_FILE,
  ).slice(0, 3)) {
    p.push(text(PAD, y, line, { size: 23, fill: DIM }));
    y += 32;
  }

  const H = Math.max(760, Math.round(y + 24 + 52 + 24 + PAD));
  const footY = H - PAD - 52;
  p.push(`<rect x="${PAD}" y="${footY - 24}" width="${CW}" height="1" fill="${RULE}"/>`);
  p.push(text(PAD, footY + 16, '@vitalscheck_bot, paste any CA', { size: 26, fill: INK, weight: 600 }));
  p.push(text(W - PAD, footY + 16, 'checkvitals.xyz', { size: 26, fill: DIM, anchor: 'end' }));
  p.push(text(PAD, footY + 46,
    `signed at block ${d.blockNumber.toLocaleString()}  ·  ${utcStamp(new Date(d.declaredAtSeconds * 1000))}`,
    { size: 19, fill: DIM }));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>${p.join('')}</svg>`
  );
}

export function renderDeclarationPng(d: Declaration, renderedAt = new Date()): Buffer {
  return rasterise(declarationCardSvg(d, renderedAt), 1080);
}

export interface CallCard {
  symbol: string | null;
  token: string;
  username: string | null;
  calledAt: number;
  mcapQuote: number;
  athQuote: number;
  multiple: number;
  quote: string;
  botUsername?: string;
}

/**
 * A call, as something somebody can post.
 *
 * States two market caps and the ratio between them, and stops. No profit, no
 * ETH figure anybody made, no verdict on the caller: the multiple is a fact
 * about the token that would read the same whoever had posted it. The line at
 * the bottom says so, because a big number over somebody's name reads as advice
 * unless it is told not to.
 */
export function callCardSvg(c: CallCard, renderedAt = new Date()): string {
  const W = 1200;
  const H = 720;
  const PAD = 64;
  const CW = W - PAD * 2;
  const p: string[] = [];

  let y = PAD + 22;
  p.push(text(PAD, y, 'PONS V2, ROBINHOOD CHAIN', { size: 20, fill: DIM, weight: 600, spacing: 1.6 }));
  p.push(text(W - PAD, y, utcStamp(renderedAt), { size: 20, fill: DIM, anchor: 'end' }));
  y += 26;
  p.push(`<rect x="${PAD}" y="${y}" width="${CW}" height="1" fill="${RULE}"/>`);

  y = 200;
  const who = c.username ? `@${drawable(c.username)}` : 'a member';
  p.push(text(PAD, y, `${who} called ${drawable(c.symbol ? `$${c.symbol}` : c.token.slice(0, 10))}`,
    { size: 34, fill: DIM }));

  y = 310;
  const headline = `${c.multiple.toFixed(1)}x`;
  p.push(text(PAD, y, headline, { size: 116, weight: 700 }));
  const headW = measure(headline, 116, SANS_BOLD_FILE);
  // Beside the number, on its baseline, because what the multiple is OF is the
  // half of it that keeps it from reading as a score.
  p.push(text(PAD + headW + 32, y, 'from the call to the peak that followed it',
    { size: 26, fill: DIM }));

  y = 380;
  p.push(`<rect x="${PAD}" y="${y}" width="${CW}" height="1" fill="${RULE}"/>`);
  y = 436;
  const cells: [string, string][] = [
    ['called at', `${compactNum(c.mcapQuote)} ${c.quote}`],
    ['peak after', `${compactNum(c.athQuote)} ${c.quote}`],
  ];
  cells.forEach(([label, value], i) => {
    const cx = PAD + i * (CW / 2);
    p.push(text(cx, y, label, { size: 24, fill: DIM, spacing: 0.8 }));
    p.push(text(cx, y + 44, drawable(value), { size: 44, weight: 600 }));
  });

  y = 540;
  p.push(text(PAD, y, `${drawable(c.token.slice(0, 10))}\u2026${drawable(c.token.slice(-6))}`,
    { size: 22, fill: DIM, mono: true }));

  const footY = H - PAD - 52;
  p.push(`<rect x="${PAD}" y="${footY - 24}" width="${CW}" height="1" fill="${RULE}"/>`);
  const bot = c.botUsername ?? 'vitalscheck_bot';
  p.push(text(PAD, footY + 16, `via @${drawable(bot)}`, { size: 26, fill: INK, weight: 600 }));
  p.push(text(W - PAD, footY + 16, `t.me/${drawable(bot)}?startgroup=true`,
    { size: 24, fill: DIM, anchor: 'end' }));
  // Last line, like every other card here: what this is, and what it is not.
  p.push(text(PAD, footY + 46,
    'a record of what was posted and what happened next. not advice, and not a profit.',
    { size: 19, fill: DIM }));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>${p.join('')}</svg>`
  );
}

export function renderCallPng(c: CallCard, renderedAt = new Date()): Buffer {
  return rasterise(callCardSvg(c, renderedAt), 1200);
}

/** The same scale the text surfaces use, so one number does not read two ways. */
function compactNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  if (a >= 100) return String(Math.round(v));
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function renderCardPng(r: ScanResult, renderedAt = new Date(), size: CardSize = 'portrait'): Buffer {
  return rasterise(cardSvg(r, renderedAt, size), SIZES[size].w);
}

function rasterise(svg: string, width: number): Buffer {
  const resvg = new Resvg(svg, {
    background: BG,
    font: {
      fontFiles: readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf')).map((f) => join(FONT_DIR, f)),
      loadSystemFonts: false,
      defaultFontFamily: SANS,
    },
    fitTo: { mode: 'width', value: width },
  });
  return resvg.render().asPng();
}

export { SIZES, SANS_FILE, SANS_BOLD_FILE, MONO_FILE };

/**
 * The drawing kit, for cards that live in other modules.
 *
 * Same palette, same text primitive, same rasteriser: a card built elsewhere
 * with these reads as this bot's, and one built with its own colours does not.
 */
export const BRAND = { BG, INK, DIM, REF, FLAG, RULE, SANS, MONO } as const;
export { text, utcStamp, rasterise };
export type { TextOpts };
