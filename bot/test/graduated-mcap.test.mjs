/**
 * The market cap of a graduated launch, and the plural of a count.
 *
 * Both were seen on a live group card. BUN, graduated, rendered "0 ETH mc"
 * while two other tools priced it in the tens of millions in the same minute,
 * and the buyer line read "1 buyers in first 30 min".
 *
 * The zero is the one that matters. After graduation the curve holds none of
 * the supply, so its marginal price is zero and the fully diluted market cap
 * computed from it is zero too. That is not a small figure, it is a false one,
 * in the headline, about the thing the reader came for.
 *
 * Nothing here touches a network: the pool read takes its storage word from an
 * injected reader, and the numbers below were read off mainnet and pinned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('graduated-mcap');

const P = await import('../dist/pool.js');
const { mcapLabel, headerMcap } = await import('../dist/card.js');
const { renderGroupCard } = await import('../dist/groupcard.js');
const { marketOf } = await import('../dist/image.js');
const { count, plural } = await import('../dist/text.js');
const { MEME_HOOK, POOL_MANAGER } = await import('../dist/config.js');
const { makeScan } = await import('./fixtures.mjs');

/**
 * BUN, read from mainnet on 2026-09-25. Graduated, curve token reserve zero,
 * and the pool holding a real price the whole time the card said zero.
 */
const BUN = '0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2';
const NATIVE = '0x0000000000000000000000000000000000000000';
const BUN_SQRT = 24854267685473350528978612244114n;
const BUN_POOL_ID = '0x06e308b77bdafd691d179645296ce8c40e33c6af4a879a913efc7eedc402581c';
const BUN_STATE_SLOT = '0x3cf1df2c65335f919473e18fb19cf1bb70885bec5a5b5d896726664cb987bd14';
const BUN_KEY = { token: BUN, pairToken: NATIVE, poolFee: 0, tickSpacing: 200 };

// ------------------------------------------------------------- the pool key

test('the currencies are sorted, and native ETH always sorts first', () => {
  const k = P.poolKeyOf(BUN_KEY);
  assert.equal(k.currency0, NATIVE);
  assert.equal(k.currency1, BUN.toLowerCase());
  assert.equal(k.hooks, MEME_HOOK);
  assert.equal(k.fee, 0);
  assert.equal(k.tickSpacing, 200);
});

test('a token that sorts below its pair takes currency0', () => {
  // Getting the order wrong derives a different poolId, which reads as an
  // uninitialised pool rather than as an error. The failure is silent, so the
  // ordering is tested rather than assumed.
  const low = '0x0000000000000000000000000000000000000abc';
  const high = '0xffffffffffffffffffffffffffffffffffffffff';
  assert.deepEqual(
    [P.poolKeyOf({ token: low, pairToken: high, poolFee: 0, tickSpacing: 200 }).currency0,
     P.poolKeyOf({ token: high, pairToken: low, poolFee: 0, tickSpacing: 200 }).currency0],
    [low, low],
    'the same pair derived two different orderings',
  );
});

test('the derivation reproduces the pool that actually held the price', () => {
  // The anchor. If this changes, every graduated launch is being priced out of
  // some other pool, and the number would look perfectly reasonable.
  const id = P.poolIdOf(P.poolKeyOf(BUN_KEY));
  assert.equal(id, BUN_POOL_ID);
  assert.equal(P.stateSlotOf(id), BUN_STATE_SLOT);
  assert.equal(P.POOLS_SLOT, 6n);
});

test('the fee and the tick spacing come from the launch, so they change the pool', () => {
  const base = P.poolIdOf(P.poolKeyOf(BUN_KEY));
  assert.notEqual(P.poolIdOf(P.poolKeyOf({ ...BUN_KEY, poolFee: 3000 })), base);
  assert.notEqual(P.poolIdOf(P.poolKeyOf({ ...BUN_KEY, tickSpacing: 60 })), base);
});

// --------------------------------------------------------------- the price

test('the price off a real sqrtPriceX96 is the one the pool holds', () => {
  const price = P.priceFromSqrt({
    sqrtPriceX96: BUN_SQRT, quoteIsCurrency0: true, tokenDecimals: 18, quoteDecimals: 18,
  });
  // 1.0161486e-5 ETH per BUN, which over a 1e9 supply is about 10,161 ETH.
  assert.ok(Math.abs(price - 1.0161486032987e-5) < 1e-17, String(price));
  assert.ok(Math.abs(price * 1e9 - 10_161.486) < 0.01, String(price * 1e9));
});

test('the square is taken in bigint, because a double cannot hold it', () => {
  // sqrtPriceX96 is around 1e31 on a live pool and its square around 1e62.
  // Through a double the low digits are gone and the price drifts.
  const viaDouble = (Number(BUN_SQRT) ** 2) / 2 ** 192;
  const exact = P.priceFromSqrt({
    sqrtPriceX96: BUN_SQRT, quoteIsCurrency0: false, tokenDecimals: 18, quoteDecimals: 18,
  });
  assert.ok(Math.abs(exact - viaDouble) / exact < 1e-9, 'sanity: the two should be close');
  // And exact is the one that came from integer arithmetic.
  assert.equal(exact, 98410.80298232751);
});

