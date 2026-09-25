import type { ScanResult } from './scan.js';
import { BLOCK_TIME_SECONDS } from './config.js';
import { shortAge } from './text.js';

/**
 * One line, for somebody else's bot.
 *
 * This is the only surface here whose consumer is a program rather than a
 * reader, and that changes what matters about it. A card can grow a line, drop
 * one, reword one; this cannot. Something else embeds it in its own output, and
 * the moment its shape moves, every embedder is printing a broken string it did
 * not write and cannot fix.
 *
 * So the shape is fixed, the version is explicit, and the rules are stricter
 * than the card's:
 *
 *   Four parts, always four, separated by a middle dot:
 *
 *     vitals · <who> · <what they did> · <cost>
 *
 *   plus " · declared #NNN" and nothing else, when there is a declaration.
 *
 *   No part is ever omitted. A part that could not be measured prints
 *   "undetermined", because a line with a part missing reads as a line with
 *   nothing to say about it, and that is a claim.
 *
 *   If any part cannot be built at all, the whole line is null. A partial line
 *   is worse than no line: the embedder prints it anyway and the reader cannot
 *   tell which part is missing.
 *
 *   Every figure comes from the card that already exists. Nothing here reads
 *   the chain, computes a median, or measures anything of its own, because a
 *   second implementation of a figure is a second answer to one question.
 *
 * What they did is measured on THIS token and never on the index. The index
 * appears once, in the cost, and only with the word "median" attached to it.
 */

/**
 * The shape version.
 *
 * Bumped only when the shape changes, which is the event this number exists to
 * make visible. Adding a value to an existing part is not a shape change;
 * adding, removing or reordering a part is.
 */
export const LINE_VERSION = 1;

/** Above this an embedder's own layout starts wrapping, so it is a bug. */
export const LINE_MAX = 110;

const SEP = ' · ';

/** The one prefix, so an embedder can recognise the line as ours. */
export const LINE_PREFIX = 'vitals';

export const UNDETERMINED = 'undetermined';

/**
 * Who got in before the public, and how much they took.
 *
 * The count is the number of DISTINCT exempt wallets, the deployer among them,
 * which is what the curve's own events report after de-duplication. The
 * deployer is never added to it and never subtracted from it: a launch whose
 * only exempt wallet is the deployer says so in words rather than as "1", and
 * counting it again on top of the count is the defect this phrasing exists to
 * avoid.
 */
function whoPart(r: ScanResult): string | null {
  const flag = r.flags.flags.find((f) => f.key === 'snipe_exemptions');
  if (!flag) return null;
  const value = flag.value as { wallets?: unknown; supply_share?: unknown } | null;
  // No value is the undetermined and the impossible-zero states of the flag.
  // Both mean the exempt set was not read, which is said rather than guessed.
  if (!value || typeof value.wallets !== 'number' || value.wallets < 1) return UNDETERMINED;

  const wallets = value.wallets;
  const share = typeof value.supply_share === 'number' ? value.supply_share * 100 : null;
  // The share is its own reading and can be absent while the count is known.
  // Said, not dropped: "3 in before you" alone invites the reader to assume it
  // was small.
  const shareText = share === null ? `share ${UNDETERMINED}` : `${share.toFixed(1)}% of supply`;
  if (wallets === 1) return `only the deployer, ${shareText}`;
  return `${wallets} in before you, ${shareText}`;
}

/**
 * What the opening buyers have done since, on this token.
 *
 * Three answers and no fourth. None of them has sold, so they are still in and
 * the line says how long that has been true; one of them has, and the line says
 * when the first went; or the window was never indexed, and the line says so.
 *
 * "Still in" is a statement with a clock on it. Without the age it reads as a
 * permanent property of the launch, and it is true only up to the moment it was
 * measured.
 */
function didPart(r: ScanResult): string {
  const e = r.earlySells;
  if (!e || e.cohort < 1) return UNDETERMINED;
  if (e.sold === 0) return `still in at ${shortAge(r.ageSeconds)}`;
  if (e.firstSoldBlock === null) {
    // Somebody sold and the block was not kept. The count is real and the time
    // is not, so only the part that was measured is claimed.
    return `${e.sold} of ${e.cohort} out, first exit ${UNDETERMINED}`;
  }
  const seconds = Math.max(0, (e.firstSoldBlock - r.launchBlock) * BLOCK_TIME_SECONDS);
  return `first exit at ${shortAge(seconds)}`;
}

/**
 * What it costs to trade, and what that is next to the index.
 *
 * The only place the index appears, and it carries the word median, because a
 * bare second percentage beside the first reads as a second fact about this
 * token. Withheld by the card when the index cannot support it, and withheld
 * here for the same reason and in the same words.
 */
function costPart(r: ScanResult): string | null {
  const bps = r.reads.creatorTaxBps;
  if (!Number.isFinite(bps) || bps < 0) return null;
  const median = r.flags.creatorTaxMedianBps;
  const pct = (v: number) => {
    const n = v / 100;
    return `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
  };
  return median === null
    ? `tax ${pct(bps)}, median ${UNDETERMINED}`
    : `tax ${pct(bps)}, median ${pct(median)}`;
}

/**
 * The declaration suffix, or nothing at all.
 *
 * Absence prints nothing. Not declared is not a finding, and a line that said
 * "not declared" would turn the absence of a voluntary claim into a mark
 * against every launch that never made one.
 *
 * The declaration is already resolved by the card, which only attaches one
 * signed by this deployer BEFORE the launch block. Nothing here re-checks that,
 * because a second implementation of the rule is a second rule.
 */
function declaredPart(r: ScanResult): string {
  const d = r.flags.declaration;
  if (!d) return '';
  // The founding number when there is one, and the id otherwise. Both are
  // stable for a given declaration and both resolve on the site.
  const n = d.freeSlot !== null ? d.freeSlot : d.id;
  if (!Number.isFinite(n) || n < 1) return '';
  return `${SEP}declared #${String(n).padStart(3, '0')}`;
}

export interface Line {
  version: number;
  line: string;
}

/**
 * Build the line, or return null.
 *
 * Null when a part could not be built at all, which is not the same as a part
 * that could not be measured: the second prints "undetermined" and the line
 * still goes out. The difference is whether we know what we are failing to say.
 */
export function buildLine(r: ScanResult): Line | null {
  const who = whoPart(r);
  const cost = costPart(r);
  if (who === null || cost === null) return null;
  const line = [LINE_PREFIX, who, didPart(r), cost].join(SEP) + declaredPart(r);

  if (line.length > LINE_MAX) {
    // Never truncated. A cut line is a partial claim in somebody else's output,
    // and they have no way to know it was cut.
    console.warn(`[line] ${line.length} characters, over the ${LINE_MAX} bound, so no line was returned: ${line}`);
    return null;
  }
  return { version: LINE_VERSION, line };
}

/** The parts of a built line, for anything that needs to check its shape. */
export function lineParts(line: string): string[] {
  return line.split(SEP);
}
