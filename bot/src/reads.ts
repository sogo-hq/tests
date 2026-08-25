import type { Address } from 'viem';
import { client } from './chain.js';
import { factoryAbi, curveAbi, erc20Abi, tokenInfoAbi, buybackVaultAbi } from './abi.js';
import { FACTORY, BUYBACK_VAULT, PHASE } from './config.js';

export interface TokenReads {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: number;
  phaseName: string;
  exists: boolean;

  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  sellableTokens: bigint;
  reservedTokens: bigint;
  readyToGraduate: boolean;
  feeBps: number;
  launchedAt: number;

  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: bigint;
  description: string | null;
  socials: Record<string, string> | null;

  vaultTotalLocked: bigint | null;
  vaultVestedAmount: bigint | null;
  vaultVestingStart: number | null;

  pairDecimals: number;
  pairSymbol: string | null;

  /** realQuoteReserve / graduationThreshold, as a percentage. */
  progressPct: number;
  /**
   * Marginal curve price, in whole pair-token units per whole token, and the
   * implied fully-diluted market cap in whole pair-token units.
   *
   * Price intentionally uses quoteReserve (phantom included) because that is the
   * reserve the curve itself prices against. Progress uses realQuoteReserve.
   * Both are denominated in the pair asset, which is NOT always ETH -- the card
   * always names the pair rather than implying a dollar or ETH figure.
   */
  priceInQuote: number;
  mcapInQuote: number;
}

export const NATIVE_PAIR = '0x0000000000000000000000000000000000000000';

/**
 * The zero address as pairToken means the launch is paired against native ETH,
 * which is the default. Anything else is a custom pair and inherits that
 * asset's risk.
 */
export function isNativePair(pairToken: string): boolean {
  return pairToken.toLowerCase() === NATIVE_PAIR;
}

/** Divide two bigints without losing precision to Number overflow. */
function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  const SCALE = 1_000_000_000_000n; // 1e12
  return Number((a * SCALE) / b) / 1e12;
}

async function tryRead<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Read everything the scan needs for one token.
 *
 * Progress is realQuoteReserve / graduationThreshold. It is NOT
 * quoteReserve / graduationThreshold: quoteReserve includes a phantom reserve
 * seeded at launch. On a freshly launched token measured during verification,
 * quoteReserve read 10.66e18 against a 26.6e18 threshold -- about 40% -- while
 * realQuoteReserve was 0 and nobody had bought anything.
 */
export async function readToken(tokenAddr: string): Promise<TokenReads | null> {
  const token = tokenAddr as Address;

  const info = await tryRead(
    () =>
      client.readContract({
        address: FACTORY,
        abi: factoryAbi,
        functionName: 'getLaunchedToken',
        args: [token],
      }),
    null as any,
  );
  if (!info || !info.exists) return null;

  const curve = info.curve as Address;

  const [
    reserves, realQuote, sellable, reserved, ready, feeBps, launchedAt,
    name, symbol, decimals, totalSupply, tokenInfo,
    locked, vested, vestingStart,
    pairDecimals, pairSymbol,
  ] = await Promise.all([
    tryRead(() => client.readContract({ address: curve, abi: curveAbi, functionName: 'getReserves' }), [0n, 0n] as readonly [bigint, bigint]),
    tryRead(() => client.readContract({ address: curve, abi: curveAbi, functionName: 'realQuoteReserve' }), 0n),
    tryRead(() => client.readContract({ address: curve, abi: curveAbi, functionName: 'sellableTokens' }), 0n),
    tryRead(() => client.readContract({ address: curve, abi: curveAbi, functionName: 'reservedTokens' }), 0n),
    tryRead(() => client.readContract({ address: curve, abi: curveAbi, functionName: 'readyToGraduate' }), false),
    tryRead(() => client.readContract({ address: curve, abi: curveAbi, functionName: 'feeBps' }), 0),
    tryRead(() => client.readContract({ address: curve, abi: curveAbi, functionName: 'launchedAt' }), 0n),
    tryRead(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }), null as string | null),
    tryRead(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }), null as string | null),
    tryRead(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }), 18),
    tryRead(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }), 0n),
    tryRead(() => client.readContract({ address: token, abi: tokenInfoAbi, functionName: 'getTokenInfo' }), null as any),
    tryRead(() => client.readContract({ address: BUYBACK_VAULT, abi: buybackVaultAbi, functionName: 'totalLocked', args: [token] }), null as bigint | null),
    tryRead(() => client.readContract({ address: BUYBACK_VAULT, abi: buybackVaultAbi, functionName: 'vestedAmount', args: [token] }), null as bigint | null),
    tryRead(() => client.readContract({ address: BUYBACK_VAULT, abi: buybackVaultAbi, functionName: 'vestingStart', args: [token] }), null as bigint | null),
    isNativePair(info.pairToken as Address)
      ? Promise.resolve(18)
      : tryRead(() => client.readContract({ address: info.pairToken as Address, abi: erc20Abi, functionName: 'decimals' }), 18),
    isNativePair(info.pairToken as Address)
      ? Promise.resolve('ETH' as string | null)
      : tryRead(() => client.readContract({ address: info.pairToken as Address, abi: erc20Abi, functionName: 'symbol' }), null as string | null),
  ]);

  const [quoteReserve, tokenReserve] = reserves;
  const gt = info.graduationThreshold as bigint;
  const progressPct = gt > 0n ? ratio(realQuote, gt) * 100 : 0;

  const dec = Number(decimals);
  const pairDec = Number(pairDecimals);

  // price = (quoteReserve / 10^pairDec) / (tokenReserve / 10^dec), i.e. whole
  // pair-token units per whole token.
  const priceInQuote =
    tokenReserve > 0n
      ? (ratio(quoteReserve, tokenReserve) * 10 ** dec) / 10 ** pairDec
      : 0;
  // fully-diluted mcap = whole supply * price
  const mcapInQuote = (Number(totalSupply) / 10 ** dec) * priceInQuote;

  return {
    token,
    curve,
    deployer: info.deployer as Address,
    creatorFeeRecipient: info.creatorFeeRecipient as Address,
    pairToken: info.pairToken as Address,
    graduationThreshold: gt,
    poolFee: Number(info.poolFee),
    tickSpacing: Number(info.tickSpacing),
    creatorTaxBps: Number(info.creatorTaxBps),
    buybackEnabled: Boolean(info.buybackEnabled),
    phase: Number(info.phase),
    phaseName: PHASE[Number(info.phase)] ?? `Unknown(${info.phase})`,
    exists: true,

    quoteReserve,
    tokenReserve,
    realQuoteReserve: realQuote,
    sellableTokens: sellable,
    reservedTokens: reserved,
    readyToGraduate: ready,
    feeBps: Number(feeBps),
    launchedAt: Number(launchedAt),

    name,
    symbol,
    decimals: dec,
    totalSupply,
    description: tokenInfo?.description ?? null,
    socials: tokenInfo?.socials
      ? Object.fromEntries(
          Object.entries(tokenInfo.socials).filter(([, v]) => typeof v === 'string' && v),
        ) as Record<string, string>
      : null,

    vaultTotalLocked: locked,
    vaultVestedAmount: vested,
    vaultVestingStart: vestingStart === null ? null : Number(vestingStart),

    pairDecimals: pairDec,
    pairSymbol,

    progressPct,
    priceInQuote,
    mcapInQuote,
  };
}
