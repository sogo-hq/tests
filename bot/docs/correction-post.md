# correction post, draft

Dated 16 september 2026. Lowercase, vitals voice, no excuses. The figures
marked PENDING are filled from the production re-decode; the method is settled
and only the totals move.

---

## the post

```
correction. 16 sep 2026.

we counted tax-free wallets wrong. every launch on this chain exempts at
least one wallet from the opening tax, and we were reporting some of them as
exempting nobody.

the pons factory exempts four slots, one event each: the wallet that sends
the launch transaction, the creatorFeeRecipient, the wallet that receives the
opening buy, and every entry of the exemptions array. we were counting the
array. the array names none of the first three.

so a launch that exempted only its deployer came out of our decoder as zero.
we checked fourteen of those receipts by hand: fourteen of fourteen had
exempted their deployer. none had exempted nobody. a count of zero was never
possible and we published it anyway.

what was wrong, exactly:

  /stats said "launches with pre-exempted wallets N (X% of decoded)". that
  percentage counted the array, so it read a small number where the true
  answer is every launch. the line is gone.

  the card had a branch that said "nobody got in tax-free at launch" and
  marked it clean. it only fired on rows read from the curve's events, so it
  reached very few cards, but it existed and it was wrong. a zero now reads
  as a read that did not finish.

  the 33% figure we quoted for "launches that exempted nobody" was the array
  count. there is no such thing as a launch that exempted nobody.

what is true, over PENDING_READ launches read from the curve's own events:

  exactly the deployer   PENDING_ONLY (PENDING_ONLY_PCT)
  beyond the deployer    PENDING_BEYOND (PENDING_BEYOND_PCT)
  median where beyond    PENDING_MEDIAN wallets (n=PENDING_SAMPLE)

PENDING_UNREAD launches are still being re-read from the events and are not
in those percentages. they will be, and the numbers may move.

how we found it: our own launch rehearsal. the config said one exempt wallet,
the chain emitted four events. the four were two wallets, and the rehearsal
wallet filled three slots at once. we then put a distinct address in each
slot and simulated against the live factory to see which slot emits what.
that tool is in the repo: tools/exemption-slots.mjs. it signs nothing.

two figures we have published and cannot stand behind:

  "median hold of an exempted wallet 141 seconds" is computed from the stored
  exemption list, which was the calldata array. so it measured wallets an
  author named on purpose and never the deployer, the fee recipient or the
  buy recipient. that is a different population from the one the sentence
  names. we are not restating it until it is recomputed from the events.

  "57% of buyers inside that window" is not produced by anything in our
  codebase. we cannot show where it came from, so treat it as withdrawn.

nothing about the checks changed. what changed is that the number under the
check is now the number of wallets rather than the length of a list in the
calldata.
```

---

## what to check before posting

- The PENDING values come from `/stats tax` after the production re-decode.
- The 33% figure was quoted in a source comment and possibly in a post. Check
  the X history before claiming what was published where; if it was never
  posted publicly, drop that paragraph rather than inventing a correction to
  something nobody saw.
- The rehearsal CA and transaction are public and can be linked:
  token `0xae3020888aEd39556469C8A8026672D781FF5f84`, transaction
  `0xf8c440ccc8c880671f22732c31046227de07d2b25113599cee43798f82f3e213`.

## the two unverified figures, in detail

### "median hold of an exempted wallet 141 seconds"

**Not from the events path.** `exemptedHoldTime()` selects launches where
`snipe_exemption_count > 0` and reads the wallet list out of
`snipe_exemptions`. That column holds whatever the decoder that ran wrote.

Before the correction almost every row was decoded from calldata, and the
calldata path wrote the exemptions array. So the population was wallets an
author explicitly named, never the deployer, the creatorFeeRecipient or the
opening-buy recipient, and never the launches whose array was empty, which
were the large majority.

It is also bounded by something the sentence does not say: hold times come
from `trades`, which is only populated for tokens somebody scanned.

Measured on the working copy part way through the re-decode: median 27s over
1,595 pairs. That is not a restatement, it is evidence the figure moves with
the population. Recompute it after the production re-decode and publish the
new figure with its n, or do not publish it.

### "57% of buyers inside that window"

**No source.** Nothing in this codebase computes a share of buyers inside a
window. There is no function, no query and no stored column behind it. It
cannot be checked, reproduced or corrected, so it should be withdrawn rather
than restated.

## the method, for anyone who wants to repeat it

```
node tools/exemption-slots.mjs
```

Simulates a launch through `eth_simulateV1` against the live factory with a
distinct address in each slot and prints which slot produced which event.
Signs nothing, sends nothing.

The re-decode is the existing decoder over the rows the old path settled:

```
node dist/index.js decode
```

It reads each launch transaction's receipt and takes the exemption list from
the curve's own events, de-duplicated. Resumable, and it picks up every row
whose `exemption_source` is null or `calldata`.
