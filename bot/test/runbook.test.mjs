/**
 * The runbook, checked against the code it tells somebody to run.
 *
 * A runbook is read once, under time pressure, by somebody who cannot check
 * whether the command in it still exists. Every command and every number on
 * that page is checked here against the thing it describes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BOOK = readFileSync('docs/launch-day-runbook.md', 'utf8');
const BOT = readFileSync('src/bot.ts', 'utf8');
const LAUNCH = readFileSync('tools/launch.mjs', 'utf8');
const PAY = readFileSync('tools/pay.mjs', 'utf8');
const DAYRUN = readFileSync('tools/dayrun.mjs', 'utf8');

test('it covers all three days and the abort rules', () => {
  for (const heading of [
    '## Thursday: the rehearsal',
    '## Friday: the day, in a private group',
    '## Launch day',
    '## Abort rules',
    '### The launch transaction reverts',
    '### The indexer is lagging at T+0',
    '### A payout run dies part way through',
  ]) {
    assert.ok(BOOK.includes(heading), heading);
  }
});

test('every bot command it names exists', () => {
  const named = [...BOOK.matchAll(/^\/([a-z]+)/gm)].map((m) => m[1]);
  assert.ok(named.length >= 8, `only found ${named.length} commands in the runbook`);
  for (const cmd of new Set(named)) {
    assert.ok(
      BOT.includes(`bot.command('${cmd}'`) || BOT.includes(`bot.command(['${cmd}'`),
      `/${cmd} is in the runbook but not in bot.ts`,
    );
  }
});

test('every ledger and seat subcommand it names exists', () => {
  for (const sub of ['preview', 'csv', 'tx', 'post']) {
    assert.ok(BOOK.includes(`/ledger ${sub}`), `the runbook skips /ledger ${sub}`);
    assert.ok(BOT.includes(`sub === '${sub}'`), `/ledger ${sub} is gone from bot.ts`);
  }
  assert.ok(BOOK.includes('/seat add'));
  assert.ok(BOT.includes("sub === 'add'"));
});

test('every script flag it names exists in that script', () => {
  for (const flag of ['--check', '--dry', '--rehearse', '--go']) {
    assert.ok(BOOK.includes(`node tools/launch.mjs ${flag}`), `the runbook skips ${flag}`);
    assert.ok(LAUNCH.includes(`'${flag}'`), `${flag} is gone from launch.mjs`);
  }
  assert.ok(BOOK.includes('--burner') && PAY.includes("'--burner'"));
  assert.ok(BOOK.includes('--kill-after') && PAY.includes("'--kill-after'"));
  assert.ok(BOOK.includes('--fast') && DAYRUN.includes("'--fast'"));
});

test('the key variables it names are the ones the scripts read', () => {
  for (const v of ['REHEARSAL_PRIVATE_KEY', 'LAUNCH_PRIVATE_KEY']) {
    assert.ok(BOOK.includes(v), v);
    assert.ok(LAUNCH.includes(v), `${v} is gone from launch.mjs`);
  }
  for (const v of ['FEE_WALLET_PRIVATE_KEY', 'BURNER_PRIVATE_KEY']) {
    assert.ok(BOOK.includes(v), v);
    assert.ok(PAY.includes(v), `${v} is gone from pay.mjs`);
  }
});

test('it names no command that does not exist', () => {
  // The CA cannot be set by hand, and the runbook has to say so rather than
  // sending somebody looking for a command on launch day.
  assert.doesNotMatch(BOOK, /\/launch set ca/);
  assert.match(BOOK, /There is no\s+command that sets the CA/);
});

test('the numbers it states are the numbers in the code', async () => {
  const W = await import('../dist/watchdog.js');
  const D = await import('../dist/dayrun.js');
  const P = await import('../dist/payplan.js');

  // The watchdog threshold, quoted in the indexer abort rule.
  assert.match(BOOK, new RegExp(`over ${W.WATCHDOG_LAG_BLOCKS} blocks for two\\s+minutes`));
  assert.equal(W.WATCHDOG_LAG_SECONDS, 120);

  // The burner cap, quoted in the Thursday section.
  assert.equal(P.BURNER_MAX_TOTAL_WEI, 10n ** 15n);
  assert.match(BOOK, /caps at 0\.001 ETH in total/);

  // The self scan and ledger deadlines.
  assert.equal(D.SELF_SCAN_AFTER_SECONDS, 15 * 60);
  assert.equal(D.LEDGER_AFTER_SECONDS, 4 * 3600);
  assert.ok(BOOK.includes('### T+15min: the self scan'));
  assert.ok(BOOK.includes('### T+4h: the ledger'));
});

test('the rehearsal ticker and the record path are what the tool writes', async () => {
  const { rehearsalSymbol } = await import('../dist/launchplan.js');
  assert.equal(rehearsalSymbol('VITALS', 'RH1'), 'VITALSRH1');
  assert.match(BOOK, /\*\*VITALSRH1\*\*/);
  // The tool writes tools/out/<mode>-<token>.json, so the runbook says that.
  assert.match(BOOK, /tools\/out\/rehearse-<token address>\.json/);
  assert.ok(LAUNCH.includes('`${MODE}-${landed.token.toLowerCase()}.json`'));
});

test('the revert selector it names is the economics check', () => {
  assert.match(BOOK, /0xecb27319/);
  assert.match(BOOK, /economics hash/);
});

test('it never tells anyone to put a key on the server', () => {
  assert.match(BOOK, /No key ever reaches the server/);
  assert.match(BOOK, /read the key from the shell/);
  assert.doesNotMatch(BOOK, /\.env/);
  // And no key-looking literal is on the page.
  assert.doesNotMatch(BOOK, /0x[0-9a-fA-F]{64}/);
});

test('no verdict wording, no exclamation, no em dash', () => {
  assert.doesNotMatch(BOOK, /!/);
  assert.doesNotMatch(BOOK, /\bsafe to buy\b|\bgood entry\b|\bwill pump\b/i);
  assert.ok(!BOOK.includes(String.fromCharCode(0x2014)));
});

test('the abort rules say what to do, not just what went wrong', () => {
  const aborts = BOOK.slice(BOOK.indexOf('## Abort rules'));
  // Each rule ends in an instruction, and the payout one says the thing that
  // actually loses money: an unrecorded half run pays those seats twice.
  assert.match(aborts, /pays those seats twice/);
  assert.match(aborts, /Run the identical command\. It resumes/);
  assert.match(aborts, /reproduces the revert\s+without sending anything/);
  assert.match(aborts, /Do not post a card built on a partial\s+read/);
});
