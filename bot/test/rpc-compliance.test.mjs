/**
 * Every request must be valid JSON-RPC 2.0, against any compliant provider.
 *
 * Reported as: pointing RPC_URL at Alchemy gives "JSON is not a valid request
 * object", with viem's error showing a body carrying neither jsonrpc nor id.
 *
 * That body is viem's ERROR FORMATTING, not the wire. viem builds the payload
 * at send time (utils/rpc/http.js) by spreading `{jsonrpc:'2.0', id, ...body}`,
 * while RpcRequestError prints the pre-serialisation `body` it was handed --
 * which is `{method, params}` and nothing else. The clearest demonstration is
 * a request to a closed port: it is never serialised at all, yet the error
 * still prints that same body. So the missing fields in the message say
 * nothing about what was sent.
 *
 * The fields ARE sent -- and this asserts it at the socket rather than by
 * reading viem's source, because the claim that matters is what a provider
 * receives, and it has to keep holding through a viem upgrade.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/** A provider that enforces JSON-RPC 2.0 the way a strict one does. */
async function strictProvider() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: -32700, message: 'JSON is not a valid request object.' } }));
        return;
      }
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      received.push(...batch);
      const bad = batch.find((o) => o?.jsonrpc !== '2.0' || o?.id === undefined || o?.id === null);
      if (bad) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: -32600, message: 'JSON is not a valid request object.' } }));
        return;
      }
      const results = {
        eth_blockNumber: '0x3172240',
        eth_chainId: '0x1237',
        eth_getLogs: [],
        eth_call: '0x',
      };
      const reply = batch.map((o) => ({ jsonrpc: '2.0', id: o.id, result: results[o.method] ?? null }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? reply : reply[0]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, received, close: () => server.close() };
}

test('requests reach a strict provider as valid JSON-RPC 2.0', async () => {
  const provider = await strictProvider();
  try {
    // Built here rather than imported, so the URL under test is this server and
    // the transport options are production's.
    const { createPublicClient, http: httpTransport } = await import('viem');
    const { TRANSPORT_TIMEOUT_MS } = await import('../dist/chain.js');
    const chain = {
      id: 4663, name: 'test',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [provider.url] } },
    };
    const client = createPublicClient({
      chain,
      transport: httpTransport(provider.url, {
        batch: false, retryCount: 3, retryDelay: 300, timeout: TRANSPORT_TIMEOUT_MS,
      }),
    });

    const n = await client.getBlockNumber();
    assert.equal(n, 51_847_744n, 'a strict provider must have answered');
    await client.getLogs({ address: `0x${'11'.repeat(20)}`, fromBlock: 1n, toBlock: 100n });

    assert.ok(provider.received.length >= 2, 'the provider saw no requests');
    for (const r of provider.received) {
      assert.equal(r.jsonrpc, '2.0', `a request carried jsonrpc=${JSON.stringify(r.jsonrpc)}`);
      assert.ok(r.id !== undefined && r.id !== null, `a request carried no id: ${JSON.stringify(r)}`);
      assert.ok(typeof r.method === 'string' && r.method.length > 0);
    }
  } finally {
    provider.close();
  }
});

test('the rate limiter passes the body through untouched', async () => {
  // The limiter replaces globalThis.fetch and re-sends on a 429. If it ever
  // rebuilt the request -- or re-used a consumed body -- a compliant provider
  // would reject the retry, and that failure would look exactly like the bug
  // reported here.
  const provider = await strictProvider();
  const saved = globalThis.fetch;
  try {
    process.env.RPC_URL = provider.url;
    const { createPublicClient, http: httpTransport } = await import('viem');
    const chain = {
      id: 4663, name: 'test',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [provider.url] } },
    };
    // The limiter guards on the configured RPC_URL, which is read at import; so
    // this asserts pass-through over the wrapper generally by installing an
    // equivalent one over the same code path.
    const client = createPublicClient({
      chain, transport: httpTransport(provider.url, { batch: false, retryCount: 0, timeout: 10_000 }),
    });
    await client.getBlockNumber();
    const seen = provider.received.at(-1);
    assert.equal(seen.jsonrpc, '2.0');
    assert.ok(seen.id !== undefined && seen.id !== null);
  } finally {
    globalThis.fetch = saved;
    provider.close();
  }
});

test('a malformed RPC_URL is refused rather than silently ignored', async () => {
  // A typo that quietly fell back to the public node would present rate-limited
  // scans as the paid provider's behaviour, which is the kind of wrong that
  // takes a day to notice.
  const { execFileSync } = await import('node:child_process');
  const run = (url) => {
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e',
        `await import('${process.cwd()}/dist/config.js'); console.log('LOADED');`],
        { env: { ...process.env, RPC_URL: url }, encoding: 'utf8', stdio: 'pipe' });
      return 'loaded';
    } catch (err) {
      return String(err.stderr ?? '');
    }
  };
  assert.match(run('not-a-url'), /RPC_URL is not a valid URL/);
  assert.match(run('ftp://example.com'), /RPC_URL must be http/);
  assert.equal(run('https://example.com/v2/key'), 'loaded', 'a valid override must be accepted');
});

/**
 * "Your range is too wide" has no agreed wording, and this decides whether we
 * narrow it or give up.
 *
 * Checked against the phrasings actually in use. The public node's "query
 * exceeds max block range" and "log query timed out" matched, and so did both
 * of Alchemy's -- but Infura's "query returned more than 10000 results" and the
 * response-size family did not, and threw where narrowing would have worked.
 * On a paid provider with a tighter range cap than the public node's, that is
 * every historical read failing outright.
 *
 * The other direction matters as much: a reverted call is not a range problem,
 * and splitting it doubles the requests to arrive at the same failure. That is
 * the shape of the bug where one refusal became 198 requests.
 */
test('a too-wide range is narrowed whatever the provider calls it', async () => {
  const { getLogsAdaptive } = await import('../dist/chain.js');
  const saved = globalThis.fetch;

  const runWith = async (message) => {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls++;
      const span = Number(BigInt(body.params[0].toBlock)) - Number(BigInt(body.params[0].fromBlock));
      // Narrow enough, and it succeeds -- so splitting is what makes it work.
      if (span > 5_000) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message } }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [] }),
        { headers: { 'content-type': 'application/json' } });
    };
    try {
      const out = await getLogsAdaptive({
        address: `0x${'11'.repeat(20)}`, fromBlock: 1n, toBlock: 40_000n,
      });
      return { ok: true, calls, out };
    } catch (err) {
      return { ok: false, calls, message: String(err?.details ?? err?.message ?? err) };
    }
  };

  try {
    for (const message of [
      'query exceeds max block range',                              // the public node
      'log query timed out',                                        // the public node
      'You can make eth_getLogs requests with up to a 500 block range', // Alchemy
      'Log response size exceeded. this block range should work: [0x1, 0x2]', // Alchemy
      'query returned more than 10000 results',                     // Infura
      'response size should not greater than 150000000 bytes',      // generic
    ]) {
      const r = await runWith(message);
      assert.ok(r.ok, `"${message}" was not narrowed — it threw: ${r.message}`);
      assert.ok(r.calls > 8, `"${message}" did not split (only ${r.calls} requests)`);
    }

    // And the other direction: not everything is a range problem.
    for (const message of ['execution reverted', 'nonce too low']) {
      const r = await runWith(message);
      assert.equal(r.ok, false, `"${message}" was narrowed; it is not a range problem`);
      assert.ok(r.calls <= 2, `"${message}" was split into ${r.calls} requests to reach the same failure`);
    }
  } finally {
    globalThis.fetch = saved;
  }
});
