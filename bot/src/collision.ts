import { db, normaliseKey } from './db.js';
import { indexCoverage, coverageReason, type IndexCoverage } from './coverage.js';
import { clamp, MAX_TICKER } from './text.js';

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
 * The match itself, written once.
 *
 * An empty key matches nothing rather than matching every row with an empty
 * one, which is why each side carries its own non-empty test. Everything that
 * asks about a collision, including the launch-day watch, pastes this exact
 * fragment: a second copy of it is a second answer to the same question.
 */
const KEY_MATCH = `((symbol_key = ? AND ? != '') OR (name_key = ? AND ? != ''))`;

const keyArgs = (k: CollisionKeys) =>
  [k.symbolKey, k.symbolKey, k.nameKey, k.nameKey] as const;

const WHERE = `token != ? AND ${KEY_MATCH}`;

const argsFor = (token: string, k: CollisionKeys) => [token, ...keyArgs(k)] as const;

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

/**
 * The same three states, for somebody asking from a phone.
 *
 * Reads the index this process has and nothing else: no chain, no config, no
 * write. The keys are printed beside the strings because the whole point of
 * the normalisation is that it changes what is being compared, and a count
 * whose comparison is invisible is a count nobody can check.
 */
export function collisionText(
  name: string, symbol: string,
  cov: IndexCoverage | { indexed: number; decoded: number; trustNegatives: { collision: boolean } } = indexCoverage(),
  reason = coverageReason(cov as IndexCoverage),
): string {
  const keys = collisionKeys(name, symbol);
  const r = collisionCheckRow(name, symbol, cov, reason);
  return [
    'collision check, against the index this bot holds',
    `name    ${name || '(empty)'}`,
    `symbol  ${symbol || '(empty)'}`,
    `compared as  ${keys.nameKey || '(empty)'} / ${keys.symbolKey || '(empty)'}`,
    '',
    r.value,
    ...r.note.split('\n'),
  ].join('\n');
}

// --------------------------------------------------------- the launch-day watch

export interface CollisionHit {
  token: string;
  name: string | null;
  symbol: string | null;
  deployer: string;
  blockNumber: number;
  /** As stored, so the side that matched is read rather than recomputed. */
  nameKey: string | null;
  symbolKey: string | null;
}

/**
 * Which of these launches match, using the same predicate as the count.
 *
 * The one question the count cannot answer: not "how many others share it"
 * but "is this new row one of them". Same fragment, different scope, so a
 * homoglyph the count would catch is a homoglyph the watch catches.
 */
