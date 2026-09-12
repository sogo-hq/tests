/**
 * The v1 contract.
 *
 * The shape here is committed to a partner who is building against it, so these
 * tests are the contract rather than a description of the code. Two of them are
 * load-bearing and are the reason the API exists in this form at all:
 *
 *   nothing in any response is a score, a grade, a verdict or a "safe" field
 *   an undetermined check never carries a value, and "none" is never called clean
 *
 * Both are swept over every response rather than asserted per endpoint, because
 * the way a verdict field gets added is that somebody adds it to one response.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('api');
process.env.API_KEYS = 'pub-key:public,partner-key:partner';
process.env.API_PUBLIC_URL = 'https://api.checkvitals.xyz';

const T = await import('../dist/api/types.js');
const A = await import('../dist/api/auth.js');
const H = await import('../dist/api/handlers.js');
const { openapiDocument } = await import('../dist/api/openapi.js');
const { toApiLaunch } = await import('../dist/api/map.js');
const { db } = await import('../dist/db.js');
const { computeFlags } = await import('../dist/metrics/flags.js');
const { recordIndexAdvance } = await import('../dist/indexer/health.js');
const { makeScan } = await import('./fixtures.mjs');

const TOKEN = '0x147bbaa458ab7cd11e1e478b87f08fe5a42a9e67';
const CURVE = '0x0000000000000000000000000000000000000002';
const DEP = '0x0000000000000000000000000000000000000003';
const PAIR = '0x' + 'e'.repeat(40);
const NOW = 1_789_000_000_000;

// A populated index so the checks have baselines and the negatives are not
// withheld: an API answer full of "undetermined" would test nothing.
const insert = db.prepare(
  `INSERT OR REPLACE INTO launches (token, curve, deployer, pair_token, launch_config_id,
     graduation_threshold, block_number, tx_hash, launched_at, name, symbol, name_key,
     symbol_key, snipe_exemption_count, exemption_source, creator_tax_bps,
     exempt_open_pct, creator_open_pct)
   VALUES (?,?,?,?,1,'4200000000000000000',?,?,?,?,?,?,?,?,'logs',?,?,?)`,
);
for (let i = 0; i < 1500; i++) {
  const a = '0x' + i.toString(16).padStart(40, '0');
  insert.run(a, CURVE, a, PAIR, 1000 + i, '0x' + i.toString(16).padStart(64, '0'),
    1_780_000_000, 'n' + i, i < 60 ? 'DUPE' : 's' + i, 'n' + i, i < 60 ? 'dupe' : 's' + i,
    1, 100, 0.5, 0.5);
}
insert.run(TOKEN, CURVE, DEP, PAIR, 900_000, '0x' + 'f'.repeat(64), 1_780_000_000,
  'Ghats', 'DUPE', 'ghats', 'dupe', 5, 400, 22.3, 4.9);
recordIndexAdvance(1n);

const flags = computeFlags({
  token: TOKEN, deployer: DEP, name: 'Ghats', symbol: 'DUPE',
  creatorTaxBps: 400, buybackEnabled: false, pairToken: PAIR, pairSymbol: 'ETH',
  scannedAt: 1_780_003_600,
  concentration: { top5Share: 61, top1Share: 34, holders: 412, circulating: 1000n },
});

const scan = () => {
  const r = makeScan({ buyers: 412, mcapInQuote: 1.68, benchmarkMedian: 12, benchmarkN: 1837 });
  r.flags = flags;
  r.reads.token = TOKEN;
  r.reads.curve = CURVE;
  r.reads.deployer = DEP;
  r.reads.pairToken = PAIR;
  r.reads.symbol = 'DUPE';
  r.launchBlock = 900_000;
  return r;
};

const launch = () => toApiLaunch(scan(), new Date(NOW));

// ------------------------------------------------------- the two guarantees

/**
 * Every key name in a response, however deep.
 *
 * The sweep is over KEYS rather than values because a verdict arrives as a
 * field: nobody adds `"grade": "B"` to a design that forbids grades, they add
 * `"risk_level"` to one endpoint and it spreads.
 */
