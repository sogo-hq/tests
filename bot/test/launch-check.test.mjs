import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkConfig, imageInfo, checkImage, pointsAt,
  EXPECTED_DEPLOYER, EXPECTED_SOCIALS, EXAMPLE_SALT, MAX_IMAGE_BYTES, OBSERVED_MAX_DESCRIPTION,
} from '../dist/launchcheck.js';
import { gatewayUrl } from '../tools/check.mjs';

// Config 0, the only one the factory accepts.
const CURVE = { supply: 10n ** 27n, phantomQuote: 1_680_000_000_000_000_000n, curveFeeBps: 100n };

const GOOD = {
  name: 'vitals',
  symbol: 'VITALS',
  logo: 'ipfs://bafybeigoodcidgoodcidgoodcid',
  description: 'scanner for pons launches on robinhood chain. facts and their reference points.',
  socials: {
    twitter: 'https://x.com/vitalsxyz',
    telegram: 'https://t.me/vitalsofficial',
    discord: '',
    website: 'https://checkvitals.xyz',
    farcaster: '',
  },
  creatorFeeRecipient: EXPECTED_DEPLOYER,
  creatorTaxBps: 400,
  buybackEnabled: false,
  expectedEconomics: '0xa9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca7',
  salt: '0x1111111111111111111111111111111111111111111111111111111111111111',
  launchConfigId: 0,
  pairToken: '0x0000000000000000000000000000000000000000',
  devBuyEth: '0.0930',
  minTokensOut: '0',
  recipient: EXPECTED_DEPLOYER,
  extraExemptions: [],
};

const row = (rows, field) => rows.find((r) => r.field === field);
const clone = (over = {}) => ({ ...structuredClone(GOOD), ...over });

test('the filled config passes every field', () => {
  const rows = checkConfig(GOOD, CURVE);
  const bad = rows.filter((r) => r.verdict !== 'pass');
  assert.deepEqual(bad.map((r) => `${r.field}: ${r.note}`), []);
});

test('no field verdict is ever the word clean or safe', () => {
  const rows = checkConfig(GOOD, CURVE);
  for (const r of rows) {
    assert.doesNotMatch(`${r.field} ${r.note}`, /\bclean\b|\bsafe\b|\bgood\b/i);
  }
});

test('no em dash anywhere in the output', () => {
  const rows = checkConfig(clone({ description: 'x'.repeat(200), salt: EXAMPLE_SALT }), CURVE);
  for (const r of rows) assert.ok(!`${r.field}${r.value}${r.note}`.includes(String.fromCharCode(0x2014)), r.field);
});

// --------------------------------------------------------------- the dev buy

test('0.0930 is under the 5 percent cap at a 4 percent tax', () => {
  const r = row(checkConfig(GOOD, CURVE), 'devBuyEth');
  assert.equal(r.verdict, 'pass');
  assert.match(r.note, /4\.99\d+% of supply at 400 bps, under the 5% cap/);
});

test('0.0931 is over the cap and fails', () => {
  const r = row(checkConfig(clone({ devBuyEth: '0.0931' }), CURVE), 'devBuyEth');
  assert.equal(r.verdict, 'fail');
  assert.match(r.note, /over the 5% cap/);
});

test('a dev buy under the cap but not the agreed number is a warning, not a pass', () => {
  const r = row(checkConfig(clone({ devBuyEth: '0.05' }), CURVE), 'devBuyEth');
  assert.equal(r.verdict, 'warn');
  assert.match(r.note, /expected 0\.0930/);
});

test('without the curve the share is undetermined, never assumed fine', () => {
  const r = row(checkConfig(GOOD, null), 'devBuyEth');
  assert.equal(r.verdict, 'unknown');
  assert.doesNotMatch(r.note, /pass|ok/i);
});

// ------------------------------------------------------------------ the salt

test('the example salt fails because it decides the address', () => {
  const r = row(checkConfig(clone({ salt: EXAMPLE_SALT }), CURVE), 'salt');
  assert.equal(r.verdict, 'fail');
  assert.match(r.note, /example salt/);
});

