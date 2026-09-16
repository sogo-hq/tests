# correction post

Dated 16 september 2026. Lowercase, vitals voice, no excuses.

Production has been re-read: every decodable launch now has its exemption list
from the curve's own events.

| | |
| --- | --- |
| rows read from the events | 478,610 |
| exactly the deployer | 331,678 (69.3%) |
| beyond the deployer | 146,932 (30.7%) |
| undecodable, still undetermined | 422 |

**The split of the 146,932 is not in this draft yet.** It needs one more pass,
and the reason is in "what is still missing" at the bottom. Fill the two
figures from `/stats tax` before posting, or cut those two lines.

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

we have re-read every launch we can decode, from the curve's own events.

over 478,610 launches:

  exactly the deployer   331,678  69.3%
  beyond the deployer    146,932  30.7%

    of those, the creator's own other wallets only   PENDING_A
    of those, at least one wallet outside them       PENDING_B
    median strangers where there are any             PENDING_MEDIAN

422 launches are still undetermined. their creation transactions use entry
points we have no ABI for, so we cannot read them, and we report that as
undetermined rather than as a number.

what the numbers we published before actually were. 33%, 38% and 29% were a
split of launches by the length of the exemptions array: none, one, and two
or more. they were never a count of tax-free wallets. the 33% we described as
"exempted nobody" was 33% of launches that named nobody in the array, and
every one of them exempted its deployer.

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

## what the three old numbers were

33 + 38 + 29 adds to 100, which is what they were: a partition of decoded
launches by the length of the `exemptions` array in the calldata.

| published as | what it actually counted |
| --- | --- |
| 33% "exempted nobody" | the array was empty. Every one of these launches exempted its deployer, and the fee recipient and buy recipient where those differ. |
| 38% "exempt exactly one wallet" | the array had one entry. The launch exempted that wallet plus up to three creator slots. |
| 29% | the array had two or more entries. |

Only the 33% is traceable in this repository, in a source comment. The 38%
came from a message and the 29% has no source here at all, so check what was
actually posted before correcting a number nobody saw. The arithmetic above is
what the three add up to, not a record of where they were published.

## what is still missing

The two-way split of "beyond the deployer" needs the creator's fee recipient,
and that was never stored. It is in the launch calldata and nowhere else: not
in `TokenLaunched`, not derivable from the exemption list, and not recoverable
by arithmetic over the rows already read. A wallet that is exempt and is not
the sender and not the buy recipient is either the fee recipient or a
stranger, and without the fee recipient stored there is no way to say which.

Two columns are added, `creator_fee_recipient` and `third_party_exempt`, both
written by the decoder. Filling them for existing rows is the same resumable
command as the last pass:

```
node dist/index.js decode
```

or `/decode start` in a DM, with `/decode status` for where it is.

Until then `/stats tax` prints the two buckets over the rows that have the
column and names the rest as not split yet. It never folds an unsplit row into
either bucket, because a row that cannot be classified is not evidence for
whichever side is larger.

## what to check before posting

- Fill PENDING_A, PENDING_B and PENDING_MEDIAN from `/stats tax`, or cut those
  three lines. Do not estimate them: the whole point of this post is that we
  published a number that was a count of something else.
- The median strangers figure is withheld below thirty observations. If it is
  withheld, cut the line rather than printing a floor notice in a post.
- The rehearsal CA and transaction are public and can be linked: token
  `0xae3020888aEd39556469C8A8026672D781FF5f84`, transaction
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

Recompute it now that the lists are the real ones, and publish the new figure
with its n, or do not publish it.

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
