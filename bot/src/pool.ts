import { encodeAbiParameters, keccak256, type Address } from 'viem';
import { client } from './chain.js';
import { poolManagerAbi } from './abi.js';
import { MEME_HOOK, POOL_MANAGER } from './config.js';
import { NATIVE_PAIR } from './reads.js';

/**
 * The price of a graduated launch, read from the pool that holds its liquidity.
 *
 * After graduation the curve is empty. Its token reserve is zero, so its
 * marginal price is zero and the fully diluted market cap computed from it is
 * zero too. That zero was rendered as "0 ETH mc" on a token other tools priced
 * in the tens of millions, which reads as a worthless token rather than a
 * finished one. It is the worst kind of wrong number: confident, in the
 * headline, and about the thing the reader came for.
 *
 * Uniswap v4 exposes no getter for a pool's price. The pool's state lives in
 * the manager's own storage and is reachable only through `extsload`, so the
 * slot is derived here rather than read from an interface:
 *
 *   poolId    = keccak256(abi.encode(PoolKey))
 *   stateSlot = keccak256(abi.encode(poolId, POOLS_SLOT))
 *   slot0     = extsload(stateSlot), with sqrtPriceX96 in the low 160 bits
 *
 * Every component of the PoolKey is read live off the launch rather than
 * assumed: the fee and the tick spacing come from the factory's own record of
 * the launch, because they differ per launch and a hardcoded pair would derive
 * the wrong pool and then read a completely unrelated price out of it.
 *
 * Which is why this fails closed. A derivation that misses returns null, and a
 * null renders as undetermined. There is no fallback that guesses.
 */

/** Where the manager keeps its pools mapping. From v4's own StateLibrary. */
export const POOLS_SLOT = 6n;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/**
 * The PoolKey for a launch.
 *
 * v4 requires currency0 < currency1 by address, and native ETH is the zero
 * address so it always sorts first. Getting the order wrong derives a different
 * poolId, which reads as an uninitialised pool rather than as an error: the
 * failure is silent, so the ordering is done here once and tested.
 */
export function poolKeyOf(opts: {
  token: string; pairToken: string; poolFee: number; tickSpacing: number;
}): PoolKey {
  const token = opts.token.toLowerCase() as Address;
  const pair = opts.pairToken.toLowerCase() as Address;
  const [currency0, currency1] = pair < token ? [pair, token] : [token, pair];
  return {
    currency0, currency1,
    fee: opts.poolFee,
    tickSpacing: opts.tickSpacing,
    hooks: MEME_HOOK as Address,
  };
}

export function poolIdOf(key: PoolKey): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

export function stateSlotOf(poolId: `0x${string}`): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }],
    [poolId, POOLS_SLOT],
  ));
}

const Q192 = 1n << 192n;
const SCALE = 10n ** 18n;

/**
 * Whole quote units per whole token, from a sqrtPriceX96.
 *
 * Squared in bigint before it is ever a Number: sqrtPriceX96 is around 1e31 on
 * a live pool, and its square is around 1e62, which a double cannot hold
 * without dropping most of the precision the price depends on.
 */
export function priceFromSqrt(opts: {
  sqrtPriceX96: bigint;
  /** True when the quote asset is currency0, which it is for a native pair. */
  quoteIsCurrency0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
}): number | null {
  const { sqrtPriceX96: sqrt, quoteIsCurrency0, tokenDecimals, quoteDecimals } = opts;
  if (sqrt <= 0n) return null;
  // P = amount1 / amount0, both in smallest units, scaled by 1e18.
  const pScaled = (sqrt * sqrt * SCALE) / Q192;
  if (pScaled <= 0n) return null;
  const p = Number(pScaled) / 1e18;
  if (!Number.isFinite(p) || p <= 0) return null;
  const scale = 10 ** (tokenDecimals - quoteDecimals);
  const price = quoteIsCurrency0 ? scale / p : p * scale;
  return Number.isFinite(price) && price > 0 ? price : null;
}

export interface PoolPrice {
  poolId: `0x${string}`;
  sqrtPriceX96: bigint;
  /** Whole quote units per whole token. */
  priceInQuote: number;
}

export interface PoolReadDeps {
  /** Injected in tests. Nothing in the bot passes it. */
  extsload?: (slot: `0x${string}`) => Promise<bigint>;
}

/**
 * Read the pool price for a launch, or null.
 *
 * Null on every failure, and deliberately not a throw. A graduated launch whose
 * pool cannot be read has an undetermined market cap, which is a true statement
 * the card can make. Throwing would turn one unreadable slot into a failed scan
 * of a token whose findings were all read successfully.
 */
export async function readPoolPrice(opts: {
  token: string; pairToken: string; poolFee: number; tickSpacing: number;
  tokenDecimals: number; quoteDecimals: number;
}, deps: PoolReadDeps = {}): Promise<PoolPrice | null> {
  const key = poolKeyOf(opts);
  const poolId = poolIdOf(key);
  const slot = stateSlotOf(poolId);
  let word: bigint;
  try {
    word = deps.extsload
      ? await deps.extsload(slot)
      : BigInt(await client.readContract({
          address: POOL_MANAGER as Address, abi: poolManagerAbi,
          functionName: 'extsload', args: [slot],
        }) as `0x${string}`);
  } catch (err) {
    console.warn(`[pool] price unreadable for ${opts.token}: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    return null;
  }
  const sqrtPriceX96 = word & ((1n << 160n) - 1n);
  // An uninitialised pool reads as a zero word, which is what a wrong poolId
  // also produces. Both mean the same thing here: no price was read.
  if (sqrtPriceX96 <= 0n) return null;
  const quoteIsCurrency0 = key.currency0 === opts.pairToken.toLowerCase();
  const priceInQuote = priceFromSqrt({
    sqrtPriceX96, quoteIsCurrency0,
    tokenDecimals: opts.tokenDecimals, quoteDecimals: opts.quoteDecimals,
  });
  if (priceInQuote === null) return null;
  return { poolId, sqrtPriceX96, priceInQuote };
}

/** A native pair's quote is the zero address, which always sorts to currency0. */
export function quoteIsNative(pairToken: string): boolean {
  return pairToken.toLowerCase() === NATIVE_PAIR;
}
