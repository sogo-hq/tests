/**
 * The fomoradar leaderboard, robinx smart holders, and the overlap.
 *
 * Two outside sources, neither of them this chain's node, so everything here
 * is parsing and set arithmetic and nothing here makes a request. The tool in
 * tools/fomo_intersect.mjs does the fetching and the paying; this is the part
 * that can be tested against a fixture, which is most of what can go wrong:
 * a leaderboard whose field moved, a paid call that answered in a shape
 * nobody expected, and an intersection done on addresses of different case.
 *
 * The host is pinned as a constant and never derived from anything, the same
 * rule the RPC and explorer hosts follow. A lookalike leaderboard is as easy
 * to stand up as a lookalike explorer.
 */

/** Pinned. Never resolved, never taken from a search result or a redirect. */
export const FOMORADAR_HOST = 'https://fomoradar.app';

/** Traders at or above this are worth a second list of their own. */
export const FOMO_TOP_SCORE = 74;

export interface FomoTrader {
  handle: string;
  /** Lowercased, because it is the join key. */
  address: string;
  score: number;
  /** The API returns a list: a trader is often more than one thing. */
  style: string[];
  status: string;
  fomoPnl: number | null;
  redFlags: string[];
  summary: string;
}

/**
 * The leaderboard, from GET /api/leaderboard.
 *
 * A trader with no address cannot be intersected with anything, so it is
 * dropped and counted rather than carried through as a row that can never
 * match. Everything else is kept as given.
 */
export function parseLeaderboard(raw: unknown): { traders: FomoTrader[]; skipped: number } {
  const body = raw as { traders?: unknown[] } | null;
  const list = Array.isArray(body?.traders) ? body!.traders! : Array.isArray(raw) ? (raw as unknown[]) : [];
  const traders: FomoTrader[] = [];
  let skipped = 0;
  for (const item of list) {
    const t = item as Record<string, unknown>;
    const address = typeof t.address === 'string' ? t.address.trim().toLowerCase() : '';
    const handle = typeof t.handle === 'string' ? t.handle.trim() : '';
    if (!/^0x[0-9a-f]{40}$/.test(address) || !handle) { skipped++; continue; }
    traders.push({
      handle,
      address,
      score: Number.isFinite(Number(t.score)) ? Number(t.score) : 0,
      // Tolerated as a string too: one field that turns from a list into a
      // string upstream should not empty the style column.
      style: Array.isArray(t.style)
        ? t.style.filter((s): s is string => typeof s === 'string')
        : typeof t.style === 'string' && t.style ? [t.style] : [],
      status: typeof t.status === 'string' ? t.status : '',
      fomoPnl: Number.isFinite(Number(t.fomo_pnl)) ? Number(t.fomo_pnl) : null,
      redFlags: Array.isArray(t.red_flags) ? t.red_flags.filter((s): s is string => typeof s === 'string') : [],
      summary: typeof t.summary === 'string' ? t.summary : '',
    });
  }
  return { traders, skipped };
}

export interface SmartHolders {
  wallets: string[];
  /** Whatever the paid call gave back as proof of payment, if anything. */
  receipt: string | null;
}

const ADDRESS_KEYS = ['address', 'wallet', 'holder', 'owner', 'account'];
const LIST_KEYS = ['holders', 'smart_holders', 'smartHolders', 'wallets', 'results', 'items', 'data'];

/**
 * Smart holders, out of whatever the MCP call wrapped them in.
 *
 * Deliberately tolerant. This is a paid call to somebody else's server,
 * reached through an MCP transport that wraps a result in content parts, and
 * the shape is not this repository's to fix. So: unwrap the JSON-RPC envelope
 * if there is one, unwrap the MCP content part if there is one, parse the text
 * inside it if it is JSON, then look for a list of holders in the usual places.
 *
 * Tolerant is not the same as greedy. It looks for addresses in fields that
 * name a holder, never for every hex string anywhere in the payload: the token
 * being asked about is in there too, and collecting that would make the token
 * its own holder in every intersection.
 */
export function parseSmartHolders(raw: unknown): SmartHolders {
  const payload = unwrap(raw);
  const receipt = findReceipt(raw) ?? findReceipt(payload);
  const list = findList(payload);
  const wallets: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const a = addressOf(entry);
    if (!a || seen.has(a)) continue;
    seen.add(a);
    wallets.push(a);
  }
  return { wallets, receipt };
}

function asJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    // Not JSON. That is an answer too: the caller gets no holders from it.
    return null;
  }
}

/** Peel the JSON-RPC envelope and the MCP content part, if present. */
function unwrap(raw: unknown): unknown {
  let node: any = raw;
  if (typeof node === 'string') node = asJson(node) ?? node;
  if (node && typeof node === 'object' && 'result' in node) node = (node as any).result;
  if (node && typeof node === 'object') {
    if ((node as any).structuredContent) return (node as any).structuredContent;
    const content = (node as any).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
          const inner = asJson((part as any).text);
          if (inner !== null) return inner;
        }
      }
    }
  }
  return node;
}

