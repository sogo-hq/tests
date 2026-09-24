import {
  LAUNCHLAB_PROGRAM, PINNED_PLATFORMS, PLATFORM_CONFIG_DISCRIMINATOR, PLATFORM_CONFIG_SIZE,
  PLATFORM_NAME_AT, PLATFORM_NAME_LEN, PLATFORM_SITE_AT, PLATFORM_SITE_LEN, UNRECOGNISED,
  isPubkey, type PinnedPlatform,
} from './config.js';
import { getProgramAccounts, type RpcOptions, type RpcResult } from './rpc.js';

/**
 * Which platform a launch came from, and whether we believe it.
 *
 * The pinned set is the only thing that names a platform. Everything here
 * either reads that set or compares chain against it; nothing in this file can
 * add to it, and that is deliberate rather than an oversight. An allowlist that
 * can grow at runtime is not an allowlist.
 */

export interface PlatformConfig {
  pubkey: string;
  /** The name the config carries TODAY. Never rendered for an unpinned key. */
  name: string;
  site: string;
}

const NUL = 0;

/** A fixed-width NUL-padded string, as the account actually stores them. */
function fixedString(b: Buffer, at: number, len: number): string {
  if (at + len > b.length) return '';
  const field = b.subarray(at, at + len);
  const end = field.indexOf(NUL);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/**
 * Decode a platform config account, or null when it is not one.
 *
 * Checks the size AND the discriminator before reading a byte of the strings.
 * An account of the right size with different contents would otherwise decode
 * into two plausible strings that mean nothing, and this path would then print
 * them beside a launch.
 */
export function decodePlatformConfig(pubkey: string, data: Buffer | string): PlatformConfig | null {
  const b = typeof data === 'string' ? Buffer.from(data, 'base64') : data;
  if (b.length !== PLATFORM_CONFIG_SIZE) return null;
  if (b.subarray(0, 8).toString('hex') !== PLATFORM_CONFIG_DISCRIMINATOR) return null;
  return {
    pubkey,
    name: fixedString(b, PLATFORM_NAME_AT, PLATFORM_NAME_LEN),
    site: fixedString(b, PLATFORM_SITE_AT, PLATFORM_SITE_LEN),
  };
}

const BY_PUBKEY = new Map(PINNED_PLATFORMS.map((p) => [p.pubkey, p]));

/** The pinned entry for a config pubkey, or null. Membership is the key alone. */
export function pinnedPlatform(pubkey: string): PinnedPlatform | null {
  return BY_PUBKEY.get(pubkey) ?? null;
}

export interface PlatformLabel {
  /** What the card prints. */
  text: string;
  recognised: boolean;
  platform: string | null;
  pubkey: string;
}

/**
 * What a card calls the platform of a launch.
 *
 * An unpinned config renders as its raw pubkey and the words "platform not
 * recognised". It never renders the config's own name, in any position,
 * including a link title or a tooltip: the name is free text an impersonator
 * chose, and printing it in our voice is repeating their claim as ours.
 *
 * The observed config is taken as an argument and deliberately ignored for
 * unpinned keys. It is there so the caller cannot be tempted to reach for it.
 */
export function platformLabel(pubkey: string, _observed?: PlatformConfig | null): PlatformLabel {
  if (!isPubkey(pubkey)) {
    return { text: UNRECOGNISED, recognised: false, platform: null, pubkey: String(pubkey) };
  }
  const pin = pinnedPlatform(pubkey);
  if (!pin) return { text: `${pubkey}, ${UNRECOGNISED}`, recognised: false, platform: null, pubkey };
  return { text: pin.platform, recognised: true, platform: pin.platform, pubkey };
}

// ------------------------------------------------------------- the diff

export type PlatformDrift =
  | { kind: 'appeared'; pubkey: string; name: string; site: string }
  | { kind: 'disappeared'; pubkey: string; platform: string; was: { name: string; site: string } }
  | {
      kind: 'renamed'; pubkey: string; platform: string;
      was: { name: string; site: string }; now: { name: string; site: string };
    };

/**
 * The pinned set against what is on chain now.
 *
 * Three cases, all reported, none acted on. The third is the one an allowlist
 * misses entirely: a pinned key that starts saying something new passes every
 * membership check, because membership was decided by the key. Catching it is
 * the only reason the pinned set stores a name and a site at all.
 *
 * "Appeared" covers a config carrying a pinned platform's site that we do not
 * carry. It is reported so it can be reviewed and pinned BY HAND, and it is
 * emphatically not evidence that the config belongs to that platform: the site
 * string is the one field an impersonator copies character for character.
 */
export function diffPlatforms(
  observed: PlatformConfig[], pinned: readonly PinnedPlatform[] = PINNED_PLATFORMS,
): PlatformDrift[] {
  const seen = new Map(observed.map((o) => [o.pubkey, o]));
  const out: PlatformDrift[] = [];

  for (const pin of pinned) {
    const now = seen.get(pin.pubkey);
    if (!now) {
      out.push({
        kind: 'disappeared', pubkey: pin.pubkey, platform: pin.platform,
        was: { name: pin.name, site: pin.site },
      });
      continue;
    }
    if (now.name !== pin.name || now.site !== pin.site) {
      out.push({
        kind: 'renamed', pubkey: pin.pubkey, platform: pin.platform,
        was: { name: pin.name, site: pin.site },
        now: { name: now.name, site: now.site },
      });
    }
  }

  const sites = new Set(pinned.map((p) => p.site));
  for (const o of observed) {
    if (BY_PUBKEY.has(o.pubkey)) continue;
    if (!sites.has(o.site)) continue;
    out.push({ kind: 'appeared', pubkey: o.pubkey, name: o.name, site: o.site });
  }
  return out;
}

/** One line per drift, for the log. Loud for the two that mean something moved. */
export function driftLines(drift: PlatformDrift[]): string[] {
  return drift.map((d) => {
    if (d.kind === 'appeared') {
      return `[solana] platform APPEARED, not pinned and not used: ${d.pubkey} `
        + `name ${JSON.stringify(d.name)} site ${JSON.stringify(d.site)}. `
        + 'review and pin by hand if it is ours. the site string is not evidence.';
    }
    if (d.kind === 'disappeared') {
      return `[solana] platform DISAPPEARED: ${d.pubkey} was ${d.platform} `
        + `(${JSON.stringify(d.was.name)}, ${JSON.stringify(d.was.site)}). `
        + 'something pinned no longer holds a platform config.';
    }
    return `[solana] platform RENAMED: ${d.pubkey} pinned as ${d.platform}, `
      + `was ${JSON.stringify(d.was.name)} at ${JSON.stringify(d.was.site)}, `
      + `now ${JSON.stringify(d.now.name)} at ${JSON.stringify(d.now.site)}. `
      + 'a pinned key saying something new passes every membership check.';
  });
}

/** Every platform config on LaunchLab, read by size and discriminator. */
export async function readPlatformConfigs(opts: RpcOptions = {}): Promise<RpcResult<PlatformConfig[]>> {
  const r = await getProgramAccounts(LAUNCHLAB_PROGRAM, [
    { dataSize: PLATFORM_CONFIG_SIZE },
    { memcmp: { offset: 0, bytes: base58OfDiscriminator() } },
  ], opts);
  if (!r.ok) return r;
  const out: PlatformConfig[] = [];
  for (const row of r.value) {
    const cfg = decodePlatformConfig(row.pubkey, row.account.data);
    if (cfg) out.push(cfg);
  }
  return { ok: true, value: out };
}

/**
 * The discriminator as base58, which is what a memcmp filter takes.
 *
 * Eight bytes, encoded here rather than pulled in: the only base58 this path
 * ever writes is this one constant, and a dependency for it would be a
 * dependency in the trust path of the allowlist.
 */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58OfDiscriminator(hex = PLATFORM_CONFIG_DISCRIMINATOR): string {
  const bytes = Buffer.from(hex, 'hex');
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = `1${s}`; else break; }
  return s || '1';
}

/**
 * Read the set at startup and log the difference. Never adds.
 *
 * Returns the drift so a caller can assert on it. A read that fails is logged
 * and returns null, which is not the same as "no drift": an unread set is
 * undetermined, and a caller that treated null as agreement would have built
 * exactly the silent failure this exists to prevent.
 */
export async function startupDiff(
  opts: RpcOptions = {}, log: (s: string) => void = console.warn,
): Promise<PlatformDrift[] | null> {
  const r = await readPlatformConfigs(opts);
  if (!r.ok) {
    log(`[solana] the platform set could not be read, so it was not checked: ${r.reason}`);
    return null;
  }
  const drift = diffPlatforms(r.value);
  if (!drift.length) {
    log(`[solana] platform set checked against chain: ${PINNED_PLATFORMS.length} pinned, no drift`);
    return drift;
  }
  for (const line of driftLines(drift)) log(line);
  return drift;
}
