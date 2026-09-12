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
import { readFileSync } from 'node:fs';
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

// ------------------------------------------- the structured value contract

/**
 * Every value and reference in every response is an object or null.
 *
 * Never a number, a string or a boolean. A consumer that has to parse "9" out
 * of one check and "400 bps" out of the next has no contract at all, and a bare
 * scalar cannot gain a second field later without breaking every client that
 * read it. This is swept over every check of every response rather than
 * asserted per check, because the way a scalar gets back in is that somebody
 * adds one check that returns one.
 */
function assertStructured(label, checks) {
  for (const c of checks) {
    for (const field of ['value', 'reference']) {
      const v = c[field];
      if (v === null) continue;
      assert.equal(typeof v, 'object',
        `${label}: ${c.id}.${field} is a ${typeof v} (${JSON.stringify(v)}), not an object or null`);
      assert.ok(!Array.isArray(v), `${label}: ${c.id}.${field} is an array`);
      assert.ok(Object.keys(v).length > 0, `${label}: ${c.id}.${field} is an empty object`);
    }
  }
}

test('every value and reference is an object or null, never a scalar', () => {
  assertStructured('GET /v1/launch', launch().checks);
  // And on a launch where most checks come back undetermined, which is the
  // shape most likely to carry a stray scalar.
  const thin = toApiLaunch((() => {
    const r = makeScan({ windowIndexed: false });
    r.flags = computeFlags({
      token: '0x' + '2'.repeat(40), deployer: '0x' + '3'.repeat(40),
      name: null, symbol: null, creatorTaxBps: 0, buybackEnabled: false,
      pairToken: PAIR, pairSymbol: 'ETH', scannedAt: 1_780_003_600,
    });
    r.reads.token = '0x' + '2'.repeat(40);
    return r;
  })(), new Date(NOW));
  assertStructured('a mostly-undetermined launch', thin.checks);
});

test('the committed value shapes are the committed value shapes', () => {
  const by = Object.fromEntries(launch().checks.map((c) => [c.id, c]));

  // Shares are FRACTIONS, not percentages: 0.174 is 17.4% of supply.
  const ex = by.snipe_tax_exemptions;
  assert.deepEqual(Object.keys(ex.value).sort(),
    ['beyond_deployer', 'slots', 'supply_share', 'wallets']);
  assert.equal(ex.value.wallets, 5);
  assert.equal(ex.value.beyond_deployer, 4);
  assert.equal(ex.value.slots, 32);
  assert.ok(Math.abs(ex.value.supply_share - 0.223) < 1e-9, ex.value.supply_share);
  assert.equal(ex.reference, null);

  assert.deepEqual(Object.keys(by.creator_tax.value), ['bps']);
  assert.deepEqual(Object.keys(by.creator_tax.reference).sort(), ['median_bps', 'n']);
  assert.equal(by.creator_tax.value.bps, 400);

  assert.deepEqual(Object.keys(by.ticker_collision.value), ['matches']);
  assert.deepEqual(Object.keys(by.ticker_collision.reference).sort(),
    ['flag_at_or_above', 'indexed']);

  assert.deepEqual(Object.keys(by.deployer_history.value), ['launches_7d']);
  assert.deepEqual(by.deployer_history.reference, { flag_above: 2 });

  assert.deepEqual(Object.keys(by.pair_asset.value).sort(), ['address', 'asset']);
  assert.equal(by.pair_asset.value.asset, 'ETH');

  assert.deepEqual(Object.keys(by.ticker_vs_pair.value), ['differs']);
  assert.equal(typeof by.ticker_vs_pair.value.differs, 'boolean');

  assert.deepEqual(by.buyback_vesting.value, { enabled: false });

  assert.deepEqual(Object.keys(by.creator_opening_buy.value), ['supply_share']);
  assert.deepEqual(Object.keys(by.holder_concentration.value).sort(),
    ['holders', 'largest_share', 'top5_share']);
});

test('severity is an integer, and the order survives the rounding', () => {
  const checks = launch().checks;
  for (const c of checks) {
    assert.ok(Number.isInteger(c.severity), `${c.id} severity is ${c.severity}`);
  }
  for (let i = 1; i < checks.length; i++) {
    assert.ok(checks[i - 1].severity >= checks[i].severity, 'checks are out of order');
  }
  // The supply share is no longer hidden in the decimal; it is a field.
  const ex = checks.find((c) => c.id === 'snipe_tax_exemptions');
  assert.equal(ex.severity, 922);
  assert.ok(ex.value.supply_share > 0);
});

