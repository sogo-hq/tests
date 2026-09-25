import { isPubkey } from './config.js';

/**
 * Metadata from the platform's own API.
 *
 * Metadata and nothing else. Which platform a launch belongs to is decided by
 * the pinned config pubkey read from the creation transaction, and no field
 * here can change that: the API is a party with an interest in what it says
 * about its own launches, so it may tell us a name and never what something IS.
 *
 * What was read on 2026-09-25, from this environment, with no key:
 *
 *   /api/platform-pools?page=N   the listing. 30 rows a page, and `page` is the
 *                                ONLY pagination key that does anything: limit,
 *                                offset and cursor are all accepted and all
 *                                ignored, so a seeder that trusted one of them
 *                                would page over page one forever.
 *   /api/recent-launches         a time window, not a page. It carries windowMs
 *                                and no cursor, so it is the live feed and is
 *                                not a backfill source.
 *   /api/quote-tokens            the quote asset catalogue, with the platform's
 *                                own category and a launchLabReady flag.
 *   /api/tokens                  answers 200 with {"tokens": []} and appears
 *                                nowhere in the site's own bundle. Vestigial.
 *                                It is not the listing and never was.
 *
 * No key was needed and nothing was geo-blocked. The empty answer earlier was
 * the wrong route, not a wall.
 */

/** Rows a page of the listing carries. Not a parameter: the server decides. */
export const PAGE_SIZE = 30;

const BASE = 'https://www.stonkfun.xyz';
export const ENDPOINTS = {
  listing: `${BASE}/api/platform-pools`,
  recent: `${BASE}/api/recent-launches`,
  quotes: `${BASE}/api/quote-tokens`,
} as const;

/**
 * The fields this path refuses to carry, named rather than merely omitted.
 *
 * priceUsd is a price and priceChange24h is a price direction, which is the
 * one thing that was taken out of every card in this project on purpose. They
 * are dropped at the boundary rather than at render, because a field that is in
 * the store is a field somebody will render one day.
 *
 * Market cap, FDV, volume and the peak stay: those are quantities, and the
 * distinction is deliberate and was decided before this was built.
 */
export const REFUSED_FIELDS = ['priceUsd', 'priceChange24h', 'priceChange', 'price'] as const;

export interface SeedToken {
  mint: string;
  pool: string | null;
  name: string | null;
  symbol: string | null;
  /** The quote asset, by mint. The symbol alone is never sufficient. */
  quoteMint: string | null;
  /** The platform's OWN claims about the quote. Never our reading of it. */
  claimedQuoteSymbol: string | null;
  claimedQuoteCategory: string | null;
  claimedQuoteVerification: string | null;
  /** The platform's claim about the launch mode and its transfer tax. */
  claimedRewardLaunch: boolean | null;
  claimedTransferTaxBps: number | null;
  /** Quantities, which are allowed. Never a price and never a direction. */
  marketCapUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  peakMarketCapUsd: number | null;
  graduationProgress: number | null;
  status: string | null;
  createdAt: string | null;
}

export type SeedPage =
  | { ok: true; tokens: SeedToken[]; rows: number; empty: boolean }
  | { ok: false; reason: string };

const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/**
 * One row, with everything the platform asserts kept as an assertion.
 *
 * Every field the platform decides rather than measures is named "claimed".
 * That is not decoration: transferTaxBps is a number the platform prints about
 * a mint whose real rate is readable off the mint, and the two disagreeing is a
 * finding. Naming them the same thing would lose the ability to notice.
 */
export function parseRow(row: unknown): SeedToken | null {
  const r = row as Record<string, unknown>;
  if (!r || typeof r !== 'object') return null;
  const mint = str(r.mint) ?? str(r.address) ?? str(r.tokenAddress);
  // The mint is what every later read joins on. A row that cannot be joined
  // would be attached to the wrong launch later, so it is dropped now.
  if (!isPubkey(mint)) return null;
  const pool = str(r.pool);
  return {
    mint,
    pool: isPubkey(pool) ? pool : null,
    name: str(r.name),
    symbol: str(r.symbol) ?? str(r.ticker),
    quoteMint: isPubkey(str(r.quoteMint)) ? str(r.quoteMint) : null,
    claimedQuoteSymbol: str(r.quoteSymbol),
    claimedQuoteCategory: str(r.quoteCategory),
    claimedQuoteVerification: str(r.quoteVerification),
    claimedRewardLaunch: bool(r.isRewardLaunch),
    claimedTransferTaxBps: num(r.transferTaxBps),
    marketCapUsd: num(r.marketCapUsd),
    fdvUsd: num(r.fdvUsd),
    volume24hUsd: num(r.volume24hUsd),
    peakMarketCapUsd: num(r.peakMarketCapUsd),
    graduationProgress: num(r.graduationProgress),
    status: str(r.status),
    createdAt: str(r.createdAt),
  };
}

