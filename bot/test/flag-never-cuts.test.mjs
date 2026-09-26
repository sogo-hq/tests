/**
 * A finding is never truncated. The flag lines are the product.
 *
 * The defect, from a live group screenshot of SHUFFLE
 * (0x6EAcc0461fDF3BD446634CCd0eD774a1EAD028cC):
 *
 *   🚩 2 wallets tax-free at launch, 1 of them the deployer, together 2.8% o…
 *
 * The headline went through plainField at 70 characters, and the sentence is 77.
 * What got cut was the share of supply, which is the size of the claim: the
 * count alone does not separate two wallets that took 0.2% from two that took
 * 40%. A reader saw the number of wallets and a dangling "2.8% o".
 *
 * Two things are asserted here, and the second is the one that keeps this fixed.
 * The reported sentence renders in full; and NO finding the generator can emit
 * comes out of the renderer cut, across the whole range of the inputs that
 * sentence is built from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';
process.env.DB_PATH = process.env.DB_PATH || freshDb('nevercuts');

const { db } = await import('../dist/db.js');
const { computeFlags } = await import('../dist/metrics/flags.js');
const { renderDefaultCard, CONCERN_MAX } = await import('../dist/card.js');
const { makeScan } = await import('./fixtures.mjs');

const NOW = 1_757_000_000;
const DEP = '0x' + 'd'.repeat(40);
const SHUFFLE = '0x6eacc0461fdf3bd446634ccd0ed774a1ead028cc';

const put = (token, exemptCount, openPct) => db.prepare(
  `INSERT OR REPLACE INTO launches
     (token, curve, deployer, pair_token, launch_config_id, graduation_threshold,
      block_number, tx_hash, launched_at, name, symbol, snipe_exemption_count,
      snipe_exemptions, entry_point, creator_tax_bps, buyback_enabled,
      exemption_source, exempt_open_pct)
   VALUES (?,?,?,?,1,'4200000000000000000',100,'0xaa',?,?,?,?,'[]','launch',400,0,'logs',?)`,
).run(token, '0x' + 'c'.repeat(40), DEP, '0x' + 'e'.repeat(40), NOW, 'T', 'T', exemptCount, openPct);

const exemptionFlag = (token) => computeFlags({
  token, deployer: DEP, name: 'T', symbol: 'T',
  creatorTaxBps: 400, buybackEnabled: false,
  pairToken: '0x' + 'e'.repeat(40), pairSymbol: 'ETH', scannedAt: NOW,
}).flags.find((f) => f.key === 'snipe_exemptions');

const cardFor = (flags) => renderDefaultCard(makeScan({
  symbol: 'SHUFFLE', ageSeconds: 900, buyers: 12, windowMinutes: 15,
  flags, flagsTotal: 9,
}), 'vitalscheck_bot');

/** Every line the card marks as a finding. */
const findingLines = (card) => card.split('\n').filter((l) => l.startsWith('\u{1F6A9}'));

test('the SHUFFLE headline renders whole, share and all', () => {
  put(SHUFFLE, 2, 2.8);
  const fl = exemptionFlag(SHUFFLE);
  assert.equal(fl.state, 'raised');
  assert.equal(fl.plain, '2 wallets tax-free at launch, 1 of them the deployer, together 2.8% of supply');

  const lines = findingLines(cardFor([fl]));
  assert.equal(lines.length, 1);
  assert.equal(lines[0],
    '\u{1F6A9} 2 wallets tax-free at launch, 1 of them the deployer, together 2.8% of supply');
  // The exact characters that were lost, named rather than implied.
  assert.ok(lines[0].endsWith('together 2.8% of supply'), lines[0]);
  assert.ok(!lines[0].includes('…'), `still truncated: ${lines[0]}`);
});

test('no exemption finding is cut, at any count or any share', () => {
  // The sentence grows with both inputs: the count, the derived "others", and a
  // share that can reach three digits before the decimal. 32 is the protocol's
  // exemption cap.
  for (const n of [2, 3, 9, 10, 31, 32]) {
    for (const pct of [0.1, 2.8, 12.8, 99.9, 100]) {
      const token = `0x${String(n).padStart(2, '0')}${String(Math.round(pct * 10)).padStart(4, '0')}${'b'.repeat(34)}`;
      put(token, n, pct);
      const fl = exemptionFlag(token);
      assert.equal(fl.state, 'raised', `${n}/${pct}`);
      for (const line of findingLines(cardFor([fl]))) {
        assert.ok(!line.includes('…'), `${n} wallets at ${pct}% was cut: ${line}`);
        assert.ok(line.includes(fl.plain), `${n} wallets at ${pct}% lost text: ${line}`);
      }
    }
  }
});

test('a finding well past the old cap survives intact', () => {
  // 70 was the cap. Nothing between it and CONCERN_MAX may be touched.
  const long = `${'word '.repeat(48)}end`.trim();
  assert.ok(long.length > 70 && long.length < CONCERN_MAX, `${long.length}`);
  const line = findingLines(cardFor([{
    key: 'k', label: 'k', state: 'raised', detail: 'd', compactDetail: 'c',
    plain: long, severity: 50,
  }]))[0];
  assert.equal(line, `\u{1F6A9} ${long}`);
  assert.ok(!line.includes('…'));
});

