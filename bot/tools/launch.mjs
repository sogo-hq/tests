#!/usr/bin/env node
/**
 * The launch, from a laptop.
 *
 * Runs nowhere but a machine that holds the key. The bot process never sees
 * one, the server never has one in its environment, and this script reads it
 * from the shell for the length of one transaction. Three modes:
 *
 *   --dry       simulate through eth_call and print what would happen. Sends
 *               nothing, signs nothing, and still prints the token address the
 *               launch will have, because that address is decided by the salt
 *               and the sender and can be known in advance.
 *   --rehearse  launch a throwaway token with the same parameters on a burner
 *               key, then scan it with this repo's own scanner and print the
 *               card. The ticker is deliberately not the real one.
 *   --go        the launch, after a typed confirmation of the symbol.
 *
 * Every number comes from tools/launch.config.json. Every mode ends with a
 * diff of that file against what the chain says, because one file used by
 * three modes is only worth something if the comparison is actually made.
 *
 *   node tools/launch.mjs --dry
 *   REHEARSAL_PRIVATE_KEY=0x... node tools/launch.mjs --rehearse
 *   LAUNCH_PRIVATE_KEY=0x...    node tools/launch.mjs --go
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, decodeEventLog, formatEther, formatUnits, parseAbiItem, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'out');

const { client, robinhoodChain } = await import(join(ROOT, 'dist/chain.js'));
const { factoryAbi, forwarderAbi, TokenLaunched, CurveBuy } = await import(join(ROOT, 'dist/abi.js'));
const { FACTORY, LAUNCH_FORWARDER, RPC_URL } = await import(join(ROOT, 'dist/config.js'));
const { calibrate, quoteLaunchBuy, CALIBRATION } = await import(join(ROOT, 'dist/curve.js'));
const P = await import(join(ROOT, 'dist/launchplan.js'));
const C = await import(join(ROOT, 'dist/launchcheck.js'));

const SnipeTaxExempted = parseAbiItem('event SnipeTaxExempted(address indexed wallet)');
const ZERO = '0x0000000000000000000000000000000000000000';

// ------------------------------------------------------------------ plumbing

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const MODES = ['--dry', '--rehearse', '--go'];
const mode = MODES.filter(has);
const die = (msg, code = 1) => { console.error(`\n  ${msg}\n`); process.exit(code); };

// --check is its own thing and stops here: it reads the config, fetches the
// logo and asks the chain for the address the salt makes. It never reaches the
// key, the window or the send, so it works on a Sunday.
if (has('--check')) {
  const { runCheck } = await import(join(HERE, 'check.mjs'));
  const ok = await runCheck({
    configPath: arg('--config', join(HERE, 'launch.config.json')),
    as: arg('--as', null),
  });
  process.exit(ok ? 0 : 1);
}

if (mode.length !== 1) {
  die(`pick exactly one mode: ${MODES.join(' ')}\n\n` +
      '  --check     validate the config only. sends nothing, needs no key, ignores the window\n' +
      '  --dry       simulate, send nothing\n' +
      '  --rehearse  a throwaway token on a burner key, then scan it\n' +
      '  --go        the launch');
}
const MODE = mode[0].slice(2);
const FORCE = has('--force');
const CONFIG_PATH = arg('--config', join(HERE, 'launch.config.json'));

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const rule = () => console.log(dim('  ' + '-'.repeat(72)));
const h = (t) => { console.log(`\n${bold('  ' + t)}`); rule(); };

/**
 * The key comes from the shell and from nowhere else.
 *
 * A key in a file beside the code is a key that reaches a server the first time
 * somebody copies a directory, so the presence of one in any .env here is
 * treated as the mistake it is rather than read.
 */
function readKey(varName) {
  for (const f of readdirSync(ROOT).filter((x) => x === '.env' || x.startsWith('.env.'))) {
    const body = readFileSync(join(ROOT, f), 'utf8');
    if (new RegExp(`^\\s*(export\\s+)?${varName}\\s*=`, 'm').test(body)) {
      die(red(`${varName} is set in ${f}.`) + '\n  a launch key never lives in a file next to the code.\n' +
          `  remove that line, then:  ${varName}=0x... node tools/launch.mjs --${MODE}`);
    }
  }
  const raw = (process.env[varName] ?? '').trim();
  if (!raw) die(`${varName} is not set in this shell.\n  ${varName}=0x... node tools/launch.mjs --${MODE}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) die(`${varName} is not a 32-byte hex private key`);
  return raw;
}

async function confirm(question, expected) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  ${question} `)).trim();
  rl.close();
  if (answer !== expected) die(`typed ${JSON.stringify(answer)}, expected ${JSON.stringify(expected)}. nothing was sent.`);
}

