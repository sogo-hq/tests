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
