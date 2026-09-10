import { getAddress, isAddress, type Address } from 'viem';
import { client } from './chain.js';
import { erc20Abi } from './abi.js';
import { bulk } from './ratelimit.js';
import { BURN_ADDRESS } from './config.js';

/**
 * Who may use a paid feature, and where what they pay ends up.
 *
 * Two ways in, either one is enough: hold the token, or hold the ETH. No burn.
 * Anything paid to the bot goes to the treasury -- which is why the treasury
 * address is refused rather than defaulted when it is not configured. A default
 * of the zero address is not a safe fallback here, it is a burn by another
 * name, and the amendment that removed the burn removed it on purpose.
 */
export const PREMIUM_MIN_VITALS = BigInt(process.env.PREMIUM_MIN_VITALS || 1_000_000);
export const PREMIUM_MIN_ETH = Number(process.env.PREMIUM_MIN_ETH || 0.05) || 0.05;
export const PREMIUM_MIN_WEI = BigInt(Math.round(PREMIUM_MIN_ETH * 1e18));

/**
 * The $VITALS contract, from the environment.
 *
 * Not compiled in, and never resolved from a search, a registry or a message:
 * a lookalike token address here would gate the feature on somebody else's
 * supply. Unset means the token half of the test cannot run, which is reported
 * as undetermined rather than as a refusal.
 */
export function vitalsToken(): Address | null {
  const raw = (process.env.VITALS_TOKEN_ADDRESS ?? '').trim();
  if (!raw) return null;
  if (!isAddress(raw.toLowerCase(), { strict: false })) {
    throw new Error(`VITALS_TOKEN_ADDRESS is not an address: ${JSON.stringify(raw.slice(0, 60))}`);
  }
  return getAddress(raw.toLowerCase());
}

/**
 * Where payments go.
 *
 * Throws when unset or when it names a burn address. The caller must not have a
 * way to accidentally send tokens nowhere: "no burn" is a product decision, and
 * the only place it can be enforced for certain is before the transfer.
 */
export function treasuryAddress(): Address {
  const raw = (process.env.TREASURY_ADDRESS ?? '').trim();
  if (!raw) {
    throw new Error('TREASURY_ADDRESS is not set — payments have nowhere to go, and must not be burned');
  }
  if (!isAddress(raw.toLowerCase(), { strict: false })) {
    throw new Error(`TREASURY_ADDRESS is not an address: ${JSON.stringify(raw.slice(0, 60))}`);
  }
  const addr = getAddress(raw.toLowerCase());
  if (addr.toLowerCase() === BURN_ADDRESS.toLowerCase() || /^0x0{40}$/i.test(addr)) {
    throw new Error('TREASURY_ADDRESS is a burn address — this feature does not burn');
  }
  return addr;
}

export type Entitlement =
  | { state: 'premium'; via: 'vitals' | 'eth'; vitals: bigint | null; wei: bigint | null }
  | { state: 'below'; vitals: bigint | null; wei: bigint }
  /**
   * The chain could not be read. NOT a refusal.
   *
   * A failed balance read that returned "below" would tell a holder they do not
   * hold what they hold, which is the same class of error as reporting a token
   * clean because a check did not finish. The caller says so and offers a
   * retry; it does not deny the feature on data it never saw.
   */
  | { state: 'undetermined'; reason: string };

async function tokenBalance(token: Address, wallet: Address): Promise<bigint> {
  const [raw, decimals] = await Promise.all([
    bulk(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })),
    bulk(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })),
  ]);
  // Compared in whole tokens: the threshold is "1M $VITALS", which is a
  // statement about the token's own units, not about 1e18.
  return (raw as bigint) / 10n ** BigInt(Number(decimals));
}

/**
 * Is this wallet entitled to a paid feature?
 *
 * ETH is checked first because it needs no contract and no configuration, so a
 * holder who qualifies that way is never told the feature is unavailable
 * because the operator has not set VITALS_TOKEN_ADDRESS yet.
 */
export async function entitlement(wallet: string): Promise<Entitlement> {
  if (!isAddress(wallet.toLowerCase(), { strict: false })) {
    return { state: 'undetermined', reason: 'that is not an address' };
  }
  const addr = getAddress(wallet.toLowerCase());

  let wei: bigint;
  try {
    wei = await bulk(() => client.getBalance({ address: addr }));
  } catch (err) {
    return { state: 'undetermined', reason: `balance unreadable: ${String((err as Error)?.message ?? err).slice(0, 80)}` };
  }
  if (wei >= PREMIUM_MIN_WEI) return { state: 'premium', via: 'eth', vitals: null, wei };

  const token = vitalsToken();
  if (!token) {
    // No token configured: the ETH answer stands on its own and is a real
    // measurement, so this is "below", not "undetermined".
    return { state: 'below', vitals: null, wei };
  }
  let vitals: bigint;
  try {
    vitals = await tokenBalance(token, addr);
  } catch (err) {
    return { state: 'undetermined', reason: `$VITALS balance unreadable: ${String((err as Error)?.message ?? err).slice(0, 80)}` };
  }
  if (vitals >= PREMIUM_MIN_VITALS) return { state: 'premium', via: 'vitals', vitals, wei };
  return { state: 'below', vitals, wei };
}

/** What the holder is told. Facts and the thresholds, no upsell. */
export function entitlementLine(e: Entitlement): string {
  if (e.state === 'undetermined') return `could not check your holdings — ${e.reason}. try again`;
  if (e.state === 'premium') {
    return e.via === 'eth'
      ? `premium · ${(Number(e.wei) / 1e18).toFixed(3)} ETH held`
      : `premium · ${e.vitals!.toLocaleString()} $VITALS held`;
  }
  const held = e.vitals === null
    ? `${(Number(e.wei) / 1e18).toFixed(3)} ETH`
    : `${e.vitals.toLocaleString()} $VITALS · ${(Number(e.wei) / 1e18).toFixed(3)} ETH`;
  return `not premium · you hold ${held} · need ${PREMIUM_MIN_VITALS.toLocaleString()} $VITALS or ${PREMIUM_MIN_ETH} ETH`;
}
