import { buildRevenue, type Revenue } from '../revenue.js';
import { feeWalletBalance } from '../ledger.js';
import { db, getCursor } from '../db.js';
import { client } from '../chain.js';
import { indexCoverage } from '../coverage.js';
import { resolveLaunch } from '../resolve.js';
import { performScan, normaliseToken } from '../service.js';
import { api as atApiPriority } from '../ratelimit.js';
import { MIN_BENCHMARK_SAMPLES } from '../metrics/benchmark.js';
import { toApiLaunch } from './map.js';
import { buildLine, LINE_VERSION } from '../line.js';
import {
  MAX_BATCH, MAX_LAG_BLOCKS,
  type ApiBatchItem, type ApiError, type ApiHealth, type ApiLaunch, type ApiStats,
} from './types.js';

/**
 * The handlers.
 *
 * Every one of them answers out of work the bot already does: the same scan,
 * the same cache, the same rate limiter. The API is a second way to ask, not a
 * second implementation, which is what keeps a partner's answer and a Telegram
 * user's answer the same answer.
 */

export type Outcome =
  | { status: number; body: unknown; headers?: Record<string, string> };

/** How long a rendered API answer is reused. */
export const API_CACHE_MS = Number(process.env.API_CACHE_MS || 30_000) || 30_000;

const cache = new Map<string, { at: number; launch: ApiLaunch }>();

export function resetApiCache(): void {
  cache.clear();
}

/**
 * How far behind the index is, in blocks.
 *
 * Null when either end is unreadable, which is not the same as zero: a head we
 * could not fetch is not a head we are caught up to.
 */
export async function lagBlocks(): Promise<{ head: number | null; indexed: number | null; lag: number | null }> {
  let head: number | null = null;
  try {
    head = Number(await atApiPriority(() => client.getBlockNumber()));
  } catch (err) {
    console.warn('[api] head unreadable:', String((err as Error)?.message ?? err).slice(0, 120));
  }
  const cursor = getCursor('launches');
  const indexed = cursor === null ? null : Number(cursor);
  const lag = head === null || indexed === null ? null : Math.max(0, head - indexed);
  return { head, indexed, lag };
}

const NOT_A_LAUNCH = 'not_a_pons_v2_launch';

/**
 * Request validation, separated from the work.
 *
 * Called before the lag gate rather than inside the handler: "0xnope is not an
 * address" is a fact about the request and stays true whatever the index is
 * doing, and answering it with a 503 would send a partner looking for an outage
 * that is not there.
 */
export function validateAddress(address: string): Outcome | null {
  return normaliseToken(address)
    ? null
    : { status: 400, body: { error: 'invalid_address', resolved_as: null } satisfies ApiError };
}

/** The same, for the batch body. */
export function validateBatch(body: unknown): Outcome | null {
  const addresses = (body as any)?.addresses;
  if (!Array.isArray(addresses)) {
    return { status: 400, body: { error: 'addresses_must_be_an_array' } satisfies ApiError };
  }
  if (addresses.length === 0) {
    return { status: 400, body: { error: 'addresses_must_not_be_empty' } satisfies ApiError };
  }
  if (addresses.length > MAX_BATCH) {
    return {
      status: 400,
      body: { error: 'too_many_addresses', limit: MAX_BATCH, given: addresses.length } satisfies ApiError,
    };
  }
  return null;
}

/**
 * GET /v1/launch/{address}
 *
 * A 404 here says what the address turned out to be. A deployer address and a
 * curve address are both things people paste expecting a token, and "not a pons
 * v2 launch" alone is true and useless.
 */
