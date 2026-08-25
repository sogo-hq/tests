import { parseAbi, parseAbiItem } from 'viem';

/**
 * Launch params tuple, shared by all four launch entry points.
 * Taken verbatim from the factory's verified ABI.
 */
const LAUNCH_PARAMS =
  '(string name,string symbol,string logo,string description,' +
  '(string twitter,string telegram,string discord,string website,string farcaster) socials,' +
  'address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,' +
  'bytes32 expectedEconomics,bytes32 salt)';

export const factoryAbi = parseAbi([
  `function launchToken(${LAUNCH_PARAMS} params,uint256 launchConfigId,address pairToken,address[] snipeTaxExemptions) payable returns (address,address)`,
  `function launchToken(${LAUNCH_PARAMS} params,uint256 launchConfigId,address pairToken) payable returns (address,address)`,
  `function launchTokenFor(${LAUNCH_PARAMS} params,uint256 launchConfigId,address pairToken,address originalDeployer,address[] snipeTaxExemptions) payable returns (address,address)`,
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  'function getLaunchFeePolicy(address token) view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))',
  'function getLaunchConfig(uint256 id) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))',
  'function memeHook() view returns (address)',
  'function locker() view returns (address)',
  'function buybackVault() view returns (address)',
  'function feeEscrow() view returns (address)',
  'function launchForwarder() view returns (address)',
  'function launchFee() view returns (uint256)',
  'function launchEnabled() view returns (bool)',
  'function snipeTaxSeconds() view returns (uint256)',
  'function snipeTaxStartBps() view returns (uint256)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function launchConfigCount() view returns (uint256)',
]);

/**
 * The forwarder's launch path. 71% of launches arrive this way. It launches AND
 * buys in one transaction and carries its own snipe-tax exemption array --
 * decoding only the factory overloads would report a false "clean" here.
 */
export const forwarderAbi = parseAbi([
  `function launchAndBuy(${LAUNCH_PARAMS} params,uint256 launchConfigId,address pairToken,uint256 buyAmount,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address,address)`,
]);

/** Every ABI a launch transaction might be encoded against. */
export const launchDecodeAbi = [...factoryAbi, ...forwarderAbi];

/**
 * Curve reads. Every one of these was confirmed present in the deployed curve's
 * dispatch table by selector before being relied on.
 */
export const curveAbi = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function reservedTokens() view returns (uint256)',
  'function feeBps() view returns (uint16)',
  'function creatorTaxBps() view returns (uint16)',
  'function buybackEnabled() view returns (bool)',
  'function launchedAt() view returns (uint256)',
  'function token() view returns (address)',
  'function pairToken() view returns (address)',
  'function deployer() view returns (address)',
]);

export const buybackVaultAbi = parseAbi([
  'function totalLocked(address token) view returns (uint256)',
  'function vestedAmount(address token) view returns (uint256)',
  'function vestingStart(address token) view returns (uint256)',
  'function VESTING_DURATION() view returns (uint256)',
  'function factory() view returns (address)',
]);

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

export const tokenInfoAbi = parseAbi([
  'function getTokenInfo() view returns ((address tokenDeployer,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials))',
]);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const TokenLaunched = parseAbiItem(
  'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)',
);
export const LaunchSwept = parseAbiItem(
  'event LaunchSwept(address indexed token,uint256 quoteOut,uint256 tokenOut)',
);
export const PoolGraduated = parseAbiItem(
  'event PoolGraduated(address indexed token,uint256 positionId,uint256 tokenAmount,uint256 pairTokenAmount)',
);
export const CreatorFeeRecipientChangeProposed = parseAbiItem(
  'event CreatorFeeRecipientChangeProposed(address indexed token,address indexed currentRecipient,address indexed proposedRecipient,uint256 effectiveAt,uint256 expiresAt)',
);
export const CreatorFeeRecipientUpdated = parseAbiItem(
  'event CreatorFeeRecipientUpdated(address indexed token,address indexed previousRecipient,address indexed newRecipient)',
);

/**
 * Curve trade events. These signatures were confirmed by matching keccak256 of
 * the candidate signature against the topic0 constants embedded in the deployed
 * curve bytecode, then re-confirmed by decoding live logs. Not guessed.
 *
 * On a buy, snipe tax is folded into `fee`; creator tax is reported separately
 * as `creatorTax`. Always read `tokensOut` from the event -- never assume the
 * amount the buyer requested.
 */
export const CurveBuy = parseAbiItem(
  'event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 creatorTax)',
);
export const CurveSell = parseAbiItem(
  'event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 creatorTax)',
);
export const CurveBuyRefunded = parseAbiItem(
  'event CurveBuyRefunded(address indexed buyer,uint256 quoteRefunded)',
);
export const CurveCompleted = parseAbiItem(
  'event CurveCompleted(address token,uint256 quoteReserve,uint256 tokenReserve)',
);

/** Selectors for the four launch entry points, for fast dispatch. */
export const SELECTOR = {
  launchTokenWithExemptions: '0xa72101af',
  launchTokenPlain: '0xf35abbcf',
  launchTokenFor: '0xd6a0eef5',
  launchAndBuy: '0xf85f8e41',
} as const;
