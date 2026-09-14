import { db } from './db.js';
import { client } from './chain.js';
import { tokenInfoAbi } from './abi.js';
import { bulk } from './ratelimit.js';

/**
 * The socials a launch was deployed with.
 *
 * Decoded from the launch calldata by the indexer, in the same request that
 * reads the exemptions, and stored with the launch. Rows decoded before those
 * columns existed carry NULL, and for them the token's own getTokenInfo is the
 * on-chain copy of the same params: the constructor stored what the calldata
 * said, and nothing since can have changed it. So the lazy fill reads that,
 * once, at bulk priority, and stores what it found.
 *
 * NULL is "not read". An empty string is "read, and the deployer gave none".
 * The two are kept apart because /scout requires socials to be PRESENT, and a
 * launch whose socials were never read must not be dropped as if it had none.
 */

export interface StoredSocials {
  x: string;
  tg: string;
  web: string;
  readAt: number;
}

export function storedSocials(token: string): StoredSocials | null {
  const row = db
    .prepare('SELECT social_x, social_tg, social_web, socials_read_at FROM launches WHERE token = ?')
    .get(token.toLowerCase()) as
    | { social_x: string | null; social_tg: string | null; social_web: string | null; socials_read_at: number | null }
    | undefined;
  if (!row || row.socials_read_at === null) return null;
  return { x: row.social_x ?? '', tg: row.social_tg ?? '', web: row.social_web ?? '', readAt: row.socials_read_at };
}

const store = db.prepare(
  `UPDATE launches SET social_x = ?, social_tg = ?, social_web = ?, socials_read_at = ? WHERE token = ?`,
);

/**
 * Read the socials from the token itself and store them.
 *
 * Returns null when the read failed, and stores nothing then: a failed read is
 * not "no socials", and writing empty strings would turn a transient RPC error
 * into a permanent fact about the launch.
 */
export async function fillSocials(token: string, at = Math.floor(Date.now() / 1000)): Promise<StoredSocials | null> {
  let info: { socials?: Record<string, unknown> } | null = null;
  try {
    info = (await bulk(() =>
      client.readContract({ address: token as `0x${string}`, abi: tokenInfoAbi, functionName: 'getTokenInfo' }),
    )) as { socials?: Record<string, unknown> };
  } catch (err) {
    console.warn(`[socials] could not read ${token}:`, String((err as Error)?.message ?? err).slice(0, 120));
    return null;
  }
  const so = info?.socials ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const out = { x: str(so.twitter), tg: str(so.telegram), web: str(so.website), readAt: at };
  store.run(out.x, out.tg, out.web, at, token.toLowerCase());
  return out;
}

/** Stored if read, read and stored if not, null if the read failed. */
export async function socialsFor(token: string): Promise<StoredSocials | null> {
  return storedSocials(token) ?? fillSocials(token);
}

/** Present means the deployer gave at least one of X or Telegram. */
export function socialsPresent(s: StoredSocials | null): boolean {
  return s !== null && (s.x.length > 0 || s.tg.length > 0);
}
