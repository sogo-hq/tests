import { quoteLaunchBuy, type CurveConfig } from './curve.js';
import { DEV_BUY_MAX_PCT, type LaunchConfigFile } from './launchplan.js';

/**
 * The pre-flight on launch.config.json.
 *
 * Everything here is a verdict on a value in that file, so it can be checked
 * on a Sunday with no key in the shell and no intention of sending anything.
 * Nothing in this module signs, sends, or reads a key; the only thing the tool
 * adds around it is fetching the image and asking the chain for the address
 * the salt produces.
 *
 * The expected values are written down rather than passed in. A pre-flight
 * that takes what to expect as an argument checks that the file agrees with
 * itself, which is not the question.
 */

/** The wallet that deploys, receives the opening buy and takes the creator fee. */
export const EXPECTED_DEPLOYER = '0x447c8dc55B88C09830E123f9fB3e7C484714ED93';
export const EXPECTED_TAX_BPS = 400;
export const EXPECTED_DEV_BUY_ETH = '0.0930';
export const EXPECTED_CONFIG_ID = 0;
export const ETH_PAIR = '0x0000000000000000000000000000000000000000';

/** Where the three socials must point. Checked by host, not by exact string. */
export const EXPECTED_SOCIALS = {
  website: 'checkvitals.xyz',
  twitter: 'x.com/vitalsxyz',
  telegram: 't.me/vitalsofficial',
} as const;

/** An image over this is too heavy for a card and for most clients. */
export const MAX_IMAGE_BYTES = 1_000_000;

/**
 * The longest description seen on this chain, measured over the last thirty
 * decoded launches: 152 characters.
 *
 * Pons does not publish a limit, and the factory does not expose one, so this
 * is an observation and is labelled as one. Over it is a warning rather than a
 * failure, because the only thing that can actually reject the string is the
 * transaction, and the dry run is what asks it.
 */
export const OBSERVED_MAX_DESCRIPTION = 152;

/** The salt shipped in the example. A launch that goes out with it is not ours. */
export const EXAMPLE_SALT = '0x766974616c732d6c61756e63682d73616c742d76312d6368616e67652d6d6521';

export type Verdict = 'pass' | 'fail' | 'warn' | 'unknown';

export interface CheckRow {
  field: string;
  value: string;
  verdict: Verdict;
  note: string;
}

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Does a URL point at this host, whatever scheme or path it carries? */
export function pointsAt(value: string, host: string): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const h = host.toLowerCase();
  return v === h || v.startsWith(`${h}/`) || v.startsWith(`${h}?`);
}

/**
 * Every field of the config, with a verdict.
 *
 * The image and the deterministic address are not here: one needs a gateway
 * and the other needs the chain, and both are the tool's job. What comes back
 * is a list in the order a person would read it.
 */
