import { db } from './db.js';

/**
 * Has this launch been declared to the bot?
 *
 * The badge means "somebody claimed this launch here", and nothing more. It is
 * not a verification, not an endorsement, and carries no weight in any check:
 * every figure on the card is read from the chain either way.
 *
 * The command that writes these rows is specified separately; this is the read
 * the renderer needs, so the badge is wired rather than retrofitted.
 */
export function isDeclared(token: string): boolean {
  return Boolean(
    db.prepare('SELECT token FROM declarations WHERE token = ?').get(token.toLowerCase()),
  );
}

export function declaredAt(token: string): number | null {
  const row = db.prepare('SELECT declared_at FROM declarations WHERE token = ?')
    .get(token.toLowerCase()) as { declared_at: number } | undefined;
  return row ? row.declared_at * 1000 : null;
}
