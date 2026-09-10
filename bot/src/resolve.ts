import type { Address } from 'viem';
import { db } from './db.js';
import { deployerSummary } from './deployerlookup.js';
import { client } from './chain.js';
import { curveAbi, factoryAbi } from './abi.js';
import { FACTORY } from './config.js';

/**
 * What a pasted address actually refers to.
 *
 * Recognition itself was never the problem. `getLaunchedToken(token)` on the
 * factory is a direct, authoritative answer that has nothing to do with the
 * transaction's `to` field, and it already tells `exists=false` apart from a
 * read that failed. The reported "not a pons v2 launch" on a real launch comes
 * from somewhere else: the address pasted was not the token's.
 *
 * Every launch has a bonding-curve contract, and that address is what an
 * explorer shows in the trace of every buy and sell. Pasting it is the obvious
 * mistake to make, and the factory has no record of it -- correctly, because it
 * is not a launched token. Verified on a live launch: the factory answers
 * exists=false for its own curve, and the card said "not a pons v2 launch"
 * about a token that had graduated.
 *
 * So this resolves an address to the launch it belongs to, and the factory
 * still has the final say. Nothing here can invent a launch: every path ends
 * with getLaunchedToken confirming, so an address the factory denies stays
 * denied. That is the difference between this and a heuristic like "a billion
 * supply and a curve event, therefore a pons launch" -- which would assert a
 * launch the authoritative registry says does not exist.
 */

export type ResolvedVia = 'token' | 'curve-index' | 'curve-call' | 'deployer';

export interface Resolution {
  /** The launched token, or null when this address is not one and points at none. */
  token: string | null;
  /** Which path answered, for the log and for /why. */
  via: ResolvedVia | 'none';
  /** What was pasted, when it turned out not to be the token. */
  pastedWas?: 'curve' | 'deployer';
  /**
   * Set when the address is a DEPLOYER the index knows.
   *
   * `token` stays null: a deployer is not a launch and must not be scanned as
   * one. This only says what the address is, so the reply can be "that is a
   * deployer" instead of "not a pons v2 launch" -- which was true, and useless.
   */
  deployerOf?: { launches: number; latestToken: string; latestSymbol: string | null };
}

async function isLaunch(addr: string): Promise<boolean> {
  const info: any = await client.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: 'getLaunchedToken',
    args: [addr as Address],
  });
  return Boolean(info?.exists);
}

/**
 * Resolve a pasted address to the token it belongs to.
 *
 * Ordered by cost. The first path is the one that already existed and answers
 * for every correctly pasted address; the rest run only when it does not, so a
 * normal scan pays nothing for them.
 */
export async function resolveLaunch(address: string): Promise<Resolution> {
  const addr = address.toLowerCase();

  // 1. The address IS the token. The ordinary case, and the only one that costs
  //    a request on the happy path -- readToken makes this same call, so the
  //    caller passes `alreadyKnownNotALaunch` rather than repeating it.
  //    (see resolveAfterMiss below)

  // 2. A curve this index has already seen. Free, and it covers every launch
  //    the indexer has walked.
  const row = db
    .prepare('SELECT token FROM launches WHERE curve = ? LIMIT 1')
    .get(addr) as { token: string } | undefined;
  if (row?.token) return { token: row.token, via: 'curve-index', pastedWas: 'curve' };

  // 3. Ask the contract what token it serves. One call, on the miss path only.
  //    A non-curve address simply reverts, which is the answer.
  let curveToken: Address | null = null;
  try {
    curveToken = (await client.readContract({
      address: addr as Address,
      abi: curveAbi,
      functionName: 'token',
    })) as Address;
  } catch (err) {
    // Not a curve, or not readable. Neither is a launch, and neither is an
    // error worth surfacing to the user: the caller already has a real answer
    // from the factory for the address that was actually pasted. Logged
    // quietly, because a curve that stops answering token() would otherwise be
    // invisible.
    console.warn(
      `[resolve] ${addr.slice(0, 10)} is not a readable curve:`,
      String((err as any)?.shortMessage ?? (err as Error)?.message ?? err).slice(0, 80),
    );
    // Falls through rather than returning: a deployer is not a curve either, so
    // token() reverting is exactly the case the next path exists for. Returning
    // here skipped it -- on the very address this was written to handle.
    return resolveAsDeployer(addr);
  }

  /**
   * Deliberately OUTSIDE that catch.
   *
   * The first version had this inside it, so a factory read that FAILED was
   * swallowed and returned as "no launch" -- which the card renders as "not a
   * pons v2 launch", a confident statement about a chain we had just failed to
   * reach. That is the exact mistake reads.ts:118 exists to prevent, and it had
   * been made twice before in this codebase. A failure here must reach the
   * caller as a failure, so the scan says "couldn't read" instead.
   *
   * The factory still decides: without this call, any contract with a token()
   * getter would be accepted as a pons launch.
   */
  if (curveToken && (await isLaunch(curveToken))) {
    return { token: curveToken.toLowerCase(), via: 'curve-call', pastedWas: 'curve' };
  }

  return resolveAsDeployer(addr);
}

/**
 * Last: is this address a DEPLOYER the index has seen?
 *
 * Measured on the address a tester reported as a broken scan. It is not a
 * token: name(), symbol() and totalSupply() all revert, every curve getter
 * reverts, and the factory answers exists=false. "Not a pons v2 launch" was
 * therefore correct -- and useless, because the address is squarely inside the
 * pons system: it answers factory() with our factory, and it appears in a
 * TokenLaunched log as the deployer field.
 *
 * A deployer is not a launch and is never scanned as one -- `token` stays null.
 * This only names what was pasted, so the reply can point somewhere.
 *
 * Index-only, deliberately. Finding a deployer from the chain means walking
 * TokenLaunched logs, which took 82.7 seconds over nine days on the live node
 * and is not something a scan can spend. An address the index has not seen
 * falls through to the same honest "not a launch" as before.
 */
function resolveAsDeployer(addr: string): Resolution {
  const d = deployerSummary(addr);
  if (!d) return { token: null, via: 'none' };
  return { token: null, via: 'deployer', pastedWas: 'deployer', deployerOf: d };
}