export function checkConfig(cfg: LaunchConfigFile, curve: CurveConfig | null): CheckRow[] {
  const rows: CheckRow[] = [];
  const add = (field: string, value: unknown, verdict: Verdict, note: string) =>
    rows.push({ field, value: String(value ?? ''), verdict, note });

  add('name', cfg.name, cfg.name.trim() && !/change.?me/i.test(cfg.name) ? 'pass' : 'fail',
    cfg.name.trim() ? '' : 'empty');
  add('symbol', cfg.symbol,
    cfg.symbol.trim() && cfg.symbol.length <= 16 && !/change.?me/i.test(cfg.symbol) ? 'pass' : 'fail',
    `${cfg.symbol.length} characters, the card renders 16`);

  // The image itself is fetched by the tool; this is the reference to it.
  const logo = (cfg.logo ?? '').trim();
  add('logo', logo,
    !logo || /change.?me/i.test(logo) ? 'fail' : /^ipfs:\/\/[A-Za-z0-9]+/.test(logo) ? 'pass' : 'warn',
    !logo ? 'empty' : /change.?me/i.test(logo) ? 'still the placeholder'
      : /^ipfs:\/\//.test(logo) ? '' : 'not an ipfs:// reference, so it depends on a host staying up');

  const desc = (cfg.description ?? '').trim();
  add('description', desc.length > 60 ? `${desc.slice(0, 57)}...` : desc,
    !desc || /change.?me/i.test(desc) ? 'fail' : desc.length > OBSERVED_MAX_DESCRIPTION ? 'warn' : 'pass',
    !desc ? 'empty'
      : /change.?me/i.test(desc) ? 'still the placeholder'
      : desc.length > OBSERVED_MAX_DESCRIPTION
        ? `${desc.length} characters. pons publishes no limit; the longest seen on chain is ${OBSERVED_MAX_DESCRIPTION}. the dry run is what would reject it`
        : `${desc.length} characters`);

  const salt = (cfg.salt ?? '').trim();
  const defaulted = eq(salt, EXAMPLE_SALT) || /^0x0+$/.test(salt);
  add('salt', salt, defaulted ? 'fail' : 'pass',
    defaulted ? 'still the example salt, which decides the token address' : 'set, and not the example');

  // The size of the opening buy, from the curve rather than from a table.
  const devBuy = (cfg.devBuyEth ?? '').trim();
  if (!curve) {
    add('devBuyEth', devBuy, 'unknown', 'the launch config could not be read from the factory, so the share is not known');
  } else {
    const wei = toWeiSafe(devBuy);
    const q = wei === null ? null : quoteLaunchBuy(curve, BigInt(cfg.creatorTaxBps), wei);
    if (!q) add('devBuyEth', devBuy, 'fail', 'not a number');
    else {
      const overCap = q.supplyPct > DEV_BUY_MAX_PCT;
      const expected = eq(devBuy, EXPECTED_DEV_BUY_ETH);
      add('devBuyEth', devBuy,
        overCap ? 'fail' : expected ? 'pass' : 'warn',
        `${q.supplyPct.toFixed(4)}% of supply at ${cfg.creatorTaxBps} bps`
        + (overCap ? `, over the ${DEV_BUY_MAX_PCT}% cap` : `, under the ${DEV_BUY_MAX_PCT}% cap`)
        + (expected ? '' : `. expected ${EXPECTED_DEV_BUY_ETH}`));
    }
  }

  add('creatorTaxBps', cfg.creatorTaxBps, cfg.creatorTaxBps === EXPECTED_TAX_BPS ? 'pass' : 'fail',
    `${cfg.creatorTaxBps / 100}%, expected ${EXPECTED_TAX_BPS / 100}%`);
  add('creatorFeeRecipient', cfg.creatorFeeRecipient, eq(cfg.creatorFeeRecipient, EXPECTED_DEPLOYER) ? 'pass' : 'fail',
    eq(cfg.creatorFeeRecipient, EXPECTED_DEPLOYER) ? '' : `expected ${EXPECTED_DEPLOYER}`);
  add('recipient', cfg.recipient, eq(cfg.recipient, EXPECTED_DEPLOYER) ? 'pass' : 'fail',
    eq(cfg.recipient, EXPECTED_DEPLOYER) ? 'receives the opening buy' : `expected ${EXPECTED_DEPLOYER}`);
  add('pairToken', cfg.pairToken, eq(cfg.pairToken, ETH_PAIR) ? 'pass' : 'fail',
    eq(cfg.pairToken, ETH_PAIR) ? 'ETH' : 'not the ETH pair');
  add('launchConfigId', cfg.launchConfigId, cfg.launchConfigId === EXPECTED_CONFIG_ID ? 'pass' : 'fail',
    `the only config the factory accepts is ${EXPECTED_CONFIG_ID}`);
  add('buybackEnabled', cfg.buybackEnabled, 'pass', cfg.buybackEnabled ? 'creator fees vest' : 'no buyback vest');

  const extra = cfg.extraExemptions ?? [];
  add('extraExemptions', extra.length ? extra.join(' ') : '(none)', extra.length === 0 ? 'pass' : 'fail',
    extra.length === 0
      ? 'the deployer alone, which the protocol exempts anyway'
      : `${extra.length} wallet${extra.length === 1 ? '' : 's'} beyond the deployer would be tax free at launch`);

  // The create path carries socials: the launch params tuple has a socials
  // struct, and 28 of the last 30 launches on this chain filled at least one.
  const socials = cfg.socials;
  for (const key of Object.keys(EXPECTED_SOCIALS) as Array<keyof typeof EXPECTED_SOCIALS>) {
    const host = EXPECTED_SOCIALS[key];
    const v = (socials?.[key] ?? '').trim();
    add(`socials.${key}`, v || '(empty)', pointsAt(v, host) ? 'pass' : 'fail',
      pointsAt(v, host) ? 'carried in the launch calldata' : `expected ${host}`);
  }

  return rows;
}

function toWeiSafe(decimal: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(decimal.trim())) return null;
  const [whole, frac = ''] = decimal.trim().split('.');
  if (frac.length > 18) return null;
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

// ------------------------------------------------------------------- images

export interface ImageInfo {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | null;
  width: number | null;
  height: number | null;
  bytes: number;
}

/**
 * Format and dimensions from the header alone.
 *
 * Header parsing rather than a decoder: the question is whether the logo is a
 * square under a megabyte, and pulling an image library into a launch tool to
 * answer it would be a dependency on the one path that has to work.
 */
export function imageInfo(buf: Uint8Array): ImageInfo {
  const bytes = buf.length;
  const be16 = (i: number) => (buf[i]! << 8) | buf[i + 1]!;
  const be32 = (i: number) => ((buf[i]! << 24) | (buf[i + 1]! << 16) | (buf[i + 2]! << 8) | buf[i + 3]!) >>> 0;
  const le16 = (i: number) => buf[i]! | (buf[i + 1]! << 8);
  const ascii = (i: number, n: number) => String.fromCharCode(...buf.slice(i, i + n));

  if (bytes >= 24 && be32(0) === 0x89504e47 && be32(4) === 0x0d0a1a0a) {
    return { format: 'png', width: be32(16), height: be32(20), bytes };
  }
  if (bytes >= 10 && ascii(0, 3) === 'GIF') {
    return { format: 'gif', width: le16(6), height: le16(8), bytes };
  }
  if (bytes >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') return { format: 'webp', width: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)), height: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)), bytes };
    if (chunk === 'VP8 ') return { format: 'webp', width: le16(26) & 0x3fff, height: le16(28) & 0x3fff, bytes };
    if (chunk === 'VP8L') {
      const b = buf[21]! | (buf[22]! << 8) | (buf[23]! << 16) | (buf[24]! << 24);
      return { format: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, bytes };
    }
    return { format: 'webp', width: null, height: null, bytes };
  }
  if (bytes >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      // Start of frame, in every flavour that carries dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: 'jpeg', height: be16(i + 5), width: be16(i + 7), bytes };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + be16(i + 2);
    }
    return { format: 'jpeg', width: null, height: null, bytes };
  }
  return { format: null, width: null, height: null, bytes };
}

/** The verdict on a fetched logo: square, under a megabyte, an image at all. */
export function checkImage(info: ImageInfo): { verdict: Verdict; note: string } {
  if (!info.format) return { verdict: 'fail', note: `${info.bytes} bytes, and not a png, jpeg, gif or webp` };
  const parts = [`${info.format}`, `${(info.bytes / 1024).toFixed(0)} KB`];
  if (info.width === null || info.height === null) {
    return { verdict: 'warn', note: `${parts.join(', ')}, dimensions unreadable from the header` };
  }
  parts.splice(1, 0, `${info.width}x${info.height}`);
  const square = info.width === info.height;
  const small = info.bytes <= MAX_IMAGE_BYTES;
  if (square && small) return { verdict: 'pass', note: parts.join(', ') };
  const why = [!square ? 'not square' : '', !small ? `over ${MAX_IMAGE_BYTES / 1000} KB` : ''].filter(Boolean);
  return { verdict: 'fail', note: `${parts.join(', ')}, ${why.join(' and ')}` };
}