test('which currency is the quote flips the price, not scales it', () => {
  const a = P.priceFromSqrt({ sqrtPriceX96: BUN_SQRT, quoteIsCurrency0: true, tokenDecimals: 18, quoteDecimals: 18 });
  const b = P.priceFromSqrt({ sqrtPriceX96: BUN_SQRT, quoteIsCurrency0: false, tokenDecimals: 18, quoteDecimals: 18 });
  assert.ok(Math.abs(a * b - 1) < 1e-9, `${a} and ${b} are not reciprocal`);
});

test('decimals that differ between the token and the quote are carried', () => {
  // A 6 decimal quote against an 18 decimal token is 1e12 apart, and getting
  // it wrong is a market cap wrong by a trillion.
  const same = P.priceFromSqrt({ sqrtPriceX96: BUN_SQRT, quoteIsCurrency0: true, tokenDecimals: 18, quoteDecimals: 18 });
  const six = P.priceFromSqrt({ sqrtPriceX96: BUN_SQRT, quoteIsCurrency0: true, tokenDecimals: 18, quoteDecimals: 6 });
  assert.ok(Math.abs(six / same - 1e12) / 1e12 < 1e-9, `${six} against ${same}`);
});

test('a zero or absent price is null, never a number', () => {
  for (const sqrtPriceX96 of [0n, -1n]) {
    assert.equal(P.priceFromSqrt({ sqrtPriceX96, quoteIsCurrency0: true, tokenDecimals: 18, quoteDecimals: 18 }), null);
  }
});

// ------------------------------------------------------- reading the pool

test('a live storage word gives the price, from the low 160 bits', async () => {
  // slot0 packs sqrtPriceX96 into the low 160 bits with the tick and the fees
  // above it. Reading the whole word as the price would be nonsense.
  const tickAndFees = (123n << 160n) | (500n << 184n);
  const asked = [];
  const got = await P.readPoolPrice({ ...BUN_KEY, tokenDecimals: 18, quoteDecimals: 18 }, {
    extsload: async (slot) => { asked.push(slot); return BUN_SQRT | tickAndFees; },
  });
  assert.deepEqual(asked, [BUN_STATE_SLOT], 'a slot other than the pool state was read');
  assert.equal(got.poolId, BUN_POOL_ID);
  assert.equal(got.sqrtPriceX96, BUN_SQRT);
  assert.ok(Math.abs(got.priceInQuote - 1.0161486032987e-5) < 1e-17);
});

test('an uninitialised pool and an unreadable one are both null, never zero', async () => {
  const zero = await P.readPoolPrice({ ...BUN_KEY, tokenDecimals: 18, quoteDecimals: 18 },
    { extsload: async () => 0n });
  assert.equal(zero, null, 'an empty storage word became a price');

  const threw = await P.readPoolPrice({ ...BUN_KEY, tokenDecimals: 18, quoteDecimals: 18 },
    { extsload: async () => { throw new Error('rpc down'); } });
  assert.equal(threw, null, 'a failed read became a price');
});

test('a failed pool read does not throw, because the rest of the scan is good', async () => {
  // One unreadable slot must not fail a scan whose findings all read fine. The
  // market cap is undetermined; nothing else about the launch is.
  await assert.doesNotReject(() => P.readPoolPrice(
    { ...BUN_KEY, tokenDecimals: 18, quoteDecimals: 18 },
    { extsload: async () => { throw new Error('boom'); } },
  ));
});

test('the pool manager it reads is the one the hook and the factory name', () => {
  assert.equal(POOL_MANAGER, '0x8366a39CC670B4001A1121B8F6A443A643e40951');
});

// -------------------------------------------------------- what a card says

const graduated = (over = {}) => makeScan({
  symbol: 'BUN', name: 'Bun', ageSeconds: 158_400,
  phaseName: 'PoolCreated', ...over,
});

test('a graduated launch priced from the pool prints the figure', () => {
  const r = graduated({ mcapInQuote: 10_161.486, reads: { mcapSource: 'pool' } });
  assert.equal(mcapLabel(r), '10.2K ETH mc');
  assert.equal(headerMcap(r), '10.2K ETH mc');
});

test('a graduated launch whose pool could not be read says so, and never zero', () => {
  // The rule, in the words it was asked for.
  const r = graduated({ mcapInQuote: 0, reads: { mcapSource: null } });
  assert.equal(mcapLabel(r), 'mc undetermined after graduation');
  assert.doesNotMatch(mcapLabel(r), /\b0\b/);
});

