import { recoverMessageAddress, isAddress, getAddress, type Hex } from 'viem';
import { createHash, randomBytes } from 'node:crypto';
import { splitVerbatim, TELEGRAM_MAX_MESSAGE } from './text.js';
import { db } from './db.js';
import { client } from './chain.js';
import { effectiveTier, atLeast, vitalsBalance, tierForBalance } from './tiers.js';

/**
 * Declared launches.
 *
 * A creator states, before launching, what the launch will do: how much of the
 * supply they will take, which wallets skip the opening tax, what the creator
 * tax is and where it goes, and what happens to any team tokens. They sign it
 * with the wallet that will deploy, and the bot stores the signature with the
 * block it arrived at.
 *
 * The declaration is never evidence about the chain. Every figure on every card
 * is still read from the launch transaction, and where the two disagree the
 * disagreement is itself a finding: a declaration can only ever add a line, it
 * can never remove one or soften one. That is the whole design. A badge that
 * could quiet a check would be worth buying, and this one is worth nothing
 * except to a creator who intends to keep to it.
 */

/** The first N declarations cost nothing, and say so on the card. */
export const DECLARE_FREE_UNTIL = (() => {
  const raw = Number(process.env.DECLARE_FREE_UNTIL);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 100;
})();

/**
 * The one character the bot never prints, built rather than written.
 *
 * These fields are quoted back on a card and into the canonical text, so a
 * creator pasting one would put it in the bot's own output. Constructed from
 * its code point because the source sweep that enforces the rule reads the
 * source, and a literal here would be indistinguishable from a violation.
 */
const EM_DASH = String.fromCharCode(0x2014);

/**
 * Every free text field is bounded, and bounded the same way.
 *
 * A room's terms or a fee-share policy does not fit in a slogan and is not
 * worth signing if it has to be abbreviated into one. Bounded anyway: what is
 * signed has to stay readable by the person signing it.
 */
export const MAX_BLOCK_TEXT = 700;

/**
 * The single-line fields used to stop at 120 characters.
 *
 * That was below what the form asks for. The vesting question asks who the dev
 * buy is for, when it vests and what moves at launch, which is three clauses,
 * and 120 characters refuses a straight answer to it. A cap that rejects the
 * answer its own prompt requested is not a cap, it is a trap: the rejection
 * re-asks, the next message lands in the slot the rejected one was meant for,
 * and everything after it is one step out. Same bound as a block now, so the
 * only reason to be refused is writing more than fits on a page.
 */
export const MAX_FREE_TEXT = MAX_BLOCK_TEXT;

/** Each "declared:" line on a card, so it cannot push a finding off it. */
export const MAX_DECLARED_LINE = 59;

export interface Declaration {
  id: number;
  deployer: string;
  declaredBy: number;
  declaredAtSeconds: number;
  blockNumber: number;
  devBuyPct: number;
  exemptList: string[];
  exemptCount: number;
  creatorTaxBps: number;
  taxSplit: string;
  vesting: string;
  /** Optional blocks. Empty means the line is absent from the signed text. */
  room: string;
  holderFeeShare: string;
  docsUrl: string;
  /** sha256 of the docs page as it was when the draft was built, or ''. */
  docsSha256: string;
  canonical: string;
  signature: string;
  freeSlot: number | null;
}

export interface DeclarationAnswers {
  deployer: string;
  devBuyPct: number;
  exemptList: string[];
  creatorTaxBps: number;
  taxSplit: string;
  vesting: string;
  room: string;
  holderFeeShare: string;
  docsUrl: string;
  docsSha256: string;
}

// ------------------------------------------------------------------ the form

export type StepKey =
  | 'deployer' | 'devBuy' | 'exemptions' | 'tax' | 'vesting' | 'room' | 'holderFeeShare' | 'docs';

export interface Step {
  key: StepKey;
  prompt: string;
  /**
   * `sofar` is what the form has already been told, so a step can refuse an
   * answer that contradicts an earlier one. Only the vesting step uses it, and
   * it is the whole reason "team tokens: none" cannot be signed beside a dev
   * buy any more.
   */
  parse(input: string, sofar?: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; error: string };
}

/**
 * The wallets exempt BESIDES the deployer.
 *
 * The deployer is exempt by the protocol, is counted separately everywhere it
 * is counted, and is the address a creator is most likely to paste here,
 * because the question is about exemptions and theirs is the one they know.
 * Naming it used to put it in the list as well: the signed text then read
 * "the deployer and 1 other" above the deployer's own address, and the count
 * signed was 2 against a chain that would show 1. So it is taken out here,
 * where the answer is read, rather than explained away later.
 */
