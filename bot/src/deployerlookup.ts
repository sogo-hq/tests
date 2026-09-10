import { db } from './db.js';

/**
 * What the index knows about an address as a DEPLOYER.
 *
 * Its own module because two callers need it and neither should reach for the
 * other: the resolver, which asks after every other path has failed, and the
 * not-found renderer, which asks so it can say what the address IS. Putting it
 * in resolve.ts would drag a viem client into the renderer's import graph for
 * a query that only touches SQLite.
 */
export interface DeployerSummary {
  launches: number;
  latestToken: string;
  latestSymbol: string | null;
}

export function deployerSummary(address: string): DeployerSummary | null {
  const row = db
    .prepare(
      `SELECT token, symbol, COUNT(*) OVER () AS n
         FROM launches WHERE deployer = ? ORDER BY block_number DESC LIMIT 1`,
    )
    .get(address.toLowerCase()) as { token: string; symbol: string | null; n: number } | undefined;
  if (!row) return null;
  return { launches: row.n, latestToken: row.token, latestSymbol: row.symbol };
}
