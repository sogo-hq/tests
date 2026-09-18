import { db, normaliseKey } from './db.js';

/**
 * The name and ticker collision query, in one place.
 *
 * The card runs it on every scan and --check runs it before a launch, and they
 * have to be the same query or the number printed on a Sunday is not the
 * number the room sees at T+15. So the predicate lives here rather than being
 * written twice, and both callers count the same rows.
 *
 * Both sides are compared on a homoglyph-normalised key, because the thing
 * this catches is a VITALS with a Cyrillic A, not a second literal VITALS. The
 * token being asked about is excluded in SQL, so the count is always OTHER
 * launches: a unique ticker counts zero.
 *
 * Only decoded rows carry the keys, so an indexed launch whose calldata was
 * never read cannot match. That is the reason indexCoverage keeps a separate
 * trustNegatives.collision: a zero here is only a negative if enough rows were
 * decoded to have been able to match.
 */

/** At or above this many, the card calls it a finding. */
export const MIN_COLLISION_MATCHES = 2;

export interface CollisionKeys {
  symbolKey: string;
  nameKey: string;
}

export function collisionKeys(name: string | null | undefined, symbol: string | null | undefined): CollisionKeys {
  return { symbolKey: normaliseKey(symbol), nameKey: normaliseKey(name) };
}

/**
 * An empty key matches nothing rather than matching every row with an empty
 * one, which is why each side carries its own non-empty test.
 */
const WHERE = `token != ? AND ((symbol_key = ? AND ? != '') OR (name_key = ? AND ? != ''))`;

const argsFor = (token: string, k: CollisionKeys) =>
  [token, k.symbolKey, k.symbolKey, k.nameKey, k.nameKey] as const;

export function countCollisions(token: string, k: CollisionKeys): number {
  return (db
    .prepare(`SELECT COUNT(*) AS n FROM launches WHERE ${WHERE}`)
    .get(...argsFor(token, k)) as { n: number }).n;
}

/**
 * Distinct spellings of the colliding symbol.
 *
 * Distinct, because colliding tokens frequently render the same glyph and a
 * list of three identical strings says less than one of them does.
 */
export function collisionSymbols(token: string, k: CollisionKeys, limit = 25): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT symbol FROM launches WHERE ${WHERE} AND symbol IS NOT NULL LIMIT ?`)
    .all(...argsFor(token, k), limit) as { symbol: string }[];
  return [...new Set(rows.map((r) => r.symbol).filter(Boolean))];
}

// ------------------------------------------------------- the pre-launch read

/**
 * No token to exclude.
 *
 * Before a launch the token does not exist, so nothing is taken out of the
 * count. At T+15 the card excludes the token itself, which cannot be in this
 * count either, so the two agree on everything except launches indexed in
 * between. The address is a sentinel rather than a special case in the query:
 * no launch has the zero address as its token.
 */
export const NOT_ON_CHAIN_YET = `0x${'0'.repeat(40)}`;

export interface CollisionRow {
  field: string;
  value: string;
  verdict: 'pass' | 'fail' | 'warn' | 'unknown';
  note: string;
  matches: number;
}

/**
 * What the card would say about this name and ticker, asked before the launch.
 *
 * Read-only, and a finding here is a warn rather than a fail: the config is
 * not wrong because somebody else took the ticker, and this mode decides
 * whether the config is sendable. The number is what it wants to hand over.
 *
 * The three states are the card's, including the one where zero is not a
 * negative. An index that has not decoded enough rows to have been able to
 * match cannot support "nothing shares it", and saying so on a Sunday and
 * having the card say something else at T+15 is the drift this exists to stop.
 */
export function collisionCheckRow(
  name: string, symbol: string,
  cov: { indexed: number; decoded: number; trustNegatives: { collision: boolean } },
  reason: string,
): CollisionRow {
  const keys = collisionKeys(name, symbol);
  const matches = countCollisions(NOT_ON_CHAIN_YET, keys);
  const n = (x: number) => x.toLocaleString('en-US');
  const outOf = `out of ${n(cov.indexed)} indexed, ${n(cov.decoded)} of them decoded`
    + ' (only a decoded row carries the keys this matches on)';
  const value = `${matches} other indexed token${matches === 1 ? '' : 's'}`;
  const field = 'ticker collision';

  if (matches === 0 && !cov.trustNegatives.collision) {
    return {
      field, value: 'undetermined', verdict: 'unknown', matches,
      note: `${reason}\nzero here is not "nobody else uses it", and the card would say the same at T+15`,
    };
  }
  if (matches >= MIN_COLLISION_MATCHES) {
    const ex = collisionSymbols(NOT_ON_CHAIN_YET, keys).slice(0, 3).join(', ');
    return {
      field, value, verdict: 'warn', matches,
      note: `${ex ? `${ex}. ` : ''}homoglyph normalised, ${outOf}`
        + `\nthe card calls this a finding at ${MIN_COLLISION_MATCHES} or more, so it will be on the card at T+15`,
    };
  }
  return {
    field, value, verdict: 'pass', matches,
    note: matches === 0
      ? `no other decoded pons token shares this name or ticker, ${outOf}`
      : `below the ${MIN_COLLISION_MATCHES} that make it a finding on the card, ${outOf}`,
  };
}
