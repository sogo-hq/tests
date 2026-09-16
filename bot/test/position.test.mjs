import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePosition, positionText, ordinal, shortWallet, SELL_WINDOW_BLOCKS,
} from '../dist/position.js';

const LAUNCH_BLOCK = 1_000_000;
const LAUNCHED_AT = 1_700_000_000;
const SUPPLY = 10n ** 27n;
const W = (n) => `0x${String(n).padStart(2, '0').repeat(20)}`.slice(0, 42);
const DEPLOYER = W(1), EXEMPT_A = W(2), EXEMPT_B = W(3), ME = W(9), LATE = W(8);

// Twelve seconds of a launch: the deployer, two exempt wallets, then the public.
const buy = (who, secs, tokens, sender = who) => ({
  side: 'buy', trader: sender, recipient: who, tokenAmount: tokens,
  blockNumber: LAUNCH_BLOCK + secs * 10, blockTime: LAUNCHED_AT + secs,
});
const sell = (who, secs, tokens) => ({
  side: 'sell', trader: who, recipient: who, tokenAmount: tokens,
  blockNumber: LAUNCH_BLOCK + secs * 10, blockTime: LAUNCHED_AT + secs,
});

const TRADES = [
  buy(DEPLOYER, 0, 50n * 10n ** 24n, '0xe33e9e479df8802cb0866d5d05258bec4cf62948'),
  buy(EXEMPT_A, 1, 30n * 10n ** 24n),
  buy(EXEMPT_B, 2, 20n * 10n ** 24n),
  buy(W(4), 3, 10n * 10n ** 24n),
  buy(ME, 4, 5n * 10n ** 24n),
  buy(LATE, 9, 1n * 10n ** 24n),
  sell(EXEMPT_A, 60, 30n * 10n ** 24n),
  sell(W(4), 120, 10n * 10n ** 24n),
  sell(LATE, 4000, 1n * 10n ** 24n),
];

const base = (over = {}) => ({
  wallet: ME,
  token: '0xtoken',
  symbol: 'ZZZ',
  launchBlock: LAUNCH_BLOCK,
  launchedAt: LAUNCHED_AT,
  exemptWallets: [DEPLOYER, EXEMPT_A, EXEMPT_B],
  exemptionsKnown: true,
  trades: TRADES,
  indexedTo: LAUNCH_BLOCK + SELL_WINDOW_BLOCKS + 10,
  headBlock: LAUNCH_BLOCK + SELL_WINDOW_BLOCKS + 20,
  totalSupply: SUPPLY,
  ...over,
});

test('the rank counts first buys, not trades', () => {
  const r = computePosition(base());
  assert.equal(r.status, 'found');
  assert.equal(r.rank, 5);
  assert.equal(r.secondsAfterLaunch, 4);
});

test('a buyer is its recipient, so the forwarder is never the first buyer', () => {
  const r = computePosition(base({ wallet: DEPLOYER }));
  assert.equal(r.rank, 1);
  const fwd = computePosition(base({ wallet: '0xe33e9e479df8802cb0866d5d05258bec4cf62948' }));
  assert.equal(fwd.status, 'absent');
});

test('exempt wallets ahead of it are counted and their holding is a share of supply', () => {
  const r = computePosition(base());
  // deployer, A and B are all ahead of me: 50 + 30 + 20 of 1000 million.
  assert.equal(r.exemptBefore, 3);
  assert.equal(r.exemptSharePct, 10);
});

test('a sell by an exempt wallet before my buy reduces what it held at that point', () => {
  const trades = [...TRADES];
  trades.splice(3, 0, sell(EXEMPT_A, 2, 30n * 10n ** 24n));
  const r = computePosition(base({ trades }));
  assert.equal(r.exemptBefore, 3);
  assert.equal(r.exemptSharePct, 7);
});

test('wallets that bought after me are not counted as ahead of me', () => {
  const r = computePosition(base({ wallet: W(4) }));
  assert.equal(r.rank, 4);
  assert.equal(r.exemptBefore, 3);
});

test('the first buyer has nobody ahead of it', () => {
  const r = computePosition(base({ wallet: DEPLOYER }));
  assert.equal(r.exemptBefore, 0);
  assert.equal(r.exemptSharePct, 0);
});

test('sells inside 30 min count wallets once, and only the first N', () => {
  const r = computePosition(base());
  // Of the first 5: EXEMPT_A at +60s and W(4) at +120s. LATE sold at +4000s
  // and is not in the first 5 anyway.
  assert.equal(r.soldInside30m, 2);
});

test('a sell past 30 minutes is not counted', () => {
  const r = computePosition(base({ wallet: LATE }));
  assert.equal(r.rank, 6);
  assert.equal(r.soldInside30m, 2);
});

test('without total supply the share is undetermined and the rest still stands', () => {
  const r = computePosition(base({ totalSupply: null }));
  assert.equal(r.status, 'found');
  assert.equal(r.rank, 5);
  assert.equal(r.exemptBefore, 3);
  assert.equal(r.exemptSharePct, null);
  assert.match(positionText({ wallet: ME, token: '0xt', symbol: 'ZZZ' }, r, true), /undetermined share/);
});