export function parsePage(body: unknown): SeedPage {
  const rows = (body as { pools?: unknown; tokens?: unknown })?.pools
    ?? (body as { tokens?: unknown })?.tokens;
  if (!Array.isArray(rows)) return { ok: false, reason: 'the response carried no pools array' };
  const tokens: SeedToken[] = [];
  for (const row of rows) {
    const t = parseRow(row);
    if (t) tokens.push(t);
  }
  return { ok: true, tokens, rows: rows.length, empty: rows.length === 0 };
}

export interface FetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function getJson(url: string, opts: FetchOptions): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) return { ok: false, reason: `${url} answered http ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, reason: `${url} could not be read: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
}

/** One page of the listing. `page` is one-based, as the server counts. */
export async function listingPage(page: number, opts: FetchOptions = {}): Promise<SeedPage> {
  const r = await getJson(`${ENDPOINTS.listing}?page=${page}`, opts);
  return r.ok ? parsePage(r.body) : r;
}

/**
 * The live window. Not a backfill source and not treated as one.
 *
 * It carries windowMs and no cursor, so asking it twice gives whatever landed
 * in the last window both times. A caller walking it for history would get the
 * same rows until it gave up.
 */
export async function recentLaunches(opts: FetchOptions = {}): Promise<SeedPage & { windowMs?: number | null }> {
  const r = await getJson(ENDPOINTS.recent, opts);
  if (!r.ok) return r;
  const page = parsePage(r.body);
  const windowMs = num((r.body as { windowMs?: unknown })?.windowMs);
  return { ...page, windowMs };
}

export interface QuoteEntry {
  quoteMint: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  /** The platform's category and readiness claim. Both are claims. */
  claimedCategory: string | null;
  claimedLaunchLabReady: boolean | null;
}

export async function quoteCatalogue(
  opts: FetchOptions = {},
): Promise<{ ok: true; quotes: QuoteEntry[] } | { ok: false; reason: string }> {
  const r = await getJson(ENDPOINTS.quotes, opts);
  if (!r.ok) return r;
  const rows = (r.body as { quoteTokens?: unknown })?.quoteTokens;
  if (!Array.isArray(rows)) return { ok: false, reason: 'the quote catalogue carried no quoteTokens array' };
  const quotes: QuoteEntry[] = [];
  for (const row of rows) {
    const q = row as Record<string, unknown>;
    const quoteMint = str(q.quoteMint);
    if (!isPubkey(quoteMint)) continue;
    quotes.push({
      quoteMint,
      symbol: str(q.symbol),
      name: str(q.name),
      decimals: num(q.decimals),
      claimedCategory: str(q.category),
      claimedLaunchLabReady: bool(q.launchLabReady),
    });
  }
  return { ok: true, quotes };
}

/**
 * Walk the listing until it stops giving new rows.
 *
 * Three stopping conditions, and the middle one is the one that matters. A
 * listing that ignores its page parameter returns page one forever, and a
 * listing at its last page was observed returning a short page rather than an
 * empty one, so neither "empty" nor "short" alone is a reliable end.
 */
export async function seed(
  { pages = 200, ...rest }: FetchOptions & { pages?: number } = {},
): Promise<{ tokens: SeedToken[]; pagesRead: number; stopped: string }> {
  const tokens: SeedToken[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const got = await listingPage(page, rest);
    if (!got.ok) return { tokens, pagesRead: page - 1, stopped: got.reason };
    if (got.empty) {
      return {
        tokens, pagesRead: page - 1,
        stopped: page === 1 ? 'the listing answered with no rows at all' : 'the listing ran out of rows',
      };
    }
    const fresh = got.tokens.filter((t) => !seen.has(t.mint));
    for (const t of fresh) { seen.add(t.mint); tokens.push(t); }
    if (!fresh.length) {
      return { tokens, pagesRead: page, stopped: 'the listing repeated a page, so paging stopped' };
    }
    if (got.rows < PAGE_SIZE) {
      return { tokens, pagesRead: page, stopped: 'the listing gave a short page, which is its last' };
    }
  }
  return { tokens, pagesRead: pages, stopped: `stopped at the ${pages} page bound` };
}

/** What a card says about a name that came from the platform rather than chain. */
export function metadataLine(t: SeedToken | null): string {
  if (!t) return 'name: not in the platform listing, undetermined';
  const name = t.name ?? 'unnamed';
  const symbol = t.symbol ? ` (${t.symbol})` : '';
  return `name: ${name}${symbol}, as the platform lists it`;
}

/**
 * The platform's claimed transfer tax against the rate read off the mint.
 *
 * A disagreement is a finding and not a correction: we do not know which is
 * wrong, only that the platform is printing one number about a mint that
 * carries another.
 */
export function taxClaimLine(claimedBps: number | null, readBps: number | null): string | null {
  if (claimedBps === null || readBps === null) return null;
  if (claimedBps === readBps) return null;
  return `the platform lists a transfer tax of ${claimedBps} bps and the mint carries ${readBps} bps`;
}