// ------------------------------------------------------------------ the plan

const rawConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const checked = P.validateConfig(rawConfig);
if (!checked.ok) die(`${CONFIG_PATH}:\n` + checked.errors.map((e) => `    ${e}`).join('\n'));
const cfg = checked.config;

/**
 * An unrecorded transaction from a previous run, before anything else.
 *
 * The record is written between sending and awaiting the receipt, so a crash
 * in that gap leaves a launch that went out and a file that says so. Saying it
 * first matters: a simulation can fail for its own reasons, and a run that
 * died on one of those would never reach this and would invite a second send.
 */
mkdirSync(OUT, { recursive: true });
const pendingPath = join(OUT, `pending-${MODE}.json`);
if (existsSync(pendingPath) && MODE !== 'dry') {
  const pend = JSON.parse(readFileSync(pendingPath, 'utf8'));
  die(red('a previous run of this mode sent a transaction and did not record its receipt.') +
      `\n  tx     ${pend.txHash}\n  nonce  ${pend.nonce}\n  sent   ${pend.at}\n  as     ${pend.symbol}\n` +
      '\n  check that transaction before sending another. if it landed, the launch is done.\n' +
      `  if it failed or was dropped, delete ${pendingPath} and run again.`);
}

const isRehearsal = MODE === 'rehearse';
const symbol = isRehearsal ? P.rehearsalSymbol(cfg.symbol, cfg.rehearsal.symbolSuffix) : cfg.symbol;
const name = isRehearsal ? `${cfg.name} rehearsal` : cfg.name;
const devBuyWei = P.toWei(isRehearsal ? cfg.rehearsal.devBuyEth : cfg.devBuyEth);

console.log(`\n${bold(`  VITALS launch tool, ${MODE}`)}`);
console.log(dim(`  config ${CONFIG_PATH}`));
console.log(dim(`  rpc    ${RPC_URL}`));

// ---------------------------------------------------------------- the chain

h('the chain');
const [chainCfg, launchFee, launchEnabled, maxTax, head] = await Promise.all([
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getLaunchConfig', args: [BigInt(cfg.launchConfigId)] }),
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'launchFee' }),
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'launchEnabled' }),
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'maxCreatorTaxBps' }),
  client.getBlockNumber(),
]);
console.log(`  config ${cfg.launchConfigId}: supply ${formatUnits(chainCfg.supply, 18)} · curve fee ${Number(chainCfg.curveFeeBps) / 100}% · phantom quote ${formatEther(chainCfg.phantomQuote)} · graduation ${formatEther(chainCfg.graduationThreshold)}`);
console.log(`  launch fee ${formatEther(launchFee)} ETH · launches ${launchEnabled ? 'enabled' : red('DISABLED')} · max creator tax ${Number(maxTax) / 100}% · head ${head}`);
if (!chainCfg.enabled) die(`launch config ${cfg.launchConfigId} is disabled on the factory`);
if (!launchEnabled) die('the factory has launches disabled');
if (BigInt(cfg.creatorTaxBps) > maxTax) die(`creatorTaxBps ${cfg.creatorTaxBps} is over the factory maximum of ${maxTax}`);

// ----------------------------------------------------------- the curve model

h('the opening buy');
const cal = calibrate({ supply: chainCfg.supply, phantomQuote: chainCfg.phantomQuote, curveFeeBps: chainCfg.curveFeeBps });
console.log(`  ${cal.ok ? cal.line : red(cal.line)}`);
if (!cal.ok) {
  die(red('the curve model is wrong.') + '\n' +
      `  it no longer reproduces ${CALIBRATION.txHash}, a launch that is on chain.\n` +
      '  the factory\'s economics have changed, or the model has. nothing was sent.');
}