test('an all zero salt fails', () => {
  assert.equal(row(checkConfig(clone({ salt: `0x${'0'.repeat(64)}` }), CURVE), 'salt').verdict, 'fail');
});

test('a salt that is not 32 bytes of hex fails before the transaction does', () => {
  for (const bad of ['0xCHANGE-ME-32-BYTES-OF-YOUR-OWN', '', '0x1234', `0x${'1'.repeat(63)}`, `0x${'1'.repeat(65)}`, 'no']) {
    const r = row(checkConfig(clone({ salt: bad }), CURVE), 'salt');
    assert.equal(r.verdict, 'fail', JSON.stringify(bad));
  }
});

// -------------------------------------------------------------- the wallets

test('either recipient pointing anywhere else fails', () => {
  const other = '0x0000000000000000000000000000000000000001';
  assert.equal(row(checkConfig(clone({ recipient: other }), CURVE), 'recipient').verdict, 'fail');
  assert.equal(row(checkConfig(clone({ creatorFeeRecipient: other }), CURVE), 'creatorFeeRecipient').verdict, 'fail');
});

test('the recipient check ignores address casing', () => {
  const r = row(checkConfig(clone({ recipient: EXPECTED_DEPLOYER.toLowerCase() }), CURVE), 'recipient');
  assert.equal(r.verdict, 'pass');
});

test('a tax other than 400 bps fails', () => {
  assert.equal(row(checkConfig(clone({ creatorTaxBps: 500 }), CURVE), 'creatorTaxBps').verdict, 'fail');
  assert.equal(row(checkConfig(clone({ creatorTaxBps: 0 }), CURVE), 'creatorTaxBps').verdict, 'fail');
});

test('a pair other than ETH and a config other than 0 both fail', () => {
  const rows = checkConfig(clone({ pairToken: '0x' + 'ab'.repeat(20), launchConfigId: 1 }), CURVE);
  assert.equal(row(rows, 'pairToken').verdict, 'fail');
  assert.equal(row(rows, 'launchConfigId').verdict, 'fail');
});

// ------------------------------------------------------------- exemptions

test('exemptions are the deployer alone', () => {
  const r = row(checkConfig(GOOD, CURVE), 'extraExemptions');
  assert.equal(r.verdict, 'pass');
  assert.match(r.note, /deployer alone/);
});

test('one extra exempt wallet fails and is counted', () => {
  const r = row(checkConfig(clone({ extraExemptions: ['0x' + '11'.repeat(20)] }), CURVE), 'extraExemptions');
  assert.equal(r.verdict, 'fail');
  assert.match(r.note, /1 wallet beyond the deployer/);
});

// ---------------------------------------------------------------- socials

test('the three socials are checked by host', () => {
  const rows = checkConfig(GOOD, CURVE);
  for (const key of Object.keys(EXPECTED_SOCIALS)) {
    assert.equal(row(rows, `socials.${key}`).verdict, 'pass', key);
  }
});

test('a social pointing at a lookalike host fails', () => {
  const rows = checkConfig(clone({ socials: { ...GOOD.socials, website: 'https://checkvitals.xyz.example.com' } }), CURVE);
  assert.equal(row(rows, 'socials.website').verdict, 'fail');
});

test('an empty social fails rather than being skipped', () => {
  const rows = checkConfig(clone({ socials: { ...GOOD.socials, twitter: '' } }), CURVE);
  assert.equal(row(rows, 'socials.twitter').verdict, 'fail');
  assert.match(row(rows, 'socials.twitter').note, /x\.com\/vitalsxyz/);
});

test('pointsAt accepts scheme and www variants and rejects suffix tricks', () => {
  assert.ok(pointsAt('https://x.com/vitalsxyz', 'x.com/vitalsxyz'));
  assert.ok(pointsAt('x.com/vitalsxyz', 'x.com/vitalsxyz'));
  assert.ok(pointsAt('https://www.checkvitals.xyz', 'checkvitals.xyz'));
  assert.ok(pointsAt('https://checkvitals.xyz/docs', 'checkvitals.xyz'));
  assert.ok(!pointsAt('https://checkvitals.xyz.evil.com', 'checkvitals.xyz'));
  assert.ok(!pointsAt('https://notcheckvitals.xyz', 'checkvitals.xyz'));
  assert.ok(!pointsAt('', 'checkvitals.xyz'));
});

