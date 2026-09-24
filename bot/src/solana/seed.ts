import { isPubkey } from './config.js';

/**
 * Metadata from the platform's own API.
 *
 * Metadata and nothing else. Which platform a launch belongs to is decided by
 * the pinned config pubkey read from the creation transaction, and no field
 * here can change that: the API is a party with an interest in what it says
 * about its own launches, so it is allowed to tell us a name and a description
 * and never allowed to tell us what something IS.
 *
 * Read on 2026-09-24: https://www.stonkfun.xyz/api/tokens answers 200 with
 * {"tokens": []} for every shape tried, including a known mint. The endpoint
 * exists and returns nothing from here. So an empty page is an explicit,
 * reportable state rather than "there are no launches", and the scan path does
 * not depend on this source being up: with no metadata a card is missing a
 * name, not missing a launch.
 */

export interface SeedToken {
  mint: string;
  name: string | null;
  symbol: string | null;
  /** The platform's own claim that this symbol is not unique. A second party. */
  symbolAmbiguous: boolean | null;
}

export type SeedPage =
  | { ok: true; tokens: SeedToken[]; empty: boolean }
  | { ok: false; reason: string };

export const SEED_BASE = 'https://www.stonkfun.xyz/api/tokens';

/** One field, and only when it is the type it should be. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Take only what is recognisably a token row.
 *
 * A row without a valid mint is dropped rather than carried with an empty key:
 * the mint is what every later read joins on, and a row that cannot be joined
 * is a row that would later be attached to the wrong launch.
 */
export function parseSeedPage(body: unknown): SeedPage {
  const rows = (body as { tokens?: unknown })?.tokens;
  if (!Array.isArray(rows)) return { ok: false, reason: 'the response carried no tokens array' };
  const tokens: SeedToken[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const mint = str(r.mint) ?? str(r.address) ?? str(r.tokenAddress);
    if (!isPubkey(mint)) continue;
    tokens.push({
      mint,
      name: str(r.name),
      symbol: str(r.symbol) ?? str(r.ticker),
      symbolAmbiguous: typeof r.symbolAmbiguous === 'boolean' ? r.symbolAmbiguous : null,
    });
  }
  return { ok: true, tokens, empty: rows.length === 0 };
}

export interface SeedOptions {
  limit?: number;
  offset?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchSeedPage(opts: SeedOptions = {}): Promise<SeedPage> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${SEED_BASE}?limit=${opts.limit ?? 100}&offset=${opts.offset ?? 0}`;
  try {
    const res = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) return { ok: false, reason: `the token listing answered http ${res.status}` };
    return parseSeedPage(await res.json());
  } catch (err) {
    return { ok: false, reason: `the token listing could not be read: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
}

/**
 * Pages until a page comes back short, empty, or repeats itself.
 *
 * The repeat guard is not defensive dressing. A listing that ignores `offset`
 * returns page one forever, and a loop that trusted the offset would page
 * until it ran out of whatever it was counting.
 */
export async function seed(
  { pages = 50, limit = 100, ...rest }: SeedOptions & { pages?: number } = {},
): Promise<{ tokens: SeedToken[]; pagesRead: number; stopped: string }> {
  const tokens: SeedToken[] = [];
  const seen = new Set<string>();
  for (let p = 0; p < pages; p++) {
    const page = await fetchSeedPage({ ...rest, limit, offset: p * limit });
    if (!page.ok) return { tokens, pagesRead: p, stopped: page.reason };
    if (page.empty) {
      return {
        tokens, pagesRead: p,
        stopped: p === 0
          ? 'the token listing answered with no rows at all'
          : 'the listing ran out of rows',
      };
    }
    const fresh = page.tokens.filter((t) => !seen.has(t.mint));
    for (const t of fresh) { seen.add(t.mint); tokens.push(t); }
    if (!fresh.length) {
      return { tokens, pagesRead: p + 1, stopped: 'the listing repeated a page, so paging stopped' };
    }
    if (page.tokens.length < limit) {
      return { tokens, pagesRead: p + 1, stopped: 'the listing ran out of rows' };
    }
  }
  return { tokens, pagesRead: pages, stopped: `stopped at the ${pages} page bound` };
}

/** What a card says about a name it got from the platform rather than chain. */
export function metadataLine(t: SeedToken | null): string {
  if (!t) return 'name: not in the platform listing, undetermined';
  const name = t.name ?? 'unnamed';
  const symbol = t.symbol ? ` (${t.symbol})` : '';
  return `name: ${name}${symbol}, as the platform lists it`;
}
