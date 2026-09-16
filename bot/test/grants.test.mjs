import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

freshDb();
const G = await import('../dist/grants.js');
const { db } = await import('../dist/db.js');

const WALLET = '0x447c8dc55B88C09830E123f9fB3e7C484714ED93';
const ADMIN = 12345;
const DAY = 86_400;

const reset = () => db.prepare('DELETE FROM access_grants').run();
const backdate = (kind, subject, seconds) =>
  db.prepare('UPDATE access_grants SET expires_at = ? WHERE kind = ? AND subject = ?')
    .run(Math.floor(Date.now() / 1000) + seconds, kind, subject.toLowerCase());

test('a wallet grant is live, lowercased and dated', () => {
  reset();
  const res = G.grantAccess('wallet', WALLET, 30, ADMIN);
  assert.equal(res.ok, true);
  assert.equal(res.extended, false);
  assert.equal(res.grant.subject, WALLET.toLowerCase());
  const live = G.activeGrant('wallet', WALLET);
  assert.ok(live);
  assert.equal(G.daysLeft(live), 30);
});

test('the wallet is found whatever case it is asked about in', () => {
  reset();
  G.grantAccess('wallet', WALLET.toLowerCase(), 5, ADMIN);
  assert.ok(G.activeGrant('wallet', WALLET));
  assert.ok(G.activeGrant('wallet', WALLET.toUpperCase().replace('0X', '0x')));
});

test('a second grant extends what is left rather than replacing it', () => {
  reset();
  G.grantAccess('wallet', WALLET, 30, ADMIN);
  const again = G.grantAccess('wallet', WALLET, 30, ADMIN);
  assert.equal(again.extended, true);
  assert.equal(G.daysLeft(G.activeGrant('wallet', WALLET)), 60);
});

test('an expired grant is absent from every read, with no cleanup run', () => {
  reset();
  G.grantAccess('wallet', WALLET, 1, ADMIN);
  backdate('wallet', WALLET, -1);
  assert.equal(G.activeGrant('wallet', WALLET), null);
  assert.deepEqual(G.liveGrants('wallet'), []);
  // The row is still there. Expiry is a comparison, not a deletion.
  const n = db.prepare('SELECT COUNT(*) AS n FROM access_grants').get().n;
  assert.equal(n, 1);
});

test('granting again after expiry starts from now, not from the old date', () => {
  reset();
  G.grantAccess('wallet', WALLET, 10, ADMIN);
  backdate('wallet', WALLET, -100 * DAY);
  const res = G.grantAccess('wallet', WALLET, 7, ADMIN);
  assert.equal(res.extended, false);
  assert.equal(G.daysLeft(G.activeGrant('wallet', WALLET)), 7);
});

test('a revoked grant is gone', () => {
  reset();
  G.grantAccess('wallet', WALLET, 30, ADMIN);
  assert.equal(G.revokeGrant('wallet', WALLET), true);
  assert.equal(G.activeGrant('wallet', WALLET), null);
  assert.equal(G.revokeGrant('wallet', WALLET), false);
});

test('bad subjects and bad day counts are refused, not stored', () => {
  reset();
  assert.deepEqual(G.grantAccess('wallet', 'not-an-address', 30, ADMIN), { ok: false, reason: 'subject' });
  assert.deepEqual(G.grantAccess('chat', 'abc', 30, ADMIN), { ok: false, reason: 'subject' });
  assert.equal(G.grantAccess('wallet', WALLET, 0, ADMIN).reason, 'days');
  assert.equal(G.grantAccess('wallet', WALLET, -5, ADMIN).reason, 'days');
  assert.equal(G.grantAccess('wallet', WALLET, G.MAX_GRANT_DAYS + 1, ADMIN).reason, 'days');
  assert.equal(G.grantAccess('wallet', WALLET, Number.NaN, ADMIN).reason, 'days');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_grants').get().n, 0);
});

// --------------------------------------------------------------- chat grants

