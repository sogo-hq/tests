import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Alerts: who is watching what, who hears about a launch, and who hears twice.
 *
 * The rules that matter are the ones about restraint. Never fire into a group.
 * Never fire the same launch at the same person twice, however many of their
 * watches it matches. Never exceed what somebody asked for.
 */
const CWD = process.cwd();

function inTempDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-watch-'));
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { db } = await import('${CWD}/dist/db.js');
      const W = await import('${CWD}/dist/watch.js');
      const A = (n) => '0x' + String(n).padStart(40, '0');
      const launch = (token, deployer, exemptions = []) => db.prepare(
        \`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
            graduation_threshold, block_number, tx_hash, launched_at,
            snipe_exemption_count, snipe_exemptions)
          VALUES (?,?,?,?,0,'0',1000,?,0,?,?)\`
      ).run(token, A(99), deployer, A(0), '0xtx' + token, exemptions.length,
            exemptions.length ? JSON.stringify(exemptions) : null);
      ${body}
    `], { cwd: CWD, env: { ...process.env, DB_PATH: join(dir, 'w.db') }, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a deployer watch fires on that deployer\'s next launch', () => {
  const out = inTempDb(`
    W.addWatch(1, 'deployer', A(50), 900);
    launch(A(7), A(50));
    const m = W.matchesFor({ deployer: A(50), exemptions: [] });
    console.log(JSON.stringify(m));
  `);
  const m = JSON.parse(out);
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'deployer');
  assert.equal(m[0].dmChatId, 900, 'delivery goes to the DM recorded when the watch was made');
});

test('a wallet watch fires when that wallet is pre-exempted on a launch', () => {
  const out = inTempDb(`
    W.addWatch(2, 'wallet', A(60), 901);
    const m = W.matchesFor({ deployer: A(50), exemptions: [A(60), A(61)] });
    console.log(JSON.stringify(m));
  `);
  const m = JSON.parse(out);
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'wallet');
});

test('one launch matching two of a user\'s watches is one alert, not two', () => {
  // The case that would otherwise double-send: they watch the deployer AND a
  // wallet it exempted.
  const out = inTempDb(`
    W.addWatch(3, 'deployer', A(50), 902);
    W.addWatch(3, 'wallet', A(60), 902);
    const m = W.matchesFor({ deployer: A(50), exemptions: [A(60)] });
    console.log(JSON.stringify({ count: m.length, kind: m[0]?.kind }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.count, 1, 'two matching watches must produce one alert');
  assert.equal(r.kind, 'deployer', 'and the deployer is the stronger relationship to report');
});

test('a delivery is claimed once, so a retry sends nothing', () => {
  const out = inTempDb(`
    const first = W.claimDelivery(4, A(7));
    const second = W.claimDelivery(4, A(7));
    const otherUser = W.claimDelivery(5, A(7));
    console.log(JSON.stringify({ first, second, otherUser }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.first, true);
  assert.equal(r.second, false, 'the same launch must never fire twice to one user');
  assert.equal(r.otherUser, true, 'but another watcher still hears about it');
});

test('the watch limit is enforced and reported', () => {
  const out = inTempDb(`
    const results = [];
    for (let i = 0; i < W.MAX_WATCHES + 3; i++) {
      results.push(W.addWatch(6, 'deployer', A(1000 + i), 903));
    }
    console.log(JSON.stringify({
      added: results.filter((r) => r.ok).length,
      refused: results.filter((r) => !r.ok && r.reason === 'limit').length,
      count: W.countWatches(6),
      max: W.MAX_WATCHES,
    }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.max, 20);
  assert.equal(r.added, 20);
  assert.equal(r.refused, 3, 'past the limit it refuses and says which limit');
  assert.equal(r.count, 20);
});

test('watching the same address twice is refused, not duplicated', () => {
  const out = inTempDb(`
    const a = W.addWatch(7, 'deployer', A(50), 904);
    const b = W.addWatch(7, 'deployer', A(50), 904);
    console.log(JSON.stringify({ a: a.ok, b: b.ok, reason: b.reason, count: W.countWatches(7) }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.a, true);
  assert.equal(r.b, false);
  assert.equal(r.reason, 'duplicate');
  assert.equal(r.count, 1);
});

test('unwatch removes every watch on an address', () => {
  const out = inTempDb(`
    W.addWatch(8, 'deployer', A(50), 905);
    W.addWatch(8, 'wallet', A(50), 905);
    const gone = W.removeWatch(8, A(50));
    console.log(JSON.stringify({ gone, left: W.countWatches(8) }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.gone, 2, 'an address watched as both is removed as both');
  assert.equal(r.left, 0);
});

test('the why-line names the address and the reason, and claims nothing else', () => {
  const out = inTempDb(`
    console.log(JSON.stringify({
      dep: W.whyLine({ userId: 1, dmChatId: 1, kind: 'deployer', address: A(50) }, '$NEW'),
      wal: W.whyLine({ userId: 1, dmChatId: 1, kind: 'wallet', address: A(60) }, '$NEW'),
    }));
  `);
  const r = JSON.parse(out);
  assert.match(r.dep, /launched \$NEW — you watch this deployer$/);
  assert.match(r.wal, /pre-exempted on \$NEW — you watch this wallet$/);
  const VERDICT = /\b(good|bad|safe|risky|opportunity|smart|alpha|gem|buy|sell)\b/i;
  for (const line of [r.dep, r.wal]) assert.ok(!VERDICT.test(line), `framing in "${line}"`);
});

test('a launch nobody watches produces nothing', () => {
  const out = inTempDb(`
    W.addWatch(9, 'deployer', A(50), 906);
    console.log(JSON.stringify(W.matchesFor({ deployer: A(77), exemptions: [A(78)] })));
  `);
  assert.deepEqual(JSON.parse(out), []);
});