test('a launch on the curve with no price is omitted, exactly as before', () => {
  // Unchanged behaviour, asserted so the fix above did not widen into it.
  for (const v of [0, -1, NaN, Infinity]) {
    assert.equal(mcapLabel(makeScan({ mcapInQuote: v })), null, `mcap ${v}`);
  }
  assert.equal(mcapLabel(makeScan({ mcapInQuote: 1234 })), '1.2K ETH mc');
});

test('the group card never prints a zero market cap, on any of the three states', () => {
  const identity = (r) => renderGroupCard(r, { botUsername: 'vitalscheck_bot' }).text.split('\n')[0];

  // The defect, at the line it was on.
  const unread = identity(graduated({ mcapInQuote: 0, reads: { mcapSource: null } }));
  assert.match(unread, /mc undetermined after graduation/);
  assert.doesNotMatch(unread, /0 ETH mc/);

  // Priced from the pool.
  assert.match(identity(graduated({ mcapInQuote: 10_161.486, reads: { mcapSource: 'pool' } })), /10\.2K ETH mc/);

  // On the curve with nothing to say: the segment is absent, not zero.
  const early = identity(makeScan({ symbol: 'GHATS', name: 'Ghats', mcapInQuote: 0 }));
  assert.doesNotMatch(early, /0 ETH mc/);
  assert.doesNotMatch(early, /mc/, early);
});

test('the group card still names the token when there is no market cap', () => {
  const line = renderGroupCard(graduated({ mcapInQuote: 0, reads: { mcapSource: null } }), {}).text.split('\n')[0];
  assert.match(line, /<b>BUN<\/b>/);
  assert.match(line, /Bun/);
});

test('a quote symbol out of launch calldata is escaped in the market cap line', () => {
  const r = graduated({
    mcapInQuote: 1234, pairSymbol: '<b>x</b>', reads: { mcapSource: 'pool' },
  });
  const line = renderGroupCard(r, {}).text.split('\n')[0];
  assert.ok(!line.includes('<b>x</b>'), line);
  assert.match(line, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('the picture says undetermined rather than leaving the cell out', () => {
  const cells = marketOf(graduated({ mcapInQuote: 0, reads: { mcapSource: null } }));
  const mc = cells.find((c) => c.label === 'mcap');
  assert.ok(mc, 'a graduated launch with no market cap had no mcap cell at all');
  assert.equal(mc.value, 'undetermined');

  const priced = marketOf(graduated({ mcapInQuote: 10_161.486, reads: { mcapSource: 'pool' } }));
  assert.match(priced.find((c) => c.label === 'mcap').value, /10\.2K ETH/);
});

// --------------------------------------------------------- one is singular

test('one of anything is singular, and everything else is not', () => {
  assert.equal(plural(1, 'buyer'), 'buyer');
  assert.equal(plural(0, 'buyer'), 'buyers');
  assert.equal(plural(2, 'buyer'), 'buyers');
  // Irregulars are passed in, because appending an s to "launch" gives "launchs".
  assert.equal(plural(1, 'launch', 'launches'), 'launch');
  assert.equal(plural(3, 'launch', 'launches'), 'launches');
});

test('a count carries its number, grouped, in one locale', () => {
  assert.equal(count(1, 'holder'), '1 holder');
  assert.equal(count(2, 'holder'), '2 holders');
  assert.equal(count(0, 'holder'), '0 holders');
  // Explicit locale: a bare toLocaleString takes the host's, and the same card
  // would render 1,837 on one machine and 1 837 on another.
  assert.equal(count(1837, 'launch', 'launches'), '1,837 launches');
});

test('the line that was wrong on a live card is right at one', () => {
  const one = renderGroupCard(makeScan({ buyers: 1, ageSeconds: 1800 }), {}).text;
  assert.match(one, /\b1 buyer in first\b/);
  assert.doesNotMatch(one, /1 buyers/);

  const two = renderGroupCard(makeScan({ buyers: 2, ageSeconds: 1800 }), {}).text;
  assert.match(two, /\b2 buyers in first\b/);
});

test('no count on a group card reads as one of a plural noun', () => {
  // Every count the group card can print, at one.
  const r = makeScan({
    buyers: 1, buyTx: 1, sellTx: 1, ageSeconds: 1800,
    flags: [{ key: 'k', label: 'k', state: 'unknown', detail: 'd', compactDetail: 'c', plain: 'p', severity: 0 }],
  });
  const text = renderGroupCard(r, { market: { athQuote: null, athMinutes: null, liquidityQuote: 5, vol5m: 1, vol1h: 2, trades: 1, complete: true, mcapQuote: 1 } }).text;
  for (const noun of ['buyer', 'holder', 'trade', 'check', 'wallet', 'launch']) {
    assert.doesNotMatch(text, new RegExp(`\\b1 ${noun}s\\b`), `"1 ${noun}s" is on the card`);
  }
});
