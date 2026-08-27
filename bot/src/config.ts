/**
 * Network + protocol constants for pons v2 on Robinhood Chain.
 *
 * Only these two hosts are ever contacted. Endpoints are never resolved from
 * search results or third-party registries -- lookalike RPCs and fake explorers
 * exist for this chain.
 */
export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
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
 * Below this age a launch is reported in early mode.
 *
 * Traction metrics are not merely small this early -- they are undefined. The
 * snipe tax window (snipeTaxSeconds, currently 3s) has barely closed, buyer
 * growth needs two points in time to exist at all, and progress velocity needs
 * elapsed time in the denominator. Rendering them as zero reads as a finding
 * when it is really an absence of data, which is the false negative this mode
 * exists to stop.
 */
export const EARLY_WINDOW_SECONDS = Number(process.env.EARLY_WINDOW_SECONDS || 180);

/**
 * Early-mode results go stale fast: the same launch at 5s and at 90s are
 * genuinely different answers, so they cannot share the normal 60s cache life.
 */
export const EARLY_CACHE_TTL_MS = Number(process.env.EARLY_CACHE_TTL_MS || 10_000);

/** Recheck offsets, in hours after the scan. */
export const RECHECK_OFFSETS_HOURS = [1, 6, 24, 24 * 7] as const;

/** Phase enum from factory.getLaunchedToken().phase */
export const PHASE = ['NotGraduated', 'Swept', 'PoolCreated', 'Rescued'] as const;

export const DB_PATH = process.env.DB_PATH || './pons.db';
export const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 7);
/** How far back /scan will hunt for an unindexed token's launch. */
export const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 10);
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

export const DISCLAIMER = 'Signals and flags only. Not financial advice.';
