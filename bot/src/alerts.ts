import { db } from './db.js';
import {
  matchesFor, claimDelivery, whyLine, filterMatchesFor, alertsSentSince, claimCapNotice,
  type Match,
} from './watch.js';
import { matchingFilters } from './filters.js';
import { performScan } from './service.js';
import { interactivelyBusy } from './ratelimit.js';

/**
 * Deliver alerts for launches the indexer has just seen.
 *
 * An alert IS a scan: it goes through performScan, so it takes the same
 * limiter, the same cache and the same budget as anything a user typed. That
 * matters most in a burst -- thirty launches arriving in one block must not
 * become thirty concurrent scans that starve the people actually waiting.
 *
 * Sent one at a time, pausing whenever interactive work appears, and the card
 * comes from the cache for every user after the first: one scan per token, not
 * one per subscriber.
 */

/** How many alerts one pass will send before leaving the rest for the next. */
const ALERT_BATCH = Number(process.env.ALERT_BATCH || 10) || 10;

/**
 * The most alerts one user may receive in an hour.
 *
 * A filter is a standing subscription to a shape, and one of them --
 * no-exemptions -- matches most launches on this chain. Without a ceiling, a
 * busy hour turns a subscription into a denial of service against the person
 * who subscribed.
 */
export const ALERTS_PER_HOUR = Number(process.env.ALERTS_PER_HOUR || 20) || 20;
const HOUR_SECONDS = 3_600;

export interface AlertSend {
  chatId: number;
  text: string;
  token: string;
  userId: number;
}

/** Every match for these launches that has not already been delivered. */
export function pendingAlerts(tokens: string[]): { token: string; match: Match }[] {
  const out: { token: string; match: Match }[] = [];
  for (const token of tokens) {
    const row = db
      .prepare('SELECT deployer, snipe_exemptions FROM launches WHERE token = ?')
      .get(token.toLowerCase()) as { deployer: string; snipe_exemptions: string | null } | undefined;
    if (!row) continue;

    let exemptions: string[] = [];
    if (row.snipe_exemptions) {
      try {
        exemptions = JSON.parse(row.snipe_exemptions) as string[];
      } catch (err) {
        // A row we cannot parse is not a reason to skip the deployer match, but
        // it is worth saying: a wallet watch on this launch will silently not
        // fire, and silence is the thing to avoid.
        console.warn(
          `[alerts] unparseable exemptions for ${token.slice(0, 10)}:`,
          String((err as Error)?.message ?? err).slice(0, 100),
        );
        exemptions = [];
      }
    }
    // Address watches first: a user watching this launch's deployer AND
    // subscribed to a filter it matches gets one alert, and the deployer is the
    // more specific reason to have asked for it.
    const matches = matchesFor({ deployer: row.deployer, exemptions });
    const already = new Set(matches.map((m) => m.userId));
    for (const m of filterMatchesFor(matchingFilters(token))) {
      if (!already.has(m.userId)) matches.push(m);
    }
    for (const match of matches) {
      out.push({ token: token.toLowerCase(), match });
    }
  }
  return out;
}

/**
 * Scan each alerted token once and hand back what to send.
 *
 * Returns the messages rather than sending them, so the transport stays in
 * bot.ts and this is testable without a Telegram token.
 */
export async function buildAlerts(
  tokens: string[],
  botUsername?: string,
  limit = ALERT_BATCH,
): Promise<{ sends: AlertSend[]; deferred: number; capped: number }> {
  const pending = pendingAlerts(tokens);
  const sends: AlertSend[] = [];
  let deferred = 0;
  let capped = 0;

  for (const { token, match } of pending) {
    if (sends.length >= limit) { deferred++; continue; }
    // Somebody is waiting on a scan of their own. Alerts are not urgent to the
    // second and the claim has not been made yet, so this token comes back
    // around on the next pass rather than competing now.
    if (interactivelyBusy()) { deferred++; continue; }

    // The hourly ceiling, checked before the claim so a capped alert is not
    // marked delivered -- it is suppressed, not consumed.
    const since = Math.floor(Date.now() / 1000) - HOUR_SECONDS;
    if (alertsSentSince(match.userId, since) >= ALERTS_PER_HOUR) {
      if (claimCapNotice(match.userId, since)) {
        sends.push({
          chatId: match.dmChatId,
          userId: match.userId,
          token,
          text:
            `that is ${ALERTS_PER_HOUR} alerts this hour, which is the cap — ` +
            `holding the rest until it clears. /watching shows what you are subscribed to.`,
        });
      }
      capped++;
      continue;
    }

    // Claimed before sending: a crash between the two loses an alert, which is
    // better than sending one twice to somebody who did not ask for it twice.
    if (!claimDelivery(match.userId, token)) continue;

    const outcome = await performScan({
      token,
      source: 'dm',
      userId: match.userId,
      chatId: match.dmChatId,
      // No quota key: the user did not ask for this one, so it must not consume
      // the allowance they would spend on scans they did ask for.
      quotaKey: undefined,
      botUsername,
    });

    if (outcome.kind !== 'ok') {
      // Nothing worth sending, and the claim stays -- an alert for a token that
      // would not scan is not worth retrying into the same failure.
      continue;
    }

    const ticker = outcome.meta.symbol ? `$${outcome.meta.symbol.toUpperCase()}` : `${token.slice(0, 6)}…`;
    sends.push({
      chatId: match.dmChatId,
      userId: match.userId,
      token,
      text: `${whyLine(match, ticker)}\n\n${outcome.defaultCard}`,
    });
  }

  return { sends, deferred, capped };
}