// ------------------------------------------------------------ description

test('a description at the observed maximum passes', () => {
  const r = row(checkConfig(clone({ description: 'x'.repeat(OBSERVED_MAX_DESCRIPTION) }), CURVE), 'description');
  assert.equal(r.verdict, 'pass');
});

test('a longer description warns and says pons publishes no limit', () => {
  const r = row(checkConfig(clone({ description: 'x'.repeat(OBSERVED_MAX_DESCRIPTION + 1) }), CURVE), 'description');
  assert.equal(r.verdict, 'warn');
  assert.match(r.note, /publishes no limit/);
});

test('placeholders in the text fields fail', () => {
  const rows = checkConfig(clone({ description: 'CHANGE ME', logo: 'ipfs://CHANGE-ME', name: 'change me' }), CURVE);
  assert.equal(row(rows, 'description').verdict, 'fail');
  assert.equal(row(rows, 'logo').verdict, 'fail');
  assert.equal(row(rows, 'name').verdict, 'fail');
});

test('a logo behind a plain http host warns about the host staying up', () => {
  const r = row(checkConfig(clone({ logo: 'https://example.com/logo.png' }), CURVE), 'logo');
  assert.equal(r.verdict, 'warn');
  assert.match(r.note, /host staying up/);
});

// --------------------------------------------------------------- the image

