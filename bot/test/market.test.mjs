/**
 * The market block, read from the trade log this bot already keeps.
 *
 * Nothing here is fetched from a price API and nothing ever will be: the claim
 * of the product is that a card states what the chain shows. Everything is in
 * the QUOTE asset, because there is no oracle for a dollar figure and inventing
 * a conversion would put a made-up number beside measured ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('market');
const M = await import('../dist/metrics/market.js');
const { db } = await import('../dist/db.js');

const TOKEN = '0x' + '11'.repeat(20);
const CURVE = '0x' + 'c'.repeat(40);
const NOW = 1_789_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);
const E = 1_000_000_000_000_000_000n;

db.prepare(
  `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
     graduation_threshold, block_number, tx_hash, launched_at, trades_indexed_to)
   VALUES (?,?,?,?,1,'1',1000,?,?,?)`,
).run(TOKEN, CURVE, '0x' + 'd'.repeat(40), '0x' + 'e'.repeat(40),
  '0x' + 'f'.repeat(64), NOW_SEC - 7200, 100_000);

let logIndex = 0;
const trade = (agoSec, quoteEth, tokenQty, side = 'buy') => {
  db.prepare(
    `INSERT OR REPLACE INTO trades (tx_hash, log_index, token, curve, side, trader, recipient,
       quote_amount, token_amount, fee, creator_tax, block_number, block_time)
     VALUES (?,?,?,?,?,?,?,?,?,'0','0',?,?)`,
  ).run(
    '0x' + String(++logIndex).padStart(64, '0'), logIndex, TOKEN, CURVE, side,
    '0x' + '9'.repeat(40), '0x' + '9'.repeat(40),
    String(quoteEth), String(tokenQty),
    100_000 - Math.floor(agoSec * 10), NOW_SEC - agoSec,
  );
};

// Quote units, not wei: the scan's own reads are already scaled, and the card
// prints "1.68 ETH mc" beside a volume in the same unit.
const snap = (over = {}) => M.marketSnapshot({
  token: TOKEN, mcapQuote: 100, liquidityQuote: 40, pairDecimals: 18,
  currentBlock: 100_000, now: NOW, ...over,
});

test('no trades is not a zero, it is nothing to say', () => {
  M.resetMarketCache();
  const s = snap();
  assert.equal(s.athQuote, null);
  assert.equal(s.vol1h, 0);
  assert.equal(s.trades, 0);
  assert.equal(s.complete, false, 'a token with no trade log is not a complete reading');
});

test('volume is summed per window, in the quote asset', () => {
  M.resetMarketCache();
  // Price 1.0 throughout, so only the amounts move.
  trade(30, 3n * E, 3n * E);      // inside 5m
  trade(400, 2n * E, 2n * E);     // inside 1h, outside 5m
  trade(3000, 5n * E, 5n * E);    // inside 1h
  trade(7000, 9n * E, 9n * E);    // outside both
  const s = snap();
  assert.equal(s.vol5m, 3);
  assert.equal(s.vol1h, 10, '1h must include the 5m trades');
  assert.equal(s.trades, 4);
});

test('a quiet window is a zero volume, and no direction at all', () => {
  M.resetMarketCache();
  db.prepare('DELETE FROM trades WHERE token = ?').run(TOKEN);
  trade(3000, 1n * E, 1n * E);
  trade(2000, 2n * E, 1n * E);
  const s = snap();
  assert.equal(s.vol5m, 0);
  assert.equal(s.vol1h, 3);
  // There is no price direction in a snapshot at all. A quantity of activity is
  // evidence; which way the price went is a trading signal, and a card carrying
  // one stops being the thing no other bot does.
  assert.ok(!('change5m' in s), 'the snapshot carries a price direction');
  assert.ok(!('change1h' in s));
});

test('the ATH is the highest one-minute candle, not the highest wick', () => {
  M.resetMarketCache();
  db.prepare('DELETE FROM trades WHERE token = ?').run(TOKEN);
  // Two trades in the SAME minute: one at 2.0 and one at 50.0. The minute's
  // high is 50, which is the candle a chart draws, and the peak is taken from
  // the minute rather than from a raw trade so a single bad fill is not
  // reported as the token's history.
  trade(3600, 1n * E, 1n * E);
  trade(1800, 2n * E, 1n * E);
  trade(1795, 50n * E, 1n * E);
  trade(30, 4n * E, 1n * E);
  const s = snap();
  // Price now is 4.0, market cap 100; the peak price was 50, so the peak cap
  // is 100 * 50/4.
  assert.equal(s.athQuote, 1250);
  // Half an hour after the first trade.
  assert.equal(s.athMinutes, 30);
});

test('market cap and liquidity are the caller\'s, never the cache\'s', () => {
  M.resetMarketCache();
  const first = snap({ mcapQuote: 100, liquidityQuote: 40 });
  const second = snap({ mcapQuote: 250, liquidityQuote: 90 });
  assert.equal(second.mcapQuote, 250, 'a cached block served a stale market cap');
  assert.equal(second.liquidityQuote, 90);
  // And the windowed figures did come from the cache.
  assert.equal(second.vol1h, first.vol1h);
});

test('a trade log that does not reach the head is incomplete, and says so', () => {
  M.resetMarketCache();
  assert.equal(snap({ currentBlock: 100_000 }).complete, true);
  // Two minutes of blocks is the slack; well past it is not a full hour.
  assert.equal(snap({ currentBlock: 200_000 }).complete, false);
  M.resetMarketCache();
  db.prepare('UPDATE launches SET trades_indexed_to = NULL WHERE token = ?').run(TOKEN);
  assert.equal(snap().complete, false, 'an unindexed token is never complete');
});
