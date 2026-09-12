/**
 * Who is calling, and how fast they may.
 *
 * Keyless requests are allowed deliberately. A partner evaluating the contract
 * should be able to curl an endpoint from the documentation and see a real
 * answer without an onboarding step, and a rate low enough to be useless for
 * production is the right way to make that free.
 */

export type Tier = 'keyless' | 'public' | 'partner';

/** Requests per second by tier. */
export const RATES: Record<Tier, number> = {
  keyless: Number(process.env.API_RPS_KEYLESS || 1) || 1,
  public: Number(process.env.API_RPS_PUBLIC || 5) || 5,
  partner: Number(process.env.API_RPS_PARTNER || 60) || 60,
};

/**
 * A burst of one second's worth.
 *
 * Small on purpose: the limit is a rate, and a deep bucket turns a 60 rps
 * partner into a 600-request spike that lands on the same node the bot reads.
 */
const BURST_SECONDS = Math.max(1, Number(process.env.API_BURST_SECONDS || 2) || 2);

let parsed: Map<string, Tier> | null = null;
let parsedFrom = '';

/**
 * API_KEYS as "key:tier,key:tier".
 *
 * Re-parsed when the variable changes so a key can be added without a restart.
 * An entry naming a tier that does not exist is dropped and logged rather than
 * quietly treated as public: a typo that silently grants the wrong rate is
 * worse than a key that does not work and says so in the log.
 */
function keys(): Map<string, Tier> {
  const raw = process.env.API_KEYS ?? '';
  if (parsed && parsedFrom === raw) return parsed;
  const map = new Map<string, Tier>();
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const at = entry.lastIndexOf(':');
    const key = at === -1 ? entry : entry.slice(0, at);
    const tier = at === -1 ? 'public' : entry.slice(at + 1).trim().toLowerCase();
    if (!key) continue;
    if (tier !== 'public' && tier !== 'partner') {
      console.warn(`[api] ignoring key with unknown tier "${tier.slice(0, 24)}"`);
      continue;
    }
    map.set(key, tier);
  }
  parsed = map;
  parsedFrom = raw;
  return map;
}

export interface Caller {
  /** The bucket this request is counted against. */
  id: string;
  tier: Tier;
}

/**
 * Identify the caller.
 *
 * A key is taken from Authorization: Bearer, or from X-API-Key, or from an
 * `key` query parameter, because a partner's first call is a curl and the
 * header is the thing people get wrong. An unrecognised key is NOT an error:
 * it is a keyless request, served at the evaluation rate, which fails loudly
 * enough through the rate limit without a 401 in the way of an evaluation.
 */
export function callerOf(headers: Record<string, string | string[] | undefined>, url: URL): Caller {
  const auth = String(headers['authorization'] ?? '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  const header = String(headers['x-api-key'] ?? '').trim();
  const query = url.searchParams.get('key')?.trim() ?? '';
  const presented = bearer || header || query;

  const tier = presented ? keys().get(presented) : undefined;
  if (presented && tier) return { id: `key:${presented}`, tier };
  // Every keyless caller shares one bucket. Per-IP would be more generous and
  // also trivially defeated, and the point of the keyless rate is that it is
  // enough to evaluate the contract and not enough to build on.
  return { id: 'keyless', tier: 'keyless' };
}

interface Bucket { tokens: number; last: number }
const buckets = new Map<string, Bucket>();

export interface Decision {
  allowed: boolean;
  /** Whole seconds, for the Retry-After header. Always at least 1. */
  retryAfter: number;
  limit: number;
}

export function consume(caller: Caller, now = Date.now()): Decision {
  const rate = RATES[caller.tier];
  const capacity = rate * BURST_SECONDS;
  const b = buckets.get(caller.id) ?? { tokens: capacity, last: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * rate);
  b.last = now;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(caller.id, b);
    return { allowed: true, retryAfter: 0, limit: rate };
  }
  buckets.set(caller.id, b);
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate)), limit: rate };
}

/** For tests, and for a key list changed at runtime. */
export function resetApiLimits(): void {
  buckets.clear();
  parsed = null;
  parsedFrom = '';
}
