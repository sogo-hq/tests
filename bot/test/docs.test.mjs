import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DOCS = readdirSync('docs').filter((f) => f.endsWith('.md'));
const read = (f) => readFileSync(`docs/${f}`, 'utf8');
const EM = String.fromCharCode(0x2014);

test('every doc exists that the launch depends on', () => {
  for (const f of ['vitals.md', 'template-self-scan-t15.md', 'template-first-ledger-t4h.md', 'template-declaration.md', 'launch-configs.md']) {
    assert.ok(DOCS.includes(f), f);
  }
});

test('no em dash in any doc', () => {
  for (const f of DOCS) assert.ok(!read(f).includes(EM), f);
});

test('no doc claims a partner, a backer or an exchange', () => {
  // The templates name the words only to forbid them, so the check is for a
  // claim: "backed by", "partnered with", "listed on".
  for (const f of DOCS) {
    const t = read(f);
    assert.doesNotMatch(t, /backed by|partnered with|in partnership with|listed on/i, f);
  }
});

test('no doc promises a price, a direction or a return', () => {
  const banned = /price target|will pump|good entry|safe to buy|guaranteed|\bAPY\b|\bROI\b/i;
  for (const f of DOCS) {
    for (const line of read(f).split('\n')) {
      if (!banned.test(line)) continue;
      // A line forbidding the phrase is the opposite of a line promising it.
      assert.match(line, /\bno\b|\bnever\b|\bnot\b/i, `${f}: ${line}`);
    }
  }
});

test('the description line says what it refuses to do', () => {
  const t = read('vitals.md');
  assert.match(t, /No score, no grade, no verdict/);
  assert.match(t, /Absence of a finding is never "clean"/);
});

test('the socials are the three that go into the launch calldata', () => {
  const t = read('vitals.md');
  for (const s of ['https://checkvitals.xyz', 'https://x.com/vitalsxyz', 'https://t.me/vitals_official']) {
    assert.ok(t.includes(s), s);
  }
});

