import { Resvg } from '@resvg/resvg-js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ScanResult } from './scan.js';
import {
  defaultTicker, headerAge, buyerLine, concentrationLine, sellingLine, growthLine, MAX_DEFAULT_FLAGS,
} from './card.js';

/**
 * Optional PNG render of the default card.
 *
 * Text stays the default everywhere. This exists because text forwards well
 * inside Telegram but does not cross to X or Discord and cannot be read in a
 * preview -- people screenshot the card anyway, and this makes that deliberate.
 * It is never rendered automatically: it is slower than the text and most
 * requests do not want it.
 *
 * Nothing here may say something the text card would not. There is no score, no
 * grade, and no colour carrying a verdict: the accent is structural only, and a
 * card with three concerns is styled identically to one with none. Only the
 * words differ.
 */

export const WIDTH = 1200;
export const HEIGHT = 630;

/** Brand, as already in use. */
const BG = '#080B09';
const ACCENT = '#C6F73A';
const INK = '#E8F0DE';
const DIM = '#6E7A66';

const PAD = 64;
const CONTENT_W = WIDTH - PAD * 2;

/** IBM Plex Mono advance width, as a fraction of the em. */
const MONO_ADVANCE = 0.6;

const FONT_DIR = fileURLToPath(new URL('../assets/fonts', import.meta.url));

/**
 * Bundled with the repo and loaded from disk -- never fetched. System fonts are
 * disabled so a render is byte-identical on any host, rather than silently
 * picking up whatever the container happens to have.
 */
let fontFiles: string[] | null = null;
function fonts(): string[] {
  if (fontFiles) return fontFiles;
  fontFiles = readdirSync(FONT_DIR)
    .filter((f) => f.endsWith('.ttf'))
    .map((f) => join(FONT_DIR, f));
  if (!fontFiles.length) throw new Error(`no bundled fonts found in ${FONT_DIR}`);
  return fontFiles;
}

/**
 * Codepoints the bundled subsets actually cover: ASCII, Latin-1 Supplement,
 * Latin Extended-A/B, Cyrillic and its supplement, and the general punctuation
 * verified to render (dashes, quotes, ellipsis, middle dot).
 *
 * Verified by rendering each glyph in isolation and comparing it against a
 * known-missing codepoint's signature, rather than assumed from the subset
 * names.
 */
const RENDERABLE = /[\u0020-\u007E\u00A0-\u024F\u0400-\u052F\u2010-\u2027\u2030-\u205E\u20AC\u2116]/;

/**
 * Substitutions for characters the text card uses that no bundled subset
 * carries. A missing glyph renders as a tofu box, which looks like a defect on
 * a card built to be forwarded.
 */
const SUBSTITUTIONS: Record<string, string> = { '\u2192': '->', '\u25AA': '-' };

/**
 * Replace anything unrenderable so the image never shows tofu.
 *
 * Tickers on this chain use scripts outside these ranges -- Georgian letters
 * standing in for Latin ones, for instance -- and Plex Mono carries none of
 * them. Those become "?" rather than empty boxes, and a ticker left with no
 * renderable character at all falls back to the short address, which is
 * verifiable against the full address printed below it.
 */
export function renderableText(s: string): string {
  let out = '';
  for (const ch of s) {
    if (SUBSTITUTIONS[ch] !== undefined) out += SUBSTITUTIONS[ch];
    else if (RENDERABLE.test(ch)) out += ch;
    else out += '?';
  }
  return out;
}

/** XML-escape. Ticker and flag text are attacker-controlled. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Largest size at or below `preferred` that keeps the line inside the column. */
function fitSize(text: string, maxWidth: number, preferred: number, min: number): number {
  const chars = [...text].length;
  if (chars === 0) return preferred;
  const needed = maxWidth / (chars * MONO_ADVANCE);
  return Math.max(min, Math.min(preferred, Math.floor(needed)));
}

interface TextOpts {
  size: number;
  fill: string;
  weight?: number;
  anchor?: 'start' | 'end';
}

function text(x: number, y: number, s: string, o: TextOpts): string {
  const anchor = o.anchor ?? 'start';
  return (
    `<text x="${x}" y="${y}" font-family="IBM Plex Mono" font-size="${o.size}" ` +
    `font-weight="${o.weight ?? 400}" fill="${o.fill}" text-anchor="${anchor}" ` +
    `xml:space="preserve">${esc(renderableText(s))}</text>`
  );
}

