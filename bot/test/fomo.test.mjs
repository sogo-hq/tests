/**
 * The leaderboard, the paid call, and the overlap, on fixtures.
 *
 * No network. What is pinned is the three things that break a run of
 * tools/fomo_intersect.mjs without failing loudly: a leaderboard field that
 * moved, a paid answer wrapped in a shape the parser did not expect, and an
 * intersection joined on addresses whose case does not match, which produces
 * an empty file that looks like a finding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const F = await import('../dist/fomo.js');

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/fomo-leaderboard.json', import.meta.url), 'utf8'));

// ------------------------------------------------------------ leaderboard

test('the live-shaped leaderboard parses, with style as the list it is', () => {
  const { traders, skipped } = F.parseLeaderboard(LIVE);
  assert.equal(skipped, 0);
  assert.equal(traders.length, LIVE.traders.length);
  const first = traders[0];
  assert.equal(first.handle, LIVE.traders[0].handle);
  assert.equal(first.address, LIVE.traders[0].address.toLowerCase());
  assert.equal(first.score, LIVE.traders[0].score);
  assert.ok(Array.isArray(first.style) && first.style.length > 0, 'style came back empty');
  assert.deepEqual(first.style, LIVE.traders[0].style);
  assert.equal(typeof first.fomoPnl, 'number');
  // Every address is the join key, so every one is lowercase.
  for (const t of traders) assert.match(t.address, /^0x[0-9a-f]{40}$/);
});

test('a trader with no address is dropped and counted, never carried', () => {
  const { traders, skipped } = F.parseLeaderboard({
    traders: [
      { handle: 'good', address: '0x' + 'a'.repeat(40), score: 80, style: ['sniper'] },
      { handle: 'noaddress', score: 90, style: ['holder'] },
      { handle: 'bad', address: 'not-an-address', score: 90 },
      { address: '0x' + 'b'.repeat(40), score: 90 },
    ],
  });
  assert.deepEqual(traders.map((t) => t.handle), ['good']);
  assert.equal(skipped, 3, 'a row that can never match was kept');
});

test('a style that arrives as a string still fills the column', () => {
  const { traders } = F.parseLeaderboard({
    traders: [{ handle: 'a', address: '0x' + 'c'.repeat(40), score: 75, style: 'sniper' }],
  });
  assert.deepEqual(traders[0].style, ['sniper']);
});

test('a checksummed address from the leaderboard is lowercased', () => {
  const mixed = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
  const { traders } = F.parseLeaderboard({ traders: [{ handle: 'a', address: mixed, score: 75 }] });
  assert.equal(traders[0].address, mixed.toLowerCase());
});

test('an empty or malformed body gives no traders rather than throwing', () => {
  assert.deepEqual(F.parseLeaderboard(null).traders, []);
  assert.deepEqual(F.parseLeaderboard({}).traders, []);
  assert.deepEqual(F.parseLeaderboard({ traders: 'nope' }).traders, []);
});

// ------------------------------------------------------------ smart holders

const A = (n) => '0x' + String(n).padStart(40, '0');

test('holders are read out of the MCP envelope, whichever layer they are in', () => {
  const payload = { holders: [{ address: A(1), pnl: 1 }, { address: A(2) }] };
  const shapes = {
    'a jsonrpc result with a text content part': {
      jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    },
    'structuredContent': { jsonrpc: '2.0', id: 2, result: { structuredContent: payload } },
    'the result alone': { result: payload },
    'the payload alone': payload,
    'a bare array of objects': [{ wallet: A(1) }, { wallet: A(2) }],
    'a bare array of strings': [A(1), A(2)],
    'nested under a name we do not know': { data: { smart_holders: [{ holder: A(1) }, { holder: A(2) }] } },
    'a JSON string': JSON.stringify(payload),
  };
  for (const [label, raw] of Object.entries(shapes)) {
    const got = F.parseSmartHolders(raw);
    assert.deepEqual(got.wallets, [A(1), A(2)], `${label}: got ${JSON.stringify(got.wallets)}`);
  }
});

test('addresses are lowercased and de-duplicated', () => {
  const got = F.parseSmartHolders({
    holders: [{ address: '0x' + 'A'.repeat(40) }, { address: '0x' + 'a'.repeat(40) }, { address: A(3) }],
  });
  assert.deepEqual(got.wallets, ['0x' + 'a'.repeat(40), A(3)]);
});

test('the token being asked about does not become its own holder', () => {
  // The payload names the token at the top level. A parser that swept every
  // hex string out of it would put the token in every intersection.
  const got = F.parseSmartHolders({
    token: A(99), symbol: 'ZZZ', total_supply: '1000000000',
    holders: [{ address: A(1) }],
  });
  assert.deepEqual(got.wallets, [A(1)], 'something other than a holder was collected');
});

test('an answer with no holders in it gives none, and does not throw', () => {
  for (const raw of [null, {}, { result: {} }, { result: { content: [{ type: 'text', text: 'not json' }] } },
    { holders: [] }, { holders: [{ pnl: 1 }] }, 'plain text']) {
    assert.deepEqual(F.parseSmartHolders(raw).wallets, []);
  }
});

test('a payment receipt is found wherever the transport put it', () => {
  assert.equal(F.parseSmartHolders({ receipt: '0xabc', holders: [{ address: A(1) }] }).receipt, '0xabc');
  assert.equal(F.parseSmartHolders({ result: { _meta: { x402_receipt: { txHash: '0xdef' } }, content: [{ type: 'text', text: '{"holders":[]}' }] } }).receipt, '0xdef');
  assert.equal(F.parseSmartHolders({ holders: [{ address: A(1) }] }).receipt, null);
});

// -------------------------------------------------------------- the overlap

const trader = (handle, address, score, style = ['holder']) => ({
  handle, address: address.toLowerCase(), score, style, status: 'active', fomoPnl: score * 1000, redFlags: [], summary: '',
});

test('the intersection joins on the wallet, whatever case each side used', () => {
  // The leaderboard gives lowercase and a chain tool gives checksummed. Joined
  // naively these two sets never meet and the file comes out empty.
  const traders = [trader('alice', A(1), 90), trader('bob', A(2), 80), trader('carol', A(3), 70)];
  const tokens = [
    { symbol: 'ZZZ', address: A(90), holders: [A(1).toUpperCase().replace('0X', '0x'), A(2)], receipt: '0xr1' },
    { symbol: 'CHIPPER', address: A(91), holders: [A(1)], receipt: '0xr2' },
  ];
  const got = F.intersect(traders, tokens);
  assert.deepEqual(got.map((c) => c.handle), ['alice', 'bob'], 'carol holds nothing and must not be here');
  assert.deepEqual(got[0].tokens, ['ZZZ', 'CHIPPER']);
  assert.deepEqual(got[0].receipts, ['0xr1', '0xr2']);
  assert.deepEqual(got[1].tokens, ['ZZZ']);
});

test('the order is score, then how many tokens, then handle', () => {
  const traders = [
    trader('low', A(1), 70), trader('zeta', A(2), 90), trader('alpha', A(3), 90), trader('two', A(4), 90),
  ];
  const tokens = [
    { symbol: 'ZZZ', address: A(90), holders: [A(1), A(2), A(3), A(4)], receipt: null },
    { symbol: 'CHIPPER', address: A(91), holders: [A(4)], receipt: null },
  ];
  const got = F.intersect(traders, tokens);
  assert.deepEqual(got.map((c) => c.handle), ['two', 'alpha', 'zeta', 'low']);
  // Deterministic: the same inputs give the same file every time.
  assert.deepEqual(F.intersect(traders, tokens).map((c) => c.handle), got.map((c) => c.handle));
});

test('a holder who is on no leaderboard is not a candidate', () => {
  const got = F.intersect([trader('alice', A(1), 90)], [{ symbol: 'ZZZ', address: A(90), holders: [A(7), A(8)], receipt: null }]);
  assert.deepEqual(got, []);
});

test('a token whose paid call returned nothing contributes nothing, and does not break the rest', () => {
  const traders = [trader('alice', A(1), 90)];
  const got = F.intersect(traders, [
    { symbol: 'ZZZ', address: A(90), holders: [], receipt: null },
    { symbol: 'CHIPPER', address: A(91), holders: [A(1)], receipt: '0xr' },
  ]);
  assert.deepEqual(got.map((c) => c.tokens), [['CHIPPER']]);
});

// ---------------------------------------------------------------- the files

test('the top list is every trader at or above the cut, highest first', () => {
  const { traders } = F.parseLeaderboard(LIVE);
  const top = F.topTraders(traders, 74);
  assert.ok(top.length > 0);
  assert.ok(top.every((t) => t.score >= 74), 'somebody under the cut is in the list');
  assert.equal(top.length, traders.filter((t) => t.score >= 74).length, 'somebody over the cut was dropped');
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].score >= top[i].score, 'not sorted by score');
  assert.equal(F.FOMO_TOP_SCORE, 74);
});

test('a summary with commas and quotes does not shift a column', () => {
  const nasty = 'PONS at 91x, "the largest", and\nthen some';
  assert.equal(F.csvCell(nasty), '"PONS at 91x, ""the largest"", and\nthen some"');
  assert.equal(F.csvCell('plain'), 'plain');
  assert.equal(F.csvCell(null), '');
  assert.equal(F.csvCell(0), '0');
});

test('the candidates file has a header and one row per candidate', () => {
  const rows = F.intersect(
    [trader('alice', A(1), 90, ['sniper', 'holder'])],
    [{ symbol: 'ZZZ', address: A(90), holders: [A(1)], receipt: '0xr1' }],
  );
  const lines = F.candidatesCsv(rows).trim().split('\n');
  assert.equal(lines[0], 'username,fomo_score,style,wallet,tokens_held,token_count,robinx_receipt,fomo_pnl,red_flags');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], `alice,90,sniper holder,${A(1)},ZZZ,1,0xr1,90000,`);
  // With no candidates it is still a valid file with a header.
  assert.equal(F.candidatesCsv([]).trim().split('\n').length, 1);
});

test('the top file carries the style column, and every cell survives a round trip', () => {
  const { traders } = F.parseLeaderboard(LIVE);
  const csv = F.topCsv(F.topTraders(traders, 74));
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'username,fomo_score,style,wallet,fomo_pnl,red_flags');
  assert.equal(lines.length, F.topTraders(traders, 74).length + 1);
  // Every data line has the same number of fields once quoting is honoured.
  const fields = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  for (const line of lines) assert.equal(fields(line).length, 6, line.slice(0, 60));
  const first = fields(lines[1]);
  assert.match(first[3], /^0x[0-9a-f]{40}$/, 'the wallet column is not a wallet');
  assert.ok(first[2].length > 0, 'the style column is empty');
});