test('the room mechanics are stated in full wherever the room is described', () => {
  // The seat count moves, so it is not pinned here. What is pinned is the
  // handful of claims the room is actually held to.
  const t = read('vitals.md');
  assert.match(t, /T\+3s/);
  assert.match(t, /same tax as everyone/i);
  assert.match(t, /[Ss]eat numbers are public\. Names are not/);
  assert.match(t, /split equally between the seats held that day/);
  assert.match(t, /recomputed from that day's payout forward/);
});

// --------------------------------------------------- the filled placeholders

/** Both bodies as supplied. A paraphrase of a signed promise is a different promise. */
const TREASURY_BODY = [
  'treasury: 0x138826536Ca720C4D614550D5DB2b22216d136ad.',
  'funded by sweeps from the fee wallet after each room payout, every sweep recorded with its hash.',
  'it may hold up to 10% of its ETH in other robinhood chain tokens. positions are discussed in BLOCK ZERO, executed and signed by one wallet, and every trade is posted with its hash on X within the hour.',
  'realized gains return to the treasury and count as income, so the room receives its 10% through the same ledger. no separate profit share, no promises.',
  'the treasury does not trade $VITALS.',
  'one signer. no other wallets. no OTC.',
].join('\n');

/**
 * The blocks of the signed text, read off the template rather than copied.
 *
 * docs/template-declaration.md is what gets built into the page whose sha256
 * is signed, so it is the original and everything else is a copy of it. This
 * file used to keep its own transcription of the room and holder blocks, which
 * meant the check that vitals.md matched the template passed by comparing two
 * stale copies with each other the moment the template moved. A copy held
 * beside the original is not a check, it is a second thing to keep in step.
 */
const SIGNED = (() => {
  const block = (read('template-declaration.md').split('\n```\n')[1] ?? '')
    .replace(/^```\w*\n?/, '').trim().split('\n');
  const at = (p) => block.findIndex((l) => l.startsWith(p));
  const room = block[at('the room:')];
  return {
    room,
    holder: block.slice(at('the room:') + 1, at('docs: ')).join('\n'),
    devBuy: block[at('dev buy: ')],
    taxSplit: block[at('tax split: ')],
  };
})();

const HOLDER_BODY = SIGNED.holder;

const TAX_SPLIT_LINE = SIGNED.taxSplit;

test('no marker is left in any doc', () => {
  for (const f of DOCS) {
    const t = read(f);
    assert.ok(!t.includes('[TREASURY RULES]'), `${f} still carries the treasury marker`);
    assert.ok(!t.includes('[HOLDER FEE SHARING]'), `${f} still carries the holder marker`);
    // Any bracketed shout is a placeholder by the convention this file set.
    const shouted = t.match(/\[[A-Z][A-Z $]{4,}\]/g) ?? [];
    assert.deepEqual(shouted, [], `${f} carries an unfilled placeholder: ${shouted.join(', ')}`);
  }
});

test('nothing signed is a placeholder, and the template says so', () => {
  const t = read('template-declaration.md');
  assert.match(t, /Both blocks that were placeholders are written/);
  assert.match(t, /there are none left/);
  // The rule survives its own satisfaction: it still says what a marker means.
  assert.match(t, /marker\s+still in it is a bug, not a draft/);
});

test('the treasury body is in both docs, verbatim', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    assert.ok(read(f).includes(TREASURY_BODY), `${f} does not carry the treasury rules as supplied`);
  }
});

test('the holder fee sharing body is in both docs, verbatim, and in the signed text', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    const t = read(f);
    assert.ok(t.includes(HOLDER_BODY), `${f} does not carry the holder rules as supplied`);
    const signed = t.split('```')[1] ?? '';
    assert.ok(signed.includes(HOLDER_BODY), `${f} has them outside the signed text`);
  }
});

test('the tax split line is the one that replaced the marker', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    const signed = read(f).split('```')[1] ?? '';
    assert.ok(signed.includes(TAX_SPLIT_LINE), `${f} signs a different tax split`);
    assert.doesNotMatch(signed, /^tax split: \[/m);
  }
});

test('the three shares in the tax split add up to a hundred', () => {
  const shares = [...TAX_SPLIT_LINE.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
  assert.deepEqual(shares, [10, 10, 80]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 100);
});

test('the tax split agrees with the room line it sits above', () => {
  // The room line states the same two figures from the other direction. A
  // declaration that split them differently in two places would be unsignable.
  const signed = read('template-declaration.md').split('```')[1] ?? '';
  assert.match(signed, /10% of gross income goes to ecosystem integrations, 80% to the build/);
  assert.match(TAX_SPLIT_LINE, /10% the room/);
  assert.match(signed, /the room is owed 10% of the fee wallet/);
});

test('b is deleted, not left beside a', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    assert.ok(read(f).includes('the treasury does not trade $VITALS.'), `${f} lost the line that was kept`);
  }
  // The alternative is gone from every document, not only the two that had it.
  for (const f of DOCS) {
    const t = read(f);
    assert.ok(!t.includes('it buys $VITALS on dips'), `${f} still carries the alternative`);
    assert.doesNotMatch(t, /<a: |<b: /, `${f} still marks it as a choice`);
  }
});

test('the treasury address is stated once and is not the fee wallet', async () => {
  const TREASURY = '0x138826536Ca720C4D614550D5DB2b22216d136ad';
  const { EXPECTED_DEPLOYER } = await import('../dist/launchcheck.js');
  assert.ok(TREASURY_BODY.includes(TREASURY));
  assert.notEqual(TREASURY.toLowerCase(), EXPECTED_DEPLOYER.toLowerCase(),
    'the treasury and the wallet payouts leave from have to be different addresses');
  for (const f of ['template-declaration.md', 'vitals.md']) {
    assert.ok(read(f).includes(TREASURY), f);
  }
});

