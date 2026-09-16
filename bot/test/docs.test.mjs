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
  for (const s of ['https://checkvitals.xyz', 'https://x.com/vitalsxyz', 'https://t.me/vitalsofficial']) {
    assert.ok(t.includes(s), s);
  }
});

test('the room mechanics are stated in full wherever the room is described', () => {
  for (const f of ['vitals.md', 'template-declaration.md']) {
    const t = read(f);
    assert.match(t, /[Ff]ifty seats/, f);
    assert.match(t, /T\+3s/, f);
    assert.match(t, /same tax as everyone/i, f);
    assert.match(t, /[Ss]eat numbers are public\. Names are not/, f);
  }
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

const HOLDER_BODY = [
  'holder fee share is off at launch. the token is access, not yield: 250k = watch, 1M = the holder feed, 10M = desk.',
  'nothing changes in the first 10 days. the room reviews it with holders on 5 oct. any change is announced 7 days ahead.',
].join('\n');

const TAX_SPLIT_LINE =
  'tax split: 10% the room, 10% ecosystem, 80% the build, treasury rules as declared';

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
const DEV_BUY_LINE =
  'dev buy: 5% of supply, held by the deployer wallet, 2% team and 3% partnerships, '
  + 'vesting contracts in october, nothing distributed at launch';

const ROOM_LINE =
  "the room: 50 seats. the room is owed 10% of the fee wallet's cumulative gross income, "
  + 'paid daily in ETH for 30 days by shares (T1 5, T2 2, T3 1), every payout printed before '
  + 'it leaves and recorded with its hash. a seat is given by the deployer, its tier is fixed '
  + 'when taken and reviewed once after the 30 days. a seat given up is reused and both '
  + 'occupants stay in the history. 10% of gross income goes to ecosystem integrations, '
  + '80% to the build.';

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
  const { TIER_SHARES } = await import('../dist/roster.js');
  assert.match(ROOM_LINE, new RegExp(`owed ${LEDGER_SHARE_PCT}% of the fee wallet`));
  assert.match(ROOM_LINE,
    new RegExp(`T1 ${TIER_SHARES.T1}, T2 ${TIER_SHARES.T2}, T3 ${TIER_SHARES.T3}`),
    'the declared shares are not the shares the ledger pays by');
  // Fifty seats is stated in the room mechanics on both pages already.
  assert.match(ROOM_LINE, /50 seats/);
});

test('the shares in the signed text add to what the room mechanics say', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    const t = read(f);
    assert.match(t, /[Ff]ifty seats/, f);
    assert.ok(t.includes('50 seats'), `${f}: the signed text and the prose count seats differently`);
  }
});

test('neither new line carries an em dash or an exclamation', () => {
  for (const line of [DEV_BUY_LINE, ROOM_LINE]) {
    assert.ok(!line.includes(String.fromCharCode(0x2014)));
    assert.doesNotMatch(line, /!/);
  }
});
