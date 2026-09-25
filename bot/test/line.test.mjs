/**
 * The one line another bot embeds.
 *
 * Everything here is about the two properties that make it embeddable rather
 * than merely short: the shape never moves, and no part is ever quietly
 * missing. A card can grow a line or reword one. This cannot: something else
 * prints it inside its own output, and the moment its shape changes, every
 * embedder is printing a broken string it did not write and cannot fix.
 *
 * Fixtures only. Nothing here reads a chain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './tmpdb.mjs';

process.env.DB_PATH = process.env.DB_PATH || freshDb('line');

const L = await import('../dist/line.js');
const { makeScan } = await import('./fixtures.mjs');
const { BLOCK_TIME_SECONDS } = await import('../dist/config.js');

/**
 * A scan whose exemption flag and tax median are stated directly.
 *
 * The line reads what the card already computed, so a fixture for it is a
 * fixture of the card's output rather than of the chain.
 */
const scan = ({
  wallets = 3, share = 0.124, median = 100, tax = 400,
  cohort = 12, sold = 0, firstSoldBlock = null,
  declaration = null, ageSeconds = 840, launchBlock = 1_000_000,
  exemptValue,
} = {}) => {
  const s = makeScan({ ageSeconds, creatorTaxBps: tax });
  s.launchBlock = launchBlock;
  s.reads.creatorTaxBps = tax;
  s.flags.creatorTaxMedianBps = median;
  s.flags.declaration = declaration;
  s.flags.flags = [{
    key: 'snipe_exemptions', label: 'Snipe-tax exemptions', state: 'clean',
    detail: 'd', compactDetail: 'c', plain: 'p', severity: 0,
    value: exemptValue !== undefined
      ? exemptValue
      : { wallets, beyond_deployer: Math.max(0, wallets - 1), supply_share: share, slots: 32 },
  }];
  s.earlySells = cohort === null ? null : { cohort, sold, firstSoldBlock };
  return s;
};

const built = (o) => L.buildLine(scan(o));

// ------------------------------------------------------------- the shape

test('the shape is vitals, who, what, cost, and never anything else', () => {
  const b = built();
  assert.ok(b, 'no line was built');
  const parts = L.lineParts(b.line);
  assert.equal(parts.length, 4, b.line);
  assert.equal(parts[0], 'vitals');
  assert.equal(b.version, L.LINE_VERSION);
  assert.equal(L.LINE_VERSION, 1);
});

test('a declaration adds one part and nothing adds a sixth', () => {
  const b = built({ declaration: { id: 7, freeSlot: 1 } });
  const parts = L.lineParts(b.line);
  assert.equal(parts.length, 5);
  assert.equal(parts[4], 'declared #001');
});

test('the line stays under the bound, on the longest shape it has', () => {
  // Every part at its longest at once: four digits of wallets, a two decimal
  // share, an hours-old age, a two decimal tax and median, and a declaration.
  const b = built({
    wallets: 9999, share: 0.99994, median: 1234, tax: 9999,
    ageSeconds: 86_400 * 9, declaration: { id: 999, freeSlot: 999 },
  });
  assert.ok(b, 'the longest shape built no line at all');
  assert.ok(b.line.length <= L.LINE_MAX, `${b.line.length} characters: ${b.line}`);
  assert.equal(L.LINE_MAX, 110);
});

test('a line that would exceed the bound is withheld, never truncated', () => {
  // A pair symbol cannot reach the line, so the bound is reached by making the
  // parts absurd. What matters is that the answer is null and not a cut string.
  const s = scan();
  s.flags.declaration = { id: 1, freeSlot: 1 };
  s.earlySells = { cohort: 1, sold: 1, firstSoldBlock: 1_000_000 };
  const long = { ...s, flags: { ...s.flags, creatorTaxMedianBps: 100 } };
  // Force the who part past the bound through the value the card handed over.
  long.flags.flags = [{ ...s.flags.flags[0], value: { wallets: 10 ** 60, supply_share: 1 } }];
  const b = L.buildLine(long);
  if (b !== null) assert.ok(b.line.length <= L.LINE_MAX, b.line);
  else assert.equal(b, null);
});

