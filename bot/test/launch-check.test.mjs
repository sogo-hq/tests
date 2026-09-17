import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkConfig, imageInfo, checkImage, pointsAt,
  EXPECTED_DEPLOYER, EXPECTED_SOCIALS, EXAMPLE_SALT, MAX_IMAGE_BYTES, OBSERVED_MAX_DESCRIPTION,
  gatewayUrls, cidOf, fetchLogo, gatewayNote, gatewayHost, isRetryableStatus,
  IPFS_GATEWAYS, GATEWAY_RETRY_MS,
} from '../dist/launchcheck.js';

/** The first gateway for a reference, which is what the old single-gateway test meant. */
const gatewayUrl = (ref) => gatewayUrls(ref)[0] ?? null;

// Config 0, the only one the factory accepts.
const CURVE = { supply: 10n ** 27n, phantomQuote: 1_680_000_000_000_000_000n, curveFeeBps: 100n };

const GOOD = {
  name: 'vitals',
  symbol: 'VITALS',
  logo: 'ipfs://bafybeigoodcidgoodcidgoodcid',
  description: 'scanner for pons launches on robinhood chain. facts and their reference points.',
  socials: {
    twitter: 'https://x.com/vitalsxyz',
    telegram: 'https://t.me/vitals_official',
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

test('exemptions are the deployer alone, counted as the union of the slots', () => {
  const rows = checkConfig(GOOD, CURVE);
  const r = row(rows, 'tax free at launch');
  assert.equal(r.verdict, 'pass');
  assert.equal(r.value, '1 wallet');
  // Three events, one wallet: the sender, the creatorFeeRecipient and the
  // opening-buy recipient are all 0x447c on this config.
  assert.match(r.note, /the deployer alone, from 3 events/);
  assert.equal(row(rows, 'extraExemptions').verdict, 'pass');
});

test('a creatorFeeRecipient that is somebody else is a second exempt wallet', () => {
  // The case the array length cannot see: nothing is added to extraExemptions
  // and a second wallet goes tax free anyway.
  const other = '0x' + '11'.repeat(20);
  const rows = checkConfig(clone({ creatorFeeRecipient: other }), CURVE);
  const r = row(rows, 'tax free at launch');
  assert.equal(r.verdict, 'fail');
  assert.equal(r.value, '2 wallets');
  assert.match(r.note, new RegExp(other));
  assert.match(r.note, /would be tax free besides the deployer/);
});

test('a recipient that is somebody else is a second exempt wallet too', () => {
  const other = '0x' + '22'.repeat(20);
  const r = row(checkConfig(clone({ recipient: other }), CURVE), 'tax free at launch');
  assert.equal(r.verdict, 'fail');
  assert.equal(r.value, '2 wallets');
});

test('one extra exempt wallet fails and is counted', () => {
  const rows = checkConfig(clone({ extraExemptions: ['0x' + '11'.repeat(20)] }), CURVE);
  assert.equal(row(rows, 'extraExemptions').verdict, 'fail');
  const r = row(rows, 'tax free at launch');
  assert.equal(r.verdict, 'fail');
  assert.equal(r.value, '2 wallets');
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

// ------------------------------------------------------------- the gateways

const PNG = png(512, 512, 1000);

/** A fake fetch driven by a script of answers per url, with no network and no clock. */
const stub = (script) => {
  const calls = [];
  const waits = [];
  const get = async (url) => {
    calls.push(url);
    const queue = script[gatewayHost(url)];
    const next = Array.isArray(queue) ? queue.shift() : queue;
    if (next === undefined) throw new Error('nothing scripted');
    if (next instanceof Error) throw next;
    return { ok: next === 200, status: next, bytes: next === 200 ? PNG : new Uint8Array() };
  };
  const wait = async (ms) => { waits.push(ms); };
  return { get, wait, calls, waits };
};

test('three gateways, in the order the runbook names them', () => {
  assert.deepEqual([...IPFS_GATEWAYS], [
    'https://ipfs.io/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://dweb.link/ipfs/',
  ]);
  assert.deepEqual(gatewayUrls('ipfs://bafyabc'), [
    'https://ipfs.io/ipfs/bafyabc',
    'https://gateway.pinata.cloud/ipfs/bafyabc',
    'https://dweb.link/ipfs/bafyabc',
  ]);
});

test('an http reference is one url: our gateways would fetch a different thing', () => {
  assert.deepEqual(gatewayUrls('https://example.com/a.png'), ['https://example.com/a.png']);
  assert.deepEqual(gatewayUrls(''), []);
  assert.deepEqual(gatewayUrls('not a reference'), []);
  assert.equal(cidOf('ipfs://ipfs/bafyabc'), 'bafyabc');
  assert.equal(cidOf('https://x/y'), null);
});

test('a busy gateway is retried once, after five seconds', async () => {
  const s = stub({ 'ipfs.io': [429, 200] });
  const got = await fetchLogo('ipfs://bafyabc', s.get, s.wait);
  assert.equal(got.ok, true);
  assert.equal(got.url, 'https://ipfs.io/ipfs/bafyabc');
  assert.deepEqual(s.waits, [GATEWAY_RETRY_MS]);
  assert.equal(GATEWAY_RETRY_MS, 5_000);
  assert.equal(s.calls.length, 2, 'asked the same gateway twice and stopped there');
});

test('every 5xx is retryable, and a 429 is', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [200, 301, 400, 404, 410]) assert.equal(isRetryableStatus(s), false, String(s));
});

test('a gateway that stays busy falls back to pinata', async () => {
  const s = stub({ 'ipfs.io': [503, 503], 'gateway.pinata.cloud': [200] });
  const got = await fetchLogo('ipfs://bafyabc', s.get, s.wait);
  assert.equal(got.ok, true);
  assert.equal(gatewayHost(got.url), 'gateway.pinata.cloud');
  assert.equal(s.waits.length, 1, 'one retry on the busy gateway, not one per attempt');
  assert.match(gatewayNote(got), /answered by gateway\.pinata\.cloud, after ipfs\.io answered 503/);
});

test('and then to dweb, and a logo verified on any of them passes', async () => {
  const s = stub({ 'ipfs.io': [429, 429], 'gateway.pinata.cloud': [500, 500], 'dweb.link': [200] });
  const got = await fetchLogo('ipfs://bafyabc', s.get, s.wait);
  assert.equal(got.ok, true);
  assert.equal(gatewayHost(got.url), 'dweb.link');
  const v = checkImage(imageInfo(got.bytes));
  assert.equal(v.verdict, 'pass', 'a square image under a megabyte is one whoever served it');
  assert.deepEqual(s.waits, [GATEWAY_RETRY_MS, GATEWAY_RETRY_MS]);
});

test('a 404 is not retried: it will not be a different answer in five seconds', async () => {
  const s = stub({ 'ipfs.io': [404], 'gateway.pinata.cloud': [404], 'dweb.link': [404] });
  const got = await fetchLogo('ipfs://bafyabc', s.get, s.wait);
  assert.equal(got.ok, false);
  assert.deepEqual(s.waits, [], 'nothing was waited on');
  assert.equal(s.calls.length, 3, 'one call per gateway');
  assert.match(gatewayNote(got), /no gateway served it: ipfs\.io answered 404/);
});

test('a request that throws is retried too, then falls back', async () => {
  const s = stub({ 'ipfs.io': [new Error('timed out'), new Error('timed out')], 'gateway.pinata.cloud': [200] });
  const got = await fetchLogo('ipfs://bafyabc', s.get, s.wait);
  assert.equal(got.ok, true);
  assert.equal(gatewayHost(got.url), 'gateway.pinata.cloud');
  assert.match(gatewayNote(got), /ipfs\.io did not answer: timed out/);
});

test('the report says which gateway answered, every time', async () => {
  const first = await fetchLogo('ipfs://bafyabc', stub({ 'ipfs.io': [200] }).get, async () => {});
  assert.equal(gatewayNote(first), 'answered by ipfs.io');

  const s = stub({ 'ipfs.io': [429, 500], 'gateway.pinata.cloud': [404], 'dweb.link': [200] });
  const third = await fetchLogo('ipfs://bafyabc', s.get, s.wait);
  const note = gatewayNote(third);
  assert.match(note, /^answered by dweb\.link, after /);
  assert.match(note, /ipfs\.io answered 429/);
  assert.match(note, /gateway\.pinata\.cloud answered 404/);
});

test('every gateway busy is undetermined, not a failed logo', async () => {
  const s = stub({ 'ipfs.io': [503, 503], 'gateway.pinata.cloud': [503, 503], 'dweb.link': [503, 503] });
  const got = await fetchLogo('ipfs://bafyabc', s.get, s.wait);
  assert.equal(got.ok, false);
  assert.equal(got.bytes, null);
  // Six calls: two at each gateway. Nothing is concluded about the image.
  assert.equal(s.calls.length, 6);
  assert.doesNotMatch(gatewayNote(got), /not an image|not square/);
});

test('the attempts are recorded in order, with the retry marked', async () => {
  const s = stub({ 'ipfs.io': [429, 200] });
  const got = await fetchLogo('ipfs://bafyabc', s.get, s.wait);
  assert.deepEqual(got.attempts.map((a) => [gatewayHost(a.url), a.ok, a.status, a.retried]), [
    ['ipfs.io', false, 429, false],
    ['ipfs.io', true, 200, true],
  ]);
});

test('nothing in the gateway reporting says clean, or carries an em dash', async () => {
  const s = stub({ 'ipfs.io': [500, 500], 'gateway.pinata.cloud': [404], 'dweb.link': [200] });
  const note = gatewayNote(await fetchLogo('ipfs://bafyabc', s.get, s.wait));
  assert.doesNotMatch(note, /\bclean\b|\bsafe\b|!/i);
  assert.ok(!note.includes(String.fromCharCode(0x2014)));
});