function parseAddressList(
  input: string, sofar?: Record<string, unknown>,
): { ok: true; value: string[] } | { ok: false; error: string } {
  const t = input.trim();
  const deployer = typeof sofar?.deployer === 'string' ? sofar.deployer.toLowerCase() : null;
  if (/^(dev wallet only|deployer only|none|just the dev|just me)$/i.test(t)) return { ok: true, value: [] };
  // An empty answer is not an answer. It used to mean "no exemptions", which
  // is a claim about the launch made by somebody who typed nothing.
  if (!t) return { ok: false, error: 'addresses, or say: dev wallet only' };
  const found = t.split(/[\s,;]+/).filter(Boolean);
  const out: string[] = [];
  for (const raw of found) {
    if (!isAddress(raw)) return { ok: false, error: `not an address: ${raw.slice(0, 24)}` };
    const a = getAddress(raw).toLowerCase();
    if (a === deployer) continue;
    if (!out.includes(a)) out.push(a);
  }
  // The protocol caps exemptions at 32, the deployer among them.
  if (out.length > 31) return { ok: false, error: 'more wallets than the curve can exempt' };
  return { ok: true, value: out };
}

/** The list with the deployer taken out, wherever it is read from. */
export function othersThanDeployer(deployer: string, list: string[]): string[] {
  const d = deployer.toLowerCase();
  const out: string[] = [];
  for (const w of list) {
    const a = String(w).toLowerCase();
    if (a === d || out.includes(a)) continue;
    out.push(a);
  }
  return out;
}

/**
 * Answers that claim there is nothing to declare.
 *
 * Deliberately broad. The point is not to catch every phrasing, it is that the
 * obvious ones stop being available to somebody filling the form in thirty
 * seconds, which is when this line used to get answered wrongly.
 */
const NOTHING_ALLOCATED =
  /^(none|no team( allocation| tokens)?|nothing|n\/?a|zero|0|no allocation|nil)\.?$/i;

function parseFreeText(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const t = input.trim().replace(/\s+/g, ' ');
  if (!t) return { ok: false, error: 'say something, or say none' };
  if (t.length > MAX_FREE_TEXT) return { ok: false, error: tooLong(t.length, MAX_FREE_TEXT) };
  return { ok: true, value: withoutEmDash(t) };
}

/**
 * How far over, not just that it is over.
 *
 * The old message named the length and the limit and left the subtraction to
 * somebody halfway through a form. Given the number to cut, a person cuts
 * exactly that much off the end, which is what happened to the last clause of
 * a room block: 736 characters, 36 over, and the clause deleted to fit was 62.
 * Nothing shortened it; the bound did, through the person holding the keyboard.
 */
function tooLong(length: number, max: number): string {
  return `${length} characters, ${length - max} over. keep it under ${max}`;
}

/**
 * The one character the bot never prints, taken out of somebody else's text.
 *
 * The spaces around it go with it: "50 seats <dash> no more" became
 * "50 seats , no more", which is the bot printing a typo instead of a dash.
 */
function withoutEmDash(t: string): string {
  return t.split(new RegExp(`\\s*${EM_DASH}\\s*`)).join(', ');
}

/**
 * An optional block: several sentences, possibly several lines, or nothing.
 *
 * Kept verbatim apart from trailing space and the em dash, because the value
 * IS the line that gets signed. Collapsing its newlines the way parseFreeText
 * does would silently rewrite a declaration between the draft a person read
 * and the text they signed.
 */
function parseBlock(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const t = input.trim().split('\r\n').join('\n').split('\n').map((l) => l.trim()).join('\n');
  // Blank, or an explicit skip. Both mean the line is left out entirely, which
  // is not the same as declaring it empty.
  if (!t || /^(skip|none|no|n\/?a|nothing)\.?$/i.test(t)) return { ok: true, value: '' };
  if (t.length > MAX_BLOCK_TEXT) return { ok: false, error: tooLong(t.length, MAX_BLOCK_TEXT) };
  return { ok: true, value: withoutEmDash(t) };
}

