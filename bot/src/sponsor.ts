import type { Address } from 'viem';
import { client } from './chain.js';
import { factoryAbi } from './abi.js';
import { FACTORY } from './config.js';
import { bulk } from './ratelimit.js';

/**
 * The one paid line on a card, and the rules that stop it eating the product.
 *
 * This is how the project gets funded. It is also the single largest threat to
 * the only thing the product sells, which is that a card states facts and makes
 * no call. So the line is constrained rather than trusted:
 *
 *   It points at a SCAN, never at a buy. We sell attention, not a
 *   recommendation, and the difference is the whole business.
 *
 *   It never varies. Not by token, not by flag count, not by outcome. A
 *   sponsor cannot buy a different card, and the way to guarantee that is for
 *   the renderer to have nothing to vary on -- sponsorLine() takes no
 *   arguments, so there is no scan for it to read.
 *
 *   An address in it must be a real pons v2 launch, checked against the
 *   factory. A paid line pointing at something that does not exist is the
 *   product endorsing a scam by omission.
 *
 * Rejection is loud and total: the line does not render, and the reason is
 * logged once. Half-accepting a line is worse than dropping it.
 */

/** Read at send time, so a line can change without a deploy. */
function configured(): string {
  return (process.env.SPONSOR_LINE ?? '').trim();
}

/**
 * Language that turns attention into advice.
 *
 * Matched on word boundaries against text with tickers and addresses REMOVED --
 * see maskSubjects(). A token legitimately called $MOON or $GEM may sponsor;
 * the line still may not tell anyone that something will moon. The distinction
 * is between naming a subject and making a promise about it, and it matters
 * because the first example line we were given is "$MOON is live on pons".
 */
const BANNED = [
  /\bbuy(s|ing)?\b/i,
  /\bape(s|d|ing)?\b/i,
  /\bmoon(s|ing|ed)?\b/i,
  /\bgem(s)?\b/i,
  /\bpump(s|ing|ed)?\b/i,
  /\bsend it\b/i,
  /\bdo(n'|n’)?t miss\b/i,
  /\bdont miss\b/i,
  // Any multiple: 100x, 10X, 2.5x.
  /\b\d+(\.\d+)?\s*x\b/i,
];

/** A percentage in any of the shapes people write one. */
const PERCENT = /(\d+(\.\d+)?\s*%)|(\b\d+(\.\d+)?\s*percent\b)/i;

/**
 * A price.
 *
 * "$" followed by a DIGIT -- "$MOON" is a ticker and must survive, "$0.004" is
 * a price and must not. Also a bare number attached to an asset or currency,
 * which is how a price gets written when the dollar sign is not to hand.
 */
const PRICE = [
  /\$\s*\d/,
  /\b\d+(\.\d+)?\s*(eth|weth|usd|usdc|usdt|dollars?|cents?)\b/i,
  /\b(mc|mcap|market cap|fdv)\b/i,
];

const ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const TICKER_RE = /\$[A-Za-z][A-Za-z0-9_]{0,15}\b/g;

/** Longest a sponsor line may be. One line on a card, not a paragraph. */
export const MAX_SPONSOR_LEN = 120;

/**
 * The dashes this bot does not print, by code point.
 *
 * Written as code points rather than as characters or escapes because the
 * guard that keeps them out of the source would otherwise flag this line,
 * which is the line that keeps them out of the product.
 */
const LONG_DASHES = [0x2013, 0x2014].map((c) => String.fromCharCode(c));

/**
 * Blank out the things a line is allowed to NAME before checking what it SAYS.
 *
 * Without this, a sponsor called $MOON could never be named, and an address
 * containing the letters "ape" would fail on a word-boundary match.
 */
function maskSubjects(text: string): string {
  return text.replace(ADDRESS_RE, ' 0xADDR ').replace(TICKER_RE, ' $TICKER ');
}

export interface SponsorCheck {
  ok: boolean;
  reason?: string;
  /** Full addresses in the line, which must exist before it may render. */
  addresses: string[];
}

/** Everything decidable without touching the chain. */
export function checkSponsorText(raw: string): SponsorCheck {
  const line = raw.trim();
  const addresses = [...line.matchAll(ADDRESS_RE)].map((m) => m[0]);
  if (!line) return { ok: false, reason: 'empty', addresses };
  if (line.length > MAX_SPONSOR_LEN) {
    return { ok: false, reason: `longer than ${MAX_SPONSOR_LEN} characters`, addresses };
  }
  if (/[\n\r]/.test(line)) return { ok: false, reason: 'contains a line break', addresses };
  // The one surface where user-facing bot text is written by somebody else.
  // The house rule against em dashes is enforced here or not at all: an
  // accepted line is rendered as it was submitted.
  const dash = LONG_DASHES.find((d) => line.includes(d));
  if (dash) {
    return { ok: false, reason: 'contains a dash this bot does not print. use a colon or a middle dot', addresses };
  }

  const subject = maskSubjects(line);
  for (const re of BANNED) {
    const hit = subject.match(re);
    if (hit) return { ok: false, reason: `says "${hit[0]}": a card points at a scan, not a buy`, addresses };
  }
  const pct = subject.match(PERCENT);
  if (pct) return { ok: false, reason: `states a percentage ("${pct[0]}")`, addresses };
  for (const re of PRICE) {
    const hit = subject.match(re);
    if (hit) return { ok: false, reason: `states a price ("${hit[0]}")`, addresses };
  }
  return { ok: true, addresses };
}

/** Does the factory have a record of this token? */
export async function launchExists(token: string): Promise<boolean> {
  const info: any = await bulk(() =>
    client.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: 'getLaunchedToken',
      args: [token as Address],
    }),
  );
  return Boolean(info?.exists);
}

