import { db } from './db.js';
import { declarationFor, type Declaration } from './declare.js';
import { vitalsToken } from './tiers.js';
import { TIERS, type Tier } from './roster.js';

/**
 * The rule the room is paid by, and the signed text it has to agree with.
 *
 * The declaration is not documentation about the ledger. It is a statement
 * signed with the deployer wallet, published at a URL whose bytes are hashed
 * into the signature, and it says how the room's 10% is divided. So the ledger
 * does not merely aim to do what it says: a run whose table would pay by a
 * different rule than the one signed is refused, and refused before anybody is
 * looking at a list of wallets and amounts.
 *
 * The direction of authority is the whole point. The signed text decides, the
 * roster follows, and where they disagree the money does not move. A ledger
 * free to pay by its own rule and a declaration free to say anything are two
 * documents that agree only by luck.
 *
 * There are three answers and the third is not the second. A declaration that
 * cannot be found, or whose room block does not state a rule this code can
 * read, is UNDETERMINED: it is not a match, and it is not a contradiction
 * either. Undetermined says so on the preview and does not block the run,
 * because refusing every payout on the absence of a lookup would be a rule
 * that fails closed on the one day it has never been exercised. What it must
 * never do is print as agreement.
 */

/** Under an equal split every seat carries the same weight, and it is one. */
export const EQUAL_SHARE = 1;

export type DeclaredSplit =
  | { kind: 'equal' }
  | { kind: 'tiered'; shares: Record<Tier, number> }
  | { kind: 'unreadable'; why: string };

/**
 * The split rule, read off the room block of a signed declaration.
 *
 * Deliberately narrow. It recognises the two rules this project has actually
 * signed and nothing else, and anything it does not recognise is unreadable
 * rather than guessed at. A loose reading here would be a parser deciding how
 * to divide money from a sentence, which is the failure this whole check is
 * built to prevent.
 */
export function declaredSplit(room: string): DeclaredSplit {
  const t = String(room ?? '').toLowerCase();
  const equal = /\bsplit equally\b|\bdivided equally\b|\bequally between the seats\b|\bin equal shares\b/.test(t);
  const tiers = /\bby shares\s*\(\s*t1\s*(\d+)\s*,\s*t2\s*(\d+)\s*,\s*t3\s*(\d+)\s*\)/.exec(t);
  if (equal && tiers) {
    return { kind: 'unreadable', why: 'the room block states an equal split and a tiered one' };
  }
  if (equal) return { kind: 'equal' };
  if (tiers) {
    return { kind: 'tiered', shares: { T1: Number(tiers[1]), T2: Number(tiers[2]), T3: Number(tiers[3]) } };
  }
  return { kind: 'unreadable', why: 'the room block does not state how the share is divided' };
}

/** The percentage of gross the room is declared to be owed, or null. */
export function declaredPoolPct(room: string): number | null {
  const m = /\bowed (\d{1,3})% of the fee wallet\b/i.exec(String(room ?? ''));
  return m ? Number(m[1]) : null;
}

export interface DeclarationLookup {
  declaration: Declaration | null;
  /** Why there is none. Null when there is one. */
  reason: string | null;
}

/**
 * The signed declaration this ledger pays under, and why there is none.
 *
 * Found the same way a card finds one: the launch of the configured token, the
 * wallet that deployed it, and the most recent declaration that wallet signed
 * BEFORE that block. A statement made after the launch is a description and
 * carries no authority over a payout.
 *
 * The reason is separate for each step, and that is the point rather than a
 * detail. The chain runs through a token that does not exist until the launch
 * transaction is mined, so a run made before that can only ever be
 * undetermined. One shared "no declaration was found" would print the same
 * sentence for the Sunday rehearsal and for a Monday run where the token is
 * live, the launch is indexed and the declaration is the thing that is missing.
 * Those are not the same fact and a reader four hours into a launch has to be
 * able to tell them apart at a glance.
 */
export function ledgerDeclaration(): DeclarationLookup {
  const token = vitalsToken();
  if (!token) {
    return {
      declaration: null,
      reason: 'VITALS_TOKEN_ADDRESS is not set, so there is no launch to find a declaration for',
    };
  }
  const at = token.toLowerCase();
  const launch = db
    .prepare('SELECT deployer, block_number FROM launches WHERE token = ?')
    .get(at) as { deployer: string; block_number: number } | undefined;
  if (!launch) {
    return {
      declaration: null,
      reason: `no launch is indexed for ${at}, so there is nothing a declaration could cover yet`,
    };
  }
  const declaration = declarationFor(launch.deployer, launch.block_number);
  if (!declaration) {
    return {
      declaration: null,
      reason: `the launch of ${at} is indexed at block ${launch.block_number} `
        + 'and no declaration signed before that block covers it',
    };
  }
  return { declaration, reason: null };
}

