/**
 * Network + protocol constants for pons v2 on Robinhood Chain.
 *
 * Endpoints are never resolved from search results or third-party registries --
 * lookalike RPCs and fake explorers exist for this chain. The default is the
 * public node and is the only address compiled in.
 *
 * RPC_URL may be overridden by the operator through the environment, because
 * the public node is rate limited and a paid provider is the fix for that. That
 * is not the same as discovering an endpoint: it is a deliberate act by whoever
 * runs the bot, on a value they typed. Anything set this way must be a URL, and
 * must not be silently ignored if it is malformed -- a typo that quietly falls
 * back to the public node would present rate-limited scans as the paid node's
 * behaviour.
 */
function configuredRpcUrl(): string {
  const raw = (process.env.RPC_URL ?? '').trim();
  if (!raw) return 'https://rpc.mainnet.chain.robinhood.com';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new Error(
      `RPC_URL is not a valid URL: ${JSON.stringify(raw.slice(0, 60))} ` +
        `(${String((err as Error)?.message ?? err).slice(0, 80)})`,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`RPC_URL must be http(s), got ${parsed.protocol}`);
  }
  // A trailing slash makes the startsWith() guard in the rate limiter miss the
  // very requests it exists to pace, so the shape is normalised once, here.
  return raw.replace(/\/+$/, '');
}

export const RPC_URL = configuredRpcUrl();
export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

export const CHAIN_ID = 4663;
export const CHAIN_ID_HEX = '0x1237';

/**
 * Contract addresses.
 *
 * FACTORY is NOT the address given in the original brief. That address
 * (0x7eD598BcEf0bd9Edd8C97A195C6d13f40801EC7e) has no code, nonce 0 and zero
 * balance -- it has never been used. The real factory differs by one character
 * at position 12 (0 -> 8) and is confirmed three independent ways:
 *   1. V2BuybackVault.factory() returns it
 *   2. it is baked as an immutable into every per-launch curve's bytecode
 *   3. it is the only one of the two with code (24,177 bytes, verified)
 *
 * MEME_HOOK in the brief contained a letter "O" instead of a zero, which is not
 * valid hex. Corrected here and confirmed against factory.memeHook().
 *
 * The remaining three match the factory's own getters exactly.
 * `verify` (src/verify.ts) re-asserts all of this against the live chain.
 */
export const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as const;
export const MEME_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' as const;
export const FEE_ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e' as const;
export const BUYBACK_VAULT = '0x42df2a798f82289E177311362e8f5ccC45c1219c' as const;
export const LAUNCH_LOCKER = '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952' as const;

/**
 * The launch forwarder. Not mentioned in the brief, but 71% of observed launches
 * route through it via launchAndBuy(), which carries its own snipe-tax exemption
 * array. Resolved from factory.launchForwarder() at startup rather than trusted
 * blindly; this constant is only the expected value used for cross-checking.
 */
export const LAUNCH_FORWARDER = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948' as const;

/**
 * The Uniswap v4 PoolManager this launchpad graduates into.
 *
 * Verified on-chain rather than looked up: both MEME_HOOK.poolManager() and
 * FACTORY.poolManager() return this address, and it answers
 * protocolFeeController(). It holds the pool's liquidity, so on a graduated
 * token it is the single largest balance -- 41.6% of $ARCHER's supply -- and
 * counting it as a wallet made every graduated launch look concentrated in one
 * hand when that hand is the pool.
 */
export const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const;

/** The conventional burn sink. Burned supply is held by nobody. */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

/**
 * Addresses that hold token balances without being holders.
 *
 * One list, used by every measurement that counts holders or divides by
 * circulating supply. Two copies of this drifted once already: the holder count
 * excluded the protocol contracts while the concentration read did not, which
 * put locked and escrowed supply into the top five and inflated the share on
 * every launch that uses them.
 */
export const NON_HOLDER_ADDRESSES: readonly string[] = [
  FACTORY, MEME_HOOK, FEE_ESCROW, BUYBACK_VAULT, LAUNCH_LOCKER, LAUNCH_FORWARDER,
  POOL_MANAGER, BURN_ADDRESS,
  '0x0000000000000000000000000000000000000000',
].map((a) => a.toLowerCase());

/** Measured across 10,000 blocks: 5,000 blocks per 500 seconds. */
export const BLOCK_TIME_SECONDS = 0.1;
export const BLOCKS_PER_MINUTE = Math.round(60 / BLOCK_TIME_SECONDS); // 600
export const BLOCKS_PER_HOUR = BLOCKS_PER_MINUTE * 60;                // 36,000
export const BLOCKS_PER_DAY = BLOCKS_PER_HOUR * 24;                   // 864,000