export const STEPS: Step[] = [
  {
    key: 'deployer',
    prompt: 'the wallet that will deploy the token. it has to be the one that signs this, later.',
    parse: (input) => {
      const t = input.trim();
      if (!isAddress(t)) return { ok: false, error: 'that is not an address' };
      return { ok: true, value: getAddress(t).toLowerCase() };
    },
  },
  {
    key: 'devBuy',
    prompt: 'the buy you plan to make yourself, as a percentage of supply. 0 if none.',
    parse: (input) => {
      // Spelled out rather than handed to Number, which reads '' and '  ' as
      // zero and '0x10' as sixteen. A blank message must never become a
      // declared dev buy of 0% of supply.
      const t = input.trim().replace(/\s*%$/, '');
      if (!/^\d{1,3}(\.\d{1,4})?$/.test(t)) return { ok: false, error: 'a percentage between 0 and 100, digits only' };
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: 'a percentage between 0 and 100' };
      return { ok: true, value: Math.round(n * 100) / 100 };
    },
  },
  {
    key: 'exemptions',
    prompt: 'every wallet that will skip the opening tax, besides the deployer. '
      + 'addresses, space separated, or say: dev wallet only',
    parse: parseAddressList,
  },
  {
    key: 'tax',
    prompt: 'the creator tax in basis points, then where it goes. '
      + 'example: 400, half to the artist and half to the treasury',
    parse: (input) => {
      const t = input.trim();
      const m = /^(\d{1,5})\s*(bps?\b|%)?\s*[,.:]?\s*([\s\S]*)$/i.exec(t);
      if (!m) return { ok: false, error: 'start with the number of basis points' };
      // A leading percentage is not a rate in basis points, and reading it as
      // one both changes the figure and eats a digit: "10% the room, 10%
      // ecosystem" was read as 10 bps with a split of "% the room, ...". The
      // conversion is obvious and is still refused, because guessing which unit
      // somebody meant is guessing at the number they are about to sign.
      if (m[2] === '%') {
        return {
          ok: false,
          error: `basis points, not a percentage. ${m[1]}% is ${Number(m[1]) * 100} bps, `
            + 'and this question wants the creator tax, not the split',
        };
      }
      const bps = Number(m[1]);
      if (!Number.isFinite(bps) || bps > 10_000) return { ok: false, error: 'basis points, 0 to 10000' };
      // A bare number used to be accepted, with the words "not stated" put in
      // where the split should be, and the form moved on. Two things went
      // wrong at once: a phrase nobody typed went into a text somebody signed,
      // and the split they typed next landed in the following answer, which
      // put it on the dev buy line. The form asks two things and it takes two.
      if (!m[3]!.trim()) {
        return {
          ok: false,
          error: `${bps} bps is the rate, and this question also asks where it goes. `
            + 'say both on one line, for example: 400, 10% the room, 10% ecosystem, '
            + '80% the build. if none of it is taken, say that in words',
        };
      }
      const rest = parseFreeText(m[3]!);
      if (!rest.ok) return rest;
      return { ok: true, value: { bps, split: rest.value } };
    },
  },
  {
    key: 'vesting',
    prompt: 'what the dev buy holds and what happens to it: who it is for, when it '
      + 'vests, what moves at launch. a dev buy is a team allocation, so if you bought '
      + 'any, "none" is not an answer to this.',
    parse: (input, sofar) => {
      const parsed = parseFreeText(input);
      if (!parsed.ok) return parsed;
      // A declaration saying "team tokens: none" beside a dev buy of 5% is
      // false on its face: the dev buy IS the allocation, sitting in the
      // deployer wallet under no lock at all. It was the one line on the form
      // a creator could answer honestly and still mislead, so it is refused
      // rather than quoted back onto a card.
      const bought = Number(sofar?.devBuy ?? 0);
      if (bought > 0 && NOTHING_ALLOCATED.test(parsed.value)) {
        return {
          ok: false,
          error: `you declared a dev buy of ${bought}% of supply, and that is the team `
            + 'allocation. say where those tokens sit, who they are for and when they move',
        };
      }
      return parsed;
    },
  },
  {
    key: 'room',
    prompt: 'if a group of people is owed a share of what this launch earns, say what '
      + 'they are owed and how a place in it is given and lost. write it as the line '
      + 'you want signed, starting "the room:". say skip if there is no such group.',
    parse: parseBlock,
  },
  {
    key: 'holderFeeShare',
    prompt: 'if holding the token pays a share of fees, say so and say on what terms. '
      + 'if it does not, saying so here is worth more than leaving it out. write it as '
      + 'the lines you want signed. say skip to leave it out.',
    parse: parseBlock,
  },
  {
    key: 'docs',
    prompt: 'a link where this can be read in full.',
    parse: (input) => {
      const t = input.trim();
      if (!/^https:\/\/[^\s]+\.[^\s]+$/i.test(t) || t.length > 200) {
        return { ok: false, error: 'an https link' };
      }
      return { ok: true, value: t };
    },
  },
];