export interface SplitRow {
  seat: number;
  tier: Tier;
  shares: number;
  amountWei: bigint;
}

export interface SplitCheck {
  state: 'match' | 'differs' | 'undetermined';
  /** One line, for a preview or a refusal. Never a verdict about anybody. */
  detail: string;
  /** What the signed text says, when it could be read. */
  declared: DeclaredSplit | null;
  declarationId: number | null;
}

/**
 * The table against the signed text.
 *
 * Checks the two things the declaration actually states: the share of gross
 * the room is owed, and how that share is divided between the seats. Both are
 * quantities on both sides, so any difference at all is a difference.
 */
export function checkAgainstDeclaration(
  rows: SplitRow[], sharePct: number, found: DeclarationLookup = ledgerDeclaration(),
): SplitCheck {
  const declaration = found.declaration;
  if (!declaration) {
    return {
      state: 'undetermined',
      detail: found.reason ?? 'no signed declaration was found for this launch',
      declared: null,
      declarationId: null,
    };
  }
  const id = declaration.id;
  const split = declaredSplit(declaration.room);
  const pct = declaredPoolPct(declaration.room);

  if (pct !== null && pct !== sharePct) {
    return {
      state: 'differs',
      detail: `declaration ${id} says the room is owed ${pct}% of gross and this run pays ${sharePct}%`,
      declared: split,
      declarationId: id,
    };
  }

  if (split.kind === 'unreadable') {
    return {
      state: 'undetermined',
      detail: `declaration ${id} was found and ${split.why}, so the split was not checked against it`,
      declared: split,
      declarationId: id,
    };
  }

  // No seats is no table, and no table cannot contradict anything.
  if (!rows.length) {
    return {
      state: 'match',
      detail: `declaration ${id}: ${describe(split)}, and there are no seats to divide between`,
      declared: split,
      declarationId: id,
    };
  }

  if (split.kind === 'equal') {
    const uneven = rows.find((r) => r.shares !== EQUAL_SHARE);
    if (uneven) {
      return {
        state: 'differs',
        detail: `declaration ${id} says the room's share is split equally, and seat ${uneven.seat} `
          + `would be paid by ${uneven.shares} shares`,
        declared: split,
        declarationId: id,
      };
    }
    const first = rows[0]!.amountWei;
    const odd = rows.find((r) => r.amountWei !== first);
    if (odd) {
      return {
        state: 'differs',
        detail: `declaration ${id} says the room's share is split equally, and seat ${odd.seat} `
          + 'would be paid a different amount from seat ' + rows[0]!.seat,
        declared: split,
        declarationId: id,
      };
    }
    return {
      state: 'match',
      detail: `declaration ${id}: equal split, ${rows.length} seat${rows.length === 1 ? '' : 's'} held today`,
      declared: split,
      declarationId: id,
    };
  }

  const wrong = rows.find((r) => r.shares !== split.shares[r.tier]);
  if (wrong) {
    return {
      state: 'differs',
      detail: `declaration ${id} says ${describe(split)}, and seat ${wrong.seat} is ${wrong.tier} `
        + `and would be paid by ${wrong.shares} shares`,
      declared: split,
      declarationId: id,
    };
  }
  return {
    state: 'match',
    detail: `declaration ${id}: ${describe(split)}, ${rows.length} seat${rows.length === 1 ? '' : 's'} held today`,
    declared: split,
    declarationId: id,
  };
}

function describe(split: DeclaredSplit): string {
  if (split.kind === 'equal') return 'equal split';
  if (split.kind === 'tiered') return `shares ${TIERS.map((t) => `${t} ${split.shares[t]}`).join(', ')}`;
  return split.why;
}

/**
 * The refusal a differing split produces, or null.
 *
 * Phrased at the person who can fix it, and it names both sides, because the
 * answer is sometimes to move the roster and sometimes to sign a new
 * declaration, and which one is never this code's call.
 */
export function splitRefusal(check: SplitCheck): string | null {
  if (check.state !== 'differs') return null;
  return `${check.detail}. a payout that contradicts a signed declaration does not go out. `
    + 'either the roster moves to what was signed, or a new declaration is signed before the next run.';
}

/** The line a preview and a payout post carry, whatever the state. */
export function splitLine(check: SplitCheck): string {
  if (check.state === 'undetermined') return `split not checked: ${check.detail}`;
  return check.detail;
}
