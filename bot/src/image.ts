import { Resvg } from '@resvg/resvg-js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ScanResult } from './scan.js';
import { cardLines, type CardLine } from './card.js';

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

  // --- everything below the wordmark, from the card itself --------------------
  // The card describes itself once, as a list of lines with roles, and this
  // draws them. It used to build its own header and its own list of body lines
  // from the same ScanResult, and silently missed three features that way --
  // the growth line, the market cap, the first-scan receipt. Each time nothing
  // failed, because a renderer that forgets a line still produces a valid
  // smaller picture. Now a line added to the card appears here or nowhere.
  const lines = cardLines(r);
  const header = lines.find((l: CardLine) => l.role === 'header');
  const body = lines.filter(
    (l: CardLine) =>
      l.role !== 'header' && l.role !== 'footer' && l.role !== 'spacer' && l.role !== 'sponsor',
  );
  // Drawn in the footer band rather than the body: the body is what gets
  // dropped when a card runs out of room, and the one line somebody paid for is
  // not the line to drop silently. Above the disclaimer, as everywhere else.
  const sponsor = lines.find((l: CardLine) => l.role === 'sponsor');
  const footer = lines.find((l: CardLine) => l.role === 'footer');

  // --- identity -------------------------------------------------------------
  // The card's own header line, minus the wordmark the picture draws already.
  const ticker = (header?.text ?? '').replace(/^VITALS\s+/, '');
  parts.push(text(PAD, 158, ticker, { size: fitSize(ticker, CONTENT_W, 52, 22), fill: INK, weight: 600 }));

  // The address in full, so a reader can verify what they are looking at.
  const addr = r.reads.token;
  parts.push(text(PAD, 194, addr, { size: fitSize(addr, CONTENT_W, 22, 14), fill: DIM }));

  parts.push(`<rect x="${PAD}" y="226" width="${CONTENT_W}" height="1" fill="${DIM}" opacity="0.35"/>`);

  // --- the body, by role ----------------------------------------------------
  // Nothing in the styling says good or bad: emphasis is size and tone only,
  // because a colour here would be read as a verdict and this card gives none.
  // Markers are drawn rather than typed -- no bundled font subset carries a
  // warning glyph or a square, and a missing one renders as tofu.
  const STYLE: Record<string, { size: number; min: number; fill: string; weight?: number; indent: number; leading: number }> = {
    'concern-top': { size: 31, min: 18, fill: INK, weight: 600, indent: 34, leading: 40 },
    concern: { size: 23, min: 15, fill: DIM, indent: 30, leading: 27 },
    extras: { size: 21, min: 14, fill: DIM, indent: 30, leading: 30 },
    summary: { size: 28, min: 16, fill: INK, indent: 0, leading: 40 },
    measure: { size: 29, min: 18, fill: INK, indent: 0, leading: 31 },
    'measure-dim': { size: 22, min: 14, fill: DIM, indent: 0, leading: 25 },
  };

  // Laid out from a fixed top and flowed downward, stopping at the footer rule
  // rather than being drawn over it. Nothing is silently dropped without the
  // count saying so.
  const TOP = 262;
  const LIMIT = 540;
  let y = TOP;
  let dropped = 0;

  for (const line of body) {
    const st = STYLE[line.role] ?? STYLE['measure-dim']!;
    if (y > LIMIT) { dropped++; continue; }
    // A gap before the measurements, matching the card's blank line.
    if (line.role === 'measure' && y > TOP) y += 10;

    if (line.role === 'concern-top') {
      parts.push(`<path d="M ${PAD + 11} ${y - 20} L ${PAD + 22} ${y - 2} L ${PAD} ${y - 2} Z" fill="${INK}"/>`);
    } else if (line.role === 'concern') {
      parts.push(`<rect x="${PAD + 3}" y="${y - 11}" width="8" height="8" fill="${DIM}"/>`);
    }

    // The text-card markers are stripped: the picture draws its own, and a
    // glyph the bundled font lacks would render as tofu beside them.
    const shown = line.text.replace(/^(\u26a0\ufe0f|\u00b7)\s+/, '');
    parts.push(text(PAD + st.indent, y, shown, {
      size: fitSize(shown, CONTENT_W - st.indent, st.size, st.min),
      fill: st.fill,
      ...(st.weight ? { weight: st.weight } : {}),
    }));
    y += st.leading;
  }

  if (dropped > 0) {
    parts.push(text(PAD, LIMIT + 8, `+${dropped} more on the card`, { size: 18, fill: DIM }));
  }

  // --- footer ---------------------------------------------------------------
  parts.push(`<rect x="${PAD}" y="552" width="${CONTENT_W}" height="1" fill="${DIM}" opacity="0.35"/>`);
  if (sponsor) {
    parts.push(
      text(PAD, 578, sponsor.text, {
        size: fitSize(sponsor.text, CONTENT_W, 20, 13),
        fill: DIM,
      }),
    );
  }
  parts.push(text(PAD, HEIGHT - PAD + 12, 'checkvitals.xyz', { size: 22, fill: ACCENT }));
  // imageText, not text: a picture cannot be clicked, so this carries
  // t.me/handle where the text card carries the bare @handle Telegram links.
  const foot = footer?.imageText ?? footer?.text ?? 'not financial advice';
  parts.push(
    text(WIDTH - PAD, HEIGHT - PAD + 12, foot, {
      size: fitSize(foot, CONTENT_W - 200, 22, 13),
      fill: DIM,
      anchor: 'end',
    }),
  );

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