// ----------------------------------------------------------------- the draft

interface Draft {
  userId: number;
  step: number;
  answers: Record<string, unknown>;
  nonce: string;
  startedAt: number;
}

function readDraft(userId: number): Draft | null {
  const row = db.prepare('SELECT * FROM declare_drafts WHERE user_id = ?').get(userId) as any;
  if (!row) return null;
  let answers: Record<string, unknown> = {};
  try {
    answers = JSON.parse(row.answers);
  } catch (err) {
    // A draft whose answers will not parse is a draft that cannot be finished.
    console.warn('[declare] unreadable draft for', userId, String((err as Error)?.message ?? err).slice(0, 80));
    return null;
  }
  return { userId, step: row.step, answers, nonce: row.nonce, startedAt: row.started_at };
}

function writeDraft(d: Draft): void {
  db.prepare(
    `INSERT INTO declare_drafts (user_id, step, answers, nonce, started_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET step = excluded.step, answers = excluded.answers`,
  ).run(d.userId, d.step, JSON.stringify(d.answers), d.nonce, d.startedAt);
}

export function clearDraft(userId: number): void {
  db.prepare('DELETE FROM declare_drafts WHERE user_id = ?').run(userId);
}

export function draftOpen(userId: number): boolean {
  return readDraft(userId) !== null;
}

/**
 * Start the form over. Returns the first question.
 *
 * Replaces the row outright rather than updating it, so a restarted form gets a
 * fresh nonce. Upserting only the step and the answers left the old nonce in
 * place, which meant a signature taken for the abandoned form still verified
 * against the new one: the replay guard would have guarded nothing.
 */
export function startDraft(userId: number, now = Date.now(), nonce = randomNonce()): string {
  db.prepare(
    `INSERT OR REPLACE INTO declare_drafts (user_id, step, answers, nonce, started_at)
     VALUES (?, 0, '{}', ?, ?)`,
  ).run(userId, nonce, Math.floor(now / 1000));
  return STEPS[0]!.prompt;
}

/**
 * The replay guard, from the system generator rather than from Math.random.
 *
 * The nonce is the only thing stopping a signature taken for one declaration
 * being presented for another, so it is the one field in the form whose value
 * an adversary must not be able to predict. Math.random is seeded per process
 * and is not built to resist anyone; eight base-36 characters of it is roughly
 * forty bits, from a generator that never claimed to be unguessable. Sixteen
 * hex characters from randomBytes is sixty-four bits that were never a
 * sequence.
 */
function randomNonce(): string {
  return randomBytes(8).toString('hex');
}

export type AnswerResult =
  | { state: 'asked'; prompt: string; step: number }
  | { state: 'rejected'; error: string; prompt: string; step: number }
  | { state: 'complete'; canonical: string; answers: DeclarationAnswers }
  | { state: 'no-draft' };

/** Feed one plain-text answer into an open form. */
export function answerDraft(userId: number, input: string): AnswerResult {
  const d = readDraft(userId);
  if (!d) return { state: 'no-draft' };
  const step = STEPS[d.step];
  if (!step) return { state: 'no-draft' };

  const parsed = step.parse(input, d.answers);
  if (!parsed.ok) {
    return { state: 'rejected', error: parsed.error, prompt: step.prompt, step: d.step };
  }
  d.answers[step.key] = parsed.value;
  d.step += 1;
  writeDraft(d);

  const next = STEPS[d.step];
  if (next) return { state: 'asked', prompt: next.prompt, step: d.step };

  const answers = answersOf(d);
  return { state: 'complete', canonical: canonicalText(answers, d.nonce), answers };
}