// ----------------------------------------------- undetermined carries nothing

test('no undetermined check states a number anywhere in its headline', () => {
  // The guarantee is that undetermined carries no value. A headline reading
  // "creator opened with 1.0% of supply" while the state says undetermined
  // breaks it in the one field a human actually reads.
  const shapes = [launch(), toApiLaunch((() => {
    const r = makeScan({ windowIndexed: false });
    r.flags = computeFlags({
      token: '0x' + '2'.repeat(40), deployer: '0x' + '3'.repeat(40),
      name: null, symbol: null, creatorTaxBps: 0, buybackEnabled: false,
      pairToken: PAIR, pairSymbol: 'ETH', scannedAt: 1_780_003_600,
    });
    r.reads.token = '0x' + '2'.repeat(40);
    return r;
  })(), new Date(NOW))];

  let seen = 0;
  for (const l of shapes) {
    for (const c of l.checks.filter((x) => x.state === 'undetermined')) {
      seen++;
      assert.doesNotMatch(c.headline, /\d/,
        `${c.id} is undetermined and its headline states a number: "${c.headline}"`);
      assert.equal(c.value, null);
      assert.equal(c.reference, null);
    }
  }
  assert.ok(seen > 0, 'no undetermined check in either fixture, so nothing was tested');
});

// -------------------------------------------------------- ticker collisions

test('a unique ticker is not a collision', () => {
  const unique = toApiLaunch((() => {
    const r = makeScan({});
    r.flags = computeFlags({
      token: TOKEN, deployer: DEP, name: 'Wholly Unique', symbol: 'UNIQ7',
      creatorTaxBps: 400, buybackEnabled: false, pairToken: PAIR, pairSymbol: 'ETH',
      scannedAt: 1_780_003_600,
    });
    r.reads.token = TOKEN;
    return r;
  })(), new Date(NOW));
  const c = unique.checks.find((x) => x.id === 'ticker_collision');
  assert.equal(c.state, 'none', `a unique ticker was reported as ${c.state}`);
  assert.equal(c.value.matches, 0);
  assert.doesNotMatch(c.headline, /shared with/);
});

test('a genuine collision is a finding, and says how many OTHERS', () => {
  // 60 launches in the fixture carry the ticker DUPE, and the token under scan
  // is a 61st. The count is of the other sixty.
  const c = launch().checks.find((x) => x.id === 'ticker_collision');
  assert.equal(c.state, 'finding');
  assert.equal(c.value.matches, 60);
  assert.match(c.headline, /shared with 60 other launches/);
  // Never the shape that reads as "only this one uses it".
  assert.doesNotMatch(c.headline, /^\d+ of [\d,]+ indexed launches use/);
});

test('one other launch sharing a ticker is below the threshold', () => {
  const one = '0x' + '5'.repeat(40);
  insert.run(one, CURVE, one, PAIR, 90_001, '0x' + '5'.repeat(64), 1_780_000_000,
    'Solo', 'SOLO1', 'solo', 'solo1', 1, 100, 0.5, 0.5);
  const other = '0x' + '6'.repeat(40);
  insert.run(other, CURVE, other, PAIR, 90_002, '0x' + '6'.repeat(64), 1_780_000_000,
    'Solo', 'SOLO1', 'solo', 'solo1', 1, 100, 0.5, 0.5);

  const r = makeScan({});
  r.flags = computeFlags({
    token: one, deployer: one, name: 'Solo', symbol: 'SOLO1',
    creatorTaxBps: 100, buybackEnabled: false, pairToken: PAIR, pairSymbol: 'ETH',
    scannedAt: 1_780_003_600,
  });
  r.reads.token = one;
  const c = toApiLaunch(r, new Date(NOW)).checks.find((x) => x.id === 'ticker_collision');
  assert.equal(c.value.matches, 1, 'the token itself was counted');
  assert.equal(c.state, 'none', 'one other launch was reported as a collision');
  assert.equal(c.reference.flag_at_or_above, 2);
});

// ------------------------------------------------------------- the documents

