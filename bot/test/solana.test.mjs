/**
 * The LaunchLab scan path, on fixtures captured from mainnet.
 *
 * Nothing here touches a network. Every fixture under test/fixtures/solana was
 * read from Solana mainnet on 2026-09-24 and is checked in, so the decoders are
 * tested against bytes the chain actually produced rather than against bytes
 * written to make a decoder pass.
 *
 * See docs/launchlab-scan-spec.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const C = await import('../dist/solana/config.js');
const R = await import('../dist/solana/rpc.js');
const P = await import('../dist/solana/platforms.js');
const E = await import('../dist/solana/extensions.js');
const D = await import('../dist/solana/decode.js');
const S = await import('../dist/solana/seed.js');

const fixture = (f) => JSON.parse(readFileSync(`test/fixtures/solana/${f}`, 'utf8'));
const CONFIGS = fixture('platform-configs.json');
const MINTS = fixture('mints.json');
const CREATIONS = fixture('creations.json');

const account = (m) => ({ data: m.data, owner: m.owner, lamports: m.lamports, executable: false });

/** A distinct, valid-looking pubkey per index, for paging tests. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mintFor = (n) => {
  let s = '';
  let v = n + 1;
  while (s.length < 43) { s += B58[v % 58]; v = Math.floor(v / 58) + 7 + s.length; }
  return s.slice(0, 43);
};

// ------------------------------------------------------------ the pinned set

test('the pinned set is 35 stonkfun configs, and every one is in the fixture', () => {
  assert.equal(C.PINNED_PLATFORMS.length, 35);
  assert.equal(new Set(C.PINNED_PLATFORMS.map((p) => p.pubkey)).size, 35, 'a pubkey is pinned twice');
  const onChain = new Set(CONFIGS.map((c) => c.pubkey));
  for (const p of C.PINNED_PLATFORMS) {
    assert.ok(onChain.has(p.pubkey), `${p.pubkey} is pinned and was not read from chain`);
    assert.ok(C.isPubkey(p.pubkey), p.pubkey);
  }
});

test('every pinned entry records what the config said when it was pinned', () => {
  // Storing the name and the site beside the key is the only thing that can
  // catch a pinned key that starts saying something new.
  for (const c of CONFIGS) {
    const pin = P.pinnedPlatform(c.pubkey);
    assert.ok(pin, c.pubkey);
    assert.equal(pin.name, c.name, `${c.pubkey} was pinned with a different name`);
    assert.equal(pin.site, c.site, `${c.pubkey} was pinned with a different site`);
  }
});

test('every config on chain is owned by launchlab, 944 bytes, one discriminator', () => {
  for (const c of CONFIGS) {
    assert.equal(c.owner, C.LAUNCHLAB_PROGRAM, c.pubkey);
    assert.equal(c.len, C.PLATFORM_CONFIG_SIZE, c.pubkey);
    assert.equal(c.disc, C.PLATFORM_CONFIG_DISCRIMINATOR, c.pubkey);
  }
});

test('a config decodes only when the size and the discriminator both match', () => {
  const good = Buffer.alloc(C.PLATFORM_CONFIG_SIZE);
  Buffer.from(C.PLATFORM_CONFIG_DISCRIMINATOR, 'hex').copy(good, 0);
  good.write('StonkFun', C.PLATFORM_NAME_AT);
  good.write('https://www.stonkfun.xyz', C.PLATFORM_SITE_AT);
  const at = C.PINNED_PLATFORMS[0].pubkey;
  assert.deepEqual(P.decodePlatformConfig(at, good),
    { pubkey: at, name: 'StonkFun', site: 'https://www.stonkfun.xyz' });

  // Right size, wrong discriminator: two plausible strings that mean nothing.
  const wrongDisc = Buffer.from(good);
  wrongDisc.write('deadbeefdeadbeef', 0, 'hex');
  assert.equal(P.decodePlatformConfig(at, wrongDisc), null);

  // Right discriminator, wrong size.
  assert.equal(P.decodePlatformConfig(at, good.subarray(0, 900)), null);
});

test('the strings are fixed width and NUL padded, not length prefixed', () => {
  // Read as length prefixed, the name would come out empty and the site would
  // come out shifted. Both produce output rather than an error, which is why
  // this is asserted against real bytes.
  const b = Buffer.alloc(C.PLATFORM_CONFIG_SIZE);
  Buffer.from(C.PLATFORM_CONFIG_DISCRIMINATOR, 'hex').copy(b, 0);
  b.write('Ab', C.PLATFORM_NAME_AT);
  b.write('https://x.test', C.PLATFORM_SITE_AT);
  const got = P.decodePlatformConfig(C.PINNED_PLATFORMS[0].pubkey, b);
  assert.equal(got.name, 'Ab', 'a trailing NUL was read as part of the name');
  assert.equal(got.site, 'https://x.test');
});

// -------------------------------------------------------------- the diff

/** The configs exactly as they were pinned. */
const asPinned = () => C.PINNED_PLATFORMS.map((p) => ({ pubkey: p.pubkey, name: p.name, site: p.site }));