const png = (w, h, pad = 0) => {
  const b = new Uint8Array(24 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const gif = (w, h) => {
  const b = new Uint8Array(32);
  b.set([...'GIF89a'].map((c) => c.charCodeAt(0)), 0);
  b[6] = w & 255; b[7] = w >> 8; b[8] = h & 255; b[9] = h >> 8;
  return b;
};
const jpeg = (w, h) => {
  // SOI, an APP0 we have to skip over, then SOF0.
  const b = new Uint8Array(40);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  const sof = 2 + 2 + 0x10;
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof);
  const dv = new DataView(b.buffer);
  dv.setUint16(sof + 5, h);
  dv.setUint16(sof + 7, w);
  return b;
};
const webpVP8X = (w, h) => {
  const b = new Uint8Array(32);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  b.set([...'VP8X'].map((c) => c.charCodeAt(0)), 12);
  const wm = w - 1, hm = h - 1;
  b[24] = wm & 255; b[25] = (wm >> 8) & 255; b[26] = (wm >> 16) & 255;
  b[27] = hm & 255; b[28] = (hm >> 8) & 255; b[29] = (hm >> 16) & 255;
  return b;
};

test('png dimensions come out of the header', () => {
  assert.deepEqual(imageInfo(png(512, 512)), { format: 'png', width: 512, height: 512, bytes: 24 });
});

test('gif, jpeg and webp dimensions come out of their headers', () => {
  const g = imageInfo(gif(400, 400));
  assert.equal(g.format, 'gif');
  assert.deepEqual([g.width, g.height], [400, 400]);
  const j = imageInfo(jpeg(1000, 800));
  assert.equal(j.format, 'jpeg');
  assert.deepEqual([j.width, j.height], [1000, 800]);
  const w = imageInfo(webpVP8X(256, 256));
  assert.equal(w.format, 'webp');
  assert.deepEqual([w.width, w.height], [256, 256]);
});

test('something that is not an image is a failure, not an unknown', () => {
  const v = checkImage(imageInfo(new TextEncoder().encode('<!doctype html><html>404')));
  assert.equal(v.verdict, 'fail');
  assert.match(v.note, /not a png, jpeg, gif or webp/);
});

test('a square image under a megabyte passes and prints its size', () => {
  const v = checkImage(imageInfo(png(512, 512, 40_000)));
  assert.equal(v.verdict, 'pass');
  assert.match(v.note, /png, 512x512/);
});

test('a rectangle fails and says so', () => {
  const v = checkImage(imageInfo(png(512, 256)));
  assert.equal(v.verdict, 'fail');
  assert.match(v.note, /not square/);
});

test('over a megabyte fails even when square', () => {
  const v = checkImage(imageInfo(png(512, 512, MAX_IMAGE_BYTES)));
  assert.equal(v.verdict, 'fail');
  assert.match(v.note, /over 1000 KB/);
});

test('exactly a megabyte is not over it', () => {
  const v = checkImage({ format: 'png', width: 512, height: 512, bytes: MAX_IMAGE_BYTES });
  assert.equal(v.verdict, 'pass');
});

test('a header without readable dimensions is a warning, not a pass', () => {
  const v = checkImage({ format: 'webp', width: null, height: null, bytes: 1000 });
  assert.equal(v.verdict, 'warn');
  assert.match(v.note, /dimensions unreadable/);
});

// ------------------------------------------------------------- the gateway

test('ipfs references become ipfs.io urls and http ones are left alone', () => {
  assert.equal(gatewayUrl('ipfs://bafyabc'), 'https://ipfs.io/ipfs/bafyabc');
  assert.equal(gatewayUrl('ipfs://ipfs/bafyabc'), 'https://ipfs.io/ipfs/bafyabc');
  assert.equal(gatewayUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(gatewayUrl(''), null);
  assert.equal(gatewayUrl(undefined), null);
});

// ------------------------------------------------------------ the real file

test('the real launch config is not in git, and the example is', async () => {
  const { execFileSync } = await import('node:child_process');
  const tracked = execFileSync('git', ['ls-files', 'tools/'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.ok(!tracked.includes('tools/launch.config.json'),
    'the salt decides the token address, so the real config never enters git');
  assert.ok(tracked.includes('tools/launch.config.example.json'));
});

test('gitignore covers the config and the launch records', async () => {
  const { readFileSync } = await import('node:fs');
  const ignore = readFileSync('.gitignore', 'utf8');
  assert.match(ignore, /^tools\/launch\.config\.json$/m);
  assert.match(ignore, /^tools\/out\/$/m);
});

test('the example has the same shape as the config the tool reads', async () => {
  const { readFileSync } = await import('node:fs');
  const example = JSON.parse(readFileSync('tools/launch.config.example.json', 'utf8'));
  const real = JSON.parse(readFileSync('tools/launch.config.json', 'utf8'));
  const keys = (o) => Object.keys(o).filter((k) => !k.startsWith('_')).sort();
  assert.deepEqual(keys(example), keys(real));
  assert.deepEqual(keys(example.socials), keys(real.socials));
  assert.deepEqual(keys(example.rehearsal), keys(real.rehearsal));
});

test('the example carries no salt, no recipient and no description of its own', async () => {
  const { readFileSync } = await import('node:fs');
  const example = JSON.parse(readFileSync('tools/launch.config.example.json', 'utf8'));
  for (const field of ['salt', 'creatorFeeRecipient', 'recipient', 'description', 'logo']) {
    assert.match(String(example[field]), /CHANGE.?ME/i, field);
  }
  // And a checker run against the example fails on every one of them, rather
  // than passing because the shape is right.
  const rows = checkConfig(example, CURVE);
  for (const field of ['salt', 'creatorFeeRecipient', 'recipient', 'description', 'logo']) {
    assert.equal(rows.find((r) => r.field === field).verdict, 'fail', field);
  }
});

test('the example names the dev buy this repo computed', async () => {
  const { readFileSync } = await import('node:fs');
  const example = JSON.parse(readFileSync('tools/launch.config.example.json', 'utf8'));
  assert.equal(example.devBuyEth, '0.0930');
  assert.equal(example.creatorTaxBps, 400);
  assert.equal(example.launchConfigId, 0);
  assert.deepEqual(example.extraExemptions, []);
  assert.match(example._devBuyEth, /0\.0931 takes 5\.0012%/);
});
