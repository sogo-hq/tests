#!/usr/bin/env node
/**
 * tools/dayrun.mjs --token <ca> --room <chat id> [--fast]
 *
 * The launch-day timeline, run end to end against a token that already exists.
 *
 * Detect the launch the way /launch watch does, pin the CA in the room, post
 * the self scan at T+15, and at T+4h run the ledger: preview, csv, the payer,
 * the hashes, the public post. Every step writes its state to
 * tools/out/dayrun-<ca>.json, so a rerun continues where it stopped and never
 * repeats a post or a payment.
 *
 * --fast compresses the waits to seconds, for the Friday private-group test.
 *
 * The payer runs in burner mode when BURNER_PRIVATE_KEY is in the shell:
 * a throwaway key, three throwaway recipients, dust, capped by payplan. With
 * no key it builds the plan and prints it without sending anything. This
 * script never runs the real fee wallet path; that is typed by a person on
 * launch day, which is the point of the confirmation pay.mjs asks for.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'out');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const die = (m, code = 1) => { console.error(`\n  ${m}\n`); process.exit(code); };

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const rule = () => console.log(dim('  ' + '-'.repeat(72)));
const h = (t) => { console.log(`\n${bold('  ' + t)}`); rule(); };

const TOKEN = (arg('--token') ?? '').toLowerCase();
const ROOM = Number(arg('--room'));
const FAST = has('--fast');
const BALANCE_ETH = arg('--balance');

if (!/^0x[0-9a-f]{40}$/.test(TOKEN) || !Number.isSafeInteger(ROOM) || ROOM === 0) {
  die('usage: node tools/dayrun.mjs --token <ca> --room <chat id> [--fast] [--balance <eth>]\n\n'
    + '  --fast       every wait becomes seconds, for the private group test\n'
    + '  --balance    a typed fee wallet balance. the run is marked hypothetical\n'
    + '  --status     print what has run and stop');
}

const D = await import(join(ROOT, 'dist/dayrun.js'));
const L = await import(join(ROOT, 'dist/ledger.js'));
const R = await import(join(ROOT, 'dist/roster.js'));
const { db } = await import(join(ROOT, 'dist/db.js'));
const { TELEGRAM_BOT_TOKEN } = await import(join(ROOT, 'dist/config.js'));

mkdirSync(OUT, { recursive: true });
const STATE_PATH = join(OUT, `dayrun-${TOKEN}.json`);
const now = () => Math.floor(Date.now() / 1000);

const loaded = D.loadState(existsSync(STATE_PATH) ? readFileSync(STATE_PATH, 'utf8') : null, TOKEN, ROOM, FAST, now());
if (loaded.error) die(red('refusing to resume: ') + loaded.error + `\n  ${STATE_PATH}`);
let state = loaded.state;
const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

console.log(`\n${bold('  VITALS launch-day harness')}${FAST ? dim('  --fast') : ''}`);
console.log(dim(`  token ${TOKEN}`));
console.log(dim(`  room  ${ROOM}`));
console.log(dim(`  state ${STATE_PATH}`));
if (loaded.resumed) console.log(dim('  resuming: a step that already ran is skipped, not repeated'));

if (has('--status')) {
  h('what has run');
  D.progressLines(state).forEach((l) => console.log(l));
  console.log('');
  process.exit(0);
}

// The bot's own Api, so every send goes through the same client the bot uses.
if (!TELEGRAM_BOT_TOKEN) die('TELEGRAM_BOT_TOKEN is not set in this shell');
const { Api } = await import('grammy');
const api = new Api(TELEGRAM_BOT_TOKEN);

/** Sleep until a step is due, printing where it is up to. */
async function waitUntil(step) {
  let left = D.waitFor(state, step, now());
  if (left <= 0) return;
  console.log(dim(`  waiting ${left}s for ${step}${FAST ? '' : `, due ${new Date(D.dueAt(state, step) * 1000).toISOString().slice(11, 19)}Z`}`));
  while (left > 0) {
    const chunk = Math.min(left, 15);
    await new Promise((r) => setTimeout(r, chunk * 1000));
    left = D.waitFor(state, step, now());
    if (left > 0) process.stdout.write(dim(`\r  ${left}s   `));
  }
  process.stdout.write('\r');
}

const skip = (step) => {
  if (!D.isDone(state, step)) return false;
  const s = state.steps[step];
  console.log(dim(`  already done ${new Date(s.at * 1000).toISOString().slice(0, 19).replace('T', ' ')}, not repeating`));
  return true;
};

// ------------------------------------------------------------------- detect