function answersOf(d: Draft): DeclarationAnswers {
  const tax = d.answers.tax as { bps: number; split: string };
  const deployer = d.answers.deployer as string;
  return {
    deployer,
    devBuyPct: d.answers.devBuy as number,
    // Cleaned here as well as at the answer, so a draft started before the
    // deployer was taken out of this list cannot be finished with it still in.
    exemptList: othersThanDeployer(deployer, (d.answers.exemptions as string[]) ?? []),
    creatorTaxBps: tax.bps,
    taxSplit: tax.split,
    vesting: d.answers.vesting as string,
    room: (d.answers.room as string) ?? '',
    holderFeeShare: (d.answers.holderFeeShare as string) ?? '',
    docsUrl: d.answers.docs as string,
    docsSha256: (d.answers.docsSha256 as string) ?? '',
  };
}

/**
 * What a rejected answer looks like to the person who sent it.
 *
 * The old reply put the reason above the question and nothing else, which
 * reads as a note attached to a prompt rather than as "that message is gone".
 * A form that re-asks quietly is how an answer ends up one slot along: the
 * creator reads a question, believes the last one was taken, and sends the
 * next thing they had ready. So the rejection says it was not recorded, says
 * which question is still open, and asks that one again.
 */
export function rejectionText(res: { error: string; prompt: string; step: number }): string {
  return [
    `not recorded: ${res.error}.`,
    '',
    `nothing was saved for question ${res.step + 1}. it is still open, and this is`,
    'the answer i am waiting for. send it again.',
    '',
    `${res.step + 1} of ${STEPS.length}. ${res.prompt}`,
  ].join('\n');
}

/**
 * The pre-sign review, in as many messages as it takes.
 *
 * The canonical text is the thing being signed, so it is never clamped and
 * never shortened: a declaration that arrives one ellipsis short of what the
 * wallet will be asked for is worse than one that arrives in two messages.
 * Under the limit this is one message and reads exactly as it always did.
 */
export function signPrompt(
  canonical: string, pinnedHash: string | null, max = TELEGRAM_MAX_MESSAGE,
): string[] {
  const note = pinnedHash
    ? 'the docs line is pinned to the page as it is right now. change the page after signing and the card says so.'
    : 'the docs page could not be read, so there is no hash line. the link is signed, its contents are not.';
  const head = 'sign this exact text with the deployer wallet:';
  const tail = ['then send: /declare sign <signature>'];
  const whole = [head, '', canonical, '', note, '', ...tail].join('\n');
  if (whole.length <= max) return [whole];

  const parts = splitVerbatim(canonical, max);
  return [
    `${head}\n\nit is longer than one message, so it follows in ${parts.length} parts. `
      + 'sign the parts joined back together with a newline between them, in order, '
      + 'and nothing else.',
    ...parts,
    [note, '', ...tail].join('\n'),
  ];
}

/** The answers of a finished form, for the signing step. */
export function draftAnswers(userId: number): { answers: DeclarationAnswers; nonce: string } | null {
  const d = readDraft(userId);
  if (!d || d.step < STEPS.length) return null;
  return { answers: answersOf(d), nonce: d.nonce };
}

// ------------------------------------------------------------- the signature

/**
 * The count the curve will emit: the wallets named, plus the deployer.
 *
 * The deployer is added once, here, so it has to be absent from the list. The
 * form takes it out at the answer; this takes it out again, because a draft
 * written before that fix is still a draft somebody can finish, and a count
 * that is wrong by one is a declaration disagreeing with the chain.
 */
export function declaredExemptCount(a: DeclarationAnswers): number {
  return othersThanDeployer(a.deployer, a.exemptList).length + 1;
}

/**
 * The exact bytes the deployer signs.
 *
 * Every field is in it, in a fixed order, with the nonce, so a signature taken
 * for one declaration cannot be replayed for another. Stored verbatim beside
 * the signature so anyone can recheck it later without trusting this build to
 * rebuild the string the same way.
 */