test('the pinned set against itself has no drift', () => {
  assert.deepEqual(P.diffPlatforms(asPinned()), []);
});

test('a pinned key that disappears is reported, loudly', () => {
  const short = asPinned().slice(1);
  const drift = P.diffPlatforms(short);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, 'disappeared');
  assert.equal(drift[0].pubkey, C.PINNED_PLATFORMS[0].pubkey);
  assert.match(P.driftLines(drift)[0], /DISAPPEARED/);
});

test('a pinned key that starts saying something new is reported as renamed', () => {
  // The case an allowlist misses entirely: membership was decided by the key,
  // so this passes every membership check there is.
  const moved = asPinned();
  moved[2] = { ...moved[2], name: 'StonkFun Official', site: 'https://stonkfun.io' };
  const drift = P.diffPlatforms(moved);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, 'renamed');
  assert.deepEqual(drift[0].was, { name: 'StonkFun', site: 'https://www.stonkfun.xyz' });
  assert.deepEqual(drift[0].now, { name: 'StonkFun Official', site: 'https://stonkfun.io' });
  const line = P.driftLines(drift)[0];
  assert.match(line, /RENAMED/);
  assert.match(line, /passes every membership check/);
});

test('a site change alone is a rename, because the site is the copied field', () => {
  const moved = asPinned();
  moved[0] = { ...moved[0], site: 'https://www.stonkfun.xyz/' };
  assert.equal(P.diffPlatforms(moved)[0].kind, 'renamed');
});

test('an unpinned config carrying a pinned site is reported and never added', () => {
  const extra = [...asPinned(), {
    pubkey: 'So11111111111111111111111111111111111111112',
    name: 'StonkFun', site: 'https://www.stonkfun.xyz',
  }];
  const drift = P.diffPlatforms(extra);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, 'appeared');
  assert.match(P.driftLines(drift)[0], /review and pin by hand/);
  assert.match(P.driftLines(drift)[0], /the site string is not evidence/);
  // And it is still not a platform.
  assert.equal(P.pinnedPlatform('So11111111111111111111111111111111111111112'), null);
  assert.equal(C.PINNED_PLATFORMS.length, 35, 'the diff added to the pinned set');
});

test('an unpinned config with an unrelated site is not even reported', () => {
  const extra = [...asPinned(), {
    pubkey: 'So11111111111111111111111111111111111111112',
    name: 'Something Else', site: 'https://elsewhere.test',
  }];
  assert.deepEqual(P.diffPlatforms(extra), []);
});

test('a read that fails is not agreement: startupDiff returns null and says so', async () => {
  const said = [];
  const drift = await P.startupDiff(
    { fetchImpl: async () => { throw new Error('nope'); }, tries: 1, sleep: async () => {} },
    (s) => said.push(s),
  );
  assert.equal(drift, null, 'an unread set must not read as no drift');
  assert.match(said.join('\n'), /could not be read, so it was not checked/);
});

