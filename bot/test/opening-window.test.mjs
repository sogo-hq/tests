/**
 * The opening window, measured from the curve's own logs.
 *
 * The numbers in this file are the real ones from chain 4663, token
 * 0x21743b27… / curve 0x88a06c9c…, launch block 60081281: a 5-wallet exempted
 * bundle taking 22.2679% of supply, the deployer's own 5.0364% of it, and
 * 182661175569153658 wei of opening tax across 16 payers.
 *
 * That launch is why the exemption line reports what it reads rather than what
 * was expected. A launch that pre-exempts one wallet and a launch that
 * pre-exempts five look identical until this line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = process.env.DB_PATH || `/tmp/vitals-opening-${process.pid}.db`;
const { client } = await import('../dist/chain.js');

const CURVE = '0x88a06c9c7a610ebe15ade18a8287131613bc448a';
const DEPLOYER = '0x73fdc2ff14f39ec21546a3647a157b746ac34bff';
const SUPPLY = 1000000000000000000000000000n; // 1e27, from the launch-tx mint

const EXEMPT = [
  DEPLOYER,
  '0x6a96de27d21bcac2cc71a76a9cc8714653c2a02f',
  '0x9a646c8d4b0afc43b6dd4ce236a0fd0c3f325af7',
  '0xe6850956450196c6345d25bcccfa23e18ca739b3',
  '0x28d84471539efba68fb4a12ddda7b8e6ddbb8f3a',
];
const BUYS = [
  [DEPLOYER, 50364592165507885365440054n],
  ['0x6a96de27d21bcac2cc71a76a9cc8714653c2a02f', 44349623580809957660559155n],
  ['0x9a646c8d4b0afc43b6dd4ce236a0fd0c3f325af7', 45511975389690543453382109n],
  ['0xe6850956450196c6345d25bcccfa23e18ca739b3', 37035605071327164975738444n],
  ['0x28d84471539efba68fb4a12ddda7b8e6ddbb8f3a', 45418062451987919897280835n],
];
const TAX_TOTAL = 182661175569153658n;

let logMode = 'full';
client.getLogs = async ({ event }) => {
  if (logMode === 'throw') throw new Error('log query timed out');
  const name = event?.name;
  if (name === 'SnipeTaxExempted') {
    // Six logs over five distinct wallets, as the real launch emitted.
    return [...EXEMPT, EXEMPT[0]].map((wallet) => ({ args: { wallet } }));
  }
  if (name === 'SnipeTaxCharged') {
    const per = TAX_TOTAL / 16n;
    return Array.from({ length: 16 }, (_, i) => ({
      args: { payer: '0x' + String(i).padStart(40, 'a'), amount: i === 15 ? TAX_TOTAL - per * 15n : per },
    }));
  }
  if (name === 'CurveBuy') {
    return BUYS.map(([recipient, tokensOut]) => ({ args: { recipient, tokensOut, quoteIn: 0n, fee: 0n } }));
  }
  return [];
};

const O = await import('../dist/metrics/opening.js');
const read = () => O.readOpeningWindow({ curve: CURVE, deployer: DEPLOYER, totalSupply: SUPPLY, fromBlock: 60081281n });

test('the exemption list is de-duplicated to distinct wallets', async () => {
  logMode = 'full';
  const w = await read();
  assert.equal(w.exemptWallets.length, 5, 'six logs, five wallets');
  assert.deepEqual(w.exemptWallets, EXEMPT);
});

test('the creator opening buy is matched on recipient, not buyer', async () => {
  const w = await read();
  assert.equal(w.creatorTokens, 50364592165507885365440054n);
  assert.ok(Math.abs(w.creatorSharePct - 5.0364) < 0.001, `got ${w.creatorSharePct}`);
});

test('the exempted bundle together is reported, not just the deployer', async () => {
  const w = await read();
  assert.ok(Math.abs(w.exemptSharePct - 22.2679) < 0.001, `got ${w.exemptSharePct}`);
  assert.ok(w.exemptSharePct > w.creatorSharePct * 4,
    'the deployer alone understated the insider take by 4x on the measured launch');
});

test('the opening tax is the sum over the curve, with its payer count', async () => {
  const w = await read();
  assert.equal(w.taxWei, TAX_TOTAL);
  assert.equal(w.taxPayers, 16);
});

test('the lines name the pair asset and report the count as measured', async () => {
  const w = await read();
  const lines = O.openingLines(w, { pairSymbol: 'ETH', pairDecimals: 18 });
  assert.match(lines[0], /^wallets exempt from the opening tax: 5, together 22\.27% of supply$/);
  assert.match(lines[1], /^creator opening buy: 5\.04% of supply$/);
  assert.match(lines[2], /^snipers paid 0\.183 ETH in tax, across 16 wallets$/);
});

test('a single exemption says WHICH wallet, checked against the deployer', () => {
  const one = (wallet, deployer) => O.openingLines(
    { exemptWallets: [wallet], creatorTokens: 0n, creatorSharePct: 1, exemptTokens: 0n, exemptSharePct: 1.5,
      taxWei: 0n, taxPayers: 0, complete: true },
    { pairSymbol: 'ETH', pairDecimals: 18, deployer },
  );
  // "the dev wallet" was a claim about who held the exemption that nothing had
  // measured, on a function holding both the list and the deployer.
  assert.equal(one(DEPLOYER, DEPLOYER)[0], 'wallets exempt from the opening tax: 1, the deployer, 1.50% of supply');
  assert.equal(one('0x9999999999999999999999999999999999999999', DEPLOYER)[0],
    'wallets exempt from the opening tax: 1, not the deployer, 1.50% of supply');
  assert.equal(one(DEPLOYER, DEPLOYER)[2], 'snipers paid nothing: no taxed buys in the opening window');
});

test('a non-ETH pair is named rather than implied', async () => {
  const w = await read();
  const lines = O.openingLines(w, { pairSymbol: 'RDDT', pairDecimals: 18 });
  assert.match(lines[2], /0\.183 RDDT in tax/);
  assert.ok(!/ETH/.test(lines.join('\n')), 'a launch priced in RDDT must not report ETH');
});

test('a window that could not be read is undetermined, never zero', async () => {
  logMode = 'throw';
  const w = await read();
  assert.equal(w, null, 'a partial window is not a measurement');
  const lines = O.openingLines(null, { pairSymbol: 'ETH', pairDecimals: 18 });
  assert.match(lines[0], /could not be read, undetermined/);
  assert.ok(!/\b0\b/.test(lines[0]), 'a failed read must not render as "0 wallets exempt"');
  logMode = 'full';
});

test('the tax policy is read live and cached, never hardcoded', async () => {
  O.resetPolicyCache();
  let calls = 0;
  client.readContract = async ({ functionName }) => {
    calls++;
    if (functionName === 'snipeTaxStartBps') return 9900n;
    if (functionName === 'snipeTaxSeconds') return 3n;
    throw new Error(`unexpected ${functionName}`);
  };
  const p = await O.snipeTaxPolicy();
  assert.deepEqual(p, { startBps: 9900, seconds: 3 }, 'measured on chain 4663');
  assert.equal(calls, 2);
  await O.snipeTaxPolicy();
  assert.equal(calls, 2, 'cached: the same answer for every launch');
});

test('a tax policy that could not be read is undetermined', async () => {
  O.resetPolicyCache();
  client.readContract = async () => { throw new Error('rpc down'); };
  assert.equal(await O.snipeTaxPolicy(), null);
});

test('the log query is bounded to the opening window, not left at latest', async () => {
  logMode = 'full';
  let seen = null;
  const real = client.getLogs;
  client.getLogs = async (args) => { seen = args; return real(args); };
  await O.readOpeningWindow({ curve: CURVE, deployer: DEPLOYER, totalSupply: SUPPLY, fromBlock: 60081281n });
  client.getLogs = real;
  assert.equal(typeof seen.toBlock, 'bigint', "'latest' grows by 600 blocks a minute on a 0.1s chain");
  assert.ok(O.OPENING_WINDOW_BLOCKS <= 20000n, 'and stays inside the node log-query limit forever');
});

test('the creator opening buy is read over the tax window, not a minute of trading', async () => {
  logMode = 'full';
  const seen = [];
  const real = client.getLogs;
  client.getLogs = async (args) => { seen.push(args); return real(args); };
  await O.readOpeningWindow({ curve: CURVE, deployer: DEPLOYER, totalSupply: SUPPLY, fromBlock: 60081281n });
  client.getLogs = real;
  const span = (name) => {
    const a = seen.find((x) => x.event?.name === name);
    return a.toBlock - a.fromBlock;
  };
  // CurveBuy is the one event that is not self-terminating: the curve emits one
  // on every buy for the rest of its life.
  assert.equal(span('CurveBuy'), O.OPENING_BUY_BLOCKS);
  assert.ok(O.OPENING_BUY_BLOCKS < O.OPENING_WINDOW_BLOCKS, 'a tighter window than the tax events need');
  assert.equal(span('SnipeTaxCharged'), O.OPENING_WINDOW_BLOCKS);
});

test('the launch-day read does not queue behind background work', async () => {
  logMode = 'full';
  const { bulkDepth } = await import('../dist/ratelimit.js').then((m) => ({ bulkDepth: m.bulk })).catch(() => ({}));
  // The post it backs is made five minutes after a launch, when every member is
  // scanning. At bulk priority the limiter refuses a token while any
  // interactive request is in flight, so it would render undetermined exactly
  // when it matters and never when it is tested.
  const w = await O.readOpeningWindow({ curve: CURVE, deployer: DEPLOYER, totalSupply: SUPPLY, fromBlock: 60081281n });
  assert.ok(w.complete, 'default priority is interactive');
});
