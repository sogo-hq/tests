/**
 * Length limits for text that reaches Telegram.
 *
 * Token names, tickers, pair-token symbols and the symbols of colliding tokens
 * all originate in launch calldata or in another token's own ERC-20 metadata.
 * Every one of them is attacker-controlled and capped by nothing on chain, so
 * each is clamped where it enters a card rather than trusted.
 */

export const TELEGRAM_MAX_MESSAGE = 4096;
export const MAX_NAME = 48;
export const MAX_TICKER = 24;
/** Symbols of colliding tokens, shown as examples in the collision flag. */
export const MAX_SAMPLE = 16;

/** Clamp by code point, so a multi-byte glyph is never split in half. */
export function clamp(s: string, max: number): string {
  const t = [...String(s).trim()];
  return t.length <= max ? t.join('') : `${t.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * Clamp at a word boundary, and say that something was cut.
 *
 * `clamp` cuts at the code point the budget runs out on, which puts the knife
 * in the middle of a word and keeps whatever punctuation happened to be there.
 * On a card that produced "80% to the build:…", which reads as a declaration
 * that ends in a colon rather than as a line with more behind it.
 *
 * So: back up to the last space, drop the punctuation that was holding the
 * next clause on, and mark the cut with a space before the ellipsis so it
 * cannot be mistaken for part of the sentence. The word boundary is skipped
 * when backing up would throw away more than half the budget, because one
 * very long token is better shown cut than shown as nothing.
 */
export function clampWords(s: string, max: number): string {
  const t = [...String(s).trim()];
  if (t.length <= max) return t.join('');
  const mark = ' …';
  const room = Math.max(1, max - mark.length);
  const head = t.slice(0, room).join('');
  const space = head.lastIndexOf(' ');
  const cut = space > room / 2 ? head.slice(0, space) : head;
  const tidy = cut.replace(/[\s,;:.!?-]+$/, '');
  return `${tidy || cut || head}${mark}`;
}

/**
 * Last-resort guard on a rendered card.
 *
 * Drops whole lines from the body and always keeps the final one. Two reasons
 * it cannot simply slice at 4096:
 *
 *  - the last line is the disclaimer, and a card without it must never be sent
 *  - slicing raw HTML lands mid-tag, and Telegram rejects the whole message,
 *    so the user gets nothing at all
 *
 * Every line a card emits is independently tag-balanced, so dropping whole
 * lines always leaves valid HTML.
 */
export function clampMessage(html: string, max = TELEGRAM_MAX_MESSAGE): string {
  if (html.length <= max) return html;

  const lines = html.split('\n');
  const footer = lines[lines.length - 1] ?? '';
  const notice = '<i>… card truncated …</i>';
  const budget = max - footer.length - notice.length - 2;

  const kept: string[] = [];
  let used = 0;
  for (const line of lines.slice(0, -1)) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [...kept, notice, footer].join('\n');
}

/**
 * An age in one token: 45s, 30m, 3h, 9d.
 *
 * Whole units only. The older `age()` in card.ts renders one decimal place
 * above ninety minutes, which is right for a technical card and wrong for a
 * header somebody reads in passing: "graduated 3.0h ago" reads as a
 * measurement of something. Kept here rather than in either renderer because
 * both the picture and the group card use it and they must not drift.
 */
export function shortAge(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/**
 * A 40-hex address, and not the first forty characters of something longer.
 *
 * Without the lookahead this matches inside a transaction hash: a hash is
 * `0x` and sixty-four hex characters, and the first forty of them are a
 * perfectly good address as far as a regular expression is concerned.
 *
 * Measured: the public ledger post carries the payout hashes, so the guard
 * that refuses to send a post containing a wallet refused to send every post
 * that had hashes in it. That is the T+4h post on launch day, and it would
 * have failed the first time it mattered and never before. The same pattern
 * guards the fake-CA check in the launch room, where a member pasting a hash
 * would have been warned and then muted for a day.
 *
 * `x` is not a hex character, so a match can only start at a real `0x` and
 * the lookahead is the whole fix.
 */
export const ADDRESS_PATTERN = '0[xX][0-9a-fA-F]{40}(?![0-9a-fA-F])';

/** Does this text contain an address? Hashes do not count. */
export function containsAddress(text: string): boolean {
  return new RegExp(ADDRESS_PATTERN).test(text);
}

/** Every address in the text, with hashes left alone. */
export function addressesIn(text: string): string[] {
  return text.match(new RegExp(ADDRESS_PATTERN, 'g')) ?? [];
}

/**
 * Split a message at blank lines so every part fits.
 *
 * /help is generated from the command table, so it grows every time a command
 * is added, and it has now outgrown one message for an admin. Clamping it
 * would drop whichever commands happened to be last in the table, which is the
 * one failure a generated list must not have. Parts break between blocks, and
 * a single block longer than the limit is clamped rather than cut mid-word.
 */
export function splitMessage(text: string, max = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = '';
  for (const block of text.split('\n\n')) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= max) { current = candidate; continue; }
    if (current) parts.push(current);
    current = block.length <= max ? block : '';
    if (!current) parts.push(clampMessage(block, max));
  }
  if (current) parts.push(current);
  return parts.length ? parts : [clampMessage(text, max)];
}

/**
 * Split without losing a character.
 *
 * `splitMessage` clamps a single block that is longer than one message, which
 * is the right last resort for /help and the wrong one for anything a person
 * is about to sign: a declaration that arrives one ellipsis short of what the
 * wallet will be asked to sign is worse than one that arrives in two messages.
 *
 * Breaks at line boundaries, so `parts.join('\n')` is the input again. The one
 * exception is a single line longer than the limit, which is cut into pieces
 * because it has nowhere else to go; nothing is dropped there either.
 */
export function splitVerbatim(text: string, max = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let cur: string | null = null;
  for (const line of text.split('\n')) {
    const candidate: string = cur === null ? line : `${cur}\n${line}`;
    let held: string = candidate;
    if (cur !== null && candidate.length > max) {
      parts.push(cur);
      held = line;
    }
    while (held.length > max) {
      parts.push(held.slice(0, max));
      held = held.slice(max);
    }
    cur = held;
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [text];
}

/**
 * The plural of a noun for a count, and the count with it.
 *
 * "1 buyers in first 30 min" was on a live card. It is small and it is the kind
 * of small that makes a reader trust the numbers beside it less, because a
 * number printed without being looked at reads like a number nobody checked.
 *
 * English, and only the two cases English has. Irregular plurals are passed in
 * rather than guessed: appending an s to "es" would give "launchs".
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * "1 holder", "2 holders", "1,837 launches".
 *
 * Grouped with an explicit locale. A bare toLocaleString takes the host's,
 * which makes the same card render "1,837" on one machine and "1 837" on
 * another, and the tests would only ever see one of them.
 */
export function count(n: number, one: string, many?: string): string {
  return `${n.toLocaleString('en-US')} ${plural(n, one, many)}`;
}
