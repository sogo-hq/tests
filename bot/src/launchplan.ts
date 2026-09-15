import { zonedParts, LAUNCH_TZ, LAUNCH_DAYS, LAUNCH_WINDOW_START_HOUR, LAUNCH_WINDOW_END_HOUR } from './launch.js';

/**
 * The decisions the launch tool makes before it signs anything.
 *
 * Separated from the tool itself because the tool's other half is a wallet and
 * a prompt, and neither can be tested. What CAN be tested is every rule that
 * stands between a typed confirmation and a transaction: the size of the buy,
 * the hour it goes out, and whether the chain still agrees with the file the
 * numbers came from. Those live here.
 *
 * Nothing in this module reads a key, sends a transaction or talks to a node.
 */

/**
 * The most of its own supply a launch may buy for itself.
 *
 * Not a tuning parameter: it is the number the card reports about everybody
 * else, and a launch that publishes a scanner and then opens above its own
 * threshold has said one thing and done another.
 */
export const DEV_BUY_MAX_PCT = 5;

export interface LaunchSocials {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
}

export interface LaunchConfigFile {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: LaunchSocials;
  creatorFeeRecipient: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  expectedEconomics: string;
  salt: string;
  launchConfigId: number;
  pairToken: string;
  devBuyEth: string;
  minTokensOut: string;
  recipient: string;
  /** Beyond the deployer, which the tool adds itself. */
  extraExemptions: string[];
  rehearsal: { symbolSuffix: string; devBuyEth: string };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Every field, checked before anything is read from the chain.
 *
 * A launch config with a typo in an address is a launch that pays a creator fee
 * to nobody, and the place to find that out is here rather than in a receipt.
 */
export function validateConfig(raw: unknown): { ok: true; config: LaunchConfigFile } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const c = (raw ?? {}) as Record<string, any>;
  const str = (k: string) => (typeof c[k] === 'string' ? c[k] : '');

  if (!str('name').trim()) e.push('name is empty');
  if (!str('symbol').trim()) e.push('symbol is empty');
  if (str('symbol').length > 16) e.push(`symbol is ${str('symbol').length} characters, over the 16 a card renders`);
  if (!ADDRESS.test(str('creatorFeeRecipient'))) e.push('creatorFeeRecipient is not an address');
  if (!ADDRESS.test(str('recipient'))) e.push('recipient is not an address');
  if (!ADDRESS.test(str('pairToken'))) e.push('pairToken is not an address');
  // The zero address is a valid address and an irreversible mistake: creator
  // fees paid to it are gone, and a launch buy delivered to it is the supply
  // burned. Both are the kind of typo a template invites.
  if (/^0x0+$/.test(str('creatorFeeRecipient'))) e.push('creatorFeeRecipient is the zero address: the creator fee would be unrecoverable');
  if (/^0x0+$/.test(str('recipient'))) e.push('recipient is the zero address: the opening buy would be burned');
  // The curve model is calibrated on the ETH pair alone. Measured, a launch
  // against another token behaves as though its phantom quote were seventeen
  // times larger, so the opening share this tool prints would be wrong.
  if (ADDRESS.test(str('pairToken')) && !/^0x0+$/.test(str('pairToken'))) {
    e.push('pairToken is not ETH: the opening-buy model is calibrated on the ETH pair only');
  }
  if (!BYTES32.test(str('expectedEconomics'))) e.push('expectedEconomics is not a 32-byte hex value');
  if (!BYTES32.test(str('salt'))) e.push('salt is not a 32-byte hex value');
  if (!DECIMAL.test(str('devBuyEth'))) e.push('devBuyEth is not a decimal number written as a string');
  if (!/^\d+$/.test(str('minTokensOut'))) e.push('minTokensOut is not an integer written as a string');
  if (!Number.isInteger(c.creatorTaxBps) || c.creatorTaxBps < 0 || c.creatorTaxBps > 1000) {
    e.push('creatorTaxBps is not an integer in 0..1000, the factory maximum');
  }
  if (typeof c.buybackEnabled !== 'boolean') e.push('buybackEnabled is not true or false');
  if (!Number.isInteger(c.launchConfigId) || c.launchConfigId < 0) e.push('launchConfigId is not a whole number');
  const so = c.socials ?? {};
  for (const k of ['twitter', 'telegram', 'discord', 'website', 'farcaster']) {
    if (typeof so[k] !== 'string') e.push(`socials.${k} is missing; write an empty string for a social you are not giving`);
  }
  if (!Array.isArray(c.extraExemptions)) e.push('extraExemptions is not a list');
  else c.extraExemptions.forEach((a: unknown, i: number) => {
    if (typeof a !== 'string' || !ADDRESS.test(a)) e.push(`extraExemptions[${i}] is not an address`);
  });
  const r = c.rehearsal ?? {};
  if (typeof r.symbolSuffix !== 'string' || !r.symbolSuffix.trim()) {
    e.push('rehearsal.symbolSuffix is empty; a rehearsal must not carry the real ticker');
  }
  if (!DECIMAL.test(String(r.devBuyEth ?? ''))) e.push('rehearsal.devBuyEth is not a decimal number written as a string');

  return e.length ? { ok: false, errors: e } : { ok: true, config: c as LaunchConfigFile };
}

