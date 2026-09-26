import type { ScanResult } from './scan.js';
import { clamp, count, shortAge as age, MAX_NAME, MAX_TICKER } from './text.js';
import { compactAmount, exemptShareLine, GROUP_HANDLE, mcapLabel, windowLabel } from './card.js';
import { BENCHMARK_LADDER_MINUTES } from './metrics/benchmark.js';
import { marketSnapshot, type MarketSnapshot } from './metrics/market.js';
import { holderBreakdown } from './metrics/concentration.js';
import { firstCallOf } from './firstcall.js';
import { buyLinks, chartLink } from './buylinks.js';
import { launchNotice } from './launchnotice.js';
import { EXPLORER_URL, DISCLAIMER } from './config.js';

/**
 * The card a group gets.
 *
 * Longer than the DM card because a group reads one message and does not open
 * /full, but bounded hard at eighteen lines: past that Telegram collapses it
 * behind a "show more" and the findings are what gets hidden.
 *
 * The one structural rule is that the findings never move below the market
 * block. Every card of this shape in every other tool leads with price and puts
 * the risk underneath, and the ordering is the product: what the chain shows
 * about how the launch was set up comes before what it is worth today.
 */

/** Telegram collapses a message past roughly this many lines. */
export const MAX_GROUP_LINES = 18;

/** Findings shown before the rest become a count. */
const MAX_FINDINGS = 3;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface GroupCardOptions {
  chatId?: number;
  botUsername?: string;
  /** Omitted while a market read is still in flight; edited in when it lands. */
  market?: MarketSnapshot | null;
  now?: number;
}

export interface GroupCard {
  text: string;
  /** The market lines, so the same render can be edited in later. */
  hasMarket: boolean;
  buttons: { text: string; callback_data: string }[][];
}

/**
 * The state line: what phase the launch is in, said with the number that
 * decides it.
 *
 * "on the curve" alone is a category. The threshold it is measured against is
 * read live from the launch config on every scan and never hardcoded, because
 * it differs per launch and a stale constant would put every card's progress
 * bar against the wrong denominator.
 */
function stateLine(r: ScanResult, quote: string): string {
  const k = r.reads;
  if (k.phaseName === 'NotGraduated') {
    const target = Number(k.graduationThreshold) / 10 ** k.pairDecimals;
    const have = Number(k.realQuoteReserve) / 10 ** k.pairDecimals;
    return `on the curve ${k.progressPct.toFixed(1)}% `
      + `(${compactAmount(have)} of ${compactAmount(target)} ${quote})`;
  }
  const now = r.launchedAt + r.ageSeconds;
  if (k.sweptAt && k.sweptAt > 0 && now > k.sweptAt) return `graduated ${age(now - k.sweptAt)} ago`;
  return 'graduated';
}