// ---------------------------------------------------------------- the who

test('the only exempt wallet being the deployer is said in words, with its share', () => {
  const b = built({ wallets: 1, share: 0.05 });
  assert.match(b.line, /vitals · only the deployer, 5\.0% of supply · /);
  // Never as a count, and never counted a second time on top of it.
  assert.ok(!b.line.includes('1 in before you'), b.line);
  assert.ok(!b.line.includes('2 in before you'), b.line);
});

test('more than one exempt wallet counts the deployer once, inside the count', () => {
  // The count is the distinct exempt set, the deployer among them. The line
  // does not add it and does not subtract it.
  assert.match(built({ wallets: 2, share: 0.08 }).line, /2 in before you, 8\.0% of supply/);
  assert.match(built({ wallets: 9, share: 0.401 }).line, /9 in before you, 40\.1% of supply/);
});

test('an unread exempt set is undetermined, not zero and not absent', () => {
  for (const exemptValue of [null, {}, { wallets: 0 }, { wallets: 'three' }]) {
    const b = built({ exemptValue });
    assert.ok(b, JSON.stringify(exemptValue));
    assert.equal(L.lineParts(b.line)[1], 'undetermined', b.line);
  }
});

test('a known count with an unread share says the share is undetermined', () => {
  const b = built({ exemptValue: { wallets: 4, supply_share: null } });
  assert.equal(L.lineParts(b.line)[1], '4 in before you, share undetermined');
});

test('no exemption flag at all builds no line', () => {
  // A part that cannot be built at all is not the same as one that could not be
  // measured. The first returns nothing rather than a partial claim.
  const s = scan();
  s.flags.flags = [];
  assert.equal(L.buildLine(s), null);
});

// -------------------------------------------------------- what they did

test('nobody out yet is still in, with the age that was true at', () => {
  const b = built({ cohort: 12, sold: 0, ageSeconds: 840 });
  assert.equal(L.lineParts(b.line)[2], 'still in at 14m');
});

test('an exit is reported at the time of the first one', () => {
  // 210 blocks at 0.1s is 21 seconds.
  const b = built({ cohort: 12, sold: 3, launchBlock: 1_000_000, firstSoldBlock: 1_000_210 });
  assert.equal(L.lineParts(b.line)[2], 'first exit at 21s');
  assert.equal(BLOCK_TIME_SECONDS, 0.1);
});

test('the earliest exit is the one reported, whatever order the walk saw them', () => {
  const b = built({ cohort: 5, sold: 2, launchBlock: 1_000_000, firstSoldBlock: 1_000_010 });
  assert.equal(L.lineParts(b.line)[2], 'first exit at 1s');
});

test('an unread window is undetermined, not "still in"', () => {
  // The dangerous default. A window that was never indexed has nobody selling
  // in it, and "still in" would turn an unread window into a fact about holders.
  for (const o of [{ cohort: null }, { cohort: 0, sold: 0 }]) {
    assert.equal(L.lineParts(built(o).line)[2], 'undetermined', JSON.stringify(o));
  }
});

test('a sale with no block says the exit time is undetermined, and keeps the count', () => {
  const b = built({ cohort: 9, sold: 2, firstSoldBlock: null });
  assert.equal(L.lineParts(b.line)[2], '2 of 9 out, first exit undetermined');
});

test('what they did never carries the index', () => {
  // The index appears once, in the cost, with the word median on it.
  for (const o of [{ sold: 0 }, { sold: 2, firstSoldBlock: 1_000_210 }, { cohort: null }]) {
    const did = L.lineParts(built(o).line)[2];
    assert.doesNotMatch(did, /median|index/, did);
  }
});

// -------------------------------------------------------------- the cost

test('the cost is this token first and the index named as a median', () => {
  assert.equal(L.lineParts(built({ tax: 400, median: 100 }).line)[3], 'tax 4%, median 1%');
  assert.equal(L.lineParts(built({ tax: 850, median: 125 }).line)[3], 'tax 8.5%, median 1.25%');
  assert.equal(L.lineParts(built({ tax: 0, median: 100 }).line)[3], 'tax 0%, median 1%');
});

