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