export function canonicalText(a: DeclarationAnswers, nonce: string): string {
  const exempt = othersThanDeployer(a.deployer, a.exemptList);
  const others = exempt.length;
  return [
    'vitals declaration',
    // Checksummed, which is how the address appears on the declaration page and
    // how a wallet shows it back to the person signing. A lowercase address is
    // forty characters nobody can check by eye; the mixed case IS the checksum.
    `deployer: ${getAddress(a.deployer)}`,
    // One line, not two. It used to say "dev buy: 5% of supply" here and
    // "team tokens: none" four lines down, and both were signed: the first is
    // true, the second is false, and the second is false BECAUSE of the first.
    // What the dev buy holds belongs on the line that declares the dev buy.
    `dev buy: ${a.devBuyPct}% of supply, ${a.vesting}`,
    others === 0
      ? 'tax-free at launch: the deployer only'
      : `tax-free at launch: the deployer and ${others} other${others === 1 ? '' : 's'}`,
    ...exempt.map((w) => `  ${w}`),
    `creator tax: ${a.creatorTaxBps} bps`,
    `tax split: ${a.taxSplit}`,
    // Optional, and omitted rather than emitted empty. A declaration that
    // carries "the room:" with nothing after it has declared something about a
    // room, and what it has declared is unreadable.
    ...(a.room ? [a.room] : []),
    ...(a.holderFeeShare ? [a.holderFeeShare] : []),
    `docs: ${a.docsUrl}`,
    // The docs line names a page, and a page can be rewritten after it is
    // signed. This pins the bytes it had at the time. Absent when the page
    // could not be read, which is an absence rather than a zero: no line at
    // all says nothing about the page, and that is the honest state.
    ...(a.docsSha256 ? [`docs sha256: ${a.docsSha256}`] : []),
    `nonce: ${nonce}`,
  ].join('\n');
}

export type SignResult =
  | { ok: true; declaration: Declaration }
  | { ok: false; reason: 'no-draft' | 'bad-signature' | 'wrong-wallet' | 'not-entitled' | 'unreadable'; detail?: string };

export interface DeclareDeps {
  now?: number;
  /**
   * The chain reads this decision rests on, injectable so the rule itself can
   * be tested without a node. Defaulted to the real ones; nothing in the bot
   * passes them.
   */
  blockNumber?: () => Promise<number>;
  balanceOf?: (wallet: string, now: number) => Promise<bigint | null>;
}

/**
 * Check a signature against an open, finished form and store the declaration.
 *
 * The recovered address must be the wallet named in the form. A declaration
 * signed by anyone else is not a weaker declaration, it is a different person's
 * statement about someone else's launch, which is worth nothing at all.
 */