test('the holder tiers in the signed text are the tiers the bot ships with', async () => {
  const { DEFAULT_THRESHOLDS } = await import('../dist/tiers.js');
  assert.equal(DEFAULT_THRESHOLDS.watch, 250_000n, 'the declaration says 250k = watch');
  assert.equal(DEFAULT_THRESHOLDS.premium, 1_000_000n, 'the declaration says 1M = the holder feed');
  assert.equal(DEFAULT_THRESHOLDS.desk, 10_000_000n, 'the declaration says 10M = desk');
  assert.match(HOLDER_BODY, /250k = watch, 1M = the holder feed, 10M = desk/);
});

test('holder fee sharing is declared off, and nothing says otherwise', () => {
  assert.match(HOLDER_BODY, /holder fee share is off at launch/);
  assert.match(HOLDER_BODY, /access, not yield/);
  for (const f of DOCS) {
    const t = read(f);
    assert.doesNotMatch(t, /holders (are paid|receive|earn) a share of/i, f);
  }
});

test('the treasury rules each name something that would show them broken', () => {
  // Not a style check: a rule with nothing to check it against is a slogan,
  // which is the thing this template says a declaration must not contain.
  for (const clause of [
    /every sweep recorded with its hash/,
    /every trade is posted with its hash on X within the hour/,
    /the room receives its 10% through the same ledger/,
    /one signer\. no other wallets\. no OTC\./,
  ]) {
    assert.match(TREASURY_BODY, clause, String(clause));
  }
});

test('the declaration template carries no signature and no nonce', () => {
  const t = read('template-declaration.md');
  assert.doesNotMatch(t, /^nonce: 0x/m);
  assert.doesNotMatch(t, /0x[0-9a-fA-F]{130}/);
});

test('the ledger template posts hashes without handles', () => {
  const t = read('template-first-ledger-t4h.md');
  assert.match(t, /Hashes without handles/i);
  assert.match(t, /No wallet, no handle, no user id/i);
});

test('the self scan template refuses to edit the card', () => {
  const t = read('template-self-scan-t15.md');
  assert.match(t, /goes out as rendered/i);
  assert.match(t, /goes out saying undetermined/);
});

test('the docs use the dev buy this repo computed, not a remembered one', () => {
  assert.match(read('template-declaration.md'), /5% is 0\.0930 ETH at a 4% tax/);
});

// ------------------------------------------ the two lines that are signed

/** As supplied. A paraphrase of a signed promise is a different promise. */
const DEV_BUY_LINE = SIGNED.devBuy;

const ROOM_LINE = SIGNED.room;

test('the dev buy line is in both docs, verbatim, in the signed text', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    const t = read(f);
    assert.ok(t.includes(DEV_BUY_LINE), `${f} does not carry the dev buy line as supplied`);
    // Inside the fenced block that says what gets signed, not only in prose.
    const signed = t.split('```')[1] ?? '';
    assert.ok(signed.includes(DEV_BUY_LINE), `${f} has it outside the signed text`);
  }
});

test('"team tokens: none" is gone and cannot come back', () => {
  for (const f of DOCS) {
    const t = read(f);
    assert.doesNotMatch(t, /^team tokens: none$/m, `${f} still signs a false line`);
    assert.doesNotMatch(t, /^team tokens:/m, `${f} still has a team tokens line`);
  }
  // And the template says why, so nobody adds it back as a tidy-up.
  const t = read('template-declaration.md');
  assert.match(t, /There is no `team tokens` line/);
  assert.match(t, /the dev buy \*\*is\*\* the team allocation/);
});

test('the room line is in both docs, verbatim, in the signed text', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    const t = read(f);
    assert.ok(t.includes(ROOM_LINE), `${f} does not carry the room line as supplied`);
    const signed = t.split('```')[1] ?? '';
    assert.ok(signed.includes(ROOM_LINE), `${f} has it outside the signed text`);
  }
});

