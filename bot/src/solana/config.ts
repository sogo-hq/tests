/**
 * The Solana side: constants, and the endpoint everything reads through.
 *
 * A second scan path, parallel to src/indexer/ and sharing nothing with it but
 * the rules. Different chain, different address shape, different rate limiter.
 * Nothing in this directory is imported by the pons path.
 *
 * See docs/launchlab-scan-spec.md. Every figure below was read from chain
 * rather than taken from a document, and the read is repeatable: a test asserts
 * the pinned set against fixtures captured from mainnet.
 */

/** Raydium LaunchLab. Every launch this path scans runs through this program. */
export const LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj' as const;

/** The authority that owns a launched mint's transfer fee config. */
export const LAUNCHLAB_AUTHORITY = 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh' as const;

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as const;
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as const;

/**
 * The platform config account, as it is laid out on chain.
 *
 * Derived by reading the bytes rather than from an IDL: the strings are
 * fixed-width and NUL padded, with no length prefix, which a length-prefixed
 * reader would get wrong in a way that still produced plausible output.
 */
export const PLATFORM_CONFIG_SIZE = 944;
export const PLATFORM_CONFIG_DISCRIMINATOR = 'a04e8000f853e6a0';
export const PLATFORM_NAME_AT = 112;
export const PLATFORM_NAME_LEN = 64;
export const PLATFORM_SITE_AT = 176;
export const PLATFORM_SITE_LEN = 256;

/**
 * Nothing is published from fewer than this many observations.
 *
 * The same floor as MIN_HOLD_SAMPLES on the pons path, for the same reason: a
 * percentage computed from four launches is a sentence that gets quoted
 * without its denominator.
 */
export const MIN_OBSERVATIONS = 30;

/** A base58 pubkey, and not something that merely looks like one. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isPubkey(s: unknown): s is string {
  return typeof s === 'string' && BASE58.test(s);
}

/**
 * The endpoint, from the environment and nowhere else.
 *
 * There is no default. The pons path defaults to a pinned host because there
 * is exactly one right answer for that chain; here the endpoint carries an API
 * key, so it can only come from the operator. An unset endpoint is not an
 * error at import time and is never quietly swapped for a public one: it makes
 * every read return undetermined with a reason that names the variable, which
 * is the honest failure and the one that says what to do about it.
 *
 * getProgramAccounts with filters is required, not merely convenient, because
 * it is what enumerates the platform configs for the startup diff. One of the
 * public endpoints refuses it outright.
 */
export function solanaRpcUrl(): string | null {
  const raw = (process.env.SOLANA_RPC_URL ?? '').trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    // Said once, without the value: the endpoint carries an API key and this
    // line goes to a log. What is wrong with it is the operator's to see; what
    // it is, is not.
    console.warn(`[solana] SOLANA_RPC_URL is not a valid url: ${String((err as Error)?.message ?? err).slice(0, 80)}`);
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.warn(`[solana] SOLANA_RPC_URL must be http(s), got ${parsed.protocol}`);
    return null;
  }
  return raw.replace(/\/+$/, '');
}

/** Why a read could not be made. Printed, so it names the fix. */
export const NO_RPC_REASON =
  'SOLANA_RPC_URL is not set, so nothing on solana could be read';

export interface PinnedPlatform {
  pubkey: string;
  /** The platform this key belongs to, as WE name it. Never read from chain. */
  platform: string;
  /** The name the config carried when it was pinned. */
  name: string;
  /** The site the config carried when it was pinned. */
  site: string;
}

/**
 * The pinned platform set: the only thing that names a platform.
 *
 * Nothing else promotes a launch into a named platform, not the name string,
 * not the site string, not the API. There are 2,591 platform configs on
 * LaunchLab under 2,253 distinct names, all free text chosen by whoever
 * created the config, and the lookalike problem is already live: America.fun
 * appears under six spellings across 46 configs, and "BONKfun 2.0" at
 * bonk20.fun is not letsbonk.fun.
 *
 * `name` and `site` are stored BESIDE the pubkey rather than instead of it,
 * and that is the whole point of storing them. Membership is decided by the
 * key, so a pinned key that starts saying something new passes every
 * membership check there is. The only thing that catches it is having written
 * down what it said when we pinned it.
 *
 * All 35 read from mainnet: owner LaunchLab, 944 bytes, discriminator
 * a04e8000f853e6a0, name "StonkFun", site "https://www.stonkfun.xyz".
 */
