/**
 * The socials a launch was deployed with.
 *
 * NULL is "not read"; an empty string is "read, and none was given". /scout
 * requires socials to be PRESENT, so the two must stay apart: a launch whose
 * socials were never read is not a launch without socials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData } from 'viem';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('socials');
const { decodeLaunchCalldata, socialsOf } = await import('../dist/indexer/exemptions.js');
const { forwarderAbi, factoryAbi } = await import('../dist/abi.js');
const S = await import('../dist/socials.js');
const { db } = await import('../dist/db.js');

const params = (socials) => ({
  name: 'Chipper', symbol: 'CHIPPER', logo: '', description: '',
  socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '', ...socials },
  creatorFeeRecipient: '0x' + '1'.repeat(40), creatorTaxBps: 0, buybackEnabled: false,
  expectedEconomics: '0x' + '0'.repeat(64), salt: '0x' + '0'.repeat(64),
});
const ZERO = '0x' + '0'.repeat(40);

test('socials are decoded from launchAndBuy calldata, trimmed, as given', () => {
  const data = encodeFunctionData({
    abi: forwarderAbi, functionName: 'launchAndBuy',
    args: [params({ twitter: ' https://x.com/chipper ', telegram: 't.me/chipper' }), 0n, ZERO, 0n, 0n, ZERO, []],
  });
  const cd = decodeLaunchCalldata(data);
  assert.deepEqual(cd.socials, { x: 'https://x.com/chipper', tg: 't.me/chipper', web: '' });
});

test('the plain launchToken overload carries them too', () => {
  const data = encodeFunctionData({
    abi: factoryAbi, functionName: 'launchToken',
    args: [params({ website: 'chipper.xyz' }), 0n, ZERO],
  });
  const cd = decodeLaunchCalldata(data);
  assert.deepEqual(cd.socials, { x: '', tg: '', web: 'chipper.xyz' });
});

test('blank socials decode as empty strings, not null', () => {
  const data = encodeFunctionData({
    abi: forwarderAbi, functionName: 'launchAndBuy',
    args: [params({}), 0n, ZERO, 0n, 0n, ZERO, []],
  });
  assert.deepEqual(decodeLaunchCalldata(data).socials, { x: '', tg: '', web: '' });
});

test('undecodable calldata leaves socials null', () => {
  assert.equal(decodeLaunchCalldata('0xdeadbeef').socials, null);
  assert.equal(socialsOf(null), null);
  assert.equal(socialsOf({}), null);
});

test('stored: null until read, then what was read', () => {
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id, graduation_threshold,
       block_number, tx_hash, launched_at) VALUES (?,?,?,?,0,'0',1,?,1)`,
  ).run('0x' + 'a'.repeat(40), ZERO, ZERO, ZERO, '0x' + 'a'.repeat(64));
  assert.equal(S.storedSocials('0x' + 'a'.repeat(40)), null, 'not read is not "none"');
  db.prepare(`UPDATE launches SET social_x = '', social_tg = 't.me/a', social_web = '', socials_read_at = 5 WHERE token = ?`)
    .run('0x' + 'a'.repeat(40));
  const s = S.storedSocials('0x' + 'a'.repeat(40));
  assert.deepEqual(s, { x: '', tg: 't.me/a', web: '', readAt: 5 });
  assert.equal(S.socialsPresent(s), true);
  assert.equal(S.socialsPresent({ x: '', tg: '', web: 'site', readAt: 5 }), false, 'a website alone is not X or Telegram');
  assert.equal(S.socialsPresent(null), false);
});