export async function getLaunch(address: string, now = Date.now()): Promise<Outcome> {
  const bad = validateAddress(address);
  if (bad) return bad;
  const token = normaliseToken(address)!;

  const hit = cache.get(token.toLowerCase());
  if (hit && now - hit.at < API_CACHE_MS) {
    return { status: 200, body: hit.launch, headers: { 'x-cache': 'hit' } };
  }

  const outcome = await atApiPriority(() => performScan({ token, source: 'api' }));

  if (outcome.kind === 'not_found') {
    // The same resolution the bot uses, so the API and a /scan reply agree
    // about what an address is.
    let resolvedAs: 'deployer' | 'curve' | null = null;
    try {
      const r = await atApiPriority(() => resolveLaunch(token));
      resolvedAs = r.pastedWas ?? (r.deployerOf ? 'deployer' : null);
    } catch (err) {
      console.warn('[api] resolution failed:', String((err as Error)?.message ?? err).slice(0, 120));
    }
    return { status: 404, body: { error: NOT_A_LAUNCH, resolved_as: resolvedAs } satisfies ApiError };
  }
  if (outcome.kind === 'rate_limited') {
    return {
      status: 429,
      body: { error: 'upstream_rate_limited', resolved_as: null } satisfies ApiError,
      headers: { 'retry-after': String(Math.max(1, outcome.retryAfterSec)) },
    };
  }
  if (outcome.kind !== 'ok' || !outcome.result) {
    // busy, unreadable, error: the chain could not be read well enough to
    // answer, which is a different thing from the launch not existing.
    return { status: 503, body: { error: 'scan_unavailable', resolved_as: null } satisfies ApiError };
  }

  const launch = toApiLaunch(outcome.result, new Date(now));
  cache.set(token.toLowerCase(), { at: now, launch });
  return { status: 200, body: launch, headers: { 'x-cache': 'miss' } };
}

/**
 * POST /v1/launches
 *
 * Partial results on purpose: one bad address in fifty is not a reason to
 * refuse the other forty-nine, and an integration that fans out has no way to
 * know in advance which of its addresses are launches.
 */
/**
 * The embeddable line.
 *
 * Its own route rather than a field on /launch, because its consumer is a
 * different thing: a bot that wants one string and should not have to parse a
 * launch object to find it, nor break when that object grows a field.
 *
 * A line that cannot be built is a 503 and not an empty 200. An embedder given
 * {"line": null} prints the word null; one given a 503 prints nothing, which is
 * the outcome the rule asks for.
 */
export async function getLine(address: string, now = Date.now()): Promise<Outcome> {
  const bad = validateAddress(address);
  if (bad) return bad;
  const token = normaliseToken(address)!;

  const outcome = await atApiPriority(() => performScan({ token, source: 'api' }));
  if (outcome.kind === 'not_found') {
    return { status: 404, body: { error: NOT_A_LAUNCH, resolved_as: null } satisfies ApiError };
  }
  if (outcome.kind === 'rate_limited') {
    return {
      status: 429,
      body: { error: 'upstream_rate_limited', resolved_as: null } satisfies ApiError,
      headers: { 'retry-after': String(Math.max(1, outcome.retryAfterSec)) },
    };
  }
  if (outcome.kind !== 'ok' || !outcome.result) {
    return { status: 503, body: { error: 'scan_unavailable', resolved_as: null } satisfies ApiError };
  }

  const built = buildLine(outcome.result);
  if (!built) {
    return { status: 503, body: { error: 'line_unavailable', resolved_as: null } satisfies ApiError };
  }
  return {
    status: 200,
    body: { version: built.version, line: built.line },
    // On the response as well as in it, so a consumer can pin the shape without
    // reading the body.
    headers: { 'x-vitals-line-version': String(LINE_VERSION) },
  };
}

export async function postLaunches(body: unknown, now = Date.now()): Promise<Outcome> {
  const bad = validateBatch(body);
  if (bad) return bad;
  const addresses = (body as any).addresses as unknown[];

  // Serially, not in parallel. Fifty concurrent scans would put the API ahead
  // of the bot by sheer count even at a lower priority, and a partner asking
  // for fifty is asking for fifty answers rather than for them at once.
  const results: ApiBatchItem[] = [];
  for (const raw of addresses) {
    const address = String(raw ?? '');
    try {
      const out = await getLaunch(address, now);
      results.push(out.status === 200
        ? { address, ok: true, launch: out.body as ApiLaunch }
        : { address, ok: false, error: out.body as ApiError });
    } catch (err) {
      console.error('[api] batch item failed:', err);
      results.push({ address, ok: false, error: { error: 'scan_unavailable', resolved_as: null } });
    }
  }
  return { status: 200, body: results };
}

