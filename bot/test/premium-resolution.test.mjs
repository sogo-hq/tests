/**
 * Which route opened premium, and what happens when more than one did.
 *
 * Three ways in now: a grant to the telegram account, a grant to a wallet the
 * account has proven it holds, and the holding rule. Having two of them must
 * never be worse than having one, and a wallet grant must never open premium
 * for somebody who merely named the wallet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('premium-resolution');
process.env.VITALS_TOKEN_ADDRESS = '0x' + '11'.repeat(20);

const { db } = await import('../dist/db.js');
const { client } = await import('../dist/chain.js');

// The chain, stubbed before tiers.js is imported, the way tiers.test.mjs does
// it. Nothing here reaches a node.
const balances = new Map();
let readable = true;
client.readContract = async ({ functionName, args }) => {
  if (!readable) throw new Error('rpc down');
  if (functionName === 'decimals') return 18;
  if (functionName === 'balanceOf') return (balances.get(String(args[0]).toLowerCase()) ?? 0n) * 10n ** 18n;
  throw new Error(`unexpected ${functionName}`);
};

const T = await import('../dist/tiers.js');
const G = await import('../dist/tggrants.js');
const { grantAccess } = await import('../dist/grants.js');

const DAY = 86_400;
const NOW = 1_800_000_000_000; // ms
const NOW_S = Math.floor(NOW / 1000);
const W = (n) => '0x' + String(n).padStart(40, '0');

let clock = NOW;
const reset = () => {
  for (const t of ['premium_tg_grants', 'premium_tg_reminders', 'tier_grants', 'access_grants', 'holder_links']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  balances.clear();
  readable = true;
  // A fresh instant each test, so the balance cache from the last one cannot
  // answer this one.
  clock += 3_600_000;
};

/** A proven link, the way /holder link writes one. */
const link = (userId, wallet) =>
  db.prepare("INSERT OR REPLACE INTO holder_links (user_id, wallet, method, linked_at) VALUES (?,?,'signature',?)")
    .run(userId, wallet.toLowerCase(), NOW_S);

/** What the stubbed chain will say this wallet holds. */
const balance = (wallet, whole) => balances.set(wallet.toLowerCase(), BigInt(whole));

test('a tg grant alone is premium, with no wallet anywhere', async () => {
  reset();
  G.grantTg(7001, 30, { note: 'floor kol', by: 9001, at: NOW_S });
  const r = await T.tierOf(7001, NOW);
  assert.equal(r.state, 'ok');
  assert.equal(r.tier, 'premium');
  assert.equal(r.via, 'grant');
  assert.equal(r.grantUntil, (NOW_S + 30 * DAY) * 1000);
  // And the gate every premium feature actually calls.
  assert.equal(await T.effectiveTier(7001, NOW), 'premium');
  assert.ok(T.atLeast(await T.effectiveTier(7001, NOW), 'premium'));
});

test('no grant and no wallet is unlinked, exactly as before', async () => {
  reset();
  const r = await T.tierOf(7002, NOW);
  assert.equal(r.state, 'unlinked');
  assert.equal(await T.effectiveTier(7002, NOW), 'none');
});

test('an expired tg grant is not premium, and says nothing about itself', async () => {
  reset();
  G.grantTg(7001, 30, { by: 9001, at: NOW_S - 40 * DAY });
  const r = await T.tierOf(7001, NOW);
  assert.equal(r.state, 'unlinked', 'an expired grant left a live one behind');
  assert.equal(await T.effectiveTier(7001, NOW), 'none');
});

test('a wallet grant opens premium only through a proven link', async () => {
  reset();
  const wallet = W(42);
  grantAccess('wallet', wallet, 30, 9001, 'partner');

  // Nobody has proven they hold it, so nobody gets premium from it.
  assert.equal(await T.effectiveTier(7003, NOW), 'none');

  // Linked, and it opens. An address is public, so the link is the whole of
  // what makes this safe.
  link(7003, wallet);
  balance(wallet, 0);
  const r = await T.tierOf(7003, NOW);
  assert.equal(r.state, 'ok');
  assert.equal(r.tier, 'premium');
  assert.equal(r.via, 'grant');
});