export async function signDraft(
  userId: number,
  signature: string,
  deps: DeclareDeps = {},
): Promise<SignResult> {
  const now = deps.now ?? Date.now();
  const pending = draftAnswers(userId);
  if (!pending) return { ok: false, reason: 'no-draft' };
  const { answers, nonce } = pending;
  const canonical = canonicalText(answers, nonce);

  let recovered: string;
  try {
    recovered = (await recoverMessageAddress({
      message: canonical,
      signature: signature.trim() as Hex,
    })).toLowerCase();
  } catch (err) {
    return { ok: false, reason: 'bad-signature', detail: String((err as Error)?.message ?? err).slice(0, 120) };
  }
  if (recovered !== answers.deployer.toLowerCase()) {
    return { ok: false, reason: 'wrong-wallet', detail: recovered };
  }

  const ent = await entitlement(userId, answers.deployer, deps);
  if (!ent.allowed) return { ok: false, reason: 'not-entitled' };

  let block: number;
  try {
    block = deps.blockNumber
      ? await deps.blockNumber()
      : Number(await client.getBlockNumber());
  } catch (err) {
    // Without a block the declaration cannot be placed before or after a
    // launch, which is the only thing that makes it mean anything.
    return { ok: false, reason: 'unreadable', detail: String((err as Error)?.message ?? err).slice(0, 120) };
  }

  const info = db.prepare(
    `INSERT INTO launch_declarations
       (deployer, declared_by, declared_at, block_number, dev_buy_pct, exempt_list, exempt_count,
        creator_tax_bps, tax_split, vesting, room, holder_fee_share, docs_url, docs_sha256,
        canonical, signature, free_slot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    answers.deployer.toLowerCase(), userId, Math.floor(now / 1000), block,
    answers.devBuyPct, JSON.stringify(answers.exemptList), declaredExemptCount(answers),
    answers.creatorTaxBps, answers.taxSplit, answers.vesting,
    answers.room, answers.holderFeeShare, answers.docsUrl, answers.docsSha256,
    canonical, signature.trim(), ent.freeSlot,
  );
  clearDraft(userId);
  return { ok: true, declaration: byId(Number(info.lastInsertRowid))! };
}

// ----------------------------------------------------------------- who may

export interface Entitlement {
  allowed: boolean;
  /** The founding number when this one is inside the free window. */
  freeSlot: number | null;
  reason: 'free-window' | 'user-premium' | 'wallet-holds' | 'none';
}

/**
 * Who may declare.
 *
 * The free window first, so the founding hundred never depend on a balance read
 * that could fail. After that, either side of the pair will do: the Telegram
 * account holding PREMIUM, or the deployer wallet itself holding enough. A
 * creator who has never linked a Telegram account to a wallet can still
 * declare, and a holder declaring on behalf of a cold deployer can too.
 */
export async function entitlement(
  userId: number,
  deployer: string,
  deps: DeclareDeps = {},
): Promise<Entitlement> {
  const now = deps.now ?? Date.now();
  const used = declarationCount();
  if (used < DECLARE_FREE_UNTIL) {
    return { allowed: true, freeSlot: used + 1, reason: 'free-window' };
  }
  if (atLeast(await effectiveTier(userId, now), 'premium')) {
    return { allowed: true, freeSlot: null, reason: 'user-premium' };
  }
  const balance = await (deps.balanceOf ?? vitalsBalance)(deployer, now);
  if (balance !== null && atLeast(tierForBalance(balance), 'premium')) {
    return { allowed: true, freeSlot: null, reason: 'wallet-holds' };
  }
  return { allowed: false, freeSlot: null, reason: 'none' };
}

export function declarationCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM launch_declarations').get() as { n: number }).n;
}

// ------------------------------------------------------------------- reading

function rowToDeclaration(row: any): Declaration {
  let exemptList: string[] = [];
  try {
    exemptList = JSON.parse(row.exempt_list);
  } catch (err) {
    console.warn('[declare] unreadable exempt list on declaration', row.id);
  }
  return {
    id: row.id,
    deployer: row.deployer,
    declaredBy: row.declared_by,
    declaredAtSeconds: row.declared_at,
    blockNumber: row.block_number,
    devBuyPct: row.dev_buy_pct,
    exemptList,
    exemptCount: row.exempt_count,
    room: row.room ?? '',
    holderFeeShare: row.holder_fee_share ?? '',
    docsSha256: row.docs_sha256 ?? '',
    creatorTaxBps: row.creator_tax_bps,
    taxSplit: row.tax_split,
    vesting: row.vesting,
    docsUrl: row.docs_url,
    canonical: row.canonical,
    signature: row.signature,
    freeSlot: row.free_slot ?? null,
  };
}

export function byId(id: number): Declaration | null {
  const row = db.prepare('SELECT * FROM launch_declarations WHERE id = ?').get(id);
  return row ? rowToDeclaration(row) : null;
}

/**
 * The declaration that covers a launch, or null.
 *
 * Covers means: made by the wallet that deployed it, at a block BEFORE the one
 * the launch was mined in. A statement made after the fact is not a
 * declaration, it is a description, and it gets no badge and no lines. The most
 * recent qualifying one wins, so a creator can correct themselves before
 * launching and the last word before the launch is the one they are held to.
 */
export function declarationFor(deployer: string, launchBlock: number): Declaration | null {
  const row = db.prepare(
    `SELECT * FROM launch_declarations
      WHERE deployer = ? AND block_number < ?
      ORDER BY block_number DESC, id DESC LIMIT 1`,
  ).get(deployer.toLowerCase(), launchBlock);
  return row ? rowToDeclaration(row) : null;
}

export function recentDeclarations(limit = 20): Declaration[] {
  const rows = db.prepare(
    'SELECT * FROM launch_declarations ORDER BY id DESC LIMIT ?',
  ).all(limit) as any[];
  return rows.map(rowToDeclaration);
}

// ------------------------------------------------------------------ display

/** 0x1234…abcd, for a list where the full address would be noise. */
export function shortWallet(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Where a declaration can be read.
 *
 * The site route is the destination; until it exists the link is a deep link
 * into the bot, which resolves today. Both are permanent for a given id, so a
 * card posted now keeps working when the route lands.
 */
export function declarationLink(id: number, botUsername?: string): string {
  const base = process.env.SITE_DECLARATION_BASE?.replace(/\/+$/, '');
  if (base) return `${base}/${id}`;
  return botUsername ? `https://t.me/${botUsername}?start=d${id}` : `declaration ${id}`;
}

/** What a declaration costs once the founding window has closed. */
export const DECLARE_PRICE =
  'declaring is premium: hold 1,000,000 $VITALS in the deployer wallet or on a '
  + 'linked account, or /premium to pay 0.05 ETH. the first '
  + `${DECLARE_FREE_UNTIL} declarations were free.`;

/**
 * The launch that followed a declaration, and how it went.
 *
 * Deliberately literal. "still trading at +24h" is a recheck this bot made,
 * "no launch yet" is the absence of a row rather than a judgement about the
 * creator, and a launch that has not been rechecked says so instead of
 * defaulting to either outcome.
 */
export function declarationOutcome(d: Declaration): string {
  const launch = db.prepare(
    `SELECT token, block_number FROM launches
      WHERE deployer = ? AND block_number > ? ORDER BY block_number ASC LIMIT 1`,
  ).get(d.deployer, d.blockNumber) as { token: string; block_number: number } | undefined;
  if (!launch) return 'no launch from this wallet yet';

  const recheck = db.prepare(
    `SELECT still_trading FROM rechecks
      WHERE token = ? AND offset_hours = 24 AND completed_at IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1`,
  ).get(launch.token) as { still_trading: number | null } | undefined;

  const short = `${launch.token.slice(0, 10)}…`;
  if (!recheck || recheck.still_trading === null) return `launched ${short}, not yet rechecked at +24h`;
  return recheck.still_trading === 1
    ? `launched ${short}, still trading at +24h`
    : `launched ${short}, not trading at +24h`;
}

// -------------------------------------------------------------- the docs hash

/**
 * Pinning the page the docs line names.
 *
 * `docs:` names a URL, and a URL is a promise about a page that can be
 * rewritten the day after it is signed. The hash is of the bytes that page
 * served when the draft was built, so the claim becomes checkable: either the
 * page still hashes to what was signed or it does not, and both are facts.
 *
 * A page that cannot be read at draft time produces no line at all. An absent
 * line says nothing about the page, which is the honest state; a line of zeros
 * or a line saying "unreachable" would be a claim about a page nobody read.
 */

export type DocsHashState = 'match' | 'differs' | 'undetermined' | 'unpinned';

export function sha256Hex(body: Uint8Array | string): string {
  return createHash('sha256').update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body).digest('hex');
}

