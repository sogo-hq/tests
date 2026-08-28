/**
 * Decompress the IBM Plex Mono subsets we ship into TTF.
 *
 * resvg reads TrueType/OpenType; fontsource only publishes woff2, which its
 * font database cannot parse. Run once and commit the result: the fonts are
 * bundled with the repo, never fetched at runtime, so a render works on a
 * container with no network and produces the same glyphs every time.
 *
 *   node scripts/build-fonts.mjs
 */
import { decompress } from 'wawoff2';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'node_modules/@fontsource/ibm-plex-mono/files';
const OUT = 'assets/fonts';

// 400 for body, 600 for the few emphasised lines. Latin plus the Cyrillic
// subsets, because tickers on this chain routinely use Cyrillic homoglyphs of
// Latin letters and a missing glyph would render as tofu.
const SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'];
const WEIGHTS = [400, 600];

mkdirSync(OUT, { recursive: true });
let total = 0;
for (const subset of SUBSETS) {
  for (const weight of WEIGHTS) {
    const name = `ibm-plex-mono-${subset}-${weight}-normal`;
    const ttf = Buffer.from(await decompress(readFileSync(join(SRC, `${name}.woff2`))));
    if (ttf.readUInt32BE(0) !== 0x00010000 && ttf.subarray(0, 4).toString() !== 'OTTO') {
      throw new Error(`${name}: not a valid sfnt after decompression`);
    }
    writeFileSync(join(OUT, `${name}.ttf`), ttf);
    total += ttf.length;
    console.log(`  ${name}.ttf  ${(ttf.length / 1024).toFixed(1)} KB`);
  }
}
console.log(`${SUBSETS.length * WEIGHTS.length} files, ${(total / 1024).toFixed(0)} KB total`);