test('the holding rule still stands on its own', async () => {
  reset();
  const wallet = W(43);
  link(7004, wallet);
  balance(wallet, 1_000_000);
  const r = await T.tierOf(7004, NOW);
  assert.equal(r.state, 'ok');
  assert.equal(r.tier, 'premium');
  assert.equal(r.via, 'balance');
  assert.equal(r.grantUntil, null);
});

test('a tg grant and a balance together take the better of the two', async () => {
  reset();
  const wallet = W(44);
  link(7005, wallet);
  balance(wallet, 10_000_000); // desk
  G.grantTg(7005, 30, { by: 9001, at: NOW_S });
  const r = await T.tierOf(7005, NOW);
  // The balance is the higher tier, so it wins, and the grant is still
  // reported: losing on tier is not losing the date.
  assert.equal(r.tier, 'desk');
  assert.equal(r.via, 'balance');
  assert.equal(r.grantUntil, (NOW_S + 30 * DAY) * 1000);
});

test('a tg grant beats a balance that has fallen below the threshold', async () => {
  reset();
  const wallet = W(45);
  link(7006, wallet);
  balance(wallet, 1); // none
  G.grantTg(7006, 30, { by: 9001, at: NOW_S });
  const r = await T.tierOf(7006, NOW);
  assert.equal(r.tier, 'premium');
  assert.equal(r.via, 'grant');
});

test('two grants on one account take the later date, never the earlier', async () => {
  // grantAccess anchors to the real clock and grantTg takes an instant, so
  // both are anchored to the same base here. The point is the max, and a test
  // whose two grants are measured from different moments cannot show it.
  const base = Math.floor(Date.now() / 1000);
  const at = base * 1000;

  reset();
  const wallet = W(46);
  link(7007, wallet);
  balance(wallet, 0);
  grantAccess('wallet', wallet, 10, 9001, 'wallet grant');
  G.grantTg(7007, 60, { by: 9001, at: base });
  const longer = await T.tierOf(7007, at);
  assert.equal(longer.tier, 'premium');
  assert.equal(longer.grantUntil, (base + 60 * DAY) * 1000, 'the shorter grant won');

  // And the other way round, so it is the max rather than the order.
  reset();
  link(7008, wallet);
  balance(wallet, 0);
  grantAccess('wallet', wallet, 60, 9001, 'wallet grant');
  G.grantTg(7008, 10, { by: 9001, at: base });
  const wins = await T.tierOf(7008, at);
  assert.equal(wins.grantUntil, (base + 60 * DAY) * 1000, 'the tg grant won although it was shorter');
});

test('the older /grant route still opens premium and is still counted', async () => {
  reset();
  T.grant(7009, 'premium', 30, 'admin', NOW);
  const r = await T.tierOf(7009, NOW);
  assert.equal(r.tier, 'premium');
  assert.equal(r.via, 'grant');
  assert.equal(T.countLegacyTierGrants(NOW), 1);
  // A payment is not an admin grant and is not counted as one.
  T.grant(7010, 'premium', 30, 'payment', NOW);
  assert.equal(T.countLegacyTierGrants(NOW), 1);
});

test('a chain that cannot be read is undetermined, unless a grant answers it', async () => {
  reset();
  const wallet = W(47);
  link(7011, wallet);
  readable = false;
  const bare = await T.tierOf(7011, clock);
  assert.equal(bare.state, 'undetermined');

  G.grantTg(7011, 30, { by: 9001, at: NOW_S });
  const granted = await T.tierOf(7011, clock);
  assert.equal(granted.state, 'ok');
  assert.equal(granted.tier, 'premium');
  assert.equal(granted.via, 'grant');
});