test('an undecodable launch transaction leaves the exempt count unknown, not zero', () => {
  const r = computePosition(base({ exemptionsKnown: false, exemptWallets: [] }));
  assert.equal(r.status, 'found');
  assert.equal(r.exemptBefore, null);
  assert.equal(r.exemptSharePct, null);
  const text = positionText({ wallet: ME, token: '0xt', symbol: 'ZZZ' }, r, true);
  assert.match(text, /undetermined/);
  assert.doesNotMatch(text, /0 wallets tax-exempt/);
});

// -------------------------------------------------------------- coverage

test('a wallet missing while the index is behind head is undetermined, never none', () => {
  const r = computePosition(base({
    wallet: W(7),
    headBlock: LAUNCH_BLOCK + 10_000_000,
    indexedTo: LAUNCH_BLOCK + SELL_WINDOW_BLOCKS,
  }));
  assert.equal(r.status, 'undetermined');
  assert.match(r.reason, /blocks behind the chain/);
  const text = positionText({ wallet: W(7), token: '0xt', symbol: 'ZZZ' }, r, true);
  assert.match(text, /undetermined is not none/);
  // The only place the word appears is in the sentence denying it.
  assert.doesNotMatch(text, /no buy from this wallet/);
  assert.equal(r.rank, null);
});

test('a wallet missing with no head recorded is undetermined', () => {
  const r = computePosition(base({ wallet: W(7), headBlock: null }));
  assert.equal(r.status, 'undetermined');
  assert.match(r.reason, /unknown amount/);
});

test('a launch the trade indexer has not reached is undetermined', () => {
  const r = computePosition(base({ wallet: W(7), indexedTo: null }));
  assert.equal(r.status, 'undetermined');
  assert.match(r.reason, /has not read this launch yet/);
});

test('a wallet missing from a current index is absent, and says what was read', () => {
  const r = computePosition(base({ wallet: W(7) }));
  assert.equal(r.status, 'absent');
  assert.match(r.reason, /no buy from this wallet in the 6 buyers read/);
  const text = positionText({ wallet: W(7), token: '0xt', symbol: 'ZZZ' }, r, true);
  assert.match(text, /not proof it never held the token/);
});

test('an index short of the 30 minute mark leaves the sell count undetermined', () => {
  const r = computePosition(base({ indexedTo: LAUNCH_BLOCK + SELL_WINDOW_BLOCKS - 1 }));
  assert.equal(r.status, 'found');
  assert.equal(r.rank, 5);
  assert.equal(r.soldInside30m, null);
  assert.equal(r.sellWindowCovered, false);
  const text = positionText({ wallet: ME, token: '0xt', symbol: 'ZZZ' }, r, true);
  assert.match(text, /sells inside 30 min: undetermined/);
  assert.doesNotMatch(text, /0 of the first/);
});

test('trades arriving out of order are ranked by block, not by arrival', () => {
  const shuffled = [TRADES[4], TRADES[0], TRADES[3], TRADES[2], TRADES[1], ...TRADES.slice(5)];
  const r = computePosition(base({ trades: shuffled }));
  assert.equal(r.rank, 5);
  assert.equal(r.exemptBefore, 3);
});

// ------------------------------------------------------------------ text

test('the message says all three things in one place', () => {
  const r = computePosition(base());
  const text = positionText({ wallet: ME, token: '0xt', symbol: 'ZZZ' }, r, true);
  assert.match(text, /was the 5th buyer in \$ZZZ at \+4s/);
  assert.match(text, /3 wallets tax-exempt before it, holding 10\.00% of supply at that point/);
  assert.match(text, /2 of the first 5 sold inside 30 min/);
});

test('a group gets the wallet short, a DM gets it in full', () => {
  const r = computePosition(base());
  assert.ok(positionText({ wallet: ME, token: '0xt', symbol: null }, r, true).includes(ME));
  const group = positionText({ wallet: ME, token: '0xt', symbol: null }, r, false);
  assert.ok(!group.includes(ME));
  assert.ok(group.includes(shortWallet(ME)));
});

test('no verdict wording anywhere in the message', () => {
  for (const over of [{}, { wallet: W(7) }, { indexedTo: null }, { totalSupply: null }]) {
    const input = base(over);
    const text = positionText(input, computePosition(input), true);
    assert.doesNotMatch(text, /\bclean\b|\bsafe\b|\brug\b|\bgood\b|\bbad\b/i);
    assert.doesNotMatch(text, /!/);
    assert.ok(!text.includes(String.fromCharCode(0x2014)));
  }
});

test('ordinals read the way people write them', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
});

// ------------------------------------------------- the list against the count

test('the exempt list is only trusted when it matches the count', async () => {
  const { readLaunchForPosition } = await import('../dist/position.js');
  assert.equal(typeof readLaunchForPosition, 'function');
});

test('a count without a list cannot place anyone, so the answer is unknown', () => {
  // exemptionsKnown false is what readLaunchForPosition produces when the row
  // knows a number of exemptions but not which wallets they were.
  const r = computePosition(base({ exemptionsKnown: false, exemptWallets: [] }));
  assert.equal(r.exemptBefore, null);
  assert.match(positionText({ wallet: ME, token: '0xt', symbol: 'ZZZ' }, r, true),
    /tax-exempt wallets ahead of it: undetermined/);
});