const quote = quoteLaunchBuy(
  { supply: chainCfg.supply, phantomQuote: chainCfg.phantomQuote, curveFeeBps: chainCfg.curveFeeBps },
  BigInt(cfg.creatorTaxBps), devBuyWei,
);
console.log(`  dev buy      ${bold(`${formatEther(devBuyWei)} ETH`)}`);
console.log(`     curve fee ${formatEther(quote.curveFee)} ETH · creator tax ${formatEther(quote.creatorTax)} ETH to ${cfg.creatorFeeRecipient}`);
console.log(`     reaching the curve: ${formatEther(quote.quoteNet)} ETH`);
console.log(`  buys         ${bold(`${Number(formatUnits(quote.tokensOut, 18)).toLocaleString('en-US', { maximumFractionDigits: 3 })} tokens`)}`);
console.log(`  which is     ${bold(`${quote.supplyPct.toFixed(4)}% of supply`)}  ${dim(`(cap ${P.DEV_BUY_MAX_PCT}%)`)}`);

const cap = P.checkDevBuyCap(quote.supplyPct);
if (!cap.ok) die(red('refused: ') + cap.reason);

// -------------------------------------------------------------- the window

const win = P.checkLaunchWindow(Date.now(), FORCE);
if (!win.ok) {
  if (MODE === 'dry') console.log(`\n  ${dim('window:')} ${win.reason}  ${dim('(a dry run sends nothing, so it is not refused)')}`);
  else die(red('refused: ') + win.reason);
} else if (FORCE) {
  console.log(`\n  ${dim('window: outside Mon to Thu 15:00-18:00, allowed by --force')}`);
}

// ------------------------------------------------------------- what is sent

const deployerKey = MODE === 'dry' ? null : readKey(isRehearsal ? 'REHEARSAL_PRIVATE_KEY' : 'LAUNCH_PRIVATE_KEY');
const account = deployerKey
  ? privateKeyToAccount(deployerKey)
  : { address: getAddress(arg('--as', cfg.recipient)) };
const deployer = account.address;

// The deployer is exempt because the protocol exempts it; the list is stated in
// full so that "nobody but me" is something read rather than assumed.
const exemptions = [deployer, ...cfg.extraExemptions.map(getAddress)]
  .filter((a, i, all) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);

const params = {
  name, symbol,
  logo: cfg.logo,
  description: cfg.description,
  socials: cfg.socials,
  creatorFeeRecipient: getAddress(cfg.creatorFeeRecipient),
  creatorTaxBps: cfg.creatorTaxBps,
  buybackEnabled: cfg.buybackEnabled,
  expectedEconomics: cfg.expectedEconomics,
  salt: cfg.salt,
};
const recipient = isRehearsal ? deployer : getAddress(cfg.recipient);
const args = [params, BigInt(cfg.launchConfigId), getAddress(cfg.pairToken), devBuyWei, BigInt(cfg.minTokensOut), recipient, exemptions];

// What this config will actually make tax free, which is the union of four
// slots and not the length of the array we pass.
const expectedWallets = C.expectedExemptWallets({
  deployer,
  creatorFeeRecipient: cfg.creatorFeeRecipient,
  recipient,
  extraExemptions: cfg.extraExemptions,
});
const value = launchFee + devBuyWei;

h('the transaction');
console.log(`  router       ${LAUNCH_FORWARDER}  ${dim('launchAndBuy')}`);
console.log(`  deployer     ${deployer}${deployerKey ? '' : dim('  (no key in --dry; --as <address> to simulate as someone else)')}`);
console.log(`  name         ${name}`);
console.log(`  symbol       ${bold(symbol)}${isRehearsal ? dim(`  (rehearsal, the real one is ${cfg.symbol})`) : ''}`);
console.log(`  pair         ETH`);
console.log(`  creator tax  ${cfg.creatorTaxBps} bps (${cfg.creatorTaxBps / 100}%) to ${cfg.creatorFeeRecipient}`);
console.log(`  buyback vest ${cfg.buybackEnabled}`);
console.log(`  recipient    ${recipient}  ${dim('receives the opening buy')}`);
console.log(`  economics    ${cfg.expectedEconomics}`);
console.log(`  salt         ${cfg.salt}`);
console.log(`  exemptions   ${bold(`${expectedWallets.length} wallet${expectedWallets.length === 1 ? '' : 's'}`)}`
  + dim(`  ${C.expectedExemptEvents({ deployer, creatorFeeRecipient: cfg.creatorFeeRecipient, recipient, extraExemptions: cfg.extraExemptions })} events, one per slot`));
