import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The hold-time figure is the one most likely to be quoted out of context, so
 * both its floor and its unit of observation are pinned down here. Runs in child
 * processes because DB_PATH is read once when db.js is imported.
 */
const CWD = process.cwd();

function inTempDb(seedAndAssert) {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-hold-'));
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { db } = await import('${CWD}/dist/db.js');
      const { exemptedHoldTime, holdTimeLine } = await import('${CWD}/dist/bot.js');
      const A = (n) => '0x' + String(n).padStart(40, '0');
      let tx = 0;
      const launch = (token, exempt) => db.prepare(
        \`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
            graduation_threshold, block_number, tx_hash, launched_at,
            snipe_exemption_count, snipe_exemptions)
          VALUES (?,?,?,?,0,'0',1,?,0,?,?)\`
      ).run(token, A(99), A(98), A(0), '0xtx' + token, exempt.length, JSON.stringify(exempt));
      const trade = (token, side, wallet, t) => db.prepare(
        \`INSERT INTO trades (tx_hash, log_index, token, curve, side, trader, recipient,
            quote_amount, token_amount, fee, creator_tax, block_number, block_time)
          VALUES (?,?,?,?,?,?,?,'0','0','0','0',?,?)\`
      ).run('0xt' + (++tx), 0, token, A(99), side, wallet, wallet, tx, t);
      ${seedAndAssert}
    `], { cwd: CWD, env: { ...process.env, DB_PATH: join(dir, 'h.db') }, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the median is withheld below 30 observations', () => {
  const out = inTempDb(`
    // 29 pairs: one exempted wallet each, bought then sold 10s later
    for (let i = 0; i < 29; i++) {
      const tok = A(1000 + i), w = A(2000 + i);
      launch(tok, [w]);
      trade(tok, 'buy', w, 100); trade(tok, 'sell', w, 110);
    }
    const a = exemptedHoldTime();
    console.log(JSON.stringify({ pairs: a.pairs, line: holdTimeLine(a) }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.pairs, 29);
  assert.equal(r.line, 'median hold time of exempted wallets not enough data yet (n=29)');
});

test('the median publishes at exactly 30 observations', () => {
  const out = inTempDb(`
    for (let i = 0; i < 30; i++) {
      const tok = A(1000 + i), w = A(2000 + i);
      launch(tok, [w]);
      trade(tok, 'buy', w, 100); trade(tok, 'sell', w, 110);
    }
    const a = exemptedHoldTime();
    console.log(JSON.stringify({ pairs: a.pairs, median: a.medianSeconds, line: holdTimeLine(a) }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.pairs, 30);
  assert.equal(r.median, 10);
  assert.equal(r.line, 'median hold time of exempted wallets 10s (n=30)');
});

test('an empty index reports not enough data, never a median', () => {
  const out = inTempDb(`
    const a = exemptedHoldTime();
    console.log(JSON.stringify({ pairs: a.pairs, median: a.medianSeconds, line: holdTimeLine(a) }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.pairs, 0);
  assert.equal(r.median, null);
  assert.equal(r.line, 'median hold time of exempted wallets not enough data yet (n=0)');
});

// ------------------------------------------------------ the unit of observation
test('the unit is the wallet-token pair, not the sell transaction', () => {
  const out = inTempDb(`
    // one wallet, one token, three sells -- still one pair
    const tok = A(1), w = A(2);
    launch(tok, [w]);
    trade(tok, 'buy', w, 100);
    trade(tok, 'sell', w, 110);
    trade(tok, 'sell', w, 200);
    trade(tok, 'sell', w, 300);
    const a = exemptedHoldTime();
    console.log(JSON.stringify({ pairs: a.pairs, median: a.medianSeconds }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.pairs, 1, 'three sells by one wallet are one observation, not three');
  assert.equal(r.median, 10, 'measured to the FIRST sell');
});

test('the same wallet across two tokens is two pairs', () => {
  const out = inTempDb(`
    const w = A(2);
    for (const [tok, sold] of [[A(1), 110], [A(3), 130]]) {
      launch(tok, [w]);
      trade(tok, 'buy', w, 100); trade(tok, 'sell', w, sold);
    }
    const a = exemptedHoldTime();
    console.log(JSON.stringify({ pairs: a.pairs, median: a.medianSeconds }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.pairs, 2);
  assert.equal(r.median, 20, 'median of 10 and 30');
});

test('a wallet that never sold is excluded, not counted as infinite', () => {
  const out = inTempDb(`
    const tok = A(1), seller = A(2), holder = A(3);
    launch(tok, [seller, holder]);
    trade(tok, 'buy', seller, 100); trade(tok, 'sell', seller, 150);
    trade(tok, 'buy', holder, 100);            // still holding
    const a = exemptedHoldTime();
    console.log(JSON.stringify({ pairs: a.pairs, median: a.medianSeconds }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.pairs, 1, 'only the wallet that actually sold');
  assert.equal(r.median, 50);
});

test('a sell with no recorded buy cannot be measured and is excluded', () => {
  const out = inTempDb(`
    const tok = A(1), w = A(2);
    launch(tok, [w]);
    trade(tok, 'sell', w, 150);   // bought before the indexed window
    const a = exemptedHoldTime();
    console.log(JSON.stringify({ pairs: a.pairs }));
  `);
  assert.equal(JSON.parse(out.trim().split('\n').pop()).pairs, 0);
});

test('only exempted wallets count, not every trader', () => {
  const out = inTempDb(`
    const tok = A(1), exempt = A(2), stranger = A(9);
    launch(tok, [exempt]);
    trade(tok, 'buy', exempt, 100); trade(tok, 'sell', exempt, 110);
    trade(tok, 'buy', stranger, 100); trade(tok, 'sell', stranger, 900);
    const a = exemptedHoldTime();
    console.log(JSON.stringify({ pairs: a.pairs, median: a.medianSeconds }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.pairs, 1);
  assert.equal(r.median, 10, "the stranger's 800s hold must not move it");
});

test('there is no 500-token cap on the population', () => {
  const out = inTempDb(`
    // 600 tokens, one pair each -- an earlier LIMIT 500 would have truncated this
    for (let i = 0; i < 600; i++) {
      const tok = A(10000 + i), w = A(50000 + i);
      launch(tok, [w]);
      trade(tok, 'buy', w, 100); trade(tok, 'sell', w, 100 + i + 1);
    }
    const a = exemptedHoldTime();
    console.log(JSON.stringify({ pairs: a.pairs }));
  `);
  assert.equal(JSON.parse(out.trim().split('\n').pop()).pairs, 600);
});
