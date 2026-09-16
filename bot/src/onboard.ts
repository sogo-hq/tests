import { db } from './db.js';
import { autoscanSetting } from './autoscan.js';

/**
 * What the bot says when it is added to a group as an admin.
 *
 * Once, three lines, and then nothing until it is asked something. A bot that
 * introduces itself at length in somebody else's room is the reason group
 * admins distrust bots, and the standing rule is that it never posts outside
 * the commands and schedules it was asked for.
 *
 * The third line is the one that matters and the one every other scanner
 * leaves out: a card with no finding on it is not a verdict that the launch is
 * fine. It is a list of the questions that were answerable.
 */

const KEY = 'onboarded';

/** Only when it becomes an admin, and only the first time. */
export function shouldOnboard(chatId: number, oldStatus: string, newStatus: string): boolean {
  if (newStatus !== 'administrator') return false;
  if (oldStatus === 'administrator') return false;
  return !wasOnboarded(chatId);
}

export function wasOnboarded(chatId: number): boolean {
  const row = db
    .prepare('SELECT value FROM group_settings WHERE chat_id = ? AND key = ?')
    .get(chatId, KEY) as { value: string } | undefined;
  return !!row;
}

export function markOnboarded(chatId: number, now = Math.floor(Date.now() / 1000)): void {
  db.prepare(
    `INSERT INTO group_settings (chat_id, key, value, set_by, set_at) VALUES (?,?,?,?,?)
     ON CONFLICT(chat_id, key) DO NOTHING`,
  ).run(chatId, KEY, String(now), null, now);
}

/**
 * The three lines.
 *
 * The middle one states what is actually true of THIS group rather than what
 * is true of the product. Telling a room that every address posted here gets a
 * card, in a room where autoscan is off, is a promise the bot then does not
 * keep, and the first unanswered paste is what people remember.
 */
export function onboardingText(chatId: number): string {
  const set = autoscanSetting(chatId);
  return [
    'VITALS reads pons v2 launches on Robinhood Chain: who was tax free at launch, what the deployer took, what the holders look like, what the chain shows.',
    set.on
      ? 'Every CA posted here gets the card.'
      : 'Autoscan is off here. An admin turns it on with /autoscan on, and then every CA posted here gets the card.',
    'No finding is not the same as clean: the card lists the questions that could be answered, and says undetermined for the rest.',
  ].join('\n');
}