const STONKFUN_KEYS = [
  '3P5BVffvoKngKMBZuki6PtMdGeScFX2N1kpjJW15WMjd',
  '3qiqsFPZgPFhzUK2vF4QwvWXnh5NTPKYDHYJAxYsvcu8',
  '3xv3SBLLeWQryvLVeG4BwfLhnhfWYN1tdeSGx3F1QaCe',
  '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7',
  '4jDsqJ8Wn2o2tE7F2HWCgAkTzm8cteBX6nn9Sgaix8aX',
  '4LkQf3v3ukz4Rm8dpUckn8wKPji2CFmSfuPCLbo1pnHF',
  '5f3S2roYYEdEGbyLmLhd3aDHoubaNtHtk7trX5Z7M1hh',
  '5LNpBsmvaPovXErRUfV7ijdCeVkEHaRSpJ2RaQ5nNhX4',
  '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt',
  '6SzhbA9AACoBmFfTsBGG5Bfj5XQzWR1kEP7ZxF4sqvdn',
  '7Skv1Zut6JMHgfsBMDGKoTKtDvFivQYHrYnY2PcQzipT',
  '7uCfLgLrH7RYkmBXiUduudsDGDwutCNdgzrMzuydm5L7',
  '8DFxvoAqP1AX5ShVLPfhKtqiS5usENj3vzNiiUfBrbEz',
  '8uzF7UKMxB43x6YDfUwsKqtmJYGMzbDLaUPBiPAXuyhp',
  '9asa5tjM9Akt6pRCUXHCfvmhEkuGo8XJDipubwPMwYo3',
  'AbfUdGULpcLmS6eCiSbmwf5h3xctJVqjLTXrkgLzeK9S',
  'ANytinarxvDziPyKVvGU78TAtKVP4R9QYZPm4c8fWYzT',
  'apwdwgRxEU3RrRAA4idkwn8sQQwDbKDSMxqMgCd7wEF',
  'Au4s8A4FWr81sA6BybLcW9wqgLd2Js4AVUEvLpiTFiBV',
  'BCN7kK9PH7VoDYdKHguG1YjmyMmFuLT9DYoSdqvXgcEQ',
  'BhFhtURYqjzkK7A1ChgkS2uoSXuYHBo3qfZa5s4MioCU',
  'ChVSt6yJVxhTn8vKpyYP6adnh3bSXG9FzzFdhizQCB8S',
  'DAR1V5XCYad4jgzDUx5FaAd42ergBMWoETuYayrk8RaK',
  'DJuS9KGAbwHVxNbmnX7HCtnDrRqpAD6spWntJnY5JdRZ',
  'DxvoksLVEaGRGKD9nGc1oizqN9W4ycHxZqLoML1yfmsC',
  'DZ1h7DdDubcYY5atjskrqcck2rpi37s59UL4c2jboNk5',
  'EbS77E9fau1cqh1mRCmZJjMAe3gzZQ5wDE86FbgdEe3t',
  'EFSEG7RUgsQgpyeiSfg3usdeeJEYhJG4h4gEXsXsP5Py',
  'Etu1AV8ynsTVNQxAPMz9gKgzECDQUeGBgdoYYkzkP69f',
  'GP8D5pqcQmuH71UpLCc4WvshLDXagDYYjzRK2bXasSNf',
  'GPeRBoTGcdX5LY153duXkMxa6VW7BEnYcd2qsoTdrQgN',
  'GTNFRgvNndgKTim9iSYo5oumKXiRcUHjoirwmE1yW38w',
  'HEjWQtsHcJMv6y1W51GMRo5JX7XEpr9LUpcM8Rrhi2z7',
  'HTMR9w3ypLLDzwMiah6Px1jqCByoSaG9EDCtU3DLdPZD',
  'QFWKD4f3e8dgkYHYyhAqWfMtu5s316BP7MP97weXW8E',
] as const;

export const PINNED_PLATFORMS: readonly PinnedPlatform[] = STONKFUN_KEYS.map((pubkey) => ({
  pubkey,
  platform: 'StonkFun',
  name: 'StonkFun',
  site: 'https://www.stonkfun.xyz',
}));

/** What a launch on a platform we do not recognise is called. Never its own name. */
export const UNRECOGNISED = 'platform not recognised';