/** ETH, as a decimal string, to wei. Exact: no float ever touches the amount. */
export function toWei(decimal: string): bigint {
  const [whole, frac = ''] = decimal.split('.');
  if (frac.length > 18) throw new Error(`${decimal} has more than 18 decimal places`);
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

/** Wei to a decimal string, trimmed, with at least one decimal place. */
export function fromWei(wei: bigint, places = 6): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, places).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : '.0'}`;
}

export type Refusal = { ok: false; reason: string };
export type Allowed = { ok: true };

/**
 * The cap on the opening buy.
 *
 * Checked against the share the curve will actually pay out, never against the
 * ETH figure: the same amount of ETH is a different share of supply at a
 * different creator tax, and it is the share the card reports.
 */
export function checkDevBuyCap(supplyPct: number, maxPct = DEV_BUY_MAX_PCT): Allowed | Refusal {
  if (!Number.isFinite(supplyPct)) {
    return { ok: false, reason: 'the opening buy could not be computed, so it cannot be checked against the cap' };
  }
  if (supplyPct > maxPct) {
    return {
      ok: false,
      reason: `the opening buy takes ${supplyPct.toFixed(4)}% of supply, over the ${maxPct}% cap. `
        + 'lower devBuyEth in the config, or raise the cap deliberately and say why',
    };
  }
  return { ok: true };
}

/**
 * The launch window: Monday to Thursday, 15:00 to 18:00, in the launch zone.
 *
 * The same window the bot enforces for a scheduled launch, read from the same
 * constants, so the tool and the bot cannot disagree about when a launch may
 * go out. By zone name, never an offset: the hour is the local one in summer
 * and in winter both.
 */
export function checkLaunchWindow(nowMs: number, force = false, tz = LAUNCH_TZ): Allowed | Refusal {
  const p = zonedParts(nowMs, tz);
  const inDay = LAUNCH_DAYS.includes(p.weekday);
  const inHour = p.hour >= LAUNCH_WINDOW_START_HOUR && p.hour < LAUNCH_WINDOW_END_HOUR;
  if (inDay && inHour) return { ok: true };
  if (force) return { ok: true };
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const when = `${days[p.weekday - 1]} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${p.abbrev}`;
  return {
    ok: false,
    reason: `it is ${when}. launches go out Mon to Thu, `
      + `${LAUNCH_WINDOW_START_HOUR}:00 to ${LAUNCH_WINDOW_END_HOUR}:00 ${tz}. pass --force to go anyway`,
  };
}

export interface DiffRow {
  field: string;
  expected: string;
  /** Null when this mode has no way to observe it. */
  actual: string | null;
  same: boolean;
  /** True when the chain was not asked, as against asked and disagreeing. */
  unobserved: boolean;
}

/**
 * What the file said against what the chain says.
 *
 * Printed after every mode, including the dry run, because the point of a
 * single config file is that the rehearsal and the launch are the same launch,
 * and the only proof of that is a comparison against what actually happened.
 */
export function diffRows(
  expected: Record<string, string>,
  actual: Record<string, string | null>,
): DiffRow[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  return keys.map((field) => {
    const e = expected[field] ?? '(absent)';
    const raw = actual[field];
    // A field this mode cannot observe is not a field that disagrees. A dry run
    // reads no receipt, and counting the three figures only a receipt carries
    // as differences would make the one screen that has to be trusted cry wolf
    // every time it is run.
    const unobserved = raw === null || raw === undefined;
    return {
      field,
      expected: e,
      actual: unobserved ? null : raw as string,
      same: !unobserved && e.toLowerCase() === (raw as string).toLowerCase(),
      unobserved,
    };
  });
}

export function renderDiff(rows: DiffRow[]): string {
  const w = Math.max(...rows.map((r) => r.field.length), 8);
  const bad = rows.filter((r) => !r.same && !r.unobserved).length;
  const blind = rows.filter((r) => r.unobserved).length;
  const head = bad === 0
    ? `config vs chain: every field the chain reported matches${blind ? `, ${blind} not observable in this mode` : ''}`
    : `config vs chain: ${bad} ${bad === 1 ? 'field differs' : 'fields differ'}${blind ? `, ${blind} not observable in this mode` : ''}`;
  const out = rows.map((r) => {
    const mark = r.unobserved ? '?' : r.same ? ' ' : '!';
    if (r.unobserved) return `  ${mark} ${r.field.padEnd(w)}  ${r.expected}  (not read in this mode)`;
    if (r.same) return `  ${mark} ${r.field.padEnd(w)}  ${r.expected}`;
    return `  ${mark} ${r.field.padEnd(w)}  ${r.expected}\n    ${''.padEnd(w)}  chain: ${r.actual}`;
  });
  return [head, ...out].join('\n');
}

/**
 * The rehearsal's ticker, which is never the real one.
 *
 * A rehearsal launches a real token on the real chain. Given the production
 * ticker it would put a second token with that symbol on chain before the
 * launch, which is the exact thing the collision check on every card exists to
 * surface, and the exact thing somebody would be fooled by.
 */
export function rehearsalSymbol(symbol: string, suffix: string): string {
  return `${symbol}${suffix}`.slice(0, 16);
}
