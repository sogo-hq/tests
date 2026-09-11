/**
 * The buy row, and why most of it is usually empty.
 *
 * Every link here sends somebody to a place where they can spend money on the
 * token the card is about. Getting one wrong does not produce a broken link, it
 * produces a working link to the wrong thing, and the person following it has
 * already decided to trade by the time they find out.
 *
 * So no format is guessed. Each bot's deep link is supplied by whoever runs
 * this bot, from that bot's own documentation, as a template in the
 * environment; the referral code is a second variable. A bot with no verified
 * template is simply absent from the row. That is the spec's own rule and it is
 * the right one: this chain is new, none of these bots publishes a
 * chain-scoped format for it that could be confirmed from here, and a row that
 * is honestly short beats one that is confidently wrong.
 *
 * Template placeholders: {address} and {ref}. Example, once verified:
 *   BUY_LINK_MAESTRO=https://t.me/maestro?start={address}-{ref}
 */

export interface BuyLink {
  label: string;
  url: string;
}

interface Source {
  label: string;
  template: string;
  ref: string;
}

function sources(): Source[] {
  return [
    { label: 'MAE', template: process.env.BUY_LINK_MAESTRO ?? '', ref: process.env.REF_MAESTRO ?? '' },
    { label: 'BAN', template: process.env.BUY_LINK_BANANA ?? '', ref: process.env.REF_BANANA ?? '' },
    { label: 'BSD', template: process.env.BUY_LINK_BASED ?? '', ref: process.env.REF_BASED ?? '' },
  ];
}

const reported = new Set<string>();

function report(label: string, why: string): void {
  const key = `${label}:${why}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[buylinks] ${label} omitted: ${why}`);
}

/** Only the ones that can actually be built, in the order the spec names. */
export function buyLinks(address: string): BuyLink[] {
  const out: BuyLink[] = [];
  for (const s of sources()) {
    if (!s.template) continue;                       // not configured is not an error
    if (!/^https:\/\/|^tg:\/\//.test(s.template)) {
      report(s.label, 'the template is not an https or tg link');
      continue;
    }
    if (!s.template.includes('{address}')) {
      report(s.label, 'the template does not place the token address');
      continue;
    }
    // A template that asks for a referral code and has not been given one would
    // render a link with the literal placeholder in it, which is a broken link
    // to a real bot: worse than no link at all.
    if (s.template.includes('{ref}') && !s.ref) {
      report(s.label, 'the template wants a referral code and none is set');
      continue;
    }
    out.push({
      label: s.label,
      url: s.template
        .replace(/\{address\}/g, encodeURIComponent(address))
        .replace(/\{ref\}/g, encodeURIComponent(s.ref)),
    });
  }
  return out;
}

/**
 * The chart link, on the same terms.
 *
 * The two hosts this bot resolves by itself are the RPC and the explorer, both
 * hardcoded, because lookalike RPCs and fake explorers exist for this chain. A
 * chart site is a third host and gets no exception: it is configured or it is
 * absent.
 */
export function chartLink(address: string): string | null {
  const template = process.env.DEX_URL_TEMPLATE ?? '';
  if (!template) return null;
  if (!/^https:\/\//.test(template) || !template.includes('{address}')) {
    report('DEX', 'the template is not an https link that places the address');
    return null;
  }
  return template.replace(/\{address\}/g, encodeURIComponent(address));
}

/** For tests, which change the environment between cases. */
export function resetBuyLinkWarnings(): void {
  reported.clear();
}