test('the room line agrees with the code that pays it', async () => {
  const { LEDGER_SHARE_PCT } = await import('../dist/ledger.js');
  const { declaredSplit, declaredPoolPct } = await import('../dist/roomsplit.js');
  assert.match(ROOM_LINE, new RegExp(`owed ${LEDGER_SHARE_PCT}% of the fee wallet`));
  assert.equal(declaredPoolPct(ROOM_LINE), LEDGER_SHARE_PCT);
  // Read by the same function the ledger refuses a payout with, rather than by
  // a regular expression written here that could agree with neither side.
  assert.deepEqual(declaredSplit(ROOM_LINE), { kind: 'equal' },
    'the declared rule is not the rule the ledger pays by');
});

test('the signed text and the prose beside it count the seats the same way', () => {
  const seats = /BLOCK ZERO is (\d+) seats today/.exec(ROOM_LINE);
  assert.ok(seats, `the room line does not say how many seats there are: ${ROOM_LINE}`);
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const spelled = words[Number(seats[1])];
  for (const f of ['template-declaration.md', 'vitals.md']) {
    const t = read(f).toLowerCase();
    assert.ok(t.includes(`${seats[1]} seats`) || t.includes(`${spelled} seats`),
      `${f}: the signed text and the prose count seats differently`);
  }
});

test('neither new line carries an em dash or an exclamation', () => {
  for (const line of [DEV_BUY_LINE, ROOM_LINE]) {
    assert.ok(!line.includes(String.fromCharCode(0x2014)));
    assert.doesNotMatch(line, /!/);
  }
});

// -------------------------------------------------------- the correction post

test('the correction post exists and is dated', () => {
  const t = read('correction-post.md');
  assert.match(t, /16 september 2026/i);
});

test('it says what was counted wrong, in the terms of the mistake', () => {
  const t = read('correction-post.md');
  assert.match(t, /we counted tax-free wallets wrong/);
  assert.match(t, /four slots/);
  assert.match(t, /we were counting the\s+array/);
  // The evidence, not just the claim.
  assert.match(t, /fourteen of fourteen had\s+exempted their deployer/);
});

test('it carries no excuse and no hedge about whose fault it was', () => {
  const t = read('correction-post.md');
  for (const weasel of [/\bunfortunately\b/i, /\bedge case\b/i, /\bminor\b/i, /\bwe apologi[sz]e\b/i, /\bregret\b/i]) {
    assert.doesNotMatch(t, weasel, String(weasel));
  }
  // It says the thing plainly instead.
  assert.match(t, /a count of zero was never\s+possible and we published it anyway/);
});

test('the two unverified figures are marked, not restated', () => {
  const t = read('correction-post.md');
  assert.match(t, /141 seconds/);
  assert.match(t, /not from the events path/i);
  assert.match(t, /57% of buyers/);
  assert.match(t, /no source/i);
  assert.match(t, /withdrawn/);
  // Neither is quoted as though it still stands.
  assert.doesNotMatch(t, /^the median hold is 141/mi);
});

test('the post is lowercase in the part that gets posted', () => {
  const t = read('correction-post.md');
  const block = t.split('```')[1];
  assert.ok(block, 'the post has no quoted block');
  // Addresses and identifiers keep their case; prose does not start sentences
  // with capitals, which is the voice.
  const sentences = block.split('\n').filter((l) => /^[a-z]/.test(l.trim()) || !l.trim());
  assert.ok(sentences.length > block.split('\n').length * 0.6, 'the post is not in the voice');
  assert.doesNotMatch(block, /^[A-Z][a-z]+ /m);
});

test('the post names the tool that found it and claims nothing it cannot show', () => {
  const t = read('correction-post.md');
  assert.match(t, /tools\/exemption-slots\.mjs/);
  assert.match(t, /it signs nothing/);
  assert.match(t, /0xae3020888aEd39556469C8A8026672D781FF5f84/);
});