type State =
  | { kind: 'approved'; raw: string; line: string }
  | { kind: 'rejected'; raw: string }
  | { kind: 'pending'; raw: string };

let state: State | null = null;

/**
 * Bumped whenever the line a card would render changes.
 *
 * The cached card has the sponsor baked into its text, so without this a line
 * set now would not appear until the cache expired -- and a card cached before
 * it was set would show no line at all. "Read at send time" has to mean the
 * next card, not the next minute.
 */
let version = 0;

/** Which sponsor line the cards currently in the cache were rendered with. */
export function sponsorVersion(): number {
  return version;
}

/**
 * The approved sponsor line, or null.
 *
 * Synchronous and free: this is called on the scan path, which has a five
 * second budget and no room for a contract read. The verdict for a given line
 * is computed once and reused until the line itself changes; an address needs a
 * factory read, so that line stays unrendered for the second or two the check
 * takes rather than holding up a card.
 *
 * Takes no arguments, and that is the enforcement rather than a convention: a
 * sponsor cannot buy a different card if the function that produces their line
 * cannot see which card it is on.
 */
export function sponsorLine(): string | null {
  const raw = configured();
  if (!raw) {
    // Nothing configured is not a rejection, and must not log like one.
    if (state !== null) version++;
    state = null;
    return null;
  }
  if (state && state.raw === raw) {
    return state.kind === 'approved' ? state.line : null;
  }

  version++;
  const check = checkSponsorText(raw);
  if (!check.ok) {
    state = { kind: 'rejected', raw };
    console.warn(`[sponsor] REJECTED: ${check.reason}\n           line: ${raw.slice(0, 140)}`);
    return null;
  }
  if (!check.addresses.length) {
    state = { kind: 'approved', raw, line: raw };
    console.log(`[sponsor] accepted: ${raw.slice(0, 140)}`);
    return raw;
  }

  // Addresses need the chain. Held back rather than rendered on trust.
  state = { kind: 'pending', raw };
  void (async () => {
    try {
      for (const addr of check.addresses) {
        if (!(await launchExists(addr))) {
          if (state?.raw === raw) state = { kind: 'rejected', raw };
          console.warn(
            `[sponsor] REJECTED: ${addr} is not a pons v2 launch\n           line: ${raw.slice(0, 140)}`,
          );
          return;
        }
      }
      if (state?.raw === raw) {
        state = { kind: 'approved', raw, line: raw };
        version++;
        console.log(`[sponsor] accepted: ${raw.slice(0, 140)}`);
      }
    } catch (err) {
      // Could not check is not the same as checked and fine. The line stays
      // down and the next card retries, because a paid line pointing at
      // something unverified is the one thing this must never render.
      if (state?.raw === raw) state = null;
      console.warn(
        `[sponsor] could not verify ${check.addresses.join(', ')}:`,
        String((err as Error)?.message ?? err).slice(0, 120),
      );
    }
  })();
  return null;
}

/** For tests, which need the verdict recomputed. */
export function resetSponsor(): void {
  state = null;
  version++;
}
