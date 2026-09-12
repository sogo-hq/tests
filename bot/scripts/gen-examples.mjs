/**
 * Regenerate the published examples from the running API.
 *
 * Over a real socket, against the real index, through the real handlers. The
 * examples a partner builds against are the API's own output or they are
 * fiction, and the reason this is a script rather than a paste is that the last
 * round of drift between the documents and the endpoint cost a partner a day.
 *
 *   node scripts/gen-examples.mjs [token]
 *
 * Defaults to CHIPPER, which is the case the integration exists for: nine
 * wallets exempted from the opening tax, eight of them beyond the deployer.
 */
import { writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const TOKEN = process.argv[2] || '0xd384722f6adfe7d79e8e6623896df199afd31b76';

/**
 * The freshness gate, relaxed for the capture only.
 *
 * /v1/launch refuses when the index is more than 500 blocks behind head, which
 * is the right answer to a consumer: a stale index cannot speak for the chain.
 * A snapshot taken for documentation is the one case where it is not, provided
 * the launch itself sits well behind the cursor -- CHIPPER is ~15M blocks back,
 * so every window this response reports was fully indexed. The lag at capture
 * is printed below so a sample can never be mistaken for a fresh read.
 */
process.env.API_MAX_LAG_BLOCKS = process.env.API_MAX_LAG_BLOCKS || '100000000';

/**
 * Captured against a COPY of the index, never the index itself.
 *
 * Two reasons. A documentation run must not write to the live database, and the
 * copy is where the observed chain head gets recorded so that coverage is
 * computed from what this run actually saw rather than from whatever the last
 * indexer pass happened to leave behind. A sample generated from an index that
 * does not know how far behind it is would assert negatives it has not earned,
 * which is the one thing these examples exist to demonstrate the absence of.
 */
const SOURCE_DB = process.env.DB_PATH || './pons.db';
const workDir = mkdtempSync(join(tmpdir(), 'vitals-examples-'));
const workDb = join(workDir, 'capture.db');
copyFileSync(SOURCE_DB, workDb);
process.env.DB_PATH = workDb;
process.env.API_KEYS = process.env.API_KEYS || 'sample-partner-key:partner';
process.env.API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'https://api.checkvitals.xyz';

// PORT=0 means "do not start" to the bot, deliberately: an API that opens a
// socket because a variable was unset is a bug. So the port is picked here.
const { createServer } = await import('node:net');
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const { startApi, stopApi } = await import('../dist/api/server.js');
const server = startApi(port);
if (!server) throw new Error('the API did not start');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const base = `http://127.0.0.1:${server.address().port}`;
console.log('listening on', base);

async function get(path, key) {
  const res = await fetch(base + path, key ? { headers: { 'x-api-key': key } } : undefined);
  const body = await res.json();
  return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

const KEY = 'sample-partner-key';

const health = await get('/v1/health');
console.log('index lag at capture:', health.body.lag_blocks, 'blocks',
  '| indexed to:', health.body.indexed_to_block, '| chain head:', health.body.head_block);

// The head this run observed, written into the copy so every check reads the
// same coverage the health endpoint just reported.
const { recordIndexAdvance } = await import('../dist/indexer/health.js');
const { getCursor } = await import('../dist/db.js');
recordIndexAdvance(getCursor('launches') ?? 0n, BigInt(health.body.head_block));

const launch = await get(`/v1/launch/${TOKEN}`, KEY);
console.log('GET /v1/launch ->', launch.status);
if (launch.status !== 200) {
  console.error(JSON.stringify(launch.body, null, 2));
  stopApi();
  process.exit(1);
}

// ------------------------------------------------- the contract, over the wire

const checks = launch.body.checks;
for (const c of checks) {
  for (const field of ['value', 'reference']) {
    const v = c[field];
    if (v === null) continue;
    assert.equal(typeof v, 'object', `${c.id}.${field} is a ${typeof v}`);
    assert.ok(!Array.isArray(v), `${c.id}.${field} is an array`);
  }
  assert.ok(Number.isInteger(c.severity), `${c.id} severity ${c.severity} is not an integer`);
  if (c.state === 'undetermined') {
    assert.doesNotMatch(c.headline, /\d/, `${c.id} undetermined, headline "${c.headline}"`);
    assert.equal(c.value, null);
    assert.equal(c.reference, null);
  }
}
assert.equal(launch.body.summary.checks_run, checks.length);
assert.doesNotMatch(JSON.stringify(launch.body), /\bclean\b|\bsafe\b|verdict|grade|score/i,
  'a verdict word reached the response');
for (let i = 1; i < checks.length; i++) {
  assert.ok(checks[i - 1].severity >= checks[i].severity, 'checks are out of order');
}
/**
 * A stale index does not get to answer a now-relative question.
 *
 * Most checks here read a fixed window around the launch and are unaffected by
 * how far the cursor is from head. Three are relative to the moment of the
 * scan -- the deployer's last seven days, and how its previous tokens have
 * fared since -- and under a stale index those must come back undetermined
 * rather than zero. The engine's coverage guard is what makes that true; this
 * asserts it held, because a sample that publishes a false zero is worse than
 * no sample.
 */
const NOW_RELATIVE = ['deployer_history', 'deployer_prior_peaks', 'deployer_prior_survival'];
const lag = health.body.lag_blocks ?? 0;
if (lag > 500) {
  console.log(`\n  capture ran against an index ${lag.toLocaleString()} blocks behind head.`);
  for (const id of NOW_RELATIVE) {
    const c = checks.find((x) => x.id === id);
    if (!c) continue;
    console.log(`  ${id}: ${c.state} -- ${c.headline}`);
    assert.equal(c.state, 'undetermined',
      `${id} answered "${c.headline}" from an index ${lag} blocks stale`);
  }
  console.log('');
}
console.log(`${checks.length} checks, contract holds over the socket`);

const stats = await get('/v1/stats', KEY);
const openapi = await get('/v1/openapi.json');
console.log('GET /v1/stats ->', stats.status, '| /v1/openapi.json ->', openapi.status);
assert.equal(stats.status, 200);
assert.equal(openapi.status, 200);

const J = (o) => JSON.stringify(o, null, 2) + '\n';
writeFileSync(new URL('../examples/sample-response.json', import.meta.url), J(launch.body));
writeFileSync(new URL('../examples/sample-stats.json', import.meta.url), J(stats.body));
writeFileSync(new URL('../examples/openapi.json', import.meta.url), J(openapi.body));

for (const c of checks) {
  console.log(String(c.severity).padStart(4), c.state.padEnd(13), c.id.padEnd(24), c.headline);
}

stopApi();
rmSync(workDir, { recursive: true, force: true });