// --------------------------------------------------- rendering a platform

test('a pinned config renders as the platform we named it', () => {
  const label = P.platformLabel(C.PINNED_PLATFORMS[0].pubkey);
  assert.equal(label.text, 'StonkFun');
  assert.equal(label.recognised, true);
});

test('an unpinned config renders as its pubkey and never as its own name', () => {
  const impostor = { pubkey: 'So11111111111111111111111111111111111111112', name: 'StonkFun', site: 'https://www.stonkfun.xyz' };
  const label = P.platformLabel(impostor.pubkey, impostor);
  assert.equal(label.recognised, false);
  assert.equal(label.platform, null);
  assert.match(label.text, /platform not recognised/);
  assert.ok(label.text.includes(impostor.pubkey));
  // The name it chose for itself appears nowhere, in any position.
  assert.ok(!label.text.includes('StonkFun'), label.text);
});

test('something that is not a pubkey is not rendered as one', () => {
  for (const bad of ['', 'not a key', '0x' + 'a'.repeat(40), 'l'.repeat(50)]) {
    const label = P.platformLabel(bad);
    assert.equal(label.recognised, false);
    assert.match(label.text, /platform not recognised/);
  }
});

test('the discriminator encodes to the base58 a memcmp filter takes', () => {
  const b58 = P.base58OfDiscriminator();
  assert.match(b58, /^[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(P.base58OfDiscriminator('00'), '1');
  assert.equal(P.base58OfDiscriminator('0000'), '11');
});

// ------------------------------------------------------------ the mints

test('every launched mint reads as token-2022, 1e9 supply at 6 decimals, no authorities', () => {
  for (const k of ['launch-bayc-standard', 'launch-suit-reward', 'launch-opus-standard']) {
    const r = E.decodeMint(MINTS[k].mint, account(MINTS[k]));
    assert.ok(r, k);
    assert.equal(r.program, 'token-2022', k);
    assert.equal(r.decimals, 6, k);
    assert.equal(r.supply, 1_000_000_000_000_000n, k);
    assert.equal(r.mintAuthority, null, `${k} kept a mint authority`);
    assert.equal(r.freezeAuthority, null, `${k} kept a freeze authority`);
  }
});

test('a reward launch carries a transfer fee and a standard launch carries none', () => {
  const reward = E.decodeMint(MINTS['launch-suit-reward'].mint, account(MINTS['launch-suit-reward']));
  assert.ok(reward.transferFee, 'the reward launch lost its transfer fee');
  assert.equal(reward.transferFee.basisPoints, 300);
  // Set at launch and still changeable by the platform afterwards.
  assert.equal(reward.transferFee.configAuthority, C.LAUNCHLAB_AUTHORITY);
  // The cap is the whole supply, which is to say uncapped.
  assert.equal(reward.transferFee.maximumFee, 1_000_000_000_000_000n);

  for (const k of ['launch-bayc-standard', 'launch-opus-standard']) {
    assert.equal(E.decodeMint(MINTS[k].mint, account(MINTS[k])).transferFee, null, k);
  }
});

test('the fee is read from the right offsets, which a COption read would not be', () => {
  // The authorities are OptionalNonZeroPubkey, 32 bytes, not a 4 byte tagged
  // COption. Read as a COption the rates come out as 5544 and 42922 basis
  // points: numbers, printable, and not rates.
  for (const [k, m] of Object.entries(MINTS)) {
    const fee = E.decodeMint(m.mint, account(m))?.transferFee;
    if (!fee) continue;
    assert.ok(fee.basisPoints >= 0 && fee.basisPoints <= 10_000,
      `${k} read ${fee.basisPoints} basis points, which is not a rate`);
    assert.ok(fee.older.basisPoints <= 10_000 && fee.newer.basisPoints <= 10_000, k);
  }
});

test('a scheduled rate change is two rates, and which one is live depends on the epoch', () => {
  // The prestock quotes carry an older 50 bps and a newer 100 bps. Printing
  // the newer unconditionally states next epoch's rate as today's.
  const a = E.decodeMint(MINTS['quote-anthropic'].mint, account(MINTS['quote-anthropic'])).transferFee;
  assert.equal(a.older.basisPoints, 50);
  assert.equal(a.newer.basisPoints, 100);
  assert.ok(a.newer.epoch > a.older.epoch);
  assert.equal(E.feeAtEpoch(a, a.older.epoch), 50);
  assert.equal(E.feeAtEpoch(a, a.newer.epoch - 1n), 50);
  assert.equal(E.feeAtEpoch(a, a.newer.epoch), 100);
  assert.equal(E.feeAtEpoch(a, a.newer.epoch + 10n), 100);
});

test('the quote assets read as the spec recorded them', () => {
  const read = (k) => E.decodeMint(MINTS[k].mint, account(MINTS[k]));
  const anthropic = read('quote-anthropic');
  assert.deepEqual(anthropic.flagged, ['permanentDelegate', 'pausableConfig']);
  assert.ok(anthropic.freezeAuthority, 'ANTHROPIC lost its freeze authority');
  assert.ok(anthropic.mintAuthority);

  const prestock = read('quote-openai-prestock');
  assert.deepEqual(prestock.flagged, ['permanentDelegate', 'pausableConfig']);

  // The same symbol, a different mint, and a different set of powers. This is
  // why the quote is named by mint everywhere.
  const tessera = read('quote-openai-tessera');
  assert.deepEqual(tessera.flagged, []);
  assert.notEqual(tessera.mint, prestock.mint);

  const pump = read('quote-pump');
  assert.deepEqual(pump.flagged, []);
  assert.ok(pump.extensions.includes('transferHook'));
  assert.equal(pump.freezeAuthority, null);
});

test('a legacy token mint reads without extensions rather than failing', () => {
  const usdc = E.decodeMint(MINTS['quote-usdc'].mint, account(MINTS['quote-usdc']));
  assert.equal(usdc.program, 'token');
  assert.deepEqual(usdc.extensions, []);
  assert.equal(usdc.transferFee, null);
  assert.ok(usdc.freezeAuthority);
});

test('bytes that are not a mint decode to null rather than to a mint of zeroes', () => {
  assert.equal(E.decodeMint('x', { data: Buffer.alloc(10).toString('base64'), owner: C.TOKEN_PROGRAM, lamports: 0, executable: false }), null);
  assert.equal(E.decodeMint('x', { data: Buffer.alloc(200).toString('base64'), owner: 'SomeOtherProgram11111111111111111111111111', lamports: 0, executable: false }), null);
});

test('freeze is a fact, permanent delegate and pausable are flags', () => {
  const anthropic = E.decodeMint(MINTS['quote-anthropic'].mint, account(MINTS['quote-anthropic']));
  const { facts, flags } = E.quoteLines(anthropic.mint, anthropic);
  assert.ok(facts.some((f) => /freeze authority: yes/.test(f)), facts.join('|'));
  assert.ok(!flags.some((f) => /freeze/.test(f)), 'a freeze authority was rendered as a flag');
  assert.equal(flags.length, 2);
  assert.match(flags.join('\n'), /permanent delegate: the issuer can move this asset out of any wallet/);
  assert.match(flags.join('\n'), /pausable: the issuer can stop this asset moving/);
  // Named by mint, every time.
  assert.ok(facts[0].includes(anthropic.mint));
});

test('a quote that could not be read says so instead of saying nothing', () => {
  const { facts, flags } = E.quoteLines('SomeMint', null, 'http 503');
  assert.deepEqual(flags, []);
  assert.match(facts[0], /could not be read, undetermined, http 503/);
});

// ------------------------------------------------- the creation transaction

test('all three creation shapes decode, and name the platform from account 3', () => {
  for (const [k, tx] of Object.entries(CREATIONS)) {
    const r = D.decodeCreation(tx);
    assert.ok(r.ok, `${k}: ${r.ok ? '' : r.reason}`);
    assert.equal(r.value.baseMint, tx.mint, k);
    assert.equal(r.value.supply, 1_000_000_000_000_000n, k);
    assert.equal(r.value.decimals, 6, k);
    assert.ok(r.value.logged.includes('InitializeWithToken2022'), k);
    assert.equal(P.platformLabel(r.value.platformConfig).text, 'StonkFun', k);
  }
});

test('a dev buy in the same transaction is read exactly, and its absence is not a guess', () => {
  const opus = D.decodeCreation(CREATIONS['opus-standard']).value;
  assert.equal(opus.devBuy.sameTransaction, true);
  assert.equal(opus.devBuy.pctOfSupply, 2.6202);
  assert.match(D.devBuyLine(opus), /2\.6202% of supply, in the creation transaction/);

  const bayc = D.decodeCreation(CREATIONS['bayc-standard']).value;
  assert.equal(bayc.devBuy.sameTransaction, false);
  assert.equal(bayc.devBuy.pctOfSupply, 0);
  assert.match(D.devBuyLine(bayc), /none in the creation transaction/);
});

test('the dev buy line says which transaction it was in, because that is the distinction', () => {
  // A buy in the same transaction was made by the creator as part of creating.
  // A buy in the same slot was made by somebody who saw the creation land, and
  // nothing in this transaction can tell them apart, so the line says which
  // one it is measuring rather than leaving the reader to assume.
  for (const tx of Object.values(CREATIONS)) {
    const line = D.devBuyLine(D.decodeCreation(tx).value);
    assert.match(line, /creation transaction/, line);
  }
});

test('the quote mint is read positionally and is the mint the launch pairs against', () => {
  const byName = {
    'bayc-standard': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'opus-standard': 'Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw',
  };
  for (const [k, mint] of Object.entries(byName)) {
    assert.equal(D.decodeCreation(CREATIONS[k]).value.quoteMint, mint, k);
  }
});

test('a failed transaction, a foreign transaction and a short one are refused by reason', () => {
  const good = CREATIONS['bayc-standard'];
  assert.match(D.decodeCreation({ ...good, meta: { ...good.meta, err: { InstructionError: [0, 'x'] } } }).reason,
    /failed on chain/);
  assert.match(D.decodeCreation({ transaction: { message: { instructions: [] } }, meta: {} }).reason,
    /no launchlab initialize instruction/);
  assert.match(D.decodeCreation({}).reason, /no transaction message/);

  // An initialize whose accounts are too few to hold a quote mint. Reading it
  // positionally anyway would name a platform out of whatever was at index 3.
  const short = JSON.parse(JSON.stringify(good));
  const ix = short.transaction.message.instructions.find((i) => i.programId === C.LAUNCHLAB_PROGRAM);
  ix.accounts = ix.accounts.slice(0, 4);
  assert.match(D.decodeCreation(short).reason, /carries 4 accounts/);
});

test('an initialize whose positional accounts are not pubkeys is refused', () => {
  const bad = JSON.parse(JSON.stringify(CREATIONS['bayc-standard']));
  const ix = bad.transaction.message.instructions.find((i) => i.programId === C.LAUNCHLAB_PROGRAM);
  ix.accounts[D.IX_PLATFORM_CONFIG] = 'not-a-pubkey';
  assert.match(D.decodeCreation(bad).reason, /platform config is not a pubkey/);
});

test('base58 decoding round trips, and refuses characters that are not in the alphabet', () => {
  assert.equal(D.bs58Decode('1').toString('hex'), '00');
  assert.equal(D.bs58Decode('0'), null, '0 is not in the base58 alphabet');
  assert.equal(D.bs58Decode('O'), null);
  assert.equal(D.bs58Decode(''), null);
  const disc = D.bs58Decode(
    CREATIONS['bayc-standard'].transaction.message.instructions
      .find((i) => i.programId === C.LAUNCHLAB_PROGRAM).data,
  );
  assert.equal(disc.subarray(0, 8).toString('hex'), D.INITIALIZE_WITH_TOKEN_2022);
});

// ------------------------------------------------------------- the rpc

test('with no endpoint configured every read is undetermined and names the variable', async () => {
  const had = process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_RPC_URL;
  try {
    assert.equal(C.solanaRpcUrl(), null);
    assert.equal(R.rpcConfigured().ok, false);
    const r = await R.rpc('getSlot', []);
    assert.equal(r.ok, false);
    assert.match(r.reason, /SOLANA_RPC_URL is not set/);
  } finally {
    if (had === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = had;
  }
});

test('a rate limit is retried and a refusal is not', async () => {
  process.env.SOLANA_RPC_URL = 'https://rpc.test/key';
  try {
    let calls = 0;
    const limited = async () => {
      calls++;
      return calls < 3
        ? new Response('slow down', { status: 429 })
        : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }), { status: 200 });
    };
    const ok = await R.rpc('getSlot', [], { fetchImpl: limited, sleep: async () => {} });
    assert.deepEqual(ok, { ok: true, value: 7 });
    assert.equal(calls, 3);

    // "Indexed requests require a personal token" is a permanent no on a
    // public endpoint. Retrying it just spends four requests to hear it again.
    let tried = 0;
    const refused = async () => {
      tried++;
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, error: { message: 'Indexed requests require a personal token' },
      }), { status: 200 });
    };
    const no = await R.rpc('getProgramAccounts', [], { fetchImpl: refused, sleep: async () => {} });
    assert.equal(no.ok, false);
    assert.match(no.reason, /personal token/);
    assert.equal(tried, 1, 'a permanent refusal was retried');
  } finally {
    delete process.env.SOLANA_RPC_URL;
  }
});