expectedWallets.forEach((a, i) => console.log(`     ${i + 1}. ${getAddress(a)}`));

// ----------------------------------------------------------- the simulation

h('simulation');
let predicted;
try {
  const sim = await client.simulateContract({
    address: LAUNCH_FORWARDER, abi: forwarderAbi, functionName: 'launchAndBuy',
    args, account: deployer, value,
  });
  predicted = { token: sim.result[0], curve: sim.result[1] };
  console.log(`  ${bold('would succeed')}`);
  console.log(`  token (CA)   ${bold(predicted.token)}`);
  console.log(`  curve        ${predicted.curve}`);
} catch (err) {
  const msg = String(err.shortMessage ?? err.message).split('\n').filter(Boolean).slice(0, 3).join('\n  ');
  if (msg.includes('0xecb27319')) {
    die(red('the factory rejected expectedEconomics.') +
        '\n  the economics of this config or pair changed since that hash was written.' +
        '\n  read the current one off a recent successful ETH-pair launch before going again.');
  }
  die(red('the simulation reverted, so the real transaction would too:') + `\n  ${msg}`);
}

const already = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getLaunchedToken', args: [predicted.token] });
if (already.exists) die(`${predicted.token} is already a launched token. change the salt.`);

// --------------------------------------------------------------- gas and cost

let gas = 0n, gasPrice = 0n;
try {
  [gas, gasPrice] = await Promise.all([
    client.estimateContractGas({ address: LAUNCH_FORWARDER, abi: forwarderAbi, functionName: 'launchAndBuy', args, account: deployer, value }),
    client.getGasPrice(),
  ]);
} catch (err) {
  console.log(dim(`  gas could not be estimated: ${String(err.shortMessage ?? err.message).slice(0, 80)}`));
}
const gasCost = gas * gasPrice;
const total = value + gasCost;

h('what leaves the wallet');
console.log(`  launch fee   ${formatEther(launchFee)} ETH`);
console.log(`  dev buy      ${formatEther(devBuyWei)} ETH`);
console.log(`  gas          ${formatEther(gasCost)} ETH  ${dim(`(${gas} units at ${formatUnits(gasPrice, 9)} gwei)`)}`);
console.log(`  ${bold(`total        ${formatEther(total)} ETH`)}`);
if (quote.creatorTax > 0n) {
  console.log(dim(`  of the dev buy, ${formatEther(quote.creatorTax)} ETH is the creator tax and returns to ${cfg.creatorFeeRecipient}`));
}
if (deployerKey) {
  const bal = await client.getBalance({ address: deployer });
  console.log(`  wallet holds ${formatEther(bal)} ETH`);
  if (bal < total) die(red(`the wallet is short: ${formatEther(bal)} ETH against ${formatEther(total)} ETH needed`));
}

// ------------------------------------------------------------- dry run stops

/** The comparison, printed after every mode. */
function printDiff(actual) {
  h('config vs chain');
  console.log(P.renderDiff(P.diffRows({
    symbol,
    name,
    pairToken: getAddress(cfg.pairToken),
    launchConfigId: String(cfg.launchConfigId),
    creatorTaxBps: String(cfg.creatorTaxBps),
    buybackEnabled: String(cfg.buybackEnabled),
    supply: formatUnits(chainCfg.supply, 18),
    devBuyEth: formatEther(devBuyWei),
    openingBuyTokens: formatUnits(quote.tokensOut, 18),
    openingBuyPct: `${quote.supplyPct.toFixed(4)}%`,
    exemptions: `${expectedWallets.length} wallet${expectedWallets.length === 1 ? '' : 's'}`,
    token: predicted.token,
    curve: predicted.curve,
  }, actual)));
}