export function collisionsAmong(tokens: readonly string[], k: CollisionKeys): CollisionHit[] {
  if (!tokens.length) return [];
  const lower = tokens.map((t) => t.toLowerCase());
  const places = lower.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT token, name, symbol, name_key, symbol_key, deployer, block_number FROM launches
       WHERE token IN (${places}) AND ${KEY_MATCH}`,
    )
    .all(...lower, ...keyArgs(k)) as any[];
  return rows.map((r) => ({
    token: r.token, name: r.name, symbol: r.symbol,
    nameKey: r.name_key ?? null, symbolKey: r.symbol_key ?? null,
    deployer: r.deployer, blockNumber: r.block_number,
  }));
}

export interface CollisionWatch {
  id: number;
  name: string;
  symbol: string;
  keys: CollisionKeys;
  createdAt: number;
  byUser: number | null;
}

const watchRow = (r: any): CollisionWatch => ({
  id: r.id, name: r.name, symbol: r.symbol,
  keys: { nameKey: r.name_key, symbolKey: r.symbol_key },
  createdAt: r.created_at, byUser: r.by_user ?? null,
});

export type WatchResult =
  | { ok: true; watch: CollisionWatch; already: boolean }
  | { ok: false; reason: 'no-keys' };

/**
 * Watch for a name or ticker landing on chain, from now on.
 *
 * A pair that normalises to nothing on both sides is refused rather than
 * stored: it would match no row and read as a watch that is running.
 *
 * Asking twice returns the watch that is already running rather than making a
 * second one. Two watches on the same keys are two DMs about one launch, on
 * the day when a duplicate alert is most expensive to read.
 */
export function startCollisionWatch(
  name: string, symbol: string, opts: { at?: number; by?: number } = {},
): WatchResult {
  const keys = collisionKeys(name, symbol);
  if (!keys.nameKey && !keys.symbolKey) return { ok: false, reason: 'no-keys' };
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const live = db
    .prepare('SELECT * FROM collision_watches WHERE name_key = ? AND symbol_key = ? AND stopped_at IS NULL')
    .get(keys.nameKey, keys.symbolKey);
  if (live) return { ok: true, watch: watchRow(live), already: true };
  const info = db
    .prepare(`INSERT INTO collision_watches (name, symbol, name_key, symbol_key, created_at, by_user, stopped_at)
              VALUES (?,?,?,?,?,?,NULL)`)
    .run(name, symbol, keys.nameKey, keys.symbolKey, at, opts.by ?? null);
  return {
    ok: true,
    watch: { id: Number(info.lastInsertRowid), name, symbol, keys, createdAt: at, byUser: opts.by ?? null },
    already: false,
  };
}

export function liveCollisionWatches(): CollisionWatch[] {
  return (db
    .prepare('SELECT * FROM collision_watches WHERE stopped_at IS NULL ORDER BY id')
    .all() as any[]).map(watchRow);
}

export function stopCollisionWatch(id: number, at = Math.floor(Date.now() / 1000)): boolean {
  const r = db
    .prepare('UPDATE collision_watches SET stopped_at = ? WHERE id = ? AND stopped_at IS NULL')
    .run(at, id);
  return r.changes > 0;
}

export interface WatchNotice {
  watch: CollisionWatch;
  hit: CollisionHit;
}

/**
 * The notices owed for a batch of new launches, claimed as they are returned.
 *
 * Claimed rather than merely computed: the indexer can hand the same token to
 * this twice, on a restart or a re-read, and a second DM about a launch that
 * was already reported is noise at the moment noise costs most. A row is
 * inserted before the notice is handed over, so a crash between here and the
 * send loses the notice rather than repeating it forever.
 */
export function claimWatchNotices(tokens: readonly string[], at = Math.floor(Date.now() / 1000)): WatchNotice[] {
  const out: WatchNotice[] = [];
  const claim = db.prepare(
    'INSERT OR IGNORE INTO collision_watch_hits (watch_id, token, seen_at) VALUES (?,?,?)',
  );
  for (const watch of liveCollisionWatches()) {
    for (const hit of collisionsAmong(tokens, watch.keys)) {
      if (claim.run(watch.id, hit.token, at).changes === 0) continue;
      out.push({ watch, hit });
    }
  }
  return out;
}

/**
 * The DM a watch sends.
 *
 * Plain text, no markup, and both strings clamped: a ticker is whatever the
 * other deployer typed, and this message goes to the people who decide what to
 * do about it. It states what landed and where, and stops there. Whether a
 * lookalike is an impersonation or a coincidence is not a thing the chain
 * says, so the message does not say it either.
 */
export function watchNoticeText(n: WatchNotice): string {
  const { watch, hit } = n;
  const sides: string[] = [];
  if (hit.symbolKey && hit.symbolKey === watch.keys.symbolKey) sides.push('the ticker');
  if (hit.nameKey && hit.nameKey === watch.keys.nameKey) sides.push('the name');
  const spelled = `${clamp(hit.name ?? '(no name)', MAX_TICKER)} / ${clamp(hit.symbol ?? '(no symbol)', MAX_TICKER)}`;
  return [
    'a launch landed matching a name or ticker you are watching',
    '',
    `watching   ${clamp(watch.name, MAX_TICKER)} / ${clamp(watch.symbol, MAX_TICKER)}`,
    `landed as  ${spelled}`,
    `matched on ${sides.join(' and ') || 'the normalised key'}, after homoglyph normalisation`,
    '',
    `CA         ${hit.token}`,
    `deployer   ${hit.deployer}`,
    `block      ${hit.blockNumber.toLocaleString('en-US')}`,
    '',
    `/scan ${hit.token} for the card. /collision unwatch ${watch.id} stops this.`,
  ].join('\n');
}