test('the post carries the production figures, and they add up', () => {
  const t = read('correction-post.md');
  assert.match(t, /478,610/);
  assert.match(t, /331,678/);
  assert.match(t, /146,932/);
  assert.equal(331_678 + 146_932, 478_610, 'the two buckets partition what was read');
  assert.equal(((331_678 / 478_610) * 100).toFixed(1), '69.3');
  assert.equal(((146_932 / 478_610) * 100).toFixed(1), '30.7');
  assert.match(t, /69\.3%/);
  assert.match(t, /30\.7%/);
});

test('the 422 undecodable are stated, and as undetermined rather than as a number', () => {
  const t = read('correction-post.md');
  assert.match(t, /422 launches are still undetermined/);
  assert.match(t, /entry\s+points we have no ABI for/);
  assert.match(t, /undetermined rather than as a number/);
});

test('the sentence about the impossible zero is in the post itself', () => {
  const block = read('correction-post.md').split('```')[1];
  assert.match(block, /a count of zero was never\s+possible and we published it anyway/);
});

test('the three old numbers are explained as what they counted', () => {
  const t = read('correction-post.md');
  assert.equal(33 + 38 + 29, 100, 'the three were a partition');
  assert.match(t, /33 \+ 38 \+ 29 adds to 100/);
  assert.match(t, /length of the `exemptions` array/);
  // And the post itself says it, not only the notes around it.
  const block = t.split('```')[1];
  assert.match(block, /33%, 38% and 29% were a\s+split of launches by the length of the exemptions array/);
  assert.match(block, /never a count of tax-free wallets/);
});

test('the split it cannot compute yet is marked, not estimated', () => {
  const t = read('correction-post.md');
  assert.match(t, /PENDING_A/);
  assert.match(t, /PENDING_B/);
  assert.match(t, /Do not estimate them/);
  // And the reason is given rather than left as a gap.
  assert.match(t, /never stored/);
  assert.match(t, /node dist\/index\.js decode/);
});

// ------------------------------------------------ the undecodable entry points

test('the entry-point report names each selector and whether it decodes', () => {
  const t = read('undecodable-entry-points.md');
  for (const sel of ['0xf85f8e41', '0xf35abbcf', '0xa72101af', '0xeafc4bc5', '0x87306c90', '0x1fad948c']) {
    assert.ok(t.includes(sel), sel);
  }
  assert.match(t, /node tools\/undecodable\.mjs/);
  assert.match(t, /Read-only report/);
});

test('it separates undecoded from undecodable rather than letting them read alike', () => {
  const t = read('undecodable-entry-points.md');
  assert.match(t, /"undecoded" and "undecodable" are different sets/);
  assert.match(t, /The counts below are that\s+sample, not production/);
});

test('it says no Pons entry point is missing, which is the question asked', () => {
  const t = read('undecodable-entry-points.md');
  assert.match(t, /Is there a Pons ABI for them/);
  assert.match(t, /No, and there could not be/);
  assert.match(t, /none of them is a Pons entry point/);
});

test('the handleOps identification is stated with what confirmed it', () => {
  const t = read('undecodable-entry-points.md');
  assert.match(t, /ERC-4337 EntryPoint/);
  assert.match(t, /confirmed by computing it/);
});

test('it warns about the bundler in the sender slot', () => {
  // The thing that would reintroduce the bug just fixed, in a different field.
  const t = read('undecodable-entry-points.md');
  assert.match(t, /`tx\.from` is the\s+bundler/);
  assert.match(t, /not from the\s+transaction/);
  assert.match(t, /same class of mistake as counting the exemptions array/);
});

test('it recommends adding nothing before launch, and says why', () => {
  const t = read('undecodable-entry-points.md');
  assert.match(t, /## What to do now/);
  assert.match(t, /Nothing\./);
  assert.match(t, /0\.09%/);
  assert.equal(((422 / 478_610) * 100).toFixed(2), '0.09');
});
