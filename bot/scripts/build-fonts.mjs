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

const OUT = 'assets/fonts';

/**
 * Two families, each for one job, and exactly ONE subset of each.
 *
 * Inter carries the text: a card is read, not typed into, and a proportional
 * face fits a great deal more of a finding on one line at the same size. IBM
 * Plex Mono is kept for the shortened contract address alone, where a reader
 * compares characters against another copy of the same address and column
 * alignment is the whole point.
 *
 * ONE SUBSET, and this is the part that matters. resvg's font database keys on
 * family name, so four subsets all calling themselves "Inter" at weight 400 are
 * four faces competing for one name: it picks one and every character that face
 * lacks falls through to another family entirely. Measured: with the mono
 * subsets loaded alongside, EVERY string rendered in mono no matter what
 * font-family said, including strings asking for a family that does not exist.
 *
 * The previous build shipped four mono subsets for the same reason this one
 * does not, and its Cyrillic never rendered either. The latin subset covers
 * everything a card draws, and anything outside it is stripped by drawable()
 * rather than drawn as tofu.
 */
const FAMILIES = [
  { pkg: 'inter', prefix: 'inter', weights: [400, 600, 700] },
  { pkg: 'ibm-plex-mono', prefix: 'ibm-plex-mono', weights: [400] },
];
const SUBSETS = ['latin'];

mkdirSync(OUT, { recursive: true });
let total = 0;
let files = 0;
for (const family of FAMILIES) {
  const src = `node_modules/@fontsource/${family.pkg}/files`;
  for (const subset of SUBSETS) {
    for (const weight of family.weights) {
      const name = `${family.prefix}-${subset}-${weight}-normal`;
      let woff2;
      try {
        woff2 = readFileSync(join(src, `${name}.woff2`));
      } catch {
        // Not every family publishes every subset at every weight.
        continue;
      }
      const ttf = Buffer.from(await decompress(woff2));
      if (ttf.readUInt32BE(0) !== 0x00010000 && ttf.subarray(0, 4).toString() !== 'OTTO') {
        throw new Error(`${name}: not a valid sfnt after decompression`);
      }
      writeFileSync(join(OUT, `${name}.ttf`), ttf);
      total += ttf.length;
      files++;
      console.log(`  ${name}.ttf  ${(ttf.length / 1024).toFixed(1)} KB`);
    }
  }
}
console.log(`${files} files, ${(total / 1024).toFixed(0)} KB total`);
