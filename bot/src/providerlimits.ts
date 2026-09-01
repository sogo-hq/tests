import { db } from './db.js';
import { RPC_URL } from './config.js';

/**
 * The widest eth_getLogs block range this provider will actually serve.
 *
 * Discovered rather than assumed, because it is not the same number twice:
 *
 *   public node   ~3.9M on an address-scoped query
 *   Goldsky        10,000
 *   Alchemy free   10
 *
 * The indexer assumed 500,000 (FACTORY_LOG_CHUNK) and, when told no, halved the
 * range in parallel with a floor of 2,000 blocks. Against a 10-block cap that
 * floor makes success impossible: it descends 500,000 -> 1,954, gives up, and
 * throws. Measured, one such chunk cost 255 getLogs calls -- 1,020 HTTP
 * requests once viem's retryCount of 3 is counted -- to then fail.
 *
 * That alone was survivable. What made it fatal is that a deploy starts with an
 * empty database (no persistent volume), so there is no cursor, so indexNew()
 * calls backfill(), which asks for seven days: thirteen such chunks. It failed,
 * so no cursor was ever written, so the next tick asked for the same seven days
 * again. 32,000 times, 31 hours, the same error.
 *
 * So: discover the ceiling once, write it down, and size every chunk to it.
 * A tighter provider then costs more requests, which is the correct way to
 * degrade, instead of costing the index entirely.
 */

/**
 * Keyed by endpoint, so pointing RPC_URL at a different provider re-discovers
 * rather than inheriting a number that was true of somewhere else. That is what
 * makes switching providers need no code change.
 */
function endpointKey(): string {
  try {
    const u = new URL(RPC_URL);
    // Host and path shape, never the API key: this row is written to a database
    // that gets copied around, and a key in it would leak with it.
    return `${u.protocol}//${u.host}`;
  } catch (err) {
    // A malformed RPC_URL is refused at config load, so reaching here means
    // something stranger; key off the raw string rather than losing the row.
    console.warn(`[index] could not parse RPC_URL for the limits key: ${String((err as Error)?.message ?? err).slice(0, 60)}`);
    return RPC_URL.slice(0, 80);
  }
}

/**
 * How long a discovered ceiling is trusted before it is found again.
 *
 * Providers change: a plan is upgraded, a limit is raised, a proxy is swapped.
 * Without this the first cramped answer would be permanent, and a bot on a paid
 * plan would keep behaving like one on the free tier. Re-discovery costs about
 * sixteen sequential requests, which once a day is nothing.
 */
const TTL_SECONDS = Number(process.env.PROVIDER_LIMIT_TTL_SECONDS || 86_400) || 86_400;

let announced = false;

export interface ProviderLimit {
  maxSpan: bigint;
  discoveredAt: number;
}

/** The stored ceiling for this endpoint, or null if unknown or stale. */
export function learnedMaxSpan(now = Math.floor(Date.now() / 1000)): bigint | null {
  const row = db
    .prepare('SELECT max_span, discovered_at FROM provider_limits WHERE endpoint = ?')
    .get(endpointKey()) as { max_span: number; discovered_at: number } | undefined;
  if (!row) return null;
  if (now - row.discovered_at > TTL_SECONDS) return null;
  return BigInt(row.max_span);
}

/**
 * Write down a span the provider actually served.
 *
 * Only ever lowers within a discovery run -- a wider span succeeding later is
 * how the ceiling rises again after the TTL, and taking the widest success
 * would let one lucky large query undo the whole discovery.
 */
export function recordServedSpan(span: bigint, now = Math.floor(Date.now() / 1000)): void {
  if (span <= 0n) return;
  const existing = learnedMaxSpan(now);
  if (existing !== null && span <= existing) return;

  db.prepare(
    `INSERT INTO provider_limits (endpoint, max_span, discovered_at) VALUES (?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET max_span = excluded.max_span,
                                         discovered_at = excluded.discovered_at`,
  ).run(endpointKey(), Number(span), now);
  announce(span);
}

/**
 * Write down that a span was refused, lowering the ceiling below it.
 *
 * Recorded as the failure happens rather than only on eventual success, so a
 * process that dies mid-discovery does not start from 500,000 again.
 */
export function recordRefusedSpan(span: bigint, now = Math.floor(Date.now() / 1000)): void {
  if (span <= 1n) return;
  const ceiling = span / 2n;
  const existing = learnedMaxSpan(now);
  if (existing !== null && existing <= ceiling) return;
  db.prepare(
    `INSERT INTO provider_limits (endpoint, max_span, discovered_at) VALUES (?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET max_span = excluded.max_span,
                                         discovered_at = excluded.discovered_at`,
  ).run(endpointKey(), Number(ceiling), now);
}

/** Said once per process, so a restart confirms it and a busy log does not repeat it. */
function announce(span: bigint): void {
  if (announced) return;
  announced = true;
  console.log(`[index] provider accepts ${Number(span).toLocaleString()} block ranges`);
}

/** For tests. */
export function resetProviderLimits(): void {
  announced = false;
  db.prepare('DELETE FROM provider_limits').run();
}

/** For /stats and the operator. */
export function providerLimitLine(): string {
  const span = learnedMaxSpan();
  return span === null
    ? 'provider log range not yet measured'
    : `provider accepts ${Number(span).toLocaleString()} block ranges`;
}