export type DocsGet = (url: string) => Promise<{ ok: boolean; status: number; bytes: Uint8Array }>;

const realGet: DocsGet = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
  return {
    ok: res.ok,
    status: res.status,
    bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(),
  };
};

/** The hash of the page as it is now, or null when it could not be read. */
export async function fetchDocsHash(url: string, get: DocsGet = realGet): Promise<string | null> {
  if (!/^https:\/\//i.test(url)) return null;
  try {
    const res = await get(url);
    if (!res.ok) return null;
    return sha256Hex(res.bytes);
  } catch (err) {
    // A page that did not answer is not a page that changed.
    console.warn(`[declare] docs page unreadable: ${String((err as Error)?.message ?? err).slice(0, 90)}`);
    return null;
  }
}

/**
 * Read the docs page and put its hash into the finished draft.
 *
 * Called once the form is complete and before the text is shown for signing,
 * so the bytes that are hashed are the bytes that were there when the person
 * read the page. Returns the canonical text as it will be signed.
 */
export async function pinDocsHash(
  userId: number, get: DocsGet = realGet,
): Promise<{ canonical: string; hash: string | null } | null> {
  const d = readDraft(userId);
  if (!d) return null;
  const url = d.answers.docs as string | undefined;
  if (!url) return null;
  const hash = await fetchDocsHash(url, get);
  d.answers.docsSha256 = hash ?? '';
  writeDraft(d);
  return { canonical: canonicalText(answersOf(d), d.nonce), hash };
}

/** What the page says today against what was signed. */
export function docsHashState(signed: string, observed: string | null): DocsHashState {
  if (!signed) return 'unpinned';
  if (observed === null) return 'undetermined';
  return observed === signed ? 'match' : 'differs';
}

/** One line for a card or a listing. Never a verdict about the launch. */
export function docsHashLine(state: DocsHashState): string {
  if (state === 'match') return 'docs page: the same bytes that were signed';
  if (state === 'differs') return 'docs page: changed since it was signed';
  if (state === 'undetermined') return 'docs page: could not be read, undetermined';
  return 'docs page: not pinned when this was signed';
}

/** The state of the page a stored declaration points at, read now. */
export async function checkDocsPage(
  d: Pick<Declaration, 'docsUrl' | 'docsSha256'>, get: DocsGet = realGet,
): Promise<DocsHashState> {
  if (!d.docsSha256) return 'unpinned';
  return docsHashState(d.docsSha256, await fetchDocsHash(d.docsUrl, get));
}