test('a short getMultipleAccounts page is an error, not a silent shift', async () => {
  process.env.SOLANA_RPC_URL = 'https://rpc.test/key';
  try {
    const short = async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { value: [null] },
    }), { status: 200 });
    const r = await R.getAccounts(['a', 'b', 'c'], { fetchImpl: short, sleep: async () => {} });
    assert.equal(r.ok, false);
    assert.match(r.reason, /returned 1 of 3/);
  } finally {
    delete process.env.SOLANA_RPC_URL;
  }
});

// ------------------------------------------------------------ the seed

const API = fixture('stonkfun-api.json');

test('the listing is the endpoint the site itself uses, not /api/tokens', () => {
  // /api/tokens answers 200 with an empty array and appears nowhere in the
  // site's own bundle. It was never the listing.
  assert.match(S.ENDPOINTS.listing, /\/api\/platform-pools$/);
  assert.match(S.ENDPOINTS.recent, /\/api\/recent-launches$/);
  assert.equal(S.parsePage(API.tokensVestigial).empty, true);
});

test('a listing page parses into rows, and a row with no mint is dropped', () => {
  const page = S.parsePage(API.platformPools);
  assert.equal(page.ok, true);
  assert.equal(page.tokens.length, API.platformPools.pools.length);
  for (const t of page.tokens) {
    assert.ok(C.isPubkey(t.mint), t.mint);
    assert.ok(t.quoteMint === null || C.isPubkey(t.quoteMint));
  }
  const dropped = S.parsePage({ pools: [{ name: 'no mint' }, { mint: 'not-a-pubkey' }] });
  assert.deepEqual(dropped.tokens, []);
  assert.equal(dropped.rows, 2, 'the rows the server sent are still counted');
});