function findList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  for (const k of LIST_KEYS) {
    if (Array.isArray(obj[k])) return obj[k] as unknown[];
  }
  // One level down, for a payload that nests its answer under a name this
  // does not know. Bounded to one level on purpose.
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of LIST_KEYS) {
        const inner = (v as Record<string, unknown>)[k];
        if (Array.isArray(inner)) return inner;
      }
    }
  }
  return [];
}

function addressOf(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const a = entry.trim().toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const obj = entry as Record<string, unknown>;
  for (const k of ADDRESS_KEYS) {
    const v = obj[k];
    if (typeof v === 'string') {
      const a = v.trim().toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(a)) return a;
    }
  }
  return null;
}

/** A payment receipt, wherever the transport chose to put it. */
function findReceipt(raw: unknown): string | null {
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > 4 || !node || typeof node !== 'object') return null;
    const obj = node as Record<string, unknown>;
    for (const k of ['receipt', 'x402_receipt', 'paymentReceipt', 'payment_receipt', 'settlement']) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object') {
        const tx = (v as Record<string, unknown>).txHash ?? (v as Record<string, unknown>).transaction
          ?? (v as Record<string, unknown>).hash;
        if (typeof tx === 'string' && tx.trim()) return tx.trim();
      }
    }
    for (const v of Object.values(obj)) {
      const found = walk(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(raw, 0);
}

export interface TokenHolders {
  /** The ticker as it goes in the CSV. */
  symbol: string;
  address: string;
  holders: string[];
  receipt: string | null;
}

export interface Candidate {
  handle: string;
  score: number;
  style: string[];
  address: string;
  /** The tickers of the tokens this wallet holds, in the order asked for. */
  tokens: string[];
  receipts: string[];
  fomoPnl: number | null;
  redFlags: string[];
}

/**
 * The overlap: scored traders who hold at least one of the tokens.
 *
 * Joined on the address, lowercased on both sides. The leaderboard gives them
 * lowercase and a chain tool gives them checksummed, and an intersection of
 * two sets of the same addresses in different cases is empty and looks like a
 * finding.
 *
 * Ordered by score, then by how many of the tokens they hold, then by handle,
 * so the same inputs give the same file every time.
 */
export function intersect(traders: FomoTrader[], tokens: TokenHolders[]): Candidate[] {
  const byWallet = new Map<string, { symbols: string[]; receipts: string[] }>();
  for (const t of tokens) {
    for (const raw of t.holders) {
      const w = raw.trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(w)) continue;
      const entry = byWallet.get(w) ?? { symbols: [], receipts: [] };
      if (!entry.symbols.includes(t.symbol)) entry.symbols.push(t.symbol);
      if (t.receipt && !entry.receipts.includes(t.receipt)) entry.receipts.push(t.receipt);
      byWallet.set(w, entry);
    }
  }
  const out: Candidate[] = [];
  for (const tr of traders) {
    const hit = byWallet.get(tr.address);
    if (!hit) continue;
    out.push({
      handle: tr.handle, score: tr.score, style: tr.style, address: tr.address,
      tokens: hit.symbols, receipts: hit.receipts, fomoPnl: tr.fomoPnl, redFlags: tr.redFlags,
    });
  }
  return out.sort((a, b) =>
    b.score - a.score || b.tokens.length - a.tokens.length || a.handle.localeCompare(b.handle));
}

/** Traders at or above the cut, highest first. */
export function topTraders(traders: FomoTrader[], minScore = FOMO_TOP_SCORE): FomoTrader[] {
  return traders
    .filter((t) => t.score >= minScore)
    .sort((a, b) => b.score - a.score || (b.fomoPnl ?? 0) - (a.fomoPnl ?? 0) || a.handle.localeCompare(b.handle));
}

/**
 * One CSV cell, quoted when it has to be.
 *
 * A summary from the leaderboard has commas in it and sometimes quotes, and a
 * file that shifts every column after one of them is a file that gets read
 * wrong rather than rejected.
 */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export function candidatesCsv(rows: Candidate[]): string {
  return [
    csvRow(['username', 'fomo_score', 'style', 'wallet', 'tokens_held', 'token_count', 'robinx_receipt', 'fomo_pnl', 'red_flags']),
    ...rows.map((r) => csvRow([
      r.handle, r.score, r.style.join(' '), r.address, r.tokens.join(' '), r.tokens.length,
      r.receipts.join(' '), r.fomoPnl ?? '', r.redFlags.join(' '),
    ])),
  ].join('\n') + '\n';
}

export function topCsv(rows: FomoTrader[]): string {
  return [
    csvRow(['username', 'fomo_score', 'style', 'wallet', 'fomo_pnl', 'red_flags']),
    ...rows.map((r) => csvRow([
      r.handle, r.score, r.style.join(' '), r.address, r.fomoPnl ?? '', r.redFlags.join(' '),
    ])),
  ].join('\n') + '\n';
}
