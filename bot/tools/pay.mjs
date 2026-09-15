#!/usr/bin/env node
/**
 * The payer.
 *
 * Reads the CSV the bot produced, prints what it is about to do, asks for the
 * total to be typed back, and then sends one transfer per row. The bot never
 * holds a key and never sends anything; this does, from a machine that has one.
 *
 * A crash cannot pay twice. Every row is given a nonce when the plan is first
 * written, and a resumed run reuses it, so a row that already landed is
 * rejected by the chain the second time rather than mined again. The plan is
 * written before the first transfer and updated after each one.
 *
 *   FEE_WALLET_PRIVATE_KEY=0x... node tools/pay.mjs --csv vitals-ledger-run-3.csv --run 3
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'out');

const { client, robinhoodChain } = await import(join(ROOT, 'dist/chain.js'));
const { RPC_URL } = await import(join(ROOT, 'dist/config.js'));
const P = await import(join(ROOT, 'dist/payplan.js'));

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const die = (m, code = 1) => { console.error(`\n  ${m}\n`); process.exit(code); };
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const csvPath = arg('--csv');
const runId = arg('--run');
if (!csvPath || !runId) {
  die('usage: FEE_WALLET_PRIVATE_KEY=0x... node tools/pay.mjs --csv <file> --run <id>');
}
if (!existsSync(csvPath)) die(`${csvPath} does not exist`);

/** The key comes from the shell, never from a file beside the code. */
for (const f of readdirSync(ROOT).filter((x) => x === '.env' || x.startsWith('.env.'))) {
  if (/^\s*(export\s+)?FEE_WALLET_PRIVATE_KEY\s*=/m.test(readFileSync(join(ROOT, f), 'utf8'))) {
    die(red(`FEE_WALLET_PRIVATE_KEY is set in ${f}.`) + '\n  a key that pays people never lives in a file next to the code.');
  }
}
const key = (process.env.FEE_WALLET_PRIVATE_KEY ?? '').trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('FEE_WALLET_PRIVATE_KEY is not set in this shell, or is not a 32-byte hex key');
const account = privateKeyToAccount(key);

const parsed = P.parsePayCsv(readFileSync(csvPath, 'utf8'));
if (!parsed.ok) die(`${csvPath}:\n` + parsed.errors.map((e) => `    ${e}`).join('\n'));
const rows = parsed.rows;
const total = P.totalWei(rows);

mkdirSync(OUT, { recursive: true });
const planPath = join(OUT, `pay-run-${runId}.json`);
const stored = existsSync(planPath) ? P.planFromJson(readFileSync(planPath, 'utf8')) : null;
const pendingNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
const built = P.buildPlan({ runId, from: account.address, rows, baseNonce: pendingNonce, stored });
if (!built.ok) die(red('the stored plan does not match this file:') + `\n  ${built.reason}\n  ${planPath}`);
const plan = built.plan;
const todo = P.unsent(plan);
const done = P.sentEntries(plan);

console.log(`\n${bold('  VITALS payer')}`);
console.log(dim(`  csv   ${basename(csvPath)}`));
console.log(dim(`  rpc   ${RPC_URL}`));
console.log(`\n  from         ${account.address}`);
console.log(`  recipients   ${bold(String(rows.length))}`);
console.log(`  total        ${bold(`${formatEther(total)} ETH`)}`);
if (built.resumed) {
  console.log(`\n  ${bold('resuming')} ${planPath}`);
  console.log(`  ${done.length} already sent, ${todo.length} to go`);
  for (const e of done) console.log(dim(`    sent  ${e.wallet}  ${e.amountEth} ETH  ${e.txHash}`));
}
if (!todo.length) {
  console.log(`\n  every row is already sent. nothing to do.\n`);
  console.log(`  paste into the bot:\n\n    ${P.recordCommand(plan)}\n`);
  process.exit(0);
}

const outstanding = P.totalWei(todo);
const bal = await client.getBalance({ address: account.address });
const gasPrice = await client.getGasPrice();
const gasEach = 21_000n;
const gasTotal = gasEach * gasPrice * BigInt(todo.length);
console.log(`\n  to send now  ${bold(`${formatEther(outstanding)} ETH`)} over ${todo.length} transfer${todo.length === 1 ? '' : 's'}`);
console.log(`  gas          about ${formatEther(gasTotal)} ETH`);
console.log(`  wallet holds ${formatEther(bal)} ETH`);
if (bal < outstanding + gasTotal) {
  die(red(`the wallet is short: ${formatEther(bal)} ETH against ${formatEther(outstanding + gasTotal)} ETH needed`));
}
console.log(`  nonces       ${todo[0].nonce} to ${todo[todo.length - 1].nonce}${built.resumed ? dim('  (from the stored plan, so a row that landed cannot be paid twice)') : ''}`);
console.log('');
for (const e of todo) console.log(`    ${e.wallet}  ${e.amountEth} ETH  ${dim(`nonce ${e.nonce}`)}`);

const expected = formatEther(outstanding);
console.log('');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed = (await rl.question(`  type the total to send (${expected}): `)).trim();
rl.close();
if (typed !== expected) die(`typed ${JSON.stringify(typed)}, expected ${JSON.stringify(expected)}. nothing was sent.`);

const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(RPC_URL) });
const save = () => writeFileSync(planPath, P.planToJson(plan));
save();

console.log('');
for (const e of plan.entries) {
  if (e.status === 'sent' && e.txHash) continue;
  try {
    const hash = await wallet.sendTransaction({ to: e.wallet, value: e.amountWei, nonce: e.nonce });
    e.txHash = hash;
    e.status = 'sent';
    save();   // after every single one, so a crash loses nothing
    console.log(`  ${String(e.index + 1).padStart(3)}/${plan.entries.length}  ${e.wallet}  ${e.amountEth} ETH  ${hash}`);
  } catch (err) {
    const msg = String(err?.shortMessage ?? err?.message ?? err).split('\n')[0];
    // A nonce the chain has already used means this row landed on an earlier
    // run. That is the guard doing its job, not a failure to pay.
    if (/nonce|already known|replacement/i.test(msg)) {
      e.status = 'failed';
      e.error = msg;
      save();
      console.log(red(`  ${String(e.index + 1).padStart(3)}/${plan.entries.length}  ${e.wallet}  nonce ${e.nonce} is spent: this row was already paid. left alone.`));
      continue;
    }
    e.status = 'failed';
    e.error = msg;
    save();
    die(red(`row ${e.index + 1} failed: ${msg}`) +
        `\n  ${P.sentEntries(plan).length} of ${plan.entries.length} were sent and are recorded in\n  ${planPath}` +
        '\n\n  fix the cause and run the same command again: it resumes, and the rows already sent are not sent again.');
  }
}

const sent = P.sentEntries(plan);
console.log(`\n  ${bold(`${sent.length} of ${plan.entries.length} sent`)}, ${formatEther(P.totalWei(sent))} ETH`);
console.log(dim(`  every hash is in ${planPath}`));
console.log(`\n  paste into the bot:\n\n${P.recordCommand(plan)}\n`);