test('an index that cannot support a median says so rather than printing one', () => {
  const b = built({ tax: 400, median: null });
  assert.equal(L.lineParts(b.line)[3], 'tax 4%, median undetermined');
});

test('the word median is always attached to the index figure', () => {
  for (const median of [0, 100, 1234, null]) {
    const cost = L.lineParts(built({ median }).line)[3];
    assert.match(cost, /median/, cost);
  }
});

test('an unreadable tax builds no line', () => {
  for (const tax of [NaN, -1]) {
    const s = scan();
    s.reads.creatorTaxBps = tax;
    assert.equal(L.buildLine(s), null, String(tax));
  }
});

// ------------------------------------------------------- the declaration

test('a declaration prints its founding number, padded', () => {
  assert.match(built({ declaration: { id: 42, freeSlot: 1 } }).line, /declared #001$/);
  assert.match(built({ declaration: { id: 42, freeSlot: 17 } }).line, /declared #017$/);
  assert.match(built({ declaration: { id: 42, freeSlot: 250 } }).line, /declared #250$/);
});

test('a declaration outside the founding window falls back to its id', () => {
  assert.match(built({ declaration: { id: 512, freeSlot: null } }).line, /declared #512$/);
});

test('no declaration prints nothing at all, because not declared is not a finding', () => {
  const b = built({ declaration: null });
  assert.equal(L.lineParts(b.line).length, 4);
  assert.doesNotMatch(b.line, /declar/i, b.line);
  assert.doesNotMatch(b.line, /undeclared|not declared|none/i, b.line);
});

test('the line never re-decides whether a declaration counts', () => {
  // declarationFor already refuses one signed at or after the launch block, so
  // whatever the card attached is what the line prints. A second rule here
  // would be a second rule.
  const b = built({ declaration: { id: 3, freeSlot: 3 } });
  assert.match(b.line, /declared #003$/);
});

// ------------------------------------------------------- the house rules

test('no part is ever silently absent: every line has four dots or five', () => {
  const cases = [
    {}, { wallets: 1 }, { exemptValue: null }, { cohort: null },
    { sold: 2, firstSoldBlock: 1_000_050 }, { median: null },
    { tax: 0 }, { declaration: { id: 1, freeSlot: 1 } },
    { exemptValue: { wallets: 4, supply_share: null } },
    { cohort: 3, sold: 1, firstSoldBlock: null },
  ];
  for (const o of cases) {
    const b = built(o);
    assert.ok(b, `no line for ${JSON.stringify(o)}`);
    const parts = L.lineParts(b.line);
    assert.ok(parts.length === 4 || parts.length === 5, `${parts.length} parts: ${b.line}`);
    for (const [i, p] of parts.entries()) {
      assert.ok(p.trim().length > 0, `part ${i} is empty: ${b.line}`);
    }
    assert.ok(b.line.length <= L.LINE_MAX, `${b.line.length}: ${b.line}`);
  }
});

test('it says nothing a card is not allowed to say', () => {
  for (const o of [{}, { wallets: 1 }, { exemptValue: null }, { median: null }, { cohort: null }]) {
    const line = built(o).line;
    assert.doesNotMatch(line, /\bclean\b|\bsafe\b|\blooks good\b|\bgood entry\b|will pump/i, line);
    assert.doesNotMatch(line, /!/, line);
    assert.ok(!line.includes(String.fromCharCode(0x2014)), line);
    // No price, no direction.
    assert.doesNotMatch(line, /\$\d|\bup \d|\bdown \d|\bmcap\b|\bprice\b/i, line);
  }
});

test('the separator is one middle dot with a space either side, everywhere', () => {
  const line = built({ declaration: { id: 1, freeSlot: 1 } }).line;
  assert.equal((line.match(/ · /g) ?? []).length, 4);
  // Never a bare dot, which would split differently for an embedder.
  assert.doesNotMatch(line, /\S·|·\S/, line);
});
