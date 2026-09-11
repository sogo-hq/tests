import { readFileSync } from 'node:fs';

/**
 * Advance widths, read from the font files we ship.
 *
 * resvg lays the text out; this exists only to decide WHERE TO BREAK and
 * whether a line fits. Estimating that from an average character width is the
 * usual shortcut and it is wrong in the one direction that shows: underestimate
 * and the hero line runs off the card, which is exactly the line a reader sees
 * first. The fonts are bundled, so parsing them costs one read at startup and
 * is exact rather than approximate.
 *
 * Parses the four tables needed for that and nothing else: head for unitsPerEm,
 * hhea for the metric count, hmtx for the advances, cmap format 4 for the
 * character to glyph mapping.
 */
interface Metrics {
  unitsPerEm: number;
  advances: number[];
  cmap: Map<number, number>;
  /** Used for any character the font has no glyph for. */
  fallback: number;
}

const cache = new Map<string, Metrics | null>();

function u16(b: Buffer, o: number): number { return b.readUInt16BE(o); }
function u32(b: Buffer, o: number): number { return b.readUInt32BE(o); }

function parse(path: string): Metrics | null {
  let b: Buffer;
  try {
    b = readFileSync(path);
  } catch (err) {
    console.warn('[fontmetrics] cannot read', path, String((err as Error)?.message ?? err).slice(0, 80));
    return null;
  }
  try {
    const numTables = u16(b, 4);
    const tables = new Map<string, { off: number; len: number }>();
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      tables.set(b.subarray(rec, rec + 4).toString('latin1'), { off: u32(b, rec + 8), len: u32(b, rec + 12) });
    }
    const head = tables.get('head');
    const hhea = tables.get('hhea');
    const hmtx = tables.get('hmtx');
    const cmapT = tables.get('cmap');
    if (!head || !hhea || !hmtx || !cmapT) return null;

    const unitsPerEm = u16(b, head.off + 18);
    const numberOfHMetrics = u16(b, hhea.off + 34);
    const advances: number[] = [];
    for (let i = 0; i < numberOfHMetrics; i++) advances.push(u16(b, hmtx.off + i * 4));

    // cmap: prefer a Windows Unicode BMP subtable (3,1), then (3,0), then (0,x).
    const nSub = u16(b, cmapT.off + 2);
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < nSub; i++) {
      const rec = cmapT.off + 4 + i * 8;
      const platform = u16(b, rec);
      const encoding = u16(b, rec + 2);
      const offset = u32(b, rec + 4);
      const score = platform === 3 && encoding === 1 ? 3 : platform === 3 ? 2 : platform === 0 ? 1 : 0;
      if (score > bestScore) { bestScore = score; best = cmapT.off + offset; }
    }
    const cmap = new Map<number, number>();
    if (best >= 0 && u16(b, best) === 4) {
      const segX2 = u16(b, best + 6);
      const ends = best + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = u16(b, ends + s * 2);
        const start = u16(b, starts + s * 2);
        const delta = u16(b, deltas + s * 2);
        const rangeOff = u16(b, ranges + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end && c !== 0x10000; c++) {
          let g: number;
          if (rangeOff === 0) {
            g = (c + delta) & 0xffff;
          } else {
            const gi = ranges + s * 2 + rangeOff + (c - start) * 2;
            if (gi + 1 >= b.length) continue;
            g = u16(b, gi);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g !== 0) cmap.set(c, g);
        }
      }
    }
    const last = advances[advances.length - 1] ?? unitsPerEm / 2;
    return { unitsPerEm, advances, cmap, fallback: last };
  } catch (err) {
    console.warn('[fontmetrics] cannot parse', path, String((err as Error)?.message ?? err).slice(0, 80));
    return null;
  }
}

function metricsFor(path: string): Metrics | null {
  if (!cache.has(path)) cache.set(path, parse(path));
  return cache.get(path) ?? null;
}

/**
 * Width of a string at a size, in pixels.
 *
 * Falls back to a deliberately GENEROUS estimate when the font cannot be read,
 * because the failure mode of a too-wide estimate is text that is slightly
 * smaller than it could be, and the failure mode of a too-narrow one is text
 * off the edge of the card.
 */
export function measure(text: string, sizePx: number, fontPath: string): number {
  const m = metricsFor(fontPath);
  if (!m) return text.length * sizePx * 0.62;
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const gid = m.cmap.get(code);
    const adv = gid !== undefined && gid < m.advances.length
      ? m.advances[gid]!
      : gid !== undefined ? m.fallback : m.fallback;
    units += adv;
  }
  return (units / m.unitsPerEm) * sizePx;
}

/**
 * Can this font actually draw this character?
 *
 * Asked of the shipped file rather than of a hand-written range list, because
 * the two drift: the previous renderer's list claimed Cyrillic, and the subsets
 * that would have drawn it were fighting each other for the family name and
 * never rendered at all.
 */
export function hasGlyph(codePoint: number, fontPath: string): boolean {
  const m = metricsFor(fontPath);
  if (!m) return codePoint >= 0x20 && codePoint <= 0x7e;
  return m.cmap.has(codePoint);
}

/** Break into lines that fit, preferring word boundaries. */
export function wrap(text: string, sizePx: number, maxPx: number, fontPath: string): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, sizePx, fontPath) <= maxPx) { line = candidate; continue; }
    if (line) out.push(line);
    // A single word wider than the box is cut rather than allowed to overflow.
    let rest = word;
    while (measure(rest, sizePx, fontPath) > maxPx && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && measure(rest.slice(0, cut), sizePx, fontPath) > maxPx) cut--;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) out.push(line);
  return out;
}

/**
 * The largest size at or below `start` at which the text fits on `maxLines`.
 *
 * Used for the hero line, which carries whatever the worst finding says and
 * cannot be written to a length in advance.
 */
export function fitSize(
  text: string, start: number, min: number, maxPx: number, maxLines: number, fontPath: string,
): { size: number; lines: string[] } {
  for (let size = start; size >= min; size -= 2) {
    const lines = wrap(text, size, maxPx, fontPath);
    if (lines.length <= maxLines) return { size, lines };
  }
  return { size: min, lines: wrap(text, min, maxPx, fontPath).slice(0, maxLines) };
}