function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

const VERDICT_WORDS = [
  /score/i, /grade/i, /rating/i, /rank(?!ed_by)/i, /verdict/i, /risk/i,
  /\bsafe\b/i, /safety/i, /trust/i, /confidence/i, /recommend/i, /advice/i,
  /\bgood\b/i, /\bbad\b/i, /rug/i, /scam/i, /legit/i, /quality/i, /tier(?!$)/i,
];

async function everyResponse() {
  H.resetApiCache();
  return {
    'GET /v1/launch/{address}': launch(),
    'POST /v1/launches': [
      { address: TOKEN, ok: true, launch: launch() },
      { address: '0xdead', ok: false, error: { error: 'not_a_pons_v2_launch', resolved_as: null } },
    ],
    'GET /v1/stats': H.getStats(NOW).body,
    'GET /v1/health': (await H.getHealth(NOW)).body,
    'GET /v1/openapi.json': openapiDocument(),
  };
}

test('no response carries a score, a grade, a verdict or a risk level', async () => {
  for (const [route, body] of Object.entries(await everyResponse())) {
    for (const key of allKeys(body)) {
      for (const re of VERDICT_WORDS) {
        assert.doesNotMatch(key, re, `${route} carries a field named "${key}"`);
      }
    }
  }
});

test('no response VALUE reads as a verdict either', async () => {
  // The openapi document is excluded from the value sweep: it DESCRIBES the
  // guarantee, so it necessarily contains the words "no score" and "risk
  // level", and banning them there would ban stating the rule.
  const responses = await everyResponse();
  delete responses['GET /v1/openapi.json'];
  const flat = JSON.stringify(responses);
  for (const re of [/\bis safe\b/i, /\blooks good\b/i, /\ball clear\b/i, /\bclean\b/i,
    /\bsafe to\b/i, /\bgood entry\b/i, /\bwill pump\b/i]) {
    assert.doesNotMatch(flat, re, `a response value reads as a verdict: ${re}`);
  }
});

test('state is exactly one of three words, on every check', () => {
  const states = new Set(launch().checks.map((c) => c.state));
  for (const s of states) {
    assert.ok(['finding', 'undetermined', 'none'].includes(s), `unknown state "${s}"`);
  }
  // And all three are reachable, or the enum is decorative.
  assert.ok(states.has('finding'), 'the fixture produced no finding');
  assert.ok(states.has('none'), 'the fixture produced no "none"');
});

test('an undetermined check never carries a value', () => {
  const l = toApiLaunch((() => {
    // A scan with nothing decoded: every index-backed check comes back
    // undetermined, which is the state this guarantee is about.
    const r = makeScan({ windowIndexed: false });
    r.flags = computeFlags({
      token: '0x' + '2'.repeat(40), deployer: '0x' + '3'.repeat(40),
      name: null, symbol: null, creatorTaxBps: 0, buybackEnabled: false,
      pairToken: PAIR, pairSymbol: 'ETH', scannedAt: 1_780_003_600,
    });
    r.reads.token = '0x' + '2'.repeat(40);
    return r;
  })(), new Date(NOW));

  const undetermined = l.checks.filter((c) => c.state === 'undetermined');
  assert.ok(undetermined.length > 0, 'the fixture produced no undetermined check');
  for (const c of undetermined) {
    assert.equal(c.value, null, `${c.id} is undetermined and carries a value: ${c.value}`);
    assert.equal(c.reference, null, `${c.id} is undetermined and carries a reference`);
  }
});

test('"none" is never described as clean', () => {
  for (const c of launch().checks.filter((x) => x.state === 'none')) {
    for (const re of [/\bclean\b/i, /\bsafe\b/i, /\ball clear\b/i, /\bno issues\b/i, /\bpassed\b/i]) {
      assert.doesNotMatch(c.headline, re, `${c.id} describes a "none" as clean: "${c.headline}"`);
    }
  }
});