export function renderGroupCard(r: ScanResult, opts: GroupCardOptions = {}): GroupCard {
  const k = r.reads;
  const quote = clamp(k.pairSymbol ?? 'ETH', MAX_TICKER);
  const sym = k.symbol ? esc(clamp(k.symbol, MAX_TICKER)) : '?';
  const name = k.name ? esc(clamp(k.name, MAX_NAME)) : 'unknown';
  const token = k.token.toLowerCase();

  const L: string[] = [];

  // -- identity ----------------------------------------------------------
  // Through mcapLabel, not from the figure. This line printed the figure
  // directly and was the one place on any card that rendered a graduated
  // launch's empty curve as "0 ETH mc". The quote symbol is launch calldata, so
  // the label is escaped like every other read.
  const mc = mcapLabel(r);
  L.push(`<b>${sym}</b>  ${name}${mc ? `  ·  ${esc(mc)}` : ''}`);
  L.push(`Robinhood Chain · pons v2 · ${age(r.ageSeconds)} · ${esc(stateLine(r, quote))}`);
  L.push('');

  // -- findings, above the market block, always --------------------------
  const raised = r.flags.flags
    .filter((f) => f.state === 'raised')
    .sort((a, b) => b.severity - a.severity);
  const unknown = r.flags.flags.filter((f) => f.state === 'unknown').length;

  if (raised.length) {
    for (const f of raised.slice(0, MAX_FINDINGS)) {
      L.push(`\u{1F6A9} ${esc(f.plain || f.compactDetail)}`);
    }
    const more = raised.length - MAX_FINDINGS;
    if (more > 0) L.push(`+${more} more, /full`);
  } else if (unknown > 0) {
    L.push(`◌ ${unknown} check${unknown === 1 ? '' : 's'} undetermined, /full`);
  } else {
    // Never "clean". The absence of a finding is the absence of a finding.
    L.push('no finding raised. that is not the same as clean, /full');
  }
  L.push('');

  // -- market ------------------------------------------------------------
  const market = opts.market ?? null;
  if (market) L.push(...marketLines(market, quote, r));

  // -- holders and buyers ------------------------------------------------
  // The tax-free set when it is only the deployer, which the findings block
  // above does not carry because it is not a finding. Same reason it is on the
  // default card: one exempt wallet is the floor, the share it took is not, and
  // a block that lists only findings was leaving the share unstated on the
  // surface a group reads. Not marked, because the floor is not a concern.
  const exempt = exemptShareLine(r);
  if (exempt) L.push(esc(exempt));
  const hb = holderBreakdown(token, k.curve);
  if (hb) {
    const top = hb.top.map((v) => `${v.toFixed(0)}%`).join(' ');
    L.push(`top5 ${top} · top10 ${hb.top10.toFixed(0)}% · ${count(hb.holders, 'holder')}`);
  }
  const w = r.traction.window;
  if (w) {
    const median = r.benchmark.median;
    L.push(
      // The window the count was taken over, not a fixed thirty: a launch two
      // minutes old has two minutes of buyers, and saying "first 30 min" over
      // them states a measurement that was never made.
      `${count(w.uniqueBuyers30m, 'buyer')} in first ${windowLabel(r.traction.windowMinutes)}`
      + (median === null
        ? r.benchmark.windowMinutes === 0
          ? ` · index median from ${windowLabel(BENCHMARK_LADDER_MINUTES[0]!)}`
          : ' · no index median yet'
        // The median is over a rung of the ladder; when that is a shorter
        // window than the count's, the line says so rather than setting two
        // figures from different windows side by side as one comparison.
        : windowLabel(r.benchmark.windowMinutes) === windowLabel(r.traction.windowMinutes)
          ? ` · index median ${median.toLocaleString()} (n=${r.benchmark.n.toLocaleString()})`
          : ` · index median ${median.toLocaleString()} over first ${windowLabel(r.benchmark.windowMinutes)} (n=${r.benchmark.n.toLocaleString()})`),
    );
  }
  L.push('');

  // -- the address, then where to go with it ------------------------------
  L.push(`<code>${token}</code>`);

  const buys = buyLinks(token);
  const buyRow = [
    ...buys.map((b) => `<a href="${esc(b.url)}">${esc(b.label)}</a>`),
    `<a href="${EXPLORER_URL}/address/${token}">explorer</a>`,
  ];
  L.push(buyRow.join(' · '));

  const chart = chartLink(token);
  const socials = k.socials ?? {};
  const linkRow = [
    ...(chart ? [`<a href="${esc(chart)}">chart</a>`] : []),
    ...(socials.twitter ? [`<a href="${esc(socials.twitter)}">X</a>`] : []),
    ...(socials.telegram ? [`<a href="${esc(socials.telegram)}">TG</a>`] : []),
    ...(socials.website ? [`<a href="${esc(socials.website)}">web</a>`] : []),
  ];
  if (linkRow.length) L.push(linkRow.join(' · '));

  // -- who called it here -------------------------------------------------
  //
  // Groups only. A DM has one reader and there is nobody to have been first in
  // front of, so the line would just be the reader's own name.
  if (opts.chatId !== undefined) {
    const call = firstCallOf(opts.chatId, token);
    if (call && call.mcapQuote !== null) {
      const who = call.username ? `@${esc(clamp(call.username, 32))}` : 'a member';
      const when = age(Math.max(0, Math.floor((opts.now ?? Date.now()) / 1000) - call.calledAt));
      L.push(`first called here by ${who} ${when} ago at ${compactAmount(call.mcapQuote)} ${esc(quote)}`);
    }
  }

  // -- footer --------------------------------------------------------------
  const bot = opts.botUsername ? `@${esc(opts.botUsername)}` : '@vitalscheck_bot';
  L.push(
    `no finding is not clean. /full. `
    + `<a href="https://t.me/${opts.botUsername ?? 'vitalscheck_bot'}?startgroup=true">${bot}, add to your group</a>`,
  );
  const notice = launchNotice(opts.now);
  if (notice) L.push(esc(notice));

  return {
    text: clampLines(L).join('\n'),
    hasMarket: market !== null,
    buttons: [[
      { text: 'Refresh', callback_data: `rf:${token}` },
      { text: 'Holders', callback_data: `hd:${token}` },
      { text: 'Full', callback_data: `fl:${token}` },
      { text: 'Image', callback_data: `img:${token}` },
    ]],
  };
}

/** Four lines, or as many of them as there is anything to say. */
function marketLines(m: MarketSnapshot, quote: string, r: ScanResult): string[] {
  const out: string[] = [];
  const q = esc(quote);
  if (m.athQuote !== null) {
    out.push(
      `ath ${compactAmount(m.athQuote)} ${q}`
      + (m.athMinutes === null ? '' : ` at +${m.athMinutes} min`)
      + ` · liquidity ${compactAmount(m.liquidityQuote)} ${q}`,
    );
  } else {
    out.push(`liquidity ${compactAmount(m.liquidityQuote)} ${q}`);
  }
  out.push(
    // How much traded, not which way it went. See the note in metrics/market.ts:
    // a quantity is evidence and a direction is a signal.
    `vol 5m ${compactAmount(m.vol5m)} · 1h ${compactAmount(m.vol1h)} ${q}`
    + ` · ${count(m.trades, 'trade')}`
    // A window measured over less than it names is still a measurement, and
    // saying so is the difference between a partial hour and an hour.
    + (m.complete ? '' : ' (partial)'),
  );
  return out;
}

/**
 * Cut to the ceiling from the BOTTOM, never the top.
 *
 * If something has to go it is the last line, not the first: the findings are
 * at the top and the whole point of the ordering is that they are never what
 * gets dropped. The footer is kept whatever else goes, because it is the line
 * that says the card is not an all-clear.
 */
export function clampLines(lines: string[], max = MAX_GROUP_LINES): string[] {
  if (lines.length <= max) return lines;
  const footerFrom = lines.findIndex((l) => l.startsWith('no finding is not clean'));
  const footer = footerFrom >= 0 ? lines.slice(footerFrom) : [];
  const body = footerFrom >= 0 ? lines.slice(0, footerFrom) : lines;
  return [...body.slice(0, Math.max(1, max - footer.length)), ...footer];
}

export { DISCLAIMER, GROUP_HANDLE };
