import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './config.js';
import { getAccount, type AccountInfo, type RpcOptions, type RpcResult } from './rpc.js';

/**
 * What a mint can do to its holders, read off the mint.
 *
 * Every card reads its quote asset, not only the ones that look wrong. The
 * split between a fact line and a flag is the whole design here and it is not
 * about severity, it is about who can do what:
 *
 *   freeze authority  a fact. Almost every serious quote asset has one, and a
 *                     line that flags the norm teaches the reader to ignore
 *                     flags.
 *   permanent delegate  a flag. The issuer can move the asset out of any
 *                     wallet without the holder.
 *   pausable          a flag. The issuer can stop the asset moving at all.
 *
 * Freezing one account and being able to take the asset from every account are
 * different orders of thing, and the card says so by putting them in different
 * places rather than by adjective.
 */

/** The base mint layout, the same in both token programs. */
const MINT_LEN = 82;
const MINT_AUTH_AT = 0;       // COption<Pubkey>: 4 byte tag then 32
const SUPPLY_AT = 36;
const DECIMALS_AT = 44;
const FREEZE_AUTH_AT = 46;    // COption<Pubkey>
/** Token-2022 puts a one byte account type here before the extension list. */
const ACCOUNT_TYPE_AT = 165;
const EXTENSIONS_AT = 166;

/**
 * Extension discriminators, from the Token-2022 program.
 *
 * Only the ones this path renders are named. An extension that is present and
 * not in this table is reported by its number rather than dropped: a mint
 * carrying something we cannot name is a fact about the mint, and silence
 * would render it identically to a mint carrying nothing.
 */
export const EXTENSION_NAMES: Record<number, string> = {
  1: 'transferFeeConfig',
  2: 'transferFeeAmount',
  3: 'mintCloseAuthority',
  4: 'confidentialTransferMint',
  5: 'confidentialTransferAccount',
  6: 'defaultAccountState',
  7: 'immutableOwner',
  8: 'memoTransfer',
  9: 'nonTransferable',
  10: 'interestBearingConfig',
  11: 'cpiGuard',
  12: 'permanentDelegate',
  13: 'nonTransferableAccount',
  14: 'transferHook',
  15: 'transferHookAccount',
  16: 'confidentialTransferFeeConfig',
  17: 'confidentialTransferFeeAmount',
  18: 'metadataPointer',
  19: 'tokenMetadata',
  20: 'groupPointer',
  21: 'tokenGroup',
  22: 'groupMemberPointer',
  23: 'tokenGroupMember',
  24: 'confidentialMintBurn',
  25: 'scaledUiAmountConfig',
  26: 'pausableConfig',
  27: 'pausableAccount',
};

/** The two that change what the issuer can do to a holder. */
export const FLAG_EXTENSIONS = ['permanentDelegate', 'pausableConfig'] as const;

export interface ScheduledFee {
  epoch: bigint;
  basisPoints: number;
  maximumFee: bigint;
}

export interface TransferFee {
  /** The newer of the two scheduled rates. Use feeAtEpoch for a given epoch. */
  basisPoints: number;
  /** The cap, in base units. Observed uncapped on every reward launch read. */
  maximumFee: bigint;
  /** Who may change the rate afterwards, or null when nobody can. */
  configAuthority: string | null;
  withdrawAuthority: string | null;
  older: ScheduledFee;
  newer: ScheduledFee;
}

export interface MintReading {
  mint: string;
  program: 'token' | 'token-2022';
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Every extension present, named where we know the name. */
  extensions: string[];
  /** The extensions that mean the issuer can take or halt the asset. */
  flagged: string[];
  transferFee: TransferFee | null;
}

function coption(b: Buffer, at: number): string | null {
  if (at + 36 > b.length) return null;
  const tag = b.readUInt32LE(at);
  if (tag !== 1) return null;
  return bs58(b.subarray(at + 4, at + 36));
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** 32 bytes to base58. The only encoder this path needs. */
export function bs58(bytes: Buffer): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = `1${s}`; else break; }
  return s || '1';
}

/**
 * Read a mint account.
 *
 * Returns null only when the bytes are not a mint at all. Everything it cannot
 * determine within a mint it reports as null on that field rather than as a
 * zero, because a zero here reads as "no authority" and that is a claim.
 */