test('every check carries the source it was read from', () => {
  for (const c of launch().checks) {
    assert.ok(typeof c.source === 'string' && c.source.length > 8,
      `${c.id} has no usable source: ${JSON.stringify(c.source)}`);
  }
  // And the source distinguishes the two ways the exemption count is read,
  // because they are different quantities.
  const ex = launch().checks.find((c) => c.id === 'snipe_tax_exemptions');
  assert.match(ex.source, /SnipeTaxExempted/);
});

// ------------------------------------------------------------------- the ids

test('the committed check ids are all published', () => {
  const ids = new Set(launch().checks.map((c) => c.id));
  for (const id of T.COMMITTED_CHECK_IDS) {
    assert.ok(ids.has(id), `the committed id "${id}" is not published`);
  }
  assert.equal(T.COMMITTED_CHECK_IDS.length, 9);
});

test('no check is published under an id that was never committed', () => {
  const known = new Set([...T.COMMITTED_CHECK_IDS, ...T.ADDITIONAL_CHECK_IDS]);
  for (const c of launch().checks) {
    assert.ok(known.has(c.id), `"${c.id}" is published and is on neither list`);
  }
});

test('the committed ids are exactly the nine that were promised', () => {
  // Spelled out rather than derived: this test exists to fail if somebody
  // renames one, and deriving the expectation from the code being tested
  // would make it pass through the rename.
  assert.deepEqual([...T.COMMITTED_CHECK_IDS], [
    'snipe_tax_exemptions', 'creator_opening_buy', 'deployer_history',
    'ticker_collision', 'ticker_vs_pair', 'creator_tax', 'buyback_vesting',
    'pair_asset', 'holder_concentration',
  ]);
});

// ----------------------------------------------------------------- the shape

test('the response has the committed top-level shape', () => {
  const l = launch();
  assert.deepEqual(Object.keys(l).sort(), [
    'age_seconds', 'as_of', 'chain', 'checks', 'index', 'launch_block',
    'launch_tx', 'launchpad', 'pair', 'summary', 'symbol', 'token',
  ]);
  assert.equal(l.chain, 4663);
  assert.equal(l.launchpad, 'pons_v2');
  assert.equal(l.token, TOKEN);
  assert.equal(l.launch_block, 900_000);
  assert.equal(l.launch_tx, '0x' + 'f'.repeat(64));
  assert.deepEqual(Object.keys(l.pair).sort(), ['address', 'asset']);
  assert.deepEqual(Object.keys(l.summary).sort(), ['checks_run', 'findings', 'undetermined']);
  assert.match(l.as_of, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof l.index.launches, 'number');
});

test('every check has the committed fields and no others', () => {
  for (const c of launch().checks) {
    assert.deepEqual(Object.keys(c).sort(),
      ['headline', 'id', 'reference', 'severity', 'source', 'state', 'value'],
      `${c.id} has the wrong fields`);
  }
});

test('the summary counts what the checks say', () => {
  const l = launch();
  assert.equal(l.summary.checks_run, l.checks.length);
  assert.equal(l.summary.findings, l.checks.filter((c) => c.state === 'finding').length);
  assert.equal(l.summary.undetermined, l.checks.filter((c) => c.state === 'undetermined').length);
});

test('checks come back worst first', () => {
  const s = launch().checks.map((c) => c.severity);
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1] >= s[i], 'checks are not ordered by severity');
});

// ------------------------------------------------------------------- limits

test('the tiers are the rates that were quoted', () => {
  assert.equal(A.RATES.keyless, 1);
  assert.equal(A.RATES.public, 5);
  assert.equal(A.RATES.partner, 60);
});

test('a key is read from a header, a bearer token or the query', () => {
  const url = new URL('https://api.checkvitals.xyz/v1/health');
  assert.equal(A.callerOf({ authorization: 'Bearer partner-key' }, url).tier, 'partner');
  assert.equal(A.callerOf({ 'x-api-key': 'pub-key' }, url).tier, 'public');
  const q = new URL('https://api.checkvitals.xyz/v1/health?key=partner-key');
  assert.equal(A.callerOf({}, q).tier, 'partner');
});

