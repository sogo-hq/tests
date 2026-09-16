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
