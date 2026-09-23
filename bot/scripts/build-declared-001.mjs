#!/usr/bin/env node
/**
 * Build site/declared/001.html from the declaration text.
 *
 * Generated rather than typed, for the same reason /help is: the page IS the
 * thing the docs line points at, and its hash is signed. A page maintained by
 * hand beside the document it reproduces drifts from it, and here a drift is a
 * declaration that no longer matches its own evidence.
 *
 * Static and self-contained on purpose. No font CDN, no analytics, no script:
 * an external request is a third party who can change what the page renders
 * after it was hashed, and the hash is the whole point.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Where the page goes. The default is the committed page, and a path given on
 * the command line sends it somewhere else instead.
 *
 * A test that checks the builder still reproduces the committed page used to
 * run this with no argument, which writes over that page: if the template and
 * the page had drifted, the check that catches the drift would have destroyed
 * the evidence of it and left the signed bytes overwritten in the working tree.
 * With a path it builds somewhere harmless and the committed page is compared,
 * never replaced.
 */
const OUT = process.argv[2]
  ? resolve(process.argv[2])
  : join(ROOT, 'site', 'declared', '001.html');

/** Lifted from the template, which the docs tests check character for character. */
const TEMPLATE = readFileSync(join(ROOT, 'docs', 'template-declaration.md'), 'utf8');

/** The nth fenced block of the template. */
function block(n) {
  const parts = TEMPLATE.split('\n```\n');
  const body = parts[n * 2 - 1];
  if (!body) throw new Error(`template has no fenced block ${n}`);
  return body.replace(/^```\w*\n?/, '').trim();
}

const CANONICAL = block(1);
const TREASURY = block(2);
const HOLDER = block(3);

const ROOM = CANONICAL.split('\n').find((l) => l.startsWith('the room:'));
if (!ROOM) throw new Error('the canonical text has no room line');
if (CANONICAL.includes('[')) throw new Error('the canonical text still carries a placeholder');

const esc = (s) => s
  .split('&').join('&amp;')
  .split('<').join('&lt;')
  .split('>').join('&gt;');

const BG = '#080B09';
const INK = '#E8F0DE';
const DIM = '#6E7A66';
const REF = '#C6F73A';
const RULE = '#1B241A';

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DECLARED #001 . VITALS</title>
<meta name="description" content="What the VITALS launch declared before it happened, signed with the deployer wallet.">
<style>
  :root {
    --bg: ${BG};
    --ink: ${INK};
    --dim: ${DIM};
    --ref: ${REF};
    --rule: ${RULE};
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 400 17px/1.65 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 0 20px 96px;
  }
  main { max-width: 760px; margin: 0 auto; }
  header { padding: 72px 0 40px; border-bottom: 1px solid var(--rule); }
  .eyebrow {
    font: 400 13px/1 "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ref);
    margin: 0 0 18px;
  }
  h1 { font-size: 40px; line-height: 1.15; margin: 0 0 16px; font-weight: 700; letter-spacing: -0.01em; }
  h2 {
    font-size: 13px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--dim);
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-weight: 400;
    margin: 56px 0 16px;
  }
  p { margin: 0 0 18px; }
  .lede { color: var(--dim); font-size: 18px; margin: 0; }
  pre {
    background: #0C100B;
    border: 1px solid var(--rule);
    border-left: 2px solid var(--ref);
    border-radius: 3px;
    padding: 20px 22px;
    margin: 0 0 20px;
    overflow-x: auto;
    font: 400 14px/1.75 "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .note { color: var(--dim); font-size: 15px; }
  ul { margin: 0 0 18px; padding-left: 22px; }
  li { margin: 0 0 10px; }
  a { color: var(--ref); text-decoration: none; border-bottom: 1px solid var(--rule); }
  a:hover { border-bottom-color: var(--ref); }
  footer {
    margin-top: 72px;
    padding-top: 28px;
    border-top: 1px solid var(--rule);
    color: var(--dim);
    font-size: 15px;
  }
  @media (max-width: 600px) {
    header { padding: 48px 0 32px; }
    h1 { font-size: 30px; }
    body { font-size: 16px; }
    pre { font-size: 13px; padding: 16px; }
  }
</style>
</head>
<body>
<main>

<header>
  <p class="eyebrow">Declared #001</p>
  <h1>What this launch declared before it happened</h1>
  <p class="lede">Signed with the wallet that deploys, before the token exists.
  Every line below is something a launch transaction or a payout hash either
  matches or does not.</p>
</header>

<h2>The signed text</h2>
<pre>${esc(CANONICAL)}</pre>
<p class="note">This is the text the deployer wallet signs, with one line added
at the moment of signing: <code>docs sha256:</code>, the hash of this page as it
was then. It cannot be printed here, because the hash of a page cannot be part
of the page. The bot stores the signed bytes and the signature together, so the
claim stays checkable against the launch that follows it.</p>

<h2>Treasury rules</h2>
<pre>${esc(TREASURY)}</pre>

<h2>Holder fee sharing</h2>
<pre>${esc(HOLDER)}</pre>

<h2>The room</h2>
<pre>${esc(ROOM)}</pre>

<h2>What can be checked, and where</h2>
<ul>
  <li><strong>The deployer</strong> is the sender of the launch transaction.</li>
  <li><strong>The dev buy</strong> is the opening buy on the curve, as a share of supply.</li>
  <li><strong>Tax-free at launch</strong> is the list of wallets the launch transaction pre-exempts.</li>
  <li><strong>The creator tax</strong> is a field in the launch parameters.</li>
  <li><strong>The room's payouts</strong> are transaction hashes, published after each run.</li>
  <li><strong>Sweeps into the treasury</strong> are transaction hashes, recorded as they happen.</li>
  <li><strong>One signer, no other wallets, no OTC</strong> is readable off the treasury
      address's own transaction list.</li>
</ul>

<h2>What this page is not</h2>
<p>It is a claim made in advance, not a finding. Nothing in it was checked
against a chain at the time it was made. After the launch, the scanner compares
what the chain shows against what was signed here, and where they differ it
says so and the original finding still stands.</p>
<p>There is no score, no grade and no verdict anywhere in this project. A check
that found nothing is not a check that found the launch to be fine, and the
card says how many checks ran and how many could not be determined.</p>

<footer>
  <p>The declaration is stored with its signature by
  <a href="https://t.me/vitalscheck_bot">@vitalscheck_bot</a>.
  This page is pinned by its sha256 inside the signed text above: change it
  after signing and the card says the page changed.</p>
  <p><a href="https://checkvitals.xyz">checkvitals.xyz</a>
  . <a href="https://x.com/vitalsxyz">x.com/vitalsxyz</a>
  . <a href="https://t.me/vitals_official">t.me/vitals_official</a></p>
</footer>

</main>
</body>
</html>
`;

const EM_DASH = String.fromCharCode(0x2014);
if (page.includes(EM_DASH)) throw new Error('the page carries an em dash');
for (const word of ['safe to buy', 'good entry', 'will pump', 'guaranteed']) {
  if (page.toLowerCase().includes(word)) throw new Error(`the page says "${word}"`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page);
const hash = createHash('sha256').update(Buffer.from(page, 'utf8')).digest('hex');
console.log(`  ${OUT}`);
console.log(`  ${Buffer.byteLength(page, 'utf8')} bytes`);
console.log(`  sha256 ${hash}`);