test('a price and a price direction never leave the boundary', () => {
  // The fixture carries priceUsd and priceChange24h on purpose. A fixture
  // without them could not prove they are dropped.
  const raw = API.platformPools.pools[0];
  assert.ok('priceUsd' in raw, 'the fixture lost the field this test exists for');
  assert.ok('priceChange24h' in raw, 'the fixture lost the direction field');

  for (const t of S.parsePage(API.platformPools).tokens) {
    for (const key of Object.keys(t)) {
      assert.doesNotMatch(key, /price/i, `${key} reached the store`);
    }
    for (const refused of S.REFUSED_FIELDS) {
      assert.ok(!(refused in t), `${refused} reached the store`);
    }
  }
});

test('the quantities that are allowed are kept', () => {
  const t = S.parsePage(API.platformPools).tokens[0];
  // Market cap, FDV, volume and the peak are quantities. The distinction from
  // a price was decided before this was built and is kept here.
  for (const k of ['marketCapUsd', 'fdvUsd', 'volume24hUsd', 'peakMarketCapUsd']) {
    assert.ok(typeof t[k] === 'number' || t[k] === null, k);
  }
});

test('everything the platform asserts is named as a claim', () => {
  const t = S.parsePage(API.platformPools).tokens[0];
  // The quote category, the verification, the launch mode and the transfer tax
  // are all the platform's to decide, and every one of them is readable or
  // checkable against chain. Naming them the same as a reading would lose the
  // ability to notice a disagreement.
  for (const k of ['claimedQuoteSymbol', 'claimedQuoteCategory', 'claimedQuoteVerification',
    'claimedRewardLaunch', 'claimedTransferTaxBps']) {
    assert.ok(k in t, k);
  }
  assert.equal(t.claimedQuoteSymbol, API.platformPools.pools[0].quoteSymbol);
});