h('1. detect the launch');
if (!skip('detect')) {
  // The same source /launch watch matches against: the indexed launch row.
  const row = db
    .prepare('SELECT token, symbol, name, deployer, launched_at, block_number FROM launches WHERE token = ?')
    .get(TOKEN);
  if (!row) {
    die(`${TOKEN} is not in the index.\n  the harness runs against a launch the bot has already seen, the way the group does.\n`
      + '  start the bot against this chain, let the indexer reach it, and run this again.');
  }
  state.t0 = row.launched_at;
  console.log(`  ${row.symbol ?? '?'}  ${row.name ?? ''}`);
  console.log(`  deployer     ${row.deployer}`);
  console.log(`  launched     ${new Date(row.launched_at * 1000).toISOString().replace('T', ' ').slice(0, 19)}  block ${row.block_number.toLocaleString()}`);
  D.markDone(state, 'detect', { symbol: row.symbol ?? '?', block: row.block_number }, now());
  save();
} else if (state.t0 === null) {
  const row = db.prepare('SELECT launched_at FROM launches WHERE token = ?').get(TOKEN);
  state.t0 = row?.launched_at ?? state.startedAt;
  save();
}

// ---------------------------------------------------------------------- pin

h('2. pin the CA in the room');
if (!skip('pin')) {
  const symbol = state.steps.detect?.detail?.symbol ?? '?';
  const sent = await api.sendMessage(ROOM, `${symbol} is live. CA: ${TOKEN}\nthis is the only CA.`, {
    link_preview_options: { is_disabled: true },
  });
  // Recorded BEFORE the pin: the message is what must not be sent twice, and a
  // pin that fails is a pin, not a second announcement.
  D.markDone(state, 'pin', { messageId: sent.message_id }, now());
  save();
  try {
    await api.pinChatMessage(ROOM, sent.message_id, { disable_notification: false });
    console.log(`  posted and pinned, message ${sent.message_id}`);
  } catch (err) {
    console.log(`  posted as message ${sent.message_id}, ${red('pin failed')}: ${String(err?.message ?? err).slice(0, 90)}`);
    console.log(dim('  the CA is in the room either way. pin it by hand.'));
  }
}

// ---------------------------------------------------------------- self scan

h(`3. the self scan, T+${FAST ? `${D.FAST_SELF_SCAN_SECONDS}s` : '15min'}`);
if (!skip('selfscan')) {
  await waitUntil('selfscan');
  const { performScan } = await import(join(ROOT, 'dist/service.js'));
  const out = await performScan({ token: TOKEN, source: 'cli', unlimited: true });
  if (out.kind !== 'ok') {
    die(`the scan did not finish: ${out.kind}.\n  nothing is posted from a scan that did not finish, so nothing was.`);
  }
  const sent = await api.sendMessage(ROOM, ['the launch, scanned by its own tool', '', out.defaultCard].join('\n'), {
    link_preview_options: { is_disabled: true },
  });
  D.markDone(state, 'selfscan', { messageId: sent.message_id }, now());
  save();
  console.log(`  card posted, message ${sent.message_id}`);
  console.log(dim('  posted as rendered. a line that says undetermined went out saying undetermined.'));
}

// ------------------------------------------------------------- the ledger

h(`4. the ledger, T+${FAST ? `${D.FAST_LEDGER_SECONDS}s` : '4h'}`);
await waitUntil('preview');

let run = null;
if (!skip('preview')) {
  const seats = R.liveSeats();
  if (!seats.length) die('the roster is empty. /seat add the seats first: there is nothing to pay.');

  let balanceWei;
  let hypothetical = false;
  if (BALANCE_ETH !== null) {
    balanceWei = BigInt(Math.round(Number(BALANCE_ETH) * 1e4)) * 10n ** 14n;
    hypothetical = true;
  } else {
    balanceWei = await L.feeWalletBalance();
    if (balanceWei === null) {
      die('the fee wallet balance could not be read, and no --balance was given.\n'
        + '  a run on a balance nobody read is not a run. set FEE_WALLET, or pass --balance <eth>.');
    }
  }
  run = L.computeRun({ balanceWei, seats, hypothetical });
  console.log(L.previewText(run));
  if (run.refusal) die(red('the ledger refuses this run:') + `\n  ${run.refusal}`);
  if (run.distributedWei <= 0n) {
    die('this run pays nothing: the pool is below the 4dp floor.\n  that is the correct answer, and there is nothing to send.');
  }
  const runId = L.saveRun(run);
  run.id = runId;
  D.markDone(state, 'preview', { runId, pool: L.eth(run.poolWei), seats: seats.length }, now());
  save();
} else {
  run = L.loadRun(state.steps.preview.detail.runId);
  if (!run) die(`ledger run ${state.steps.preview.detail.runId} is in the state file but not in the database`);
}

// ---------------------------------------------------------------------- csv

h('5. the csv the payer reads');
const csvPath = join(OUT, `ledger-run-${run.id}.csv`);
if (!skip('csv')) {
  writeFileSync(csvPath, L.csvText(run) + '\n');
  D.markDone(state, 'csv', { path: `ledger-run-${run.id}.csv`, rows: run.rows.length }, now());
  save();
}
console.log(`  ${csvPath}`);
console.log(dim(`  ${run.rows.length} row${run.rows.length === 1 ? '' : 's'}, ${L.eth(run.distributedWei)} ETH`));