test('docs/api.md lists every published check id, and invents none', () => {
  // The mismatch the partner found was between the docs and the API, not
  // inside either one. So the list is checked against the code, not re-typed.
  const md = readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8');
  const documented = new Set(
    [...md.matchAll(/^\| `([a-z_]+)` \| (?:✓|added after v1) \|/gm)].map((m) => m[1]),
  );
  const published = [...T.COMMITTED_CHECK_IDS, ...T.ADDITIONAL_CHECK_IDS];
  for (const id of published) {
    assert.ok(documented.has(id), `${id} is published and not in the id table`);
  }
  for (const id of documented) {
    assert.ok(published.includes(id), `${id} is documented and does not exist`);
  }
  assert.equal(documented.size, published.length);

  // And the v1 nine are marked as the v1 nine.
  for (const id of T.COMMITTED_CHECK_IDS) {
    assert.match(md, new RegExp(`^\\| \`${id}\` \\| ✓ \\|`, 'm'), `${id} lost its v1 mark`);
  }
  for (const id of T.ADDITIONAL_CHECK_IDS) {
    assert.match(md, new RegExp(`^\\| \`${id}\` \\| added after v1 \\|`, 'm'),
      `${id} is not marked as added after v1`);
  }
});

test('checks_run counts what is actually in the array', () => {
  const l = launch();
  assert.equal(l.summary.checks_run, l.checks.length);
  assert.equal(l.summary.findings, l.checks.filter((c) => c.state === 'finding').length);
  assert.equal(l.summary.undetermined,
    l.checks.filter((c) => c.state === 'undetermined').length);
  // The documented count for an undeclared launch.
  assert.equal(l.checks.length, 11);
});

test('the openapi document declares value and reference as object-or-null', () => {
  const check = openapiDocument().components.schemas.Check.properties;
  assert.deepEqual(check.value.type, ['object', 'null']);
  assert.deepEqual(check.reference.type, ['object', 'null']);
  assert.equal(check.severity.type, 'integer');
  // And the enum is the full published set, in committed-first order.
  assert.deepEqual(check.id.enum,
    [...T.COMMITTED_CHECK_IDS, ...T.ADDITIONAL_CHECK_IDS]);
});

test('every json block in docs/api.md obeys the contract it documents', () => {
  // The partner read the documents, not the code. A sample in the prose with a
  // scalar value is the same defect as a scalar on the wire.
  const md = readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 3, `only ${blocks.length} json blocks found`);

  let checked = 0;
  for (const [i, block] of blocks.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch (err) {
      // Blocks written with an elision are prose, not payloads.
      if (block.includes('…') || block.includes('"...":')) continue;
      assert.fail(`json block ${i} does not parse: ${err.message}`);
    }
    for (const c of collectChecks(parsed)) {
      checked++;
      for (const field of ['value', 'reference']) {
        const v = c[field];
        if (v === null) continue;
        assert.equal(typeof v, 'object',
          `docs json block ${i}: ${c.id}.${field} is a ${typeof v}`);
      }
      assert.ok(Number.isInteger(c.severity), `docs json block ${i}: ${c.id} severity`);
      if (c.state === 'undetermined') {
        assert.doesNotMatch(c.headline, /\d/,
          `docs json block ${i}: ${c.id} is undetermined and states a number`);
      }
    }
  }
  assert.ok(checked > 0, 'no checks found in any documented sample');
});

function collectChecks(node, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) collectChecks(n, out);
  } else if (node && typeof node === 'object') {
    if (typeof node.id === 'string' && 'state' in node && 'headline' in node) out.push(node);
    for (const v of Object.values(node)) collectChecks(v, out);
  }
  return out;
}

test('the committed examples obey the contract too', () => {
  for (const name of ['sample-response.json', 'sample-stats.json', 'openapi.json']) {
    const text = readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
    JSON.parse(text); // parses at all
  }
  const sample = JSON.parse(
    readFileSync(new URL('../examples/sample-response.json', import.meta.url), 'utf8'));
  assert.equal(sample.summary.checks_run, sample.checks.length);
  for (const c of sample.checks) {
    for (const field of ['value', 'reference']) {
      const v = c[field];
      if (v === null) continue;
      assert.equal(typeof v, 'object', `examples: ${c.id}.${field} is a ${typeof v}`);
    }
    assert.ok(Number.isInteger(c.severity), `examples: ${c.id} severity ${c.severity}`);
    if (c.state === 'undetermined') {
      assert.equal(c.value, null);
      assert.doesNotMatch(c.headline, /\d/, `examples: ${c.id} undetermined with a number`);
    }
  }
  assert.doesNotMatch(JSON.stringify(sample), /\bclean\b|\bsafe\b|verdict|grade|"score"/i);
});