test('the platform disagreeing with the mint about the tax is a finding, not a correction', () => {
  assert.equal(S.taxClaimLine(100, 100), null, 'agreement is not a line');
  assert.equal(S.taxClaimLine(null, 300), null, 'an unread rate is not a disagreement');
  assert.equal(S.taxClaimLine(300, null), null);
  const line = S.taxClaimLine(100, 300);
  assert.match(line, /the platform lists a transfer tax of 100 bps and the mint carries 300 bps/);
  // It states both and corrects neither: we do not know which is wrong.
  assert.doesNotMatch(line, /wrong|incorrect|lying|actually/i);
});

test('the quote catalogue parses, and its category is a claim too', async () => {
  const serve = async () => new Response(JSON.stringify(API.quoteTokens), { status: 200 });
  const r = await S.quoteCatalogue({ fetchImpl: serve });
  assert.equal(r.ok, true);
  assert.equal(r.quotes.length, API.quoteTokens.quoteTokens.length);
  for (const q of r.quotes) {
    assert.ok(C.isPubkey(q.quoteMint));
    assert.ok('claimedCategory' in q && 'claimedLaunchLabReady' in q);
  }
});

test('the live window is not treated as a page of history', async () => {
  const serve = async () => new Response(JSON.stringify(API.recentLaunches), { status: 200 });
  const r = await S.recentLaunches({ fetchImpl: serve });
  assert.equal(r.ok, true);
  // It carries a window rather than a cursor, which is what makes it a feed.
  assert.ok(typeof r.windowMs === 'number' || r.windowMs === null);
  assert.ok(r.tokens.length > 0);
});