if (MODE === 'dry') {
  printDiff({
    symbol, name,
    pairToken: getAddress(cfg.pairToken),
    launchConfigId: String(cfg.launchConfigId),
    creatorTaxBps: String(cfg.creatorTaxBps),
    buybackEnabled: String(cfg.buybackEnabled),
    supply: formatUnits(chainCfg.supply, 18),
    devBuyEth: formatEther(devBuyWei),
    openingBuyTokens: null,
    openingBuyPct: null,
    exemptions: null,
    token: predicted.token,
    curve: predicted.curve,
  });
  h('next');
  console.log('  nothing was sent. the model is calibrated and the transaction simulates clean.');
  console.log(`  arm the bot BEFORE the launch, so the CA is posted the moment it lands:`);
  console.log(`\n    ${bold(`/launch watch ${deployer}`)}\n`);
  console.log(dim('  then rehearse:  REHEARSAL_PRIVATE_KEY=0x... node tools/launch.mjs --rehearse'));
  process.exit(0);
}

// ------------------------------------------------------------------ sending

h(MODE === 'go' ? 'confirm the launch' : 'confirm the rehearsal');
console.log(`  this sends ${bold(`${formatEther(total)} ETH`)} from ${deployer}`);
console.log(`  and launches ${bold(symbol)} with ${exemptions.length} exempt wallet${exemptions.length === 1 ? '' : 's'}.`);
if (MODE === 'go') console.log(red('  this is the real launch. it cannot be undone.'));
console.log('');
await confirm(`type the symbol to confirm (${symbol}):`, symbol);

const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(RPC_URL) });
const nonce = await client.getTransactionCount({ address: deployer, blockTag: 'pending' });

console.log(`\n  sending at nonce ${nonce}...`);
const txHash = await wallet.writeContract({
  address: LAUNCH_FORWARDER, abi: forwarderAbi, functionName: 'launchAndBuy',
  args, value, nonce, gas: gas > 0n ? (gas * 12n) / 10n : undefined,
});
// Written BEFORE the receipt is awaited. A crash here must not look like a
// launch that never went out, because the next run would send a second one.
writeFileSync(pendingPath, JSON.stringify({ mode: MODE, txHash, nonce, deployer, symbol, at: new Date().toISOString() }, null, 2));
console.log(`  tx ${bold(txHash)}`);
console.log(dim(`  recorded as pending in ${pendingPath}`));

const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
if (receipt.status !== 'success') {
  die(red(`the transaction reverted in block ${receipt.blockNumber}.`) + `\n  ${txHash}\n  nothing launched; the pending record is kept.`);
}

// ------------------------------------------------------- what actually landed

let landed = null, buy = null;
const exempted = [];
for (const log of receipt.logs) {
  try {
    const d = decodeEventLog({ abi: [TokenLaunched], data: log.data, topics: log.topics });
    landed = d.args;
    continue;
  } catch (err) { /* not this event */ }
  try {
    const d = decodeEventLog({ abi: [CurveBuy], data: log.data, topics: log.topics });
    if (!buy) buy = d.args;
    continue;
  } catch (err) { /* not this event */ }
  try {
    const d = decodeEventLog({ abi: [SnipeTaxExempted], data: log.data, topics: log.topics });
    exempted.push(getAddress(d.args.wallet));
  } catch (err) { /* not this event either */ }
}
if (!landed) die(`no TokenLaunched event in ${txHash}. the transaction succeeded but did not launch.`);

// The curve emits one event per SLOT, not one per wallet: the sender, the
// creator fee recipient, the opening-buy recipient and every entry of the
// exemptions array, duplicates included. VITALSRH1 emitted four for two
// wallets. The number that means anything is the size of the distinct set.
const distinctExempt = [...new Set(exempted.map((a) => a.toLowerCase()))].map(getAddress);

h('landed');
console.log(`  token (CA)   ${bold(landed.token)}`);
console.log(`  curve        ${landed.curve}`);
console.log(`  block        ${receipt.blockNumber}`);
console.log(`  gas used     ${receipt.gasUsed} units`);
console.log(`  exempt       ${bold(`${distinctExempt.length} wallet${distinctExempt.length === 1 ? '' : 's'}`)}`
  + dim(`  from ${exempted.length} event${exempted.length === 1 ? '' : 's'}, one per slot filled`));
