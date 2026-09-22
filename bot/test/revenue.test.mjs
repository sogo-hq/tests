/**
 * The public revenue page.
 *
 * The figure that matters is "owed to BLOCK ZERO", and the only thing worth
 * proving about it is that it is /ledger's number rather than a second
 * implementation of the same arithmetic. So it is asserted against computeRun
 * to the wei, at four states of the ledger, rather than against a constant
 * somebody typed into this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('revenue');
process.env.FEE_WALLET = '0x' + 'ab'.repeat(20);

const { db } = await import('../dist/db.js');
const R = await import('../dist/revenue.js');
const L = await import('../dist/ledger.js');
const { EXPLORER_URL } = await import('../dist/config.js');

const ETH = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const W = (n) => '0x' + String(n).padStart(40, '0');
const HASH = (n) => '0x' + String(n).padStart(64, '0');
const NOW = 1_800_000_000_000;

const reset = () => {
  for (const t of ['ledger_payments', 'ledger_runs', 'ledger_sweeps', 'seats', 'seat_events']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
};

/** A run with its payments, the way /ledger writes one after pay.mjs reports. */
const payout = (runId, seat, amountWei, { hash, at, gas = 0n } = {}) => {
  db.prepare(
    `INSERT INTO ledger_payments (run_id, seat, handle, wallet, tier, shares, amount_wei, tx_hash, sent_at, gas_wei)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(runId, seat, `member_${seat}`, W(seat), 'T1', 5, String(amountWei),
        hash ?? null, at ?? null, hash ? String(gas) : null);
};

const sweep = (hash, valueWei, at) =>
  db.prepare(
    `INSERT INTO ledger_sweeps (tx_hash, to_address, value_wei, gas_wei, block, at, recorded_at, by_user)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(hash, W(999), String(valueWei), '0', 1000, at, at, 9001);

// ---------------------------------------------------------------- empty

test('before anything has come in it is empty, and says so in one field', () => {
  reset();
  const d = R.buildRevenue({ balanceWei: 0n, headBlock: null, now: NOW });
  assert.equal(d.as_of.empty, true);
  assert.equal(d.claimed_eth, '0.0000');
  assert.deepEqual(d.claims, []);
  assert.deepEqual(d.block_zero.payouts, []);
  assert.equal(d.block_zero.owed_eth, '0.0000');
  assert.equal(d.block_zero.paid_eth, '0.0000');
  // The split is still stated: it is a declaration, not a measurement.
  assert.equal(d.split.block_zero_pct, 10);
  assert.equal(d.split.ecosystem_pct, 10);
  assert.equal(d.split.build_pct, 80);
});

test('a balance that could not be read does not empty the page of what is known', () => {
  reset();
  payout(1, 1, ETH(0.5), { hash: HASH(1), at: 1_700_000_000 });
  const d = R.buildRevenue({ balanceWei: null, headBlock: null, now: NOW });
  assert.equal(d.as_of.empty, false, 'a payout that went out is revenue that came in');
  assert.equal(d.block_zero.payouts.length, 1);
  assert.equal(d.as_of.block, null, 'the block is the field that says it is not known');
});

// ------------------------------------------------------------ one claim

test('one claim: gross is the balance, and the split is computed from it', () => {
  reset();
  const d = R.buildRevenue({ balanceWei: ETH(10), headBlock: 64_000_000, now: NOW });
  assert.equal(d.as_of.empty, false);
  assert.equal(d.claimed_eth, '10.0000');
  assert.equal(d.split.block_zero_eth, '1.0000');
  assert.equal(d.split.ecosystem_eth, '1.0000');
  assert.equal(d.split.build_eth, '8.0000');
  assert.equal(d.block_zero.paid_eth, '0.0000');
  assert.equal(d.block_zero.owed_eth, '1.0000');
  assert.equal(d.as_of.block, 64_000_000);
});

test('the split is exact in wei, and the printed shares can round short of the total', () => {
  reset();
  const gross = ETH(7.7777);
  const d = R.buildRevenue({ balanceWei: gross, headBlock: 1, now: NOW });
  // Exact where it counts: the three shares are the whole, to the wei.
  const wei = (pct) => (gross * BigInt(pct)) / 100n;
  assert.equal(wei(10) + wei(10) + wei(80), gross);

  // And the printed figures are each truncated to four places, so they can sum
  // to less than the printed total. Stated here rather than hidden: a reader
  // adding the column up should find the difference documented rather than
  // wonder what happened to it.
  const printed = ['block_zero_eth', 'ecosystem_eth', 'build_eth']
    .reduce((a, k) => a + Math.round(Number(d.split[k]) * 1e4), 0);
  const total = Math.round(Number(d.claimed_eth) * 1e4);
  assert.ok(total - printed >= 0 && total - printed <= 3,
    `the printed shares are ${total - printed} units short, which is more than truncation`);
});

// ------------------------------------------------- claims plus payouts

test('claims plus payouts: every payout with a hash is listed, oldest first', () => {
  reset();
  payout(1, 1, ETH(0.4), { hash: HASH(2), at: 1_700_000_200 });
  payout(1, 2, ETH(0.3), { hash: HASH(1), at: 1_700_000_100 });
  // A row with no hash has not left the wallet and is not a payout yet.
  payout(1, 3, ETH(0.3));

  const d = R.buildRevenue({ balanceWei: ETH(9.3), headBlock: 64_000_000, now: NOW });
  assert.equal(d.block_zero.payouts.length, 2, 'an unsent row was listed as paid');
  assert.deepEqual(d.block_zero.payouts.map((p) => p.txHash), [HASH(1), HASH(2)]);
  assert.deepEqual(d.block_zero.payouts.map((p) => p.eth), ['0.3000', '0.4000']);

  // Gross is the balance plus everything that has left: 9.3 + 0.7 = 10.
  assert.equal(d.claimed_eth, '10.0000');
  assert.equal(d.block_zero.paid_eth, '0.7000');
  assert.equal(d.block_zero.owed_eth, '0.3000');
});

test('a sweep counts toward gross, because it left the wallet too', () => {
  reset();
  sweep(HASH(9), ETH(4), 1_700_000_000);
  const d = R.buildRevenue({ balanceWei: ETH(6), headBlock: 1, now: NOW });
  assert.equal(d.claimed_eth, '10.0000');
  assert.equal(d.block_zero.owed_eth, '1.0000');
  // A sweep is money moving out, not a payout to the room.
  assert.deepEqual(d.block_zero.payouts, []);
});

// ------------------------------------------------ owed equals /ledger

test('owed is computeRun to the wei, at every state of the ledger', () => {
  const states = [
    { name: 'nothing', balance: 0n, setup: () => {} },
    { name: 'income, nothing paid', balance: ETH(10), setup: () => {} },
    {
      name: 'income and a payout',
      balance: ETH(9.3),
      setup: () => {
        payout(1, 1, ETH(0.7), { hash: HASH(1), at: 1_700_000_000 });
      },
    },
    {
      name: 'a payout with gas, which left the wallet with it',
      balance: ETH(9.29),
      setup: () => {
        payout(1, 1, ETH(0.7), { hash: HASH(1), at: 1_700_000_000, gas: ETH(0.01) });
      },
    },
    {
      name: 'a sweep as well',
      balance: ETH(5), setup: () => {
        payout(1, 1, ETH(0.7), { hash: HASH(1), at: 1_700_000_000 });
        sweep(HASH(9), ETH(4.3), 1_700_000_100);
      },
    },
    {
      name: 'more paid than the share, which is not a debt owed back',
      balance: ETH(1),
      setup: () => {
        payout(1, 1, ETH(9), { hash: HASH(1), at: 1_700_000_000 });
      },
    },
  ];

  for (const s of states) {
    reset();
    s.setup();
    const run = L.computeRun({ balanceWei: s.balance, now: NOW });
    const d = R.buildRevenue({ balanceWei: s.balance, headBlock: 1, now: NOW });
    // The string the page prints, against the string /ledger prints, off the
    // same wei. Not a recomputation: the same function, called twice.
    assert.equal(d.block_zero.owed_eth, L.eth(run.poolWei), `${s.name}: owed`);
    assert.equal(d.claimed_eth, L.eth(run.grossIncomeWei), `${s.name}: gross`);
    assert.equal(d.block_zero.paid_eth, L.eth(run.paidToDateWei), `${s.name}: paid`);
    assert.equal(d.split.block_zero_eth, L.eth(run.poolTargetWei), `${s.name}: the room's total share`);
  }
});

test('owed never goes negative when more has been paid than the share', () => {
  reset();
  payout(1, 1, ETH(9), { hash: HASH(1), at: 1_700_000_000 });
  const d = R.buildRevenue({ balanceWei: ETH(1), headBlock: 1, now: NOW });
  assert.equal(d.block_zero.owed_eth, '0.0000');
  assert.ok(!d.block_zero.owed_eth.startsWith('-'));
});

// -------------------------------------------------------- what it never says

test('no price, no USD, no projection, and no seat named anywhere', () => {
  reset();
  payout(1, 1, ETH(0.7), { hash: HASH(1), at: 1_700_000_000 });
  const json = JSON.stringify(R.buildRevenue({ balanceWei: ETH(9.3), headBlock: 1, now: NOW }));
  assert.doesNotMatch(json, /usd|\$[0-9]|price|market ?cap|projection|estimate|apy|yield/i);
  // The seat's wallet is in ledger_payments and must not reach a public page.
  assert.ok(!json.includes(W(1)), 'a payout wallet reached the public page');
  assert.doesNotMatch(json, /member_1|handle/);
  assert.ok(!json.includes(String.fromCharCode(0x2014)), 'em dash');
});

test('unclaimed is undetermined rather than zero, and says why', () => {
  reset();
  const d = R.buildRevenue({ balanceWei: ETH(10), headBlock: 1, now: NOW });
  assert.equal(d.unclaimed_eth, null);
  assert.match(d.unclaimed_note, /feeEscrow/);
  assert.match(d.unclaimed_note, /undetermined rather than zero/);
});

test('claims are empty with a reason, which is not the same as none', () => {
  reset();
  const d = R.buildRevenue({ balanceWei: ETH(10), headBlock: 1, now: NOW });
  assert.deepEqual(d.claims, []);
  assert.match(d.claims_note, /emit no log/);
  assert.match(d.claims_note, /the total is exact/);
});

// ------------------------------------------------------------- the page

const PAGE = readFileSync('site/revenue.html', 'utf8');

test('the page is self contained, black, and points at the pinned explorer', () => {
  assert.match(PAGE, /--bg: #000/);
  assert.match(PAGE, /background: var\(--bg\)/);
  assert.match(PAGE, /--mono: ui-monospace/);
  // The one host it links out to is the one config.ts pins. A lookalike
  // explorer is the same class of problem as a lookalike RPC.
  assert.ok(PAGE.includes(`${EXPLORER_URL}/tx/`), `the page does not use ${EXPLORER_URL}`);
  const hosts = [...PAGE.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  for (const h of new Set(hosts)) {
    assert.ok(
      ['checkvitals.xyz', 'api.checkvitals.xyz', 'docs.checkvitals.xyz', new URL(EXPLORER_URL).host].includes(h),
      `the page reaches an unexpected host: ${h}`,
    );
  }
  // No external script, style or font: it is one file.
  assert.doesNotMatch(PAGE, /<script[^>]+src=/i);
  assert.doesNotMatch(PAGE, /<link[^>]+stylesheet/i);
});

test('the page carries the empty-state sentence, word for word', () => {
  assert.ok(PAGE.includes('no revenue yet. first payout roughly 4h after launch.'));
});

/** What a reader actually sees: markup, scripts and styles removed. */
const PROSE = PAGE
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ');

test('the page says nothing a card may not say', () => {
  assert.doesNotMatch(PAGE, /\bclean\b|\bsafe\b|looks good|\bscore\b|\bgrade\b|price target/i);
  assert.doesNotMatch(PAGE, /\busd\b|\$[0-9]/i);
  assert.ok(!PAGE.includes(String.fromCharCode(0x2014)), 'em dash');
  // In the prose rather than the markup: <!DOCTYPE> and !== are syntax.
  assert.doesNotMatch(PROSE, /!/, 'an exclamation mark reached the page');
});

test('every sentence the script can render is checked, by name', () => {
  // Listed rather than scraped: a regex over a script picks up code as well as
  // prose, and a test that cannot tell the two apart passes for the wrong
  // reason. Each of these has to be in the page AND has to be sayable.
  const spoken = [
    'no revenue yet. first payout roughly 4h after launch.',
    'no payout has gone out yet.',
    'unclaimed: undetermined. ',
    'the figures could not be read just now. ',
    'claimed to date',
    'the declared split, computed from that',
    'paid to date',
    'owed now',
    'last updated ',
    'every figure in ETH, read from chain and from the ledger. no price, no projection.',
  ];
  for (const line of spoken) {
    assert.ok(PAGE.includes(line), `the page no longer says: ${line}`);
    assert.ok(!line.includes(String.fromCharCode(0x2014)), `em dash in: ${line}`);
    assert.doesNotMatch(line, /!/, `exclamation in: ${line}`);
    assert.doesNotMatch(line, /\bclean\b|\bsafe\b|\busd\b|\bguarantee/i, `a forbidden word in: ${line}`);
  }
});

test('the page reads the endpoint this build serves', () => {
  assert.ok(PAGE.includes('https://api.checkvitals.xyz/v1/revenue'));
});