test('an unknown key is keyless, not an error', () => {
  // A 401 in the way of an evaluation is worse than a low rate: a partner
  // curling the docs with a typo should still see a real answer.
  const url = new URL('https://api.checkvitals.xyz/v1/health');
  assert.equal(A.callerOf({ 'x-api-key': 'not-a-key' }, url).tier, 'keyless');
  assert.equal(A.callerOf({}, url).tier, 'keyless');
});

test('the bucket refuses past the rate and says when to come back', () => {
  A.resetApiLimits();
  const caller = { id: 'test-keyless', tier: 'keyless' };
  let allowed = 0;
  for (let i = 0; i < 10; i++) if (A.consume(caller, NOW).allowed) allowed++;
  assert.ok(allowed >= 1 && allowed <= 3, `keyless served ${allowed} of 10 in one instant`);

  const refused = A.consume(caller, NOW);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfter >= 1, 'Retry-After must be a whole second at least');

  // A second later, one more token.
  assert.equal(A.consume(caller, NOW + 1000).allowed, true);
});

test('a partner gets sixty times what a keyless caller gets', () => {
  A.resetApiLimits();
  const p = { id: 'test-partner', tier: 'partner' };
  let allowed = 0;
  for (let i = 0; i < 200; i++) if (A.consume(p, NOW).allowed) allowed++;
  assert.ok(allowed >= 60, `partner served only ${allowed} in a burst`);
});

test('the buckets are per key', () => {
  A.resetApiLimits();
  const a = { id: 'key:a', tier: 'public' };
  const b = { id: 'key:b', tier: 'public' };
  for (let i = 0; i < 20; i++) A.consume(a, NOW);
  assert.equal(A.consume(a, NOW).allowed, false, 'a is not exhausted');
  assert.equal(A.consume(b, NOW).allowed, true, 'b was charged for a');
});

// -------------------------------------------------------------------- stats

test('stats publishes no median below the floor', () => {
  const s = H.getStats(NOW).body;
  assert.equal(typeof s.index.launches, 'number');
  if (s.exemptions.median_sample < 30) {
    assert.equal(s.exemptions.median_count_beyond_deployer, null,
      'a median was published on a sample too small to mean anything');
  }
  assert.match(s.as_of, /^\d{4}-\d{2}-\d{2}T/);
});

// ------------------------------------------------------------------ openapi

test('the document is generated from the identifiers the code branches on', () => {
  const doc = openapiDocument('https://api.checkvitals.xyz');
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.servers[0].url, 'https://api.checkvitals.xyz/v1');
  // The enums are the constants, not a copy of them.
  assert.deepEqual(
    doc.components.schemas.Check.properties.id.enum,
    [...T.COMMITTED_CHECK_IDS, ...T.ADDITIONAL_CHECK_IDS],
  );
  assert.deepEqual(doc.components.schemas.Check.properties.state.enum,
    ['finding', 'undetermined', 'none']);
  assert.equal(doc.components.schemas.Launch.properties.chain.const, 4663);
  // Every route is described.
  for (const p of ['/launch/{address}', '/launches', '/stats', '/health', '/openapi.json']) {
    assert.ok(doc.paths[p], `${p} is not in the document`);
  }
  // And the guarantees are stated in it, because a partner reads this and not
  // the source.
  assert.match(doc.info.description, /no score, no grade, no risk level and no "safe" field/);
  assert.match(doc.info.description, /never carries a `value`/);
});

test('the document names the public host from the environment only', () => {
  const doc = openapiDocument('https://example.test');
  assert.equal(doc.servers[0].url, 'https://example.test/v1');
  // Nothing else in the document resolves a host.
  const flat = JSON.stringify(doc);
  assert.ok(!/rpc\.mainnet/.test(flat), 'the document leaks the RPC host');
});
