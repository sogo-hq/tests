/**
 * The address a tester reported as a broken scan.
 *
 * Reported as: "$BUN, Bundle Cat, graduated V2, ~$36M MC — pasted the token
 * address and got 'not a pons v2 launch'." Measured against chain 4663:
 *
 *   0x232f26fF2C2F4CB6F548eF1Be7e817bdb4C397cd
 *     name() / symbol() / totalSupply()   revert   -> not an ERC-20
 *     every curve getter                  reverts  -> not a curve
 *     factory.getLaunchedToken().exists   false    -> not a launch
 *     factory()                           0x7eD5…EC7e -> inside pons
 *     appears in a TokenLaunched log as   deployer
 *
 * So the bot was right, and the answer was useless. It is a DEPLOYER. The real
 * $BUN is 0x796dfA1504ED00CB122Ce194a28092bA6EADdB8E and scans fine; it is
 * priced in RDDT rather than ETH, which is why its market cap did not look
 * like the one quoted.
 *
 * What this locks: a deployer is never scanned as a launch, and is never
 * dismissed with a sentence that leaves the reader nowhere to go.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = process.env.DB_PATH || `/tmp/bun-addr-${process.pid}.db`;
const { db } = await import('../dist/db.js');
const { deployerSummary } = await import('../dist/deployerlookup.js');
const { renderDefaultNotFound, NOT_A_PONS_LAUNCH } = await import('../dist/card.js');

const REPORTED = '0x232f26fF2C2F4CB6F548eF1Be7e817bdb4C397cd';
const ITS_LAUNCH = '0x07ebb29a38fbcb41563817e5e19f2cec619c90d2';

const insert = db.prepare(
  `INSERT OR IGNORE INTO launches (token, curve, deployer, pair_token, launch_config_id,
     graduation_threshold, block_number, tx_hash, launched_at, symbol)
   VALUES (?,?,?,?,1,'4200000000000000000',?,?,?,?)`,
);
insert.run(ITS_LAUNCH, '0x' + 'c'.repeat(40), REPORTED.toLowerCase(), '0x' + 'e'.repeat(40),
  59_000_000, '0x' + '1'.repeat(64), 1_757_000_000, 'OLDER');
insert.run('0x' + 'ab'.repeat(20), '0x' + 'd'.repeat(40), REPORTED.toLowerCase(), '0x' + 'e'.repeat(40),
  59_000_100, '0x' + '2'.repeat(64), 1_757_000_100, 'NEWEST');

test('the reported address is recognised as a deployer, not dismissed', () => {
  const d = deployerSummary(REPORTED);
  assert.ok(d, 'the index knows this address as a deployer and the lookup missed it');
  assert.equal(d.launches, 2, 'it counts every launch, not just the one returned');
  assert.equal(d.latestSymbol, 'NEWEST', 'and points at the most recent, by block');
});

test('a deployer is never resolved INTO a launch', async () => {
  // The dangerous fix would have been to scan its latest launch, or to accept
  // the address as a token because it is "obviously pons". The factory says
  // exists=false and that is the end of it: token stays null.
  const { resolveLaunch } = await import('../dist/resolve.js');
  const r = await resolveLaunch(REPORTED);
  assert.equal(r.token, null, 'a deployer must never be scanned as though it were its own launch');
  assert.equal(r.via, 'deployer');
  assert.equal(r.deployerOf?.launches, 2);
});

test('the reply names what the address is and points somewhere', () => {
  const card = renderDefaultNotFound(REPORTED, 'b');
  assert.match(card, /that is a deployer, not a token/);
  assert.match(card, /2 launches in the index/);
  assert.match(card, /\$NEWEST/, 'it names the most recent launch');
  assert.ok(!card.includes(NOT_A_PONS_LAUNCH),
    'the bare dismissal is what made this useless; it must not survive alongside the answer');
});

test('an address the index has never seen still gets the honest dismissal', () => {
  // The fix must not turn every unknown address into a claim. Nothing is known
  // about this one, and saying so is correct.
  const card = renderDefaultNotFound('0x' + '9'.repeat(40), 'b');
  assert.ok(card.includes(NOT_A_PONS_LAUNCH));
  assert.doesNotMatch(card, /deployer/);
});

test('the deployer reply carries no verdict about the deployer', () => {
  // Naming an address is not the same as characterising it. "2 launches" is a
  // count; "serial deployer" would be a judgement, and this tool does not make
  // one on a card that could not even scan.
  const card = renderDefaultNotFound(REPORTED, 'b');
  for (const banned of [/serial/i, /suspicious/i, /spam/i, /scam/i, /prolific/i, /safe/i, /clean/i]) {
    assert.doesNotMatch(card, banned, `a verdict about the deployer reached the reply: ${card}`);
  }
});