// -------------------------------------------------------------------- pay

const burnerKey = (process.env.BURNER_PRIVATE_KEY ?? '').trim();
h(`6. the payer, ${burnerKey ? 'burner path' : 'dry'}`);
if (!skip('pay')) {
  if (!burnerKey) {
    console.log('  BURNER_PRIVATE_KEY is not in this shell, so nothing is sent.');
    console.log('');
    console.log(L.sendCommand(run, csvPath));
    D.markDone(state, 'pay', { mode: 'dry', hashes: 0 }, now());
    save();
  } else {
    // pay.mjs is not modified and not imported: it is run, exactly as a person
    // would run it, and its confirmation is answered with the total it printed.
    // The burner path is a throwaway key, three throwaway recipients and dust
    // that payplan caps, so answering it here risks nothing a person would not.
    const res = await runPayer();
    if (res.code !== 0 && res.code !== 9) {
      die(`the payer exited ${res.code}. nothing else has run, and this step is still due on the next run.`);
    }
    const planPath = join(OUT, 'pay-run-burner.json');
    if (!existsSync(planPath)) die('the payer left no plan file, so there is nothing to record');
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const hashes = plan.entries.filter((e) => e.status === 'sent' && e.txHash).map((e) => e.txHash);
    console.log(`  ${hashes.length} hash${hashes.length === 1 ? '' : 'es'} from the burner run`);
    D.markDone(state, 'pay', { mode: 'burner', hashes: hashes.length }, now());
    save();
  }
}

/** Run pay.mjs --burner and answer its confirmation with the figure it prints. */
function runPayer() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'pay.mjs'), '--burner'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    let answered = false;
    child.stdout.on('data', (d) => {
      const s = d.toString();
      buf += s;
      process.stdout.write(s);
      const m = /type the total to send \(([0-9.]+)\)/.exec(buf);
      if (m && !answered) {
        answered = true;
        child.stdin.write(`${m[1]}\n`);
        child.stdin.end();
      }
    });
    child.on('close', (code) => resolve({ code: code ?? 1, out: buf }));
  });
}

// ------------------------------------------------------------------- hashes

h('7. record the hashes');
if (!skip('tx')) {
  const mode = state.steps.pay?.detail?.mode;
  if (mode === 'dry') {
    console.log('  nothing was sent, so there is nothing to record.');
    D.markDone(state, 'tx', { recorded: 0, reason: 'dry' }, now());
    save();
  } else {
    const plan = JSON.parse(readFileSync(join(OUT, 'pay-run-burner.json'), 'utf8'));
    const hashes = plan.entries.filter((e) => e.status === 'sent' && e.txHash).map((e) => e.txHash);
    // The burner paid three throwaway addresses, not the roster, so the hashes
    // cannot be matched to seats by wallet. They are attached in order and only
    // because this run is a rehearsal: on launch day pay.mjs prints a line
    // keyed by wallet and /ledger tx reads that.
    const records = D.rehearsalTxRecords(run.rows, hashes);
    const res = L.recordTxs(run.id, records);
    console.log(`  ${res.recorded} recorded, ${res.already.length} already had a hash, ${res.unknown.length} unknown seat${res.unknown.length === 1 ? '' : 's'}`);
    if (records.length < run.rows.length) {
      console.log(dim(`  ${run.rows.length - records.length} row${run.rows.length - records.length === 1 ? '' : 's'} have no hash: the burner pays three recipients, the roster has ${run.rows.length}`));
    }
    D.markDone(state, 'tx', { recorded: res.recorded }, now());
    save();
  }
}

// -------------------------------------------------------------- the post

h('8. the public ledger');
if (!skip('post')) {
  const fresh = L.loadRun(run.id);
  const text = L.postText(fresh ?? run);
  // The rule the post exists to keep: hashes, no handles, no wallets.
  const seats = R.liveSeats();
  const leaked = seats.filter((s) => text.includes(s.wallet) || (s.handle && text.includes(s.handle)));
  if (leaked.length) {
    die(red(`the post contains ${leaked.length} handle or wallet and was not sent.`)
      + '\n  this is the check that stands between the room and somebody\'s address.');
  }
  const sent = await api.sendMessage(ROOM, text, { link_preview_options: { is_disabled: true } });
  D.markDone(state, 'post', { messageId: sent.message_id }, now());
  save();
  console.log(`  posted, message ${sent.message_id}`);
  console.log(dim('  no handle, no wallet: checked before the send, not after'));
}

h('done');
D.progressLines(state).forEach((l) => console.log(l));
console.log('');
console.log(dim(`  ${STATE_PATH}`));
console.log(dim('  running this again does nothing: every step is recorded.'));
console.log('');
