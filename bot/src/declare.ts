import { recoverMessageAddress, isAddress, getAddress, type Hex } from 'viem';
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

/** Free text fields are bounded so the canonical text stays a readable page. */
export const MAX_FREE_TEXT = 120;

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
  docsUrl: string;
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
  docsUrl: string;
}

// ------------------------------------------------------------------ the form

export type StepKey = 'deployer' | 'devBuy' | 'exemptions' | 'tax' | 'vesting' | 'docs';

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

function parseAddressList(input: string): { ok: true; value: string[] } | { ok: false; error: string } {
  const t = input.trim();
  if (/^(dev wallet only|deployer only|none|just the dev|just me)$/i.test(t)) return { ok: true, value: [] };
  const found = t.split(/[\s,;]+/).filter(Boolean);
  const out: string[] = [];
  for (const raw of found) {
    if (!isAddress(raw)) return { ok: false, error: `not an address: ${raw.slice(0, 24)}` };
    const a = getAddress(raw).toLowerCase();
    if (!out.includes(a)) out.push(a);
  }
  // The protocol caps exemptions at 32, the deployer among them.
  if (out.length > 31) return { ok: false, error: 'more wallets than the curve can exempt' };
  return { ok: true, value: out };
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
  if (t.length > MAX_FREE_TEXT) return { ok: false, error: `${t.length} characters, keep it under ${MAX_FREE_TEXT}` };
  // The bot never prints an em dash, and neither does anything it quotes back.
  return { ok: true, value: t.split(EM_DASH).join(', ') };
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
      const n = Number(input.trim().replace(/%$/, ''));
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
      const m = /^(\d{1,5})\s*(?:bps?)?\s*[,.:]?\s*([\s\S]*)$/i.exec(t);
      if (!m) return { ok: false, error: 'start with the number of basis points' };
      const bps = Number(m[1]);
      if (!Number.isFinite(bps) || bps > 10_000) return { ok: false, error: 'basis points, 0 to 10000' };
      const rest = parseFreeText(m[2] || 'not stated');
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

function randomNonce(): string {
  return Math.random().toString(36).slice(2, 10);
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
  return {
    deployer: d.answers.deployer as string,
    devBuyPct: d.answers.devBuy as number,
    exemptList: d.answers.exemptions as string[],
    creatorTaxBps: tax.bps,
    taxSplit: tax.split,
    vesting: d.answers.vesting as string,
    docsUrl: d.answers.docs as string,
  };
}

/** The answers of a finished form, for the signing step. */
export function draftAnswers(userId: number): { answers: DeclarationAnswers; nonce: string } | null {
  const d = readDraft(userId);
  if (!d || d.step < STEPS.length) return null;
  return { answers: answersOf(d), nonce: d.nonce };
}

// ------------------------------------------------------------- the signature

/** The count the curve will emit: the wallets named, plus the deployer. */
export function declaredExemptCount(a: DeclarationAnswers): number {
  return a.exemptList.length + 1;
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
  const others = a.exemptList.length;
  return [
    'vitals declaration',
    `deployer: ${a.deployer}`,
    // One line, not two. It used to say "dev buy: 5% of supply" here and
    // "team tokens: none" four lines down, and both were signed: the first is
    // true, the second is false, and the second is false BECAUSE of the first.
    // What the dev buy holds belongs on the line that declares the dev buy.
    `dev buy: ${a.devBuyPct}% of supply, ${a.vesting}`,
    others === 0
      ? 'tax-free at launch: the deployer only'
      : `tax-free at launch: the deployer and ${others} other${others === 1 ? '' : 's'}`,
    ...a.exemptList.map((w) => `  ${w}`),
    `creator tax: ${a.creatorTaxBps} bps`,
    `tax split: ${a.taxSplit}`,
    `docs: ${a.docsUrl}`,
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
        creator_tax_bps, tax_split, vesting, docs_url, canonical, signature, free_slot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    answers.deployer.toLowerCase(), userId, Math.floor(now / 1000), block,
    answers.devBuyPct, JSON.stringify(answers.exemptList), declaredExemptCount(answers),
    answers.creatorTaxBps, answers.taxSplit, answers.vesting, answers.docsUrl,
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