distinctExempt.forEach((a, i) => {
  const times = exempted.filter((e) => e.toLowerCase() === a.toLowerCase()).length;
  const slots = [
    a.toLowerCase() === deployer.toLowerCase() ? 'sender' : null,
    a.toLowerCase() === getAddress(cfg.creatorFeeRecipient).toLowerCase() ? 'creatorFeeRecipient' : null,
    a.toLowerCase() === recipient.toLowerCase() ? 'recipient' : null,
    cfg.extraExemptions.some((x) => getAddress(x).toLowerCase() === a.toLowerCase()) ? 'extraExemptions' : null,
    exemptions.some((x) => x.toLowerCase() === a.toLowerCase()) ? 'exemptions[]' : null,
  ].filter(Boolean);
  console.log(`     ${i + 1}. ${a}  ${dim(`x${times}: ${slots.join(', ') || 'no slot in this config'}`)}`);
});
if (buy) {
  const pct = Number((buy.tokensOut * 1_000_000n) / chainCfg.supply) / 10_000;
  console.log(`  opening buy  ${Number(formatUnits(buy.tokensOut, 18)).toLocaleString('en-US', { maximumFractionDigits: 3 })} tokens (${pct.toFixed(4)}% of supply)`);
}

const record = {
  mode: MODE, symbol, name,
  token: landed.token, curve: landed.curve, deployer,
  txHash, block: Number(receipt.blockNumber),
  launchedAt: new Date().toISOString(),
  devBuyEth: formatEther(devBuyWei),
  openingBuyTokens: buy ? formatUnits(buy.tokensOut, 18) : null,
  openingBuyPct: buy ? Number((buy.tokensOut * 1_000_000n) / chainCfg.supply) / 10_000 : null,
  predictedTokensOut: formatUnits(quote.tokensOut, 18),
  exemptions: exempted.length ? exempted : exemptions,
  creatorTaxBps: cfg.creatorTaxBps,
  config: CONFIG_PATH,
};
const recordPath = join(OUT, `${MODE}-${landed.token.toLowerCase()}.json`);
writeFileSync(recordPath, JSON.stringify(record, null, 2));
try { (await import('node:fs')).unlinkSync(pendingPath); } catch (err) { /* already gone */ }
console.log(`  recorded in  ${recordPath}`);

printDiff({
  symbol, name,
  pairToken: getAddress(landed.pairToken),
  launchConfigId: String(landed.launchConfigId),
  creatorTaxBps: String(cfg.creatorTaxBps),
  buybackEnabled: String(cfg.buybackEnabled),
  supply: formatUnits(chainCfg.supply, 18),
  devBuyEth: buy ? formatEther(buy.quoteIn) : formatEther(devBuyWei),
  openingBuyTokens: buy ? formatUnits(buy.tokensOut, 18) : null,
  openingBuyPct: buy ? `${(Number((buy.tokensOut * 1_000_000n) / chainCfg.supply) / 10_000).toFixed(4)}%` : null,
  exemptions: `${distinctExempt.length} wallet${distinctExempt.length === 1 ? '' : 's'}`,
  token: landed.token,
  curve: landed.curve,
});

// ------------------------------------------------------------ scan and card

if (isRehearsal) {
  h('the card, from this repo\'s own scanner');
  try {
    const { scanToken } = await import(join(ROOT, 'dist/scan.js'));
    const { renderCardText } = await import(join(ROOT, 'dist/card.js'));
    const res = await scanToken(landed.token);
    console.log(res ? renderCardText(res) : '  the scanner does not see it yet; run again in a few seconds');
  } catch (err) {
    console.log(`  the scan failed: ${String(err?.message ?? err).slice(0, 200)}`);
    console.log(dim(`  scan it by hand:  npm run scan -- ${landed.token} --full`));
  }
}

h('next');
if (MODE === 'go') {
  console.log(`  ${bold('the CA is ' + landed.token)}`);
  console.log('  paste into the bot, if it was not armed before the launch:');
  console.log(`\n    ${bold(`/launch watch ${deployer}`)}\n`);
  console.log(dim(`  the record is ${recordPath}`));
} else {
  console.log(`  rehearsed ${symbol} as ${landed.token}.`);
  console.log(`  the real launch will use symbol ${bold(cfg.symbol)} and a dev buy of ${cfg.devBuyEth} ETH.`);
  console.log(dim('  when it is right:  LAUNCH_PRIVATE_KEY=0x... node tools/launch.mjs --go'));
}
console.log('');