test('a chat grant licenses a group and expires', () => {
  reset();
  db.prepare('DELETE FROM licences').run();
  assert.deepEqual(G.groupLicensed(-100123), { licensed: false, via: null });
  G.grantAccess('chat', '-100123', 14, ADMIN);
  assert.deepEqual(G.groupLicensed(-100123), { licensed: true, via: 'grant' });
  backdate('chat', '-100123', -1);
  assert.deepEqual(G.groupLicensed(-100123), { licensed: false, via: null });
});

test('a bought licence outranks a grant and survives it lapsing', () => {
  reset();
  db.prepare('DELETE FROM licences').run();
  db.prepare('INSERT INTO licences (chat_id, user_id, granted_at) VALUES (?,?,?)')
    .run(-100999, 77, Math.floor(Date.now() / 1000));
  G.grantAccess('chat', '-100999', 1, ADMIN);
  assert.equal(G.groupLicensed(-100999).via, 'holder');
  backdate('chat', '-100999', -1);
  assert.deepEqual(G.groupLicensed(-100999), { licensed: true, via: 'holder' });
  db.prepare('DELETE FROM licences').run();
});

test('wallet grants and chat grants do not see each other', () => {
  reset();
  G.grantAccess('chat', '-100123', 14, ADMIN);
  assert.equal(G.activeGrant('wallet', WALLET), null);
  assert.equal(G.liveGrants('wallet').length, 0);
  assert.equal(G.liveGrants('chat').length, 1);
});

test('live grants come back soonest to expire first', () => {
  reset();
  G.grantAccess('chat', '-1', 30, ADMIN);
  G.grantAccess('chat', '-2', 3, ADMIN);
  G.grantAccess('chat', '-3', 10, ADMIN);
  assert.deepEqual(G.liveGrants('chat').map((g) => g.subject), ['-2', '-3', '-1']);
});

test('the status line says who gave it and when it ends, with no exclamation', () => {
  reset();
  G.grantAccess('wallet', WALLET, 3, ADMIN);
  const line = G.grantLine(G.activeGrant('wallet', WALLET));
  assert.match(line, /granted by an admin, 3 days left \(until \d{4}-\d{2}-\d{2}\)/);
  assert.doesNotMatch(line, /!/);
  assert.ok(!line.includes(String.fromCharCode(0x2014)));
  assert.equal(G.grantLine(null), null);
});

test('one day left reads as a day, not as days', () => {
  reset();
  G.grantAccess('wallet', WALLET, 1, ADMIN);
  assert.match(G.grantLine(G.activeGrant('wallet', WALLET)), /1 day left/);
});

// --------------------------------------------------------- the holder path

test('a granted wallet is premium without holding anything', async () => {
  reset();
  const { entitlement, entitlementLine } = await import('../dist/premium.js');
  const e = await entitlement(WALLET);
  // No $VITALS token configured here, so the holder half cannot run and says
  // so. A grant answers without it, which is the point of checking first.
  assert.equal(e.state, 'undetermined');
  G.grantAccess('wallet', WALLET, 30, ADMIN);
  const g = await entitlement(WALLET);
  assert.equal(g.state, 'premium');
  assert.equal(g.via, 'grant');
  assert.match(entitlementLine(g), /granted by an admin, 30 days left/);
});

test('when the grant lapses the wallet falls back to the holder path untouched', async () => {
  reset();
  const { entitlement } = await import('../dist/premium.js');
  G.grantAccess('wallet', WALLET, 1, ADMIN);
  assert.equal((await entitlement(WALLET)).state, 'premium');
  backdate('wallet', WALLET, -1);
  const after = await entitlement(WALLET);
  assert.notEqual(after.state, 'premium');
  // And it falls back to the holder path rather than to a refusal.
  assert.equal(after.state, 'undetermined');
});

test('a grant on a wallet that is not an address never reaches the chain', async () => {
  reset();
  const { entitlement } = await import('../dist/premium.js');
  const e = await entitlement('nonsense');
  assert.equal(e.state, 'undetermined');
  assert.match(e.reason, /not an address/);
});