test('paging asks for page and nothing else, because nothing else does anything', async () => {
  // limit, offset and cursor are all accepted and all ignored by the listing.
  const asked = [];
  const serve = async (url) => {
    asked.push(url);
    return new Response(JSON.stringify({ pools: [] }), { status: 200 });
  };
  await S.listingPage(7, { fetchImpl: serve });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\/api\/platform-pools\?page=7$/);
  assert.doesNotMatch(asked[0], /limit|offset|cursor/);
});

test('paging stops on a listing that ignores its page parameter', async () => {
  // Observed behaviour if the wrong key is used: page one, forever.
  const same = async () => new Response(JSON.stringify({
    pools: Array.from({ length: S.PAGE_SIZE }, (_, i) => ({
      mint: C.PINNED_PLATFORMS[i % 35].pubkey, name: `t${i}`,
    })),
  }), { status: 200 });
  const r = await S.seed({ fetchImpl: same, pages: 50 });
  assert.match(r.stopped, /repeated a page/);
  assert.ok(r.pagesRead <= 2, `paged ${r.pagesRead} times against a listing that never moved`);
});

test('a short page is the last page, which is how the listing ends', async () => {
  // The last page was observed returning a short page rather than an empty one,
  // so neither empty nor short alone is a reliable end on its own.
  let page = 0;
  const serve = async () => {
    page++;
    const n = page < 3 ? S.PAGE_SIZE : 10;
    return new Response(JSON.stringify({
      pools: Array.from({ length: n }, (_, i) => ({ mint: mintFor(page * 100 + i) })),
    }), { status: 200 });
  };
  const r = await S.seed({ fetchImpl: serve, pages: 50 });
  assert.equal(r.pagesRead, 3);
  assert.match(r.stopped, /short page, which is its last/);
  assert.equal(r.tokens.length, S.PAGE_SIZE * 2 + 10);
});

