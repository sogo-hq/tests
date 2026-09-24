import { solanaRpcUrl, NO_RPC_REASON } from './config.js';

/**
 * The Solana JSON-RPC client.
 *
 * Its own client and its own pacing, deliberately not the pons one. That
 * limiter exists to keep interactive scans ahead of background work on a chain
 * with 0.1 second blocks; this path is a backfill against a paid endpoint
 * billed by credit, where getProgramAccounts costs ten times a plain read.
 * Sharing a limiter between them would mean one chain's backfill deciding how
 * fast the other chain answers a person waiting on a card.
 *
 * Nothing here throws at import time and nothing falls back to another host.
 * A read that cannot be made returns a reason, and the reason is what the card
 * prints as undetermined.
 */

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface RpcOptions {
  /** Attempts, including the first. */
  tries?: number;
  timeoutMs?: number;
  /** Injected in tests. Nothing in the bot passes it. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so a backoff does not make a suite slow. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** Retried on the shapes that mean "later", never on the ones that mean "no". */
function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export async function rpc<T = unknown>(
  method: string, params: unknown[], opts: RpcOptions = {},
): Promise<RpcResult<T>> {
  const url = solanaRpcUrl();
  if (!url) return { ok: false, reason: NO_RPC_REASON };

  const tries = opts.tries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? wait;
  let last = 'no attempt was made';

  for (let i = 0; i < tries; i++) {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (retryable(res.status)) {
        last = `${method}: http ${res.status}`;
        if (i < tries - 1) { await sleep(1000 * (i + 1)); continue; }
        break;
      }
      if (!res.ok) return { ok: false, reason: `${method}: http ${res.status}` };
      const body = await res.json() as { result?: T; error?: { message?: string } };
      if (body.error) {
        const message = String(body.error.message ?? 'unknown rpc error');
        // "Indexed requests require a personal token" is what a public endpoint
        // says to getProgramAccounts. It is a permanent no on that endpoint, so
        // it is returned rather than retried, and it names the endpoint's own
        // words so the operator can see which limit they hit.
        if (/rate|limit|busy|too many/i.test(message) && i < tries - 1) {
          last = `${method}: ${message}`;
          await sleep(1500 * (i + 1));
          continue;
        }
        return { ok: false, reason: `${method}: ${message.slice(0, 160)}` };
      }
      return { ok: true, value: body.result as T };
    } catch (err) {
      last = `${method}: ${String((err as Error)?.message ?? err).slice(0, 140)}`;
      if (i < tries - 1) await sleep(1000 * (i + 1));
    }
  }
  return { ok: false, reason: last };
}

/** Whether this build can read solana at all, and why not when it cannot. */
export function rpcConfigured(): { ok: boolean; reason: string | null } {
  return solanaRpcUrl() ? { ok: true, reason: null } : { ok: false, reason: NO_RPC_REASON };
}

export interface AccountInfo {
  /** base64, first element of the data tuple. */
  data: string;
  owner: string;
  lamports: number;
  executable: boolean;
}

function toAccount(v: unknown): AccountInfo | null {
  const a = v as { data?: unknown; owner?: unknown; lamports?: unknown; executable?: unknown } | null;
  if (!a || typeof a !== 'object') return null;
  const data = Array.isArray(a.data) ? a.data[0] : a.data;
  if (typeof data !== 'string' || typeof a.owner !== 'string') return null;
  return {
    data,
    owner: a.owner,
    lamports: typeof a.lamports === 'number' ? a.lamports : 0,
    executable: a.executable === true,
  };
}

export async function getAccount(
  pubkey: string, opts: RpcOptions = {},
): Promise<RpcResult<AccountInfo | null>> {
  const r = await rpc<{ value: unknown }>('getAccountInfo', [pubkey, { encoding: 'base64' }], opts);
  if (!r.ok) return r;
  return { ok: true, value: toAccount(r.value?.value) };
}

/** Several accounts in one call, in the order asked for, with nulls for missing. */
export async function getAccounts(
  pubkeys: string[], opts: RpcOptions = {},
): Promise<RpcResult<(AccountInfo | null)[]>> {
  const out: (AccountInfo | null)[] = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const chunk = pubkeys.slice(i, i + 100);
    const r = await rpc<{ value: unknown[] }>(
      'getMultipleAccounts', [chunk, { encoding: 'base64' }], opts,
    );
    if (!r.ok) return r;
    const value = r.value?.value ?? [];
    // A short page would silently shift every account after it onto the wrong
    // pubkey, which is the one failure here that produces confident nonsense.
    if (value.length !== chunk.length) {
      return { ok: false, reason: `getMultipleAccounts returned ${value.length} of ${chunk.length}` };
    }
    for (const v of value) out.push(toAccount(v));
  }
  return { ok: true, value: out };
}

export interface ProgramAccount {
  pubkey: string;
  account: AccountInfo;
}

/**
 * Every account of a program matching the filters.
 *
 * This is the call the startup diff is built on and the reason the endpoint
 * has to be a paid one: a public endpoint answers "Indexed requests require a
 * personal token" and there is no way around that but to pay.
 */
export async function getProgramAccounts(
  program: string,
  filters: unknown[],
  opts: RpcOptions = {},
): Promise<RpcResult<ProgramAccount[]>> {
  const r = await rpc<unknown>('getProgramAccounts', [
    program, { encoding: 'base64', filters },
  ], opts);
  if (!r.ok) return r;
  // Some endpoints wrap the array in { value }, some return it bare.
  const raw = Array.isArray(r.value)
    ? r.value
    : (r.value as { value?: unknown })?.value;
  if (!Array.isArray(raw)) return { ok: false, reason: 'getProgramAccounts did not return a list' };
  const out: ProgramAccount[] = [];
  for (const row of raw) {
    const o = row as { pubkey?: unknown; account?: unknown };
    const account = toAccount(o.account);
    if (typeof o.pubkey === 'string' && account) out.push({ pubkey: o.pubkey, account });
  }
  return { ok: true, value: out };
}
