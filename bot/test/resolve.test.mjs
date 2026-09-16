/**
 * "not a pons v2 launch" on a launch that plainly is one.
 *
 * Recognition was never the problem. getLaunchedToken(token) on the factory is
 * a direct answer that has nothing to do with the transaction's `to` field, and
 * exists=false is already told apart from a read that failed. What was pasted
 * simply was not the token's address.
 *
 * Every launch has a bonding-curve contract, and that address is what an
 * explorer shows in the trace of every buy and sell -- so it is the obvious
 * thing to paste. Verified against the live chain: the factory answers
 * exists=false for a real launch's own curve, and the card said "not a pons v2
 * launch" about a token that had already graduated.
 *
 * The factory keeps the final say. That is what separates this from a heuristic
 * like "a billion supply plus a curve event, therefore a pons launch", which
 * would assert a launch the authoritative registry denies -- a false positive
 * on the one question this product exists to answer honestly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionResult, encodeAbiParameters } from 'viem';
import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('resolve');
const { db } = await import('../dist/db.js');
const { resolveLaunch } = await import('../dist/resolve.js');
const { factoryAbi, curveAbi } = await import('../dist/abi.js');

const TOKEN = '0x' + '11'.repeat(20);
const CURVE = '0x' + '22'.repeat(20);
const STRANGER = '0x' + '33'.repeat(20);

/** The factory struct, with `exists` the only field under test. */
function launchStruct(exists, token = TOKEN, curve = CURVE) {
  return encodeFunctionResult({
    abi: factoryAbi, functionName: 'getLaunchedToken',
    result: {
      token, curve, deployer: STRANGER, creatorFeeRecipient: STRANGER, pairToken: STRANGER,
      graduationThreshold: 4200000000000000000n, poolFee: 3000, tickSpacing: 60,
      creatorTaxBps: 100, buybackEnabled: false, phase: 0,
      sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, exists,
    },
  });
}

/**
 * @param opts.curveToken what curve.token() returns, or null to revert
 * @param opts.launched   which addresses the factory says exist
 */
function stub(opts) {
  const calls = [];
  return {
    calls,
    install() {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        const reply = (v) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...v }),
          { headers: { 'content-type': 'application/json' } });
        if (body.method !== 'eth_call') return reply({ result: '0x' });
        // A stub that throws surfaces as "HTTP request failed", which reads as a
        // flaky node and hides the real mistake. Caught and made loud instead.
        try {
        const to = body.params[0].to.toLowerCase();
        const data = body.params[0].data;
        calls.push({ to, selector: data.slice(0, 10) });

        // getLaunchedToken(address) on the factory
        if (data.startsWith('0x5a8ef1a2') || to === '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e') {
          const asked = ('0x' + data.slice(-40)).toLowerCase();
          return reply({ result: launchStruct(opts.launched.includes(asked)) });
        }
        // token() on a curve
        if (opts.curveToken === null) {
          return reply({ error: { code: 3, message: 'execution reverted' } });
        }
        return reply({ result: encodeAbiParameters([{ type: 'address' }], [opts.curveToken]) });
        } catch (err) {
          console.error('STUB THREW:', err?.message ?? err);
          throw err;
        }
      };
    },
  };
}

test('a curve the index already knows resolves for free', async () => {
  db.prepare('DELETE FROM launches WHERE token = ?').run(TOKEN.toLowerCase());
  db.prepare(
    `INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
       graduation_threshold, block_number, tx_hash, launched_at)
     VALUES (?,?,?,?,1,'4200000000000000000',1,?,1)`,
  ).run(TOKEN.toLowerCase(), CURVE.toLowerCase(), STRANGER, STRANGER, '0x' + 'f'.repeat(64));

  const saved = globalThis.fetch;
  const s = stub({ curveToken: TOKEN, launched: [TOKEN.toLowerCase()] });
  s.install();
  try {
    const r = await resolveLaunch(CURVE);
    assert.equal(r.token, TOKEN.toLowerCase());
    assert.equal(r.via, 'curve-index');
    assert.equal(r.pastedWas, 'curve');
    assert.equal(s.calls.length, 0, 'an indexed curve must cost no requests at all');
  } finally {
    globalThis.fetch = saved;
    db.prepare('DELETE FROM launches WHERE token = ?').run(TOKEN.toLowerCase());
  }
});

test('a curve the index has not seen resolves by asking the contract', async () => {
  const saved = globalThis.fetch;
  const s = stub({ curveToken: TOKEN, launched: [TOKEN.toLowerCase()] });
  s.install();
  try {
    const r = await resolveLaunch(CURVE);
    assert.equal(r.token, TOKEN.toLowerCase());
    assert.equal(r.via, 'curve-call');
    assert.ok(s.calls.length >= 2, 'it should have asked the curve and then the factory');
  } finally { globalThis.fetch = saved; }
});

test('the factory keeps the final say, no launch is ever invented', async () => {
  // A contract with a token() getter pointing at something the factory denies.
  // Accepting it would assert a pons launch that the authoritative registry
  // says does not exist, which is the false positive this must never produce.
  const saved = globalThis.fetch;
  const s = stub({ curveToken: TOKEN, launched: [] });
  s.install();
  try {
    const r = await resolveLaunch(CURVE);
    assert.equal(r.token, null, 'it accepted a token the factory says is not a launch');
    assert.equal(r.via, 'none');
    // Proved rather than assumed: this test passed once while the stub was not
    // intercepting at all, so the null came from a real network failure instead
    // of from the factory refusing. Assert the factory was actually asked.
    const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
    assert.ok(s.calls.some((c) => c.to === FACTORY),
      `the factory was never consulted; calls were ${JSON.stringify(s.calls)}`);
  } finally { globalThis.fetch = saved; }
});

test('an address that is not a curve at all is simply not a launch', async () => {
  const saved = globalThis.fetch;
  const s = stub({ curveToken: null, launched: [] });
  s.install();
  try {
    const r = await resolveLaunch(STRANGER);
    assert.equal(r.token, null);
    assert.equal(r.via, 'none');
  } finally { globalThis.fetch = saved; }
});

test('a factory read that FAILS is never rendered as "no launch"', async () => {
  // The first version of resolveLaunch had the factory confirmation inside the
  // same try/catch as the curve call, so an RPC failure there was swallowed and
  // returned as "no launch" -- which the card renders as "not a pons v2 launch",
  // a confident statement about a chain we had just failed to reach.
  //
  // 307 passing tests did not catch it. This is the one that does.
  const saved = globalThis.fetch;
  let factoryCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const reply = (v) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...v }),
      { headers: { 'content-type': 'application/json' } });
    if (body.method !== 'eth_call') return reply({ result: '0x' });
    const to = body.params[0].to.toLowerCase();
    if (to === '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e') {
      // The factory is unreachable. Not an answer, an absence of one.
      factoryCalls++;
      return new Response('upstream connect error', { status: 502 });
    }
    return reply({ result: encodeAbiParameters([{ type: 'address' }], [TOKEN]) });
  };
  try {
    await assert.rejects(
      () => resolveLaunch(CURVE),
      'a failed factory read must reach the caller as a failure, so the scan can say ' +
        '"couldn\'t read" instead of asserting the token is not a pons launch',
    );
    assert.ok(factoryCalls > 0, 'the factory was never asked, so this proves nothing');
  } finally { globalThis.fetch = saved; }
});
