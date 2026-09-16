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

test('the two placeholders are marked and never quietly filled', () => {
  const t = read('template-declaration.md');
  assert.ok(t.includes('[TREASURY RULES]'));
  assert.ok(t.includes('[HOLDER FEE SHARING]'));
  assert.match(t, /not\*{0,2} to be signed until they are\s+written/);
  assert.match(t, /still in it is a bug/);
});

// ------------------------------------------------------- the $VITALS line

/** As supplied, to the character. A paraphrase of a signed promise is a different promise. */
const VITALS_LINE =
  '<a: the treasury does not trade $VITALS.> or <b: it buys $VITALS on dips, '
  + 'never sells in the first 30 days, and after that at most 5% of its $VITALS '
  + 'per day, never within 24h of a room post or partner news.>';

test('the $VITALS line is in both docs, verbatim', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    assert.ok(read(f).includes(VITALS_LINE), `${f} does not carry the line as supplied`);
  }
});

test('it is lowercase, as supplied', () => {
  // $VITALS is the ticker and stays as it is; nothing else in the line is
  // capitalised, and a sentence case rewrite would not be verbatim.
  const withoutTicker = VITALS_LINE.split('$VITALS').join('');
  assert.equal(withoutTicker, withoutTicker.toLowerCase());
  for (const f of ['template-declaration.md', 'vitals.md']) {
    const line = read(f).split('\n').find((l) => l.startsWith('<a: '));
    assert.equal(line, VITALS_LINE, f);
  }
});

test('a and b are still both there, and both marked as a choice', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    const t = read(f);
    assert.match(t, /<a: /, f);
    assert.match(t, /<b: /, f);
    // Signing both says neither, so the docs have to say that rather than
    // leaving a reader to pick one by accident.
    assert.match(t, /opposite\s+promises/, `${f} does not say a and b are exclusive`);
    assert.match(t, /signing the pair says\s+neither/i, `${f} does not say what signing both means`);
  }
});

test('neither block is reported as finished while it carries a choice', () => {
  const t = read('template-declaration.md');
  assert.match(t, /The rest is not written/);
  assert.match(t, /one of them has to go/i);
  // The rule from the top of the file still stands over the filled part.
  assert.match(t, /still in it is a bug/);
});

test('the holder fee sharing block is still marked, with the room part written', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    assert.ok(read(f).includes('[HOLDER FEE SHARING]'), f);
  }
  const t = read('template-declaration.md');
  // The room's share is written now. What is left is named rather than left
  // as a blank anybody could fill in later without it being noticed.
  assert.match(t, /The room's share is written and is in the signed text above/);
  assert.match(t, /What is still not written/);
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

test('[HOLDER FEE SHARING] is still marked, and names what is left', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    assert.ok(read(f).includes('[HOLDER FEE SHARING]'), f);
  }
  const t = read('template-declaration.md');
  assert.match(t, /still not written/);
  assert.match(t, /the review after the 30 days/);
});

test('neither new line carries an em dash or an exclamation', () => {
  for (const line of [DEV_BUY_LINE, ROOM_LINE]) {
    assert.ok(!line.includes(String.fromCharCode(0x2014)));
    assert.doesNotMatch(line, /!/);
  }
});
