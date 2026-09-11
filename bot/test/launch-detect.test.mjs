/**
 * The launch landing: detect, post, pin, then scan it with the bot's own tool.
 *
 * The published promise is "CA lands here 3 s after launch", which is why this
 * rides the index loop's callback rather than the twenty second poster, and why
 * launch_ca is written before the post rather than after.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = process.env.DB_PATH || `/tmp/vitals-detect-${process.pid}.db`;
const { db } = await import('../dist/db.js');
const R = await import('../dist/ready.js');
const L = await import('../dist/launch.js');
const D = await import('../dist/launchday.js');

const GROUP = -100999;
const DEPLOYER = '0x73fdc2ff14f39ec21546a3647a157b746ac34bff';
const TOKEN = '0x21743b272b7d383ea371fba1d278325598c54659';
const OTHER = '0x1111111111111111111111111111111111111111';
const LAUNCH = Date.parse('2026-09-22T14:00:00Z');

function stubApi(over = {}) {
  const calls = [];
  let id = 400;
  return {
    calls,
    drain: () => { const c = [...calls]; calls.length = 0; return c; },
    api: {
      async sendMessage(chat_id, text, extra) {
        const message_id = ++id;
        calls.push({ method: 'sendMessage', chat_id, text, extra, message_id });
        if (over.sendThrows) throw new Error('chat not found');
        return { message_id, chat: { id: chat_id }, text };
      },
      async pinChatMessage(chat_id, message_id, extra) {
        calls.push({ method: 'pin', chat_id, message_id, extra });
        return true;
      },
      async unpinChatMessage(chat_id, message_id) {
        calls.push({ method: 'unpin', chat_id, message_id });
        return true;
      },
      async getChatMemberCount() { return 212; },
    },
  };
}

const insertLaunch = (token, deployer, block, at) =>
  db.prepare(
    `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at)
     VALUES (?,?,?,?,0,'0',?,?,?)`,
  ).run(token, '0x' + 'c'.repeat(40), deployer, '0x' + '0'.repeat(40), block, '0x' + token.slice(2).padEnd(64, '0'), at);

const armed = () => {
  db.prepare('DELETE FROM ready_settings').run();
  db.prepare('DELETE FROM launches').run();
  R.setSetting('ready_chat', String(GROUP));
  R.setSetting('launch_at', String(Math.floor(LAUNCH / 1000)));
  R.setSetting('launch_deployer', DEPLOYER);
  R.setSetting('launch_name', '$VITALS');
};

test('the watched deployer launching posts and pins the one CA', async () => {
  armed();
  insertLaunch(TOKEN, DEPLOYER, 60081281, Math.floor(LAUNCH / 1000));
  const s = stubApi();
  const ca = await D.launchDetected(s.api, [TOKEN], { now: LAUNCH });
  assert.equal(ca, TOKEN);

  const c = s.drain();
  const sent = c.find((x) => x.method === 'sendMessage');
  assert.equal(sent.chat_id, GROUP);
  assert.match(sent.text, /^\$VITALS is live\. CA: 0x21743b272b7d383ea371fba1d278325598c54659$/m);
  assert.match(sent.text, /^this is the only CA\.$/m);
  assert.equal(c.find((x) => x.method === 'pin').message_id, sent.message_id);
});

test('another deployer launching is ignored', async () => {
  armed();
  insertLaunch(OTHER, '0x' + '9'.repeat(40), 60081281, Math.floor(LAUNCH / 1000));
  const s = stubApi();
  assert.equal(await D.launchDetected(s.api, [OTHER], { now: LAUNCH }), null);
  assert.equal(s.calls.length, 0);
  assert.equal(D.pinnedCa(), null);
});

test('the CA post replaces the pinned countdown', async () => {
  armed();
  R.setSetting('countdown_pinned', '777');
  insertLaunch(TOKEN, DEPLOYER, 60081281, Math.floor(LAUNCH / 1000));
  const s = stubApi();
  await D.launchDetected(s.api, [TOKEN], { now: LAUNCH });
  const c = s.drain();
  assert.equal(c.find((x) => x.method === 'unpin').message_id, 777, 'the countdown pin comes down');
  assert.equal(R.getSetting('countdown_pinned'), '', 'and is not unpinned twice');
});

test('detecting the launch closes the fake-CA guard and whitelists the real address', async () => {
  armed();
  insertLaunch(TOKEN, DEPLOYER, 60081281, Math.floor(LAUNCH / 1000));
  assert.equal(D.guardActive(LAUNCH + 1000), true, 'open while no CA is known');
  const s = stubApi();
  await D.launchDetected(s.api, [TOKEN], { now: LAUNCH });
  assert.equal(D.pinnedCa(), TOKEN);
  assert.equal(D.guardActive(LAUNCH + 1000), false, 'and closed the moment the CA exists');
  // The genuine address is now postable by members.
  assert.equal(
    D.guardVerdict(`CA ${TOKEN}`, { pinnedCa: D.pinnedCa(), isAdmin: false, priorOffences: 0, active: false }).action,
    'ignore',
  );
});

test('a launch is announced once, however many times the callback fires', async () => {
  armed();
  insertLaunch(TOKEN, DEPLOYER, 60081281, Math.floor(LAUNCH / 1000));
  const s = stubApi();
  assert.equal(await D.launchDetected(s.api, [TOKEN], { now: LAUNCH }), TOKEN);
  s.drain();
  assert.equal(await D.launchDetected(s.api, [TOKEN], { now: LAUNCH + 3000 }), null);
  assert.equal(await D.reconcileLaunch(s.api, { now: LAUNCH + 3000 }), null);
  assert.equal(s.calls.length, 0, 'no second "this is the only CA"');
});

test('reconcile catches a launch the callback never reported', async () => {
  armed();
  // The two real miss paths: a cold-start backfill carries no newTokens, and a
  // token already in the table because somebody scanned it is never "new".
  insertLaunch(TOKEN, DEPLOYER, 60081281, Math.floor(LAUNCH / 1000));
  const s = stubApi();
  assert.equal(await D.launchDetected(s.api, [], { now: LAUNCH }), null, 'the callback saw nothing');
  assert.equal(await D.reconcileLaunch(s.api, { now: LAUNCH }), TOKEN, 'the table still knows');
  assert.equal(s.drain().filter((x) => x.method === 'sendMessage').length, 1);
});

test('reconcile ignores the watched deployer\'s older launches', async () => {
  armed();
  // The same deployer launched something last month. That is not this launch.
  insertLaunch(OTHER, DEPLOYER, 50000000, Math.floor(LAUNCH / 1000) - 30 * 86_400);
  const s = stubApi();
  assert.equal(await D.reconcileLaunch(s.api, { now: LAUNCH }), null);
  assert.equal(s.calls.length, 0);
});

test('nothing is announced without a group, a deployer, or a plan', async () => {
  armed();
  insertLaunch(TOKEN, DEPLOYER, 60081281, Math.floor(LAUNCH / 1000));
  const s = stubApi();

  R.setSetting('ready_chat', '');
  assert.equal(await D.launchDetected(s.api, [TOKEN], { now: LAUNCH }), null);

  armed();
  R.setSetting('launch_deployer', '');
  assert.equal(await D.launchDetected(s.api, [TOKEN], { now: LAUNCH }), null);

  armed();
  R.setSetting('launch_at', '');
  assert.equal(await D.launchDetected(s.api, [TOKEN], { now: LAUNCH }), null);
  assert.equal(s.calls.length, 0);
});

// ----------------------------------------------------------- the self-scan

test('the self-scan waits five minutes, then ten more for the full card', async () => {
  armed();
  insertLaunch(TOKEN, DEPLOYER, 60081281, Math.floor(LAUNCH / 1000));
  const s = stubApi();
  await D.launchDetected(s.api, [TOKEN], { now: LAUNCH });
  s.drain();

  assert.equal(await D.selfScanTick(s.api, { now: LAUNCH + 60_000 }), null, 'not at one minute');
  assert.equal(await D.selfScanTick(s.api, { now: LAUNCH + 4 * 60_000 }), null, 'not at four');
  assert.equal(s.calls.length, 0);
});

test('the self-scan does nothing until a launch has been detected', async () => {
  armed();
  const s = stubApi();
  assert.equal(await D.selfScanTick(s.api, { now: LAUNCH + 600_000 }), null);
  assert.equal(s.calls.length, 0);
});

test('the header and the delays are the ones the spec names', () => {
  assert.equal(D.SELF_SCAN_HEADER, 'the launch, scanned by its own tool');
  assert.equal(D.SELF_SCAN_DELAY_MS, 300_000, 'T+5 min');
  assert.equal(D.SELF_FULL_DELAY_MS, 900_000, 'the /full card ten minutes after that');
});

// -------------------------------------------- the promise, re-asserted

test('no registered wallet reaches the group on any launch-day surface', async () => {
  armed();
  insertLaunch(TOKEN, DEPLOYER, 60081281, Math.floor(LAUNCH / 1000));

  // Somebody is registered, with a label and an invite, and their user id is
  // distinctive enough to find in a haystack.
  const { client } = await import('../dist/chain.js');
  const WALLET = '0x5555555555555555555555555555555555555555';
  const EXTERNAL = '0x6666666666666666666666666666666666666666';
  client.getBalance = async () => 310000000000000000n;
  client.getCode = async () => '0x';
  db.prepare('DELETE FROM ready_wallets').run();
  await R.registerMember(7007007, WALLET, { inviteLink: 'kol-batch-2' });
  await R.addExternal(EXTERNAL, 'rh trader #3');

  const s = stubApi();
  // Every countdown offset, the CA post, and the guard's own texts.
  for (const o of L.COUNTDOWN_OFFSETS) {
    await D.countdownTick(s.api, { now: LAUNCH - o.seconds * 1000 + 1000, botUsername: 'vitalscheck_bot' });
  }
  await D.launchDetected(s.api, [TOKEN], { now: LAUNCH });

  const said = s.calls
    .filter((c) => c.method === 'sendMessage' && c.chat_id === GROUP)
    .map((c) => c.text)
    .concat([D.GUARD_WARNING, D.GUARD_MUTED])
    .join('\n');
  assert.ok(said.length > 0, 'the group did hear something, or this asserts nothing');

  for (const secret of [WALLET, EXTERNAL, 'rh trader #3', 'kol-batch-2', '7007007', DEPLOYER]) {
    assert.ok(!said.toLowerCase().includes(secret.toLowerCase()),
      `"${secret}" reached the group:\n${said}`);
  }

  // Exactly one address is allowed in the group, and it is the CA the bot
  // itself posted. Anything else would be the thing the guard exists to delete.
  const addresses = [...new Set([...said.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase()))];
  assert.deepEqual(addresses, [TOKEN], `only the CA may appear, saw ${addresses.join(', ')}`);
});