test('the card does not hard-wrap a long finding into extra lines', () => {
  // Deliberate: this is plain text in a Telegram message and the client wraps at
  // the reader's own width. A break chosen here would be wrong on a desktop and
  // would break twice on a phone.
  const long = `${'word '.repeat(40)}end`.trim();
  const card = cardFor([{
    key: 'k', label: 'k', state: 'raised', detail: 'd', compactDetail: 'c',
    plain: long, severity: 50,
  }]);
  assert.equal(findingLines(card).length, 1, 'one finding, one line');
  const short = cardFor([{
    key: 'k', label: 'k', state: 'raised', detail: 'd', compactDetail: 'c',
    plain: 'short one', severity: 50,
  }]);
  assert.equal(card.split('\n').length, short.split('\n').length,
    'and a long finding costs the card no extra line');
});

test('the impossible case cuts at a word, never mid-word', () => {
  // CONCERN_MAX is a backstop for a generator bug, not a working limit. If it is
  // ever reached the card must not stop in the middle of a word the way the 70
  // cap stopped inside "of": it ends at a word boundary and says it was cut.
  const huge = `${'alpha '.repeat(80)}omega`.trim();
  assert.ok(huge.length > CONCERN_MAX);
  const line = findingLines(cardFor([{
    key: 'k', label: 'k', state: 'raised', detail: 'd', compactDetail: 'c',
    plain: huge, severity: 50,
  }]))[0];
  assert.ok(line.endsWith(' …'), `cut without saying so: ${line}`);
  assert.ok(!/alph …$|alp …$|al …$/.test(line), `cut inside a word: ${line}`);
  // Whatever survived is whole words.
  const body = line.slice('\u{1F6A9} '.length, -2);
  assert.ok(body.split(' ').every((w) => w === 'alpha'), body.slice(-40));
});

test('the deployer-only launch is not a finding, and states its share anyway', () => {
  // What VITALS prints on Monday if its deployer is the only exempt wallet. One
  // exempt wallet is the floor every pons launch that exempts anyone has, so it
  // is not raised and takes no marker -- and it still has to say how much of the
  // supply that one wallet took before anyone else could bid. The count is the
  // floor; the share is not.
  const token = '0x37b7534fc61274694638866b73bb68b7add306c8';
  put(token, 1, 5.0);
  const fl = exemptionFlag(token);
  assert.equal(fl.state, 'clean');
  assert.equal(fl.plain,
    'tax-free at launch: the deployer only (the wallet that launched it), 5.0% of supply');
  assert.equal(fl.detail, 'the deployer only, 5.0% of supply, and no other wallet');
  assert.equal(fl.compactDetail, 'the deployer only, 5.0% of supply');
  assert.equal(fl.value.supply_share, 0.05);
  assert.equal(fl.value.wallets, 1);
  assert.equal(fl.value.beyond_deployer, 0);

  const card = cardFor([fl]);
  assert.equal(findingLines(card).length, 0, 'no 🚩: the floor is not a concern');
  const line = card.split('\n').find((l) => l.startsWith('tax-free at launch:'));
  assert.equal(line, 'tax-free at launch: the deployer only, 5.0% of supply',
    'and it is on the default card, not only in /full');
});

test('an unmeasured window says undetermined rather than going quiet', () => {
  const token = '0x' + 'ab'.repeat(20);
  // exempt_open_pct left NULL: the opening window was never read.
  db.prepare('UPDATE launches SET exempt_open_pct = NULL WHERE token = ?').run(
    (put(token, 1, 0), token),
  );
  const fl = exemptionFlag(token);
  assert.equal(fl.state, 'clean');
  assert.match(fl.plain, /share of supply undetermined$/);
  assert.equal(fl.value.supply_share, null);
  const card = cardFor([fl]);
  assert.ok(card.includes('tax-free at launch: the deployer only, share of supply undetermined'), card);
});

test('a raised exemptions check is not restated in the measurements', () => {
  // The concerns block already carries it with its share. Twice on one card, at
  // two roundings, is the defect concentrationLine already guards against.
  const token = '0x' + 'cd'.repeat(20);
  put(token, 3, 7.5);
  const fl = exemptionFlag(token);
  assert.equal(fl.state, 'raised');
  const card = cardFor([fl]);
  assert.equal(findingLines(card).length, 1);
  assert.ok(!card.split('\n').some((l) => l.startsWith('tax-free at launch:')),
    `stated twice:\n${card}`);
});

test('clean and raised say the same thing about an unmeasured share', () => {
  // The asymmetry this closes: the clean branch said "share of supply
  // undetermined" while the raised branch dropped the clause, so the card was
  // more forthcoming about one exempt wallet than about five.
  const one = '0x' + '31'.repeat(20);
  const many = '0x' + '32'.repeat(20);
  put(one, 1, 0);
  put(many, 5, 0);
  db.prepare('UPDATE launches SET exempt_open_pct = NULL WHERE token IN (?,?)').run(one, many);

  const a = exemptionFlag(one);
  const b = exemptionFlag(many);
  assert.equal(a.state, 'clean');
  assert.equal(b.state, 'raised');
  for (const f of [a, b]) {
    assert.match(f.plain, /share of supply undetermined$/, f.plain);
    assert.match(f.compactDetail, /share of supply undetermined$/, f.compactDetail);
    assert.match(f.detail, /undetermined/, f.detail);
    assert.equal(f.value.supply_share, null);
  }
});
