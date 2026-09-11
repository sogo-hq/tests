/**
 * The paid line, and the rules that stop it eating the product.
 *
 * This is how the project gets funded, and it is also the only thing on a card
 * that somebody has an interest in bending. The product's whole claim is that a
 * card states facts and makes no call; a sponsor line that recommends anything
 * ends that claim for every line above it too.
 *
 * The hardest case is the first one below, and it came from the spec itself:
 * the example line is "$MOON is live on pons" while "moon" is on the banned
 * list. A validator that cannot tell a token's NAME from a PROMISE about it
 * would reject the very line it was written for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSponsorText, sponsorLine, resetSponsor, MAX_SPONSOR_LEN } from '../dist/sponsor.js';

const accept = (line) => {
  const r = checkSponsorText(line);
  assert.ok(r.ok, `rejected a legitimate line — ${r.reason}\n  ${line}`);
};
const reject = (line, why) => {
  const r = checkSponsorText(line);
  assert.equal(r.ok, false, `accepted "${line}" — it ${why}`);
};

test('a token may be NAMED with a word it may not be PROMISED with', () => {
  // The spec's own example. $MOON is a subject; "will moon" is a claim.
  accept('ad · $MOON is live on pons — scan it: 0xd5f1…');
  accept('ad · $GEM just launched on pons — scan it');
  accept('ad · $APE is live on pons — scan it');
  reject('ad · $TOKEN is going to moon', 'promises a direction');
  reject('ad · this one is a gem', 'calls it a gem');
  reject('ad · ape into $TOKEN', 'says ape');
});

test('it points at a scan, never at a buy', () => {
  for (const [line, why] of [
    ['ad · buy $TOKEN now on pons', 'says buy'],
    ['ad · $TOKEN — don\'t miss this', 'says do not miss'],
    ['ad · $TOKEN, dont miss it', 'says dont miss'],
    ['ad · $TOKEN is pumping right now', 'says pumping'],
    ['ad · $TOKEN — send it', 'says send it'],
    ['ad · $TOKEN did 100x since launch', 'states a multiple'],
    ['ad · $TOKEN 2.5x today', 'states a multiple'],
  ]) reject(line, why);
});

test('no percentage and no price', () => {
  for (const [line, why] of [
    ['ad · $TOKEN is 40% to graduation — scan it', 'states a percentage'],
    ['ad · $TOKEN up 12 percent — scan it', 'states a percentage'],
    ['ad · $TOKEN at $0.004 — scan it', 'states a price'],
    ['ad · $TOKEN has 1.7 ETH in the curve — scan it', 'states a price'],
    ['ad · $TOKEN mcap is climbing — scan it', 'talks about market cap'],
  ]) reject(line, why);
  // The ticker's dollar sign is not a price.
  accept('ad · $MOON is live on pons — scan it');
});

test('shape limits: one line, bounded', () => {
  reject('ad · $TOKEN is live\non a second line', 'contains a line break');
  reject('ad · ' + 'x'.repeat(MAX_SPONSOR_LEN), 'is longer than the cap');
  assert.equal(checkSponsorText('   ').ok, false, 'blank is not a line');
});

test('nothing configured renders nothing at all — no line, no gap', async () => {
  const saved = process.env.SPONSOR_LINE;
  try {
    delete process.env.SPONSOR_LINE;
    resetSponsor();
    assert.equal(sponsorLine(), null);

    process.env.SPONSOR_LINE = '   ';
    resetSponsor();
    assert.equal(sponsorLine(), null, 'whitespace is not a sponsor');
  } finally {
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
  }
});

test('a rejected line renders nothing rather than something', () => {
  const saved = process.env.SPONSOR_LINE;
  try {
    process.env.SPONSOR_LINE = 'ad · buy $TOKEN now';
    resetSponsor();
    assert.equal(sponsorLine(), null, 'a line that breaks the rule must not render at all');
  } finally {
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
  }
});

test('an addressless line is live immediately, and read at send time', () => {
  const saved = process.env.SPONSOR_LINE;
  try {
    process.env.SPONSOR_LINE = 'ad · $MOON is live on pons — scan it';
    resetSponsor();
    assert.equal(sponsorLine(), 'ad · $MOON is live on pons — scan it');

    // Changed without a deploy: the next read picks it up.
    process.env.SPONSOR_LINE = 'ad · $OTHER is live on pons — scan it';
    assert.equal(sponsorLine(), 'ad · $OTHER is live on pons — scan it');

    // And a change to something forbidden takes it down again.
    process.env.SPONSOR_LINE = 'ad · buy $OTHER';
    assert.equal(sponsorLine(), null);
  } finally {
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
  }
});

test('a full address is held back until the factory confirms it', async () => {
  const saved = process.env.SPONSOR_LINE;
  const savedFetch = globalThis.fetch;
  const real = '0x' + 'a'.repeat(40);
  let asked = 0;
  try {
    // The factory says this token does not exist.
    globalThis.fetch = async (_u, init) => {
      const b = JSON.parse(init.body);
      asked++;
      // eth_call returning a struct with exists=false is fiddly to encode; the
      // decode failing is enough — an unverifiable address must not render.
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: '0x' }),
        { headers: { 'content-type': 'application/json' } });
    };
    process.env.SPONSOR_LINE = `ad · $TOKEN is live on pons — scan it: ${real}`;
    resetSponsor();

    // Synchronous first read must NOT render it: the chain has not answered.
    assert.equal(sponsorLine(), null, 'an unverified address rendered on trust');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sponsorLine(), null, 'it rendered an address the factory does not know');
    assert.ok(asked > 0, 'it never asked the factory at all');
  } finally {
    globalThis.fetch = savedFetch;
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
  }
});

test('the line cannot vary by card, because it cannot see one', () => {
  // Structural, not a convention: sponsorLine() takes no arguments, so there is
  // no token, flag count or outcome for it to read. A sponsor cannot buy a
  // different card if the function producing their line cannot tell them apart.
  assert.equal(sponsorLine.length, 0, 'sponsorLine must take no arguments');
});

// ---------------------------------------------------------------- on the card
test('the sponsor sits second from last, and the disclaimer is always last', async () => {
  const { renderDefaultCard, cardLines } = await import('../dist/card.js');
  const { makeScan } = await import('./fixtures.mjs');
  const saved = process.env.SPONSOR_LINE;
  try {
    process.env.SPONSOR_LINE = 'ad · $MOON is live on pons — scan it';
    resetSponsor();
    const lines = renderDefaultCard(makeScan({}), 'vitalscheck_bot').split('\n');
    assert.equal(lines[lines.length - 1], '@vitalscheck_bot · @vitalsofficial · not financial advice',
      'whatever was paid for, it does not get the last word');
    assert.equal(lines[lines.length - 2], 'ad · $MOON is live on pons — scan it');
    assert.match(lines[lines.length - 3], /no finding ≠ clean/,
      'the doctrine line sits above the paid one');

    const roles = cardLines(makeScan({}), 'b').map((l) => l.role);
    assert.equal(roles[roles.length - 1], 'footer');
    assert.equal(roles[roles.length - 2], 'sponsor');
  } finally {
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
  }
});

test('with no sponsor there is no line and no gap', async () => {
  const { renderDefaultCard } = await import('../dist/card.js');
  const { makeScan } = await import('./fixtures.mjs');
  const saved = process.env.SPONSOR_LINE;
  try {
    delete process.env.SPONSOR_LINE;
    resetSponsor();
    const card = renderDefaultCard(makeScan({}), 'b');
    const lines = card.split('\n');
    assert.doesNotMatch(card, /\bad ·/, 'an empty sponsor rendered something');
    // The doctrine line sits directly above the footer, and the single blank
    // sits above that -- no second blank held open for a line that is not there.
    assert.match(lines[lines.length - 2], /no finding ≠ clean/);
    assert.equal(lines[lines.length - 3], '');
    assert.notEqual(lines[lines.length - 4], '', 'an empty sponsor left a gap where it would have been');
  } finally {
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
  }
});

test('the same line reaches the image, and the image footer is clickable-free', async () => {
  const { cardSvg } = await import('../dist/image.js');
  const { makeScan } = await import('./fixtures.mjs');
  const saved = process.env.SPONSOR_LINE;
  try {
    process.env.SPONSOR_LINE = 'ad · $MOON is live on pons — scan it';
    resetSponsor();
    const svg = cardSvg(makeScan({}));
    const drawn = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    assert.ok(drawn.some((t) => /\$MOON is live on pons/.test(t)),
      `the picture dropped the paid line:\n${drawn.join('\n')}`);
    // A PNG cannot be clicked, so the footer has to give something a reader can
    // act on by typing. checkvitals.xyz is that; the bot handle is typeable into
    // Telegram's own search, which a bare channel @handle is not.
    assert.ok(drawn.some((t) => /checkvitals\.xyz/.test(t)),
      'the image footer must give an address someone can type');
    assert.ok(drawn.some((t) => /@vitalscheck_bot, paste any CA/.test(t)),
      'and say what to do with it');
  } finally {
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
  }
});

test('one line, identical on every card', async () => {
  const { renderDefaultCard } = await import('../dist/card.js');
  const { makeScan } = await import('./fixtures.mjs');
  const f = (k, plain, sev, state = 'raised') =>
    ({ key: k, label: k, state, detail: k, compactDetail: k, plain, severity: sev });
  const saved = process.env.SPONSOR_LINE;
  try {
    process.env.SPONSOR_LINE = 'ad · $MOON is live on pons — scan it';
    resetSponsor();
    // Wildly different cards: clean, alarming, undetermined, graduated.
    const cards = [
      makeScan({}),
      makeScan({ flags: [f('a', 'x', 100), f('b', 'y', 90), f('c', 'z', 80)], flagsTotal: 9 }),
      makeScan({ windowIndexed: false, ageSeconds: 23 * 86_400 }),
      makeScan({ buyers: 0, roundTrippers: 0, phaseName: 'Graduated' }),
    ].map((r) => renderDefaultCard(r, 'b').split('\n').find((l) => l.startsWith('ad ·')));
    assert.equal(new Set(cards).size, 1, `the paid line varied by card: ${JSON.stringify(cards)}`);
    assert.equal(cards[0], 'ad · $MOON is live on pons — scan it');
  } finally {
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
  }
});

test('a change reaches the next card, not the next minute', async () => {
  // The paid line lives inside the cached card's text. Without the cache
  // knowing that, a line set now would not appear until the entry expired --
  // and a card cached before it was set would show no line at all. "Read at
  // send time" has to mean the next card.
  const { scanCache } = await import('../dist/cache.js');
  const { makeScan } = await import('./fixtures.mjs');
  const { renderDefaultCard } = await import('../dist/card.js');
  const saved = process.env.SPONSOR_LINE;
  const token = '0x' + 'ab'.repeat(20);
  try {
    delete process.env.SPONSOR_LINE;
    resetSponsor();
    const r = makeScan({});
    scanCache.set(token, { defaultCard: renderDefaultCard(r, 'b'), fullCard: '', meta: {} });
    assert.ok(scanCache.get(token), 'the entry should be there to begin with');
    assert.doesNotMatch(scanCache.get(token).defaultCard, /\bad ·/);

    // A sponsor arrives. The cached card is now the wrong card.
    process.env.SPONSOR_LINE = 'ad · $MOON is live on pons — scan it';
    resetSponsor();
    sponsorLine();
    assert.equal(scanCache.get(token), null,
      'a card rendered under the previous sponsor was served after it changed');
  } finally {
    scanCache.drop(token);
    if (saved === undefined) delete process.env.SPONSOR_LINE; else process.env.SPONSOR_LINE = saved;
    resetSponsor();
  }
});
