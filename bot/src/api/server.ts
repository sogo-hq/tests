import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { callerOf, consume, RATES } from './auth.js';
import { openapiDocument } from './openapi.js';
import {
  getLaunch, postLaunches, getStats, getHealth, lagRefusal,
  validateAddress, validateBatch,
} from './handlers.js';
import { API_VERSION } from './types.js';

/**
 * The HTTP surface.
 *
 * node:http rather than a framework. The whole server is five routes and a
 * token bucket, and a dependency tree is a thing that has to be kept patched
 * for as long as the partner integration lives; this has none. It runs in the
 * same process as the bot deliberately, so an API answer and a /scan answer
 * come from the same cache and the same index and cannot disagree.
 */

/** Bodies are small by design: the batch ceiling is fifty addresses. */
const MAX_BODY_BYTES = Number(process.env.API_MAX_BODY || 64 * 1024) || 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    // Open for reads. There is nothing here that is not public, and a partner
    // evaluating the contract from a browser console should not be stopped by
    // a preflight they cannot configure.
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-api-key',
    'cache-control': 'public, max-age=30',
    ...headers,
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('body is not json'));
      }
    });
    req.on('error', reject);
  });
}

/** Where the root redirects. The documentation site, not the repository. */
export const DOCS_URL = 'https://docs.checkvitals.xyz/api';

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    send(res, 204, null);
    return;
  }

  // The root is a signpost, not a 404. Somebody who pastes the api host into a
  // browser is looking for the documentation, and answering "unknown_route" to
  // the most obvious request anyone makes is a bad first impression of a
  // service whose whole product is answering clearly.
  if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(302, { location: DOCS_URL, 'cache-control': 'public, max-age=300' });
    res.end();
    return;
  }

  const prefix = `/${API_VERSION}`;
  if (!path.startsWith(prefix)) {
    send(res, 404, { error: 'unknown_route', see: `${prefix}/openapi.json` });
    return;
  }
  const route = path.slice(prefix.length) || '/';

  // The document is free: a partner reading the contract has not been given a
  // key yet, and rate-limiting the description of the rate limits is silly.
  if (route === '/openapi.json' && req.method === 'GET') {
    send(res, 200, openapiDocument());
    return;
  }

  const caller = callerOf(req.headers as Record<string, string>, url);
  const decision = consume(caller);
  const rateHeaders = {
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-tier': caller.tier,
  };
  if (!decision.allowed) {
    send(res, 429, {
      error: 'rate_limited',
      limit_rps: decision.limit,
      tier: caller.tier,
      // Said here rather than only in the docs: the first thing a developer
      // does with a 429 is read the body.
      hint: caller.tier === 'keyless'
        ? `keyless requests are ${RATES.keyless} rps, for evaluation. A key raises this.`
        : undefined,
    }, { ...rateHeaders, 'retry-after': String(decision.retryAfter) });
    return;
  }

  try {
    if (route === '/health' && req.method === 'GET') {
      const out = await getHealth();
      send(res, out.status, out.body, { ...rateHeaders, ...out.headers });
      return;
    }
    if (route === '/stats' && req.method === 'GET') {
      const out = getStats();
      send(res, out.status, out.body, { ...rateHeaders, ...out.headers });
      return;
    }

    /**
     * Route, then validate, then check the index, then work.
     *
     * The order matters. "that is not an address" and "there is no such route"
     * are facts about the REQUEST and stay true whatever the index is doing;
     * answering either with a 503 sends a partner looking for an outage that is
     * not there. Only the two routes that answer FROM the index are refused
     * when it is too far behind, and /health never is, because it is how
     * somebody finds out that the rest will be.
     */
    const launchMatch = /^\/launch\/([^/]+)$/.exec(route);
    if (launchMatch && req.method === 'GET') {
      const address = decodeURIComponent(launchMatch[1]!);
      const invalid = validateAddress(address);
      if (invalid) {
        send(res, invalid.status, invalid.body, rateHeaders);
        return;
      }
      const lagging = await lagRefusal();
      if (lagging) {
        send(res, lagging.status, lagging.body, { ...rateHeaders, ...lagging.headers });
        return;
      }
      const out = await getLaunch(address);
      send(res, out.status, out.body, { ...rateHeaders, ...out.headers });
      return;
    }

    if (route === '/launches' && req.method === 'POST') {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (err) {
        send(res, 400, { error: 'bad_request', detail: String((err as Error).message).slice(0, 80) }, rateHeaders);
        return;
      }
      const invalid = validateBatch(body);
      if (invalid) {
        send(res, invalid.status, invalid.body, rateHeaders);
        return;
      }
      const lagging = await lagRefusal();
      if (lagging) {
        send(res, lagging.status, lagging.body, { ...rateHeaders, ...lagging.headers });
        return;
      }
      const out = await postLaunches(body);
      send(res, out.status, out.body, { ...rateHeaders, ...out.headers });
      return;
    }

    send(res, 404, { error: 'unknown_route', see: `${prefix}/openapi.json` }, rateHeaders);
  } catch (err) {
    // Never the internal message. A stack trace in a partner's log is a leak
    // and tells them nothing they can act on.
    console.error('[api] unhandled:', err);
    send(res, 500, { error: 'internal_error' }, rateHeaders);
  }
}

let server: Server | null = null;

/**
 * Start the API, if a port is set.
 *
 * No port means no API, silently: the bot runs in places where nothing should
 * be listening, and failing to boot over a missing optional variable would take
 * the bot down with it.
 */
export function startApi(port = Number(process.env.PORT || 0)): Server | null {
  if (!port) {
    console.log('[api] PORT not set, HTTP API not started');
    return null;
  }
  server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error('[api] handler escaped:', err);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"internal_error"}');
      } catch (writeErr) {
        // The socket is gone. Nothing to report to.
      }
    });
  });
  server.listen(port, () => {
    console.log(`[api] listening on :${port}${'/' + API_VERSION}`);
  });
  return server;
}

export function stopApi(): void {
  server?.close();
  server = null;
}