/** GET /v1/stats: the figures /stats already prints, as JSON. */
export function getStats(now = Date.now()): Outcome {
  const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const launches = q('SELECT COUNT(*) n FROM launches');
  const decoded = q('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count IS NOT NULL');
  const withAny = q('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count > 0');
  const fromLogs = q("SELECT COUNT(*) n FROM launches WHERE exemption_source = 'logs'");
  const beyond = q("SELECT COUNT(*) n FROM launches WHERE exemption_source = 'logs' AND snipe_exemption_count > 1");

  const counts = db
    .prepare("SELECT snipe_exemption_count AS c FROM launches WHERE exemption_source = 'logs' AND snipe_exemption_count > 1 ORDER BY c")
    .all() as { c: number }[];
  // The same floor every other median here observes: a median of four is an
  // anecdote wearing a statistic's clothes, and this one will be quoted.
  const median = counts.length >= MIN_BENCHMARK_SAMPLES
    ? (counts.length % 2
      ? counts[counts.length >> 1]!.c
      : (counts[(counts.length >> 1) - 1]!.c + counts[counts.length >> 1]!.c) / 2)
    : null;

  const stats: ApiStats = {
    index: { launches, decoded, read_from_curve_events: fromLogs },
    exemptions: {
      with_any: withAny,
      beyond_deployer: beyond,
      beyond_deployer_pct: fromLogs > 0 ? Math.round((beyond / fromLogs) * 1000) / 10 : 0,
      median_count_beyond_deployer: median,
      median_sample: counts.length,
    },
    declarations: q('SELECT COUNT(*) n FROM launch_declarations'),
    as_of: new Date(now).toISOString(),
  };
  return { status: 200, body: stats };
}

/** GET /v1/health */
export async function getHealth(now = Date.now()): Promise<Outcome> {
  const { head, indexed, lag } = await lagBlocks();
  const ok = lag !== null && lag <= MAX_LAG_BLOCKS;
  const health: ApiHealth = {
    ok,
    head_block: head,
    indexed_to_block: indexed,
    lag_blocks: lag,
    as_of: new Date(now).toISOString(),
  };
  // 200 either way: /health answering is the point, and a monitor reads `ok`.
  return { status: 200, body: health };
}

/** Whether a launch-answering request may be served at all. */
export async function lagRefusal(): Promise<Outcome | null> {
  const { lag } = await lagBlocks();
  if (lag === null || lag > MAX_LAG_BLOCKS) {
    return {
      status: 503,
      body: {
        error: 'index_lagging',
        lag_blocks: lag,
        max_lag_blocks: MAX_LAG_BLOCKS,
      } satisfies ApiError,
      headers: { 'retry-after': '30' },
    };
  }
  return null;
}

export { indexCoverage };


// ----------------------------------------------------------------- revenue

/** Sixty seconds, as specified. Long enough that a post to a room cannot bill us. */
export const REVENUE_CACHE_MS = Number(process.env.REVENUE_CACHE_MS || 60_000) || 60_000;

let revenueHit: { at: number; body: Revenue } | null = null;

/** For tests: the cache is a module-level fact and has to be clearable. */
export function resetRevenueCache(): void {
  revenueHit = null;
}

/**
 * GET /v1/revenue
 *
 * Public and keyless, like /stats. It names no wallet but the fee wallet
 * itself, which is on chain and in the declaration, and no seat, no handle and
 * no amount owed to any individual.
 */
export async function getRevenue(now = Date.now()): Promise<Outcome> {
  if (revenueHit && now - revenueHit.at < REVENUE_CACHE_MS) {
    return { status: 200, body: revenueHit.body, headers: { 'x-cache': 'hit', 'cache-control': 'public, max-age=60' } };
  }
  const [balanceWei, head] = await Promise.all([
    feeWalletBalance().catch(() => null),
    lagBlocks().then((l) => l.head).catch(() => null),
  ]);
  const body = buildRevenue({ balanceWei, headBlock: head, now });
  revenueHit = { at: now, body };
  return { status: 200, body, headers: { 'x-cache': 'miss', 'cache-control': 'public, max-age=60' } };
}