test('a listing that answers with nothing says that, and is not a failure', async () => {
  const empty = async () => new Response(JSON.stringify({ pools: [] }), { status: 200 });
  const r = await S.seed({ fetchImpl: empty });
  assert.deepEqual(r.tokens, []);
  assert.match(r.stopped, /no rows at all/);
});

test('an http error stops the walk and keeps what it already had', async () => {
  let n = 0;
  const flaky = async () => {
    n++;
    return n === 1
      ? new Response(JSON.stringify({
          pools: Array.from({ length: S.PAGE_SIZE }, (_, i) => ({ mint: mintFor(i) })),
        }), { status: 200 })
      : new Response('nope', { status: 503 });
  };
  const r = await S.seed({ fetchImpl: flaky, pages: 10 });
  assert.equal(r.tokens.length, S.PAGE_SIZE);
  assert.equal(r.pagesRead, 1);
  assert.match(r.stopped, /http 503/);
});

test('a response that is not a listing is a reason, not an empty page', () => {
  assert.equal(S.parsePage({}).ok, false);
  assert.match(S.parsePage('<!doctype html>').reason, /no pools array/);
});

test('metadata missing is undetermined, and never a launch that does not exist', () => {
  assert.match(S.metadataLine(null), /not in the platform listing, undetermined/);
  assert.match(S.metadataLine({ mint: 'x', name: 'Bored Apes', symbol: 'BAYC' }),
    /name: Bored Apes \(BAYC\), as the platform lists it/);
});

// --------------------------------------------------------- the house rules

test('nothing in this path says clean, safe, or anything like a verdict', () => {
  const said = [
    ...P.driftLines(P.diffPlatforms(asPinned().slice(1))),
    P.platformLabel('So11111111111111111111111111111111111111112').text,
    D.devBuyLine(D.decodeCreation(CREATIONS['bayc-standard']).value),
    ...E.quoteLines('x', null, 'http 503').facts,
    ...E.quoteLines(MINTS['quote-anthropic'].mint,
      E.decodeMint(MINTS['quote-anthropic'].mint, account(MINTS['quote-anthropic']))).flags,
    S.metadataLine(null),
    S.taxClaimLine(100, 300),
    C.NO_RPC_REASON,
    C.UNRECOGNISED,
  ];
  for (const line of said) {
    assert.doesNotMatch(line, /\bclean\b|\bsafe\b|\blooks good\b|\bverdict\b|\bscore\b/i, line);
    assert.doesNotMatch(line, /!/, line);
    assert.ok(!line.includes(String.fromCharCode(0x2014)), line);
  }
});

test('the observation floor is the same one the pons path uses', () => {
  assert.equal(C.MIN_OBSERVATIONS, 30);
});