export function decodeMint(mint: string, account: AccountInfo): MintReading | null {
  const b = Buffer.from(account.data, 'base64');
  if (b.length < MINT_LEN) return null;
  const program = account.owner === TOKEN_2022_PROGRAM ? 'token-2022'
    : account.owner === TOKEN_PROGRAM ? 'token' : null;
  if (!program) return null;

  const reading: MintReading = {
    mint,
    program,
    decimals: b.readUInt8(DECIMALS_AT),
    supply: b.readBigUInt64LE(SUPPLY_AT),
    mintAuthority: coption(b, MINT_AUTH_AT),
    freezeAuthority: coption(b, FREEZE_AUTH_AT),
    extensions: [],
    flagged: [],
    transferFee: null,
  };
  if (program === 'token' || b.length <= EXTENSIONS_AT) return reading;
  // A Token-2022 mint with extensions is padded past the base layout and
  // carries an account type byte; 1 is Mint. Anything else is not a mint
  // extension list and is left alone rather than walked.
  if (b.readUInt8(ACCOUNT_TYPE_AT) !== 1) return reading;

  let at = EXTENSIONS_AT;
  const seen: string[] = [];
  while (at + 4 <= b.length) {
    const type = b.readUInt16LE(at);
    const len = b.readUInt16LE(at + 2);
    const body = at + 4;
    if (body + len > b.length) break;
    // Type 0 is Uninitialized: the list is over.
    if (type === 0 && len === 0) break;
    const name = EXTENSION_NAMES[type] ?? `extension ${type}`;
    seen.push(name);
    if (name === 'transferFeeConfig') reading.transferFee = decodeTransferFee(b, body, len);
    at = body + len;
  }
  reading.extensions = seen;
  reading.flagged = seen.filter((e) => (FLAG_EXTENSIONS as readonly string[]).includes(e));
  return reading;
}

/**
 * The transfer fee the mint carries.
 *
 * Two traps in this struct, both of which produce a plausible wrong number
 * rather than an error:
 *
 *   The two authorities are OptionalNonZeroPubkey, which is 32 bytes with
 *   all-zero meaning none. It is NOT the 4-byte-tagged COption the base mint
 *   layout uses. Reading it as one shifts everything after it by eight bytes
 *   and yields rates like 42922 basis points, which is not a rate at all.
 *
 *   The extension holds an older and a newer config, each with the epoch it
 *   takes effect in. Which one is live depends on the epoch NOW, so a caller
 *   that knows it says so and one that does not gets both and is told which
 *   was used. Printing the newer unconditionally states next epoch's rate as
 *   today's on any mint whose fee has been scheduled to change.
 */
function decodeTransferFee(b: Buffer, at: number, len: number): TransferFee | null {
  if (len < 108 || at + 108 > b.length) return null;
  const optionalPubkey = (o: number): string | null => {
    const raw = b.subarray(o, o + 32);
    return raw.every((x) => x === 0) ? null : bs58(raw);
  };
  const configAuthority = optionalPubkey(at);
  const withdrawAuthority = optionalPubkey(at + 32);
  const read = (o: number) => ({
    epoch: b.readBigUInt64LE(o),
    maximumFee: b.readBigUInt64LE(o + 8),
    basisPoints: b.readUInt16LE(o + 16),
  });
  const older = read(at + 72);
  const newer = read(at + 90);
  return {
    basisPoints: newer.basisPoints,
    maximumFee: newer.maximumFee,
    configAuthority,
    withdrawAuthority,
    older: { epoch: older.epoch, basisPoints: older.basisPoints, maximumFee: older.maximumFee },
    newer: { epoch: newer.epoch, basisPoints: newer.basisPoints, maximumFee: newer.maximumFee },
  };
}

/**
 * The rate in effect at a given epoch.
 *
 * Separate from the read, so the figure a card prints is always one somebody
 * asked for at a stated moment rather than whichever of the two happened to be
 * second in the struct.
 */
export function feeAtEpoch(fee: TransferFee, epoch: bigint): number {
  return epoch >= fee.newer.epoch ? fee.newer.basisPoints : fee.older.basisPoints;
}

/** Read a mint from chain. Undetermined with a reason rather than a guess. */
export async function readMint(
  mint: string, opts: RpcOptions = {},
): Promise<RpcResult<MintReading | null>> {
  const r = await getAccount(mint, opts);
  if (!r.ok) return r;
  if (!r.value) return { ok: true, value: null };
  return { ok: true, value: decodeMint(mint, r.value) };
}

/**
 * The lines a card prints about a quote asset.
 *
 * Facts and flags kept apart, and an absent reading says it is undetermined
 * rather than saying nothing. A quote asset nobody could read renders as a
 * quote asset nobody could read.
 */
export function quoteLines(
  mint: string, reading: MintReading | null, reason: string | null = null,
): { facts: string[]; flags: string[] } {
  if (!reading) {
    return {
      facts: [`quote ${mint}: could not be read, undetermined${reason ? `, ${reason}` : ''}`],
      flags: [],
    };
  }
  const facts = [
    `quote ${reading.mint}`,
    `freeze authority: ${reading.freezeAuthority ? 'yes' : 'no'}`,
    `mint authority: ${reading.mintAuthority ? 'yes' : 'no'}`,
  ];
  const flags: string[] = [];
  if (reading.flagged.includes('permanentDelegate')) {
    flags.push('permanent delegate: the issuer can move this asset out of any wallet');
  }
  if (reading.flagged.includes('pausableConfig')) {
    flags.push('pausable: the issuer can stop this asset moving');
  }
  return { facts, flags };
}