/** The UTC stamp, so a week-old card cannot pass as today's. */
export function utcStamp(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())} ` +
    `${p(at.getUTCHours())}:${p(at.getUTCMinutes())} UTC`
  );
}

/** The SVG for a card. Exported so tests can assert on it without rasterising. */
export function cardSvg(r: ScanResult, renderedAt = new Date()): string {
  const f = r.flags;
  const parts: string[] = [];

  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>`);

  // --- header: wordmark and the UTC stamp -----------------------------------
  parts.push(text(PAD, PAD + 26, 'VITALS', { size: 30, fill: ACCENT, weight: 600 }));
  parts.push(text(WIDTH - PAD, PAD + 24, utcStamp(renderedAt), { size: 20, fill: DIM, anchor: 'end' }));

  // --- identity -------------------------------------------------------------
  const ticker = `${defaultTicker(r)} · ${headerAge(r.ageSeconds)}`;
  parts.push(text(PAD, 176, ticker, { size: fitSize(ticker, CONTENT_W, 52, 22), fill: INK, weight: 600 }));

  // The address in full, so a reader can verify what they are looking at.
  const addr = r.reads.token;
  parts.push(text(PAD, 214, addr, { size: fitSize(addr, CONTENT_W, 22, 14), fill: DIM }));

  parts.push(`<rect x="${PAD}" y="252" width="${CONTENT_W}" height="1" fill="${DIM}" opacity="0.35"/>`);

  // --- concerns, or what was checked ---------------------------------------
  // Identical treatment either way: same colours, same sizes, same positions.
  // Nothing in the styling says good or bad -- only the words differ.
  const ZONE_TOP = 276;
  const ZONE_BOTTOM = 446;
  const FLAG_LEADING = 44;
  const EXTRA_LEADING = 34;

  const raised = f.flags
    .filter((fl) => fl.state === 'raised')
    .sort((a, b) => b.severity - a.severity);
  const shown = raised.slice(0, MAX_DEFAULT_FLAGS);

  const hidden = raised.length - MAX_DEFAULT_FLAGS;
  const extras: string[] = [];
  if (raised.length) {
    if (hidden > 0) extras.push(`+${hidden} more`);
    if (f.unknown > 0) extras.push(`${f.unknown} undetermined`);
  }
  const extraLine = extras.length ? `${extras.join(' · ')} · /full` : null;

  // Centred in its zone so one concern does not leave a hole where three would
  // sit, and three cannot spill into the measurements below.
  const blockHeight =
    (shown.length ? shown.length * FLAG_LEADING : FLAG_LEADING) +
    (extraLine ? EXTRA_LEADING : 0);
  let y = ZONE_TOP + Math.max(0, (ZONE_BOTTOM - ZONE_TOP - blockHeight) / 2) + 30;

  if (shown.length) {
    for (const fl of shown) {
      // A drawn bullet, not a glyph: no bundled subset carries a square, and a
      // missing glyph would render as tofu.
      parts.push(`<rect x="${PAD}" y="${y - 13}" width="10" height="10" fill="${DIM}"/>`);
      parts.push(text(PAD + 30, y, fl.plain, { size: fitSize(fl.plain, CONTENT_W - 30, 28, 16), fill: INK }));
      y += FLAG_LEADING;
    }
  } else {
    const bits = [`no concerns raised · ${f.total - f.unknown} of ${f.total} checked`];
    if (f.unknown > 0) bits.push(`${f.unknown} undetermined`);
    const line = bits.join(' · ');
    parts.push(text(PAD, y, line, { size: fitSize(line, CONTENT_W, 28, 16), fill: INK }));
    y += FLAG_LEADING;
  }
  if (extraLine) {
    parts.push(text(PAD + 30, y, extraLine, { size: fitSize(extraLine, CONTENT_W - 30, 22, 14), fill: DIM }));
  }

  // --- what was measured ----------------------------------------------------
  // Same order as the text card: the benchmarked buyer count first, because it
  // is the one measurement a reader can act on, then who holds the supply, then
  // the rest. The buyer count leads at full size; the supporting lines are dim.
  const buyers = buyerLine(r);
  parts.push(text(PAD, 466, buyers, { size: fitSize(buyers, CONTENT_W, 30, 18), fill: INK }));

  let my = 498;
  const conc = concentrationLine(r);
  if (conc) {
    parts.push(text(PAD, my, conc, { size: fitSize(conc, CONTENT_W, 24, 14), fill: DIM }));
    my += 28;
  }
  const selling = sellingLine(r);
  parts.push(text(PAD, my, selling, { size: fitSize(selling, CONTENT_W, 24, 14), fill: DIM }));
  my += 28;
  const growth = growthLine(r);
  if (growth && my <= 548) {
    parts.push(text(PAD, my, growth, { size: fitSize(growth, CONTENT_W, 24, 14), fill: DIM }));
  }

  // --- footer ---------------------------------------------------------------
  parts.push(`<rect x="${PAD}" y="552" width="${CONTENT_W}" height="1" fill="${DIM}" opacity="0.35"/>`);
  parts.push(text(PAD, HEIGHT - PAD + 12, 'checkvitals.xyz', { size: 22, fill: ACCENT }));
  parts.push(text(WIDTH - PAD, HEIGHT - PAD + 12, 'not financial advice', { size: 22, fill: DIM, anchor: 'end' }));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" ` +
    `viewBox="0 0 ${WIDTH} ${HEIGHT}">${parts.join('')}</svg>`
  );
}

/** Rasterise a card to PNG. */
export function renderCardPng(r: ScanResult, renderedAt = new Date()): Buffer {
  const svg = cardSvg(r, renderedAt);
  const resvg = new Resvg(svg, {
    background: BG,
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      fontFiles: fonts(),
      loadSystemFonts: false, // determinism: only what we ship
      defaultFontFamily: 'IBM Plex Mono',
    },
  });
  return Buffer.from(resvg.render().asPng());
}
