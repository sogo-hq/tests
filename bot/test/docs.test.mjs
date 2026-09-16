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

test('the holder fee sharing block is still a placeholder and says so', () => {
  for (const f of ['template-declaration.md', 'vitals.md']) {
    assert.ok(read(f).includes('[HOLDER FEE SHARING]'), f);
  }
  assert.match(read('template-declaration.md'), /### \[HOLDER FEE SHARING\]\s+Not written/);
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
