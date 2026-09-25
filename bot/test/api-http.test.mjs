/**
 * The server itself, over a real socket.
 *
 * The contract tests check the shapes; these check that a partner's curl gets
 * them. Status codes, headers, CORS and the routes, driven through node:http
 * rather than by calling the handlers directly, because a route that is not
 * wired up is exactly the kind of thing a unit test cannot see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('api-http');
process.env.API_KEYS = 'pub-key:public,partner-key:partner';
process.env.API_PUBLIC_URL = 'https://api.checkvitals.xyz';

const { handle } = await import('../dist/api/server.js');
const A = await import('../dist/api/auth.js');
const { db } = await import('../dist/db.js');

// The index has to be current or every launch route answers 503, which is the
// correct behaviour and would hide every other assertion here.
const HEAD = 1_000_000;
db.prepare('INSERT OR REPLACE INTO cursors (name, block_number, updated_at) VALUES (?,?,?)')
  .run('launches', HEAD, Math.floor(Date.now() / 1000));

const server = createServer((req, res) => void handle(req, res));
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const call = async (path, init = {}) => {
  A.resetApiLimits();
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (err) { body = text; }
  return { status: res.status, headers: res.headers, body };
};

test('/v1/openapi.json is served without a key and without a rate limit', async () => {
  const r = await call('/v1/openapi.json');
  assert.equal(r.status, 200);
  assert.equal(r.body.openapi, '3.1.0');
  assert.equal(r.body.servers[0].url, 'https://api.checkvitals.xyz/v1');
});

test('/v1/health answers whether or not the index is behind', async () => {
  const r = await call('/v1/health');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(),
    ['as_of', 'head_block', 'indexed_to_block', 'lag_blocks', 'ok']);
  assert.equal(typeof r.body.ok, 'boolean');
});

test('/v1/stats answers without touching the chain', async () => {
  const r = await call('/v1/stats');
  assert.equal(r.status, 200);
  assert.ok('index' in r.body && 'exemptions' in r.body);
});

test('GET is open to the browser', async () => {
  const r = await call('/v1/stats');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const pre = await call('/v1/stats', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /GET/);
});

test('an unknown route points at the document', async () => {
  const r = await call('/v1/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'unknown_route');
  assert.match(r.body.see, /openapi\.json$/);

  const outside = await call('/v2/health');
  assert.equal(outside.status, 404);
});

test('a malformed address is a 400, not a 404', async () => {
  // A 404 would say "the factory has no record of this", which is a claim
  // about the chain. "0xnope" is a claim about the request.
  const r = await call('/v1/launch/0xnope');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_address');
});

test('the rate limit returns 429 with Retry-After and the tier', async () => {
  A.resetApiLimits();
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) {
    const res = await fetch(`${base}/v1/stats`);
    await res.text();
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'a keyless caller was never limited in twelve instant requests');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(limited.headers.get('x-ratelimit-tier'), 'keyless');
  assert.equal(limited.headers.get('x-ratelimit-limit'), '1');
});

test('a partner key raises the limit on the same endpoint', async () => {
  A.resetApiLimits();
  let served = 0;
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${base}/v1/stats`, { headers: { authorization: 'Bearer partner-key' } });
    await res.text();
    if (res.status === 200) served++;
  }
  assert.equal(served, 30, `a partner was limited after ${served} requests`);
});

test('the batch refuses more than the ceiling, and says the ceiling', async () => {
  const addresses = Array.from({ length: 51 }, (_, i) => '0x' + String(i).padStart(40, '0'));
  const r = await call('/v1/launches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer partner-key' },
    body: JSON.stringify({ addresses }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'too_many_addresses');
  assert.equal(r.body.limit, 50);
  assert.equal(r.body.given, 51);
});

test('the batch refuses a body that is not a list of addresses', async () => {
  for (const [body, expected] of [
    ['{}', 'addresses_must_be_an_array'],
    ['{"addresses":[]}', 'addresses_must_not_be_empty'],
    ['not json', 'bad_request'],
  ]) {
    const r = await call('/v1/launches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer partner-key' },
      body,
    });
    assert.equal(r.status, 400, `body ${body} was accepted`);
    assert.equal(r.body.error, expected);
  }
});

test('a lagging index refuses the launch routes and not the health route', async () => {
  // How far behind is measured against the chain head, which this test cannot
  // reach, so the cursor is moved backwards instead: the same condition from
  // the other side.
  db.prepare('UPDATE cursors SET block_number = 1 WHERE name = ?').run('launches');
  const launch = await call(`/v1/launch/0x${'1'.repeat(40)}`);
  assert.equal(launch.status, 503);
  assert.equal(launch.body.error, 'index_lagging');
  assert.equal(launch.body.max_lag_blocks, 500);
  assert.ok(Number(launch.headers.get('retry-after')) >= 1);

  // /health still answers: it is how somebody finds out that the rest will not.
  const health = await call('/v1/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, false);

  db.prepare('UPDATE cursors SET block_number = ? WHERE name = ?').run(HEAD, 'launches');
});

test('the server never returns an internal message to a caller', async () => {
  // Every error body on every path above is one of a fixed set of slugs. This
  // asserts the set rather than the absence, so a new leak has to pass it.
  const KNOWN = new Set([
    'unknown_route', 'invalid_address', 'rate_limited', 'index_lagging',
    'not_a_pons_v2_launch', 'scan_unavailable', 'upstream_rate_limited',
    'addresses_must_be_an_array', 'addresses_must_not_be_empty',
    'too_many_addresses', 'bad_request', 'internal_error',
  ]);
  const probes = [
    ['/v1/nope', {}],
    ['/v1/launch/0xnope', {}],
    ['/v1/launches', { method: 'POST', body: '{' , headers: { authorization: 'Bearer partner-key' } }],
  ];
  for (const [path, init] of probes) {
    const r = await call(path, init);
    if (r.status >= 400 && r.body && r.body.error) {
      assert.ok(KNOWN.has(r.body.error), `${path} returned an unlisted error "${r.body.error}"`);
      assert.ok(!/at \w+ \(|\.ts:\d+|Error:/.test(JSON.stringify(r.body)),
        `${path} leaked an internal message`);
    }
  }
});

// ------------------------------------------------ the embeddable line

test('/v1/line/<ca> is wired up, refuses a non-address, and is open to a browser', async () => {
  // A route that is not wired is exactly what a handler test cannot see.
  const bad = await call('/v1/line/not-an-address');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_address');

  // A real address that is not a launch reaches the handler rather than a 404
  // about the route, which is the difference between "no such token" and "no
  // such endpoint" and is what a partner debugs against.
  const miss = await call(`/v1/line/0x${'1'.repeat(40)}`);
  assert.notEqual(miss.status, 404, 'the route itself answered');
  assert.ok([200, 404, 429, 503].includes(miss.status), `unexpected ${miss.status}`);
  if (miss.status === 404) assert.equal(miss.body.error, 'not_a_pons_v2_launch');

  // And it is readable from a page, like every other GET here.
  assert.equal(miss.headers.get('access-control-allow-origin'), '*');
});

test('the line route is in the openapi document, with its version pinned', async () => {
  const r = await call('/v1/openapi.json');
  const path = r.body.paths['/line/{address}'];
  assert.ok(path?.get, 'the line route is not documented');
  assert.ok(r.body.components.schemas.Line, 'the Line schema is missing');
  assert.equal(r.body.components.schemas.Line.properties.line.maxLength, 110);
  assert.deepEqual(r.body.components.schemas.Line.required, ['version', 'line']);
  // The description states the two properties an embedder relies on.
  assert.match(path.get.description, /shape does not change/);
  assert.match(path.get.description, /never a partial line/);
});