/**
 * getLogs limits, measured (see STEP0-FINDINGS.md):
 *  - address-scoped queries accept ~3.9M-block spans
 *  - topic-only queries with NO address filter time out above ~20k blocks
 * Both chunk sizes sit well inside the measured limits.
 */
export const FACTORY_LOG_CHUNK = 500_000;
export const CURVE_LOG_CHUNK = 20_000;
/** Max curve addresses per multi-address getLogs call. */
export const CURVE_BATCH_SIZE = 150;

/** Traction measurement windows. */
export const WINDOW_10_MIN_BLOCKS = BLOCKS_PER_MINUTE * 10; // 6,000
export const WINDOW_30_MIN_BLOCKS = BLOCKS_PER_MINUTE * 30; // 18,000

/**
 * Parse a numeric setting, refusing to let a malformed value disable a rule.
 *
 * Number('180s') is NaN, and every comparison against NaN is false -- so an
 * operator writing a unit suffix would silently switch early mode off entirely
 * with nothing in the logs to say so.
 */
function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[config] ignoring invalid ${name}=${JSON.stringify(raw)}, using ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Below this age a launch is reported in early mode.
 *
 * Traction metrics are not merely small this early -- they are undefined. The
 * snipe tax window (snipeTaxSeconds, currently 3s) has barely closed, buyer
 * growth needs two points in time to exist at all, and progress velocity needs
 * elapsed time in the denominator. Rendering them as zero reads as a finding
 * when it is really an absence of data, which is the false negative this mode
 * exists to stop.
 */
export const EARLY_WINDOW_SECONDS = positiveNumber('EARLY_WINDOW_SECONDS', process.env.EARLY_WINDOW_SECONDS, 180);

/**
 * Early-mode results go stale fast: the same launch at 5s and at 90s are
 * genuinely different answers, so they cannot share the normal 60s cache life.
 */
/** Hard ceiling. The rule is "10s maximum", so configuration may lower it, never raise it. */
export const EARLY_CACHE_TTL_CEILING_MS = 10_000;
export const EARLY_CACHE_TTL_MS = Math.min(
  EARLY_CACHE_TTL_CEILING_MS,
  positiveNumber('EARLY_CACHE_TTL_MS', process.env.EARLY_CACHE_TTL_MS, EARLY_CACHE_TTL_CEILING_MS),
);

/**
 * Margin added to the early window when the exact launch time is unavailable.
 *
 * Sized to the measured worst-case drift of the interpolated block timestamps
 * the index stores. Applied in the safe direction: with a less precise clock the
 * window widens, because showing "too early" for a token that is actually 185s
 * old is a far smaller error than the false "TRACTION none" this mode exists to
 * prevent.
 */
export const EARLY_DRIFT_MARGIN_SECONDS = 10;

/** Recheck offsets, in hours after the scan. */
export const RECHECK_OFFSETS_HOURS = [1, 6, 24, 24 * 7] as const;

/** Phase enum from factory.getLaunchedToken().phase */
export const PHASE = ['NotGraduated', 'Swept', 'PoolCreated', 'Rescued'] as const;

export const DB_PATH = process.env.DB_PATH || './pons.db';

/**
 * Hard ceiling on a scan, request to reply.
 *
 * A degen decides in about ten seconds; a card that lands after that is worth
 * nothing, and one that lands a minute later reads as a broken bot rather than
 * a slow one. Optional checks race whatever is left of this and render
 * undetermined if they lose.
 */
export const SCAN_BUDGET_MS = positiveNumber('SCAN_BUDGET_MS', process.env.SCAN_BUDGET_MS, 5_000);

/**
 * How long holder concentration may hold up a card.
 *
 * It never holds one up for longer than this even when the budget would allow
 * it: the reading is served from the index and refreshed in the background, so
 * waiting is the exception rather than the design.
 */
export const CONCENTRATION_DEADLINE_MS = positiveNumber(
  'CONCENTRATION_DEADLINE_MS',
  process.env.CONCENTRATION_DEADLINE_MS,
  2_000,
);
export const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 7);
/** How far back /scan will hunt for an unindexed token's launch. */
export const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 10);
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

export const DISCLAIMER = 'Signals and flags only. Not financial advice.';
