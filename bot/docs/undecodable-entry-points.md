# What is behind "entry points this build has no ABI for"

Read-only report. Nothing here changes the decoder, and no ABI is added.
Written 17 september 2026, before launch. The work it describes is for after.

## How to reproduce it

```
node tools/undecodable.mjs            the rows the decoder gave up on
node tools/undecodable.mjs --all      every undecoded row, for a database mid-run
```

It reads the launch transaction of each row, groups by the first four bytes of
the input, and asks the decoder in this build whether it decodes. Nothing is
written, nothing is signed, nothing is sent.

## What is there

Measured over 200 rows on the working copy. **The counts below are that
sample, not production.** Production has 422 rows out of attempts; run the
command there with no flags to get their counts. What the sample gives is the
set of kinds, and that is the part that decides what work exists.

| selector | sample count | decodes today | sent to | what it is |
| --- | --- | --- | --- | --- |
| `0xf85f8e41` | 137 | yes | the pons forwarder | `launchAndBuy`, already covered |
| `0xf35abbcf` | 33 | yes | the pons factory | a factory entry point, already covered |
| `0xa72101af` | 23 | yes | the pons factory | a factory entry point, already covered |
| `0xeafc4bc5` | 3 | **no** | `0xbb987e3cb2a1c0ad0767687c473f4ea050ffb13a` | a third-party contract |
| `0x87306c90` | 3 | **no** | `0xb84dadf5fc687803aaa74f954a617a0312cfa465` | a third-party contract |
| `0x1fad948c` | 1 | **no** | `0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789` | `handleOps`, the ERC-4337 EntryPoint |

Three of the six already decode. They are in this list only because the rows
had not been attempted yet on the working copy, which is worth saying plainly:
on a database mid-run, "undecoded" and "undecodable" are different sets, and
only the second one is what the phrase in `/decode status` means.

So the real set is three kinds, and none of them is a Pons entry point.

## Is there a Pons ABI for them

**No, and there could not be.** Every Pons entry point this chain uses is
already decoded: the forwarder's `launchAndBuy` and two factory functions. The
three that fail are not Pons contracts.

- **`0xeafc4bc5` and `0x87306c90`** go to two contracts nobody here has
  identified. They are somebody else's router or aggregator, calling Pons on a
  user's behalf. An ABI for them exists only if their author published one.
- **`0x1fad948c`** is `handleOps` on the canonical ERC-4337 EntryPoint v0.6.
  The selector was confirmed by computing it, and the address is the one the
  EntryPoint is deployed at on every chain that has it. The launch happened
  inside a bundled user operation. This one has a published ABI, and it is
  still not a decode: `handleOps` carries an array of user operations whose
  `callData` is itself a call, usually a smart account's own `execute`
  wrapping the real launch. Two layers of unwrapping before the launch
  parameters are in reach, and the inner shape depends on which account
  implementation the user has.

## What it would take, and the thing to be careful about

For the two unknown contracts: identify them on an explorer, get a verified
ABI or the source, add the entry point to `launchDecodeAbi`, and add a case to
the switch in `decodeLaunchCalldata` that pulls out the exemptions array, the
buy amount and the buy recipient. Perhaps an hour each once the ABI is in
hand, and nothing if it never is.

For the account-abstraction ones: decode `handleOps`, walk each
`UserOperation`, decode its `callData`, and recognise the common account
`execute` and `executeBatch` shapes before the Pons call appears. A day of
work, and it will not cover every account implementation.

**The part worth stopping on.** For a bundled transaction, `tx.from` is the
bundler. The wallet the factory exempts is the smart account that made the
call, not the bundler and not the transaction sender. Anyone adding these
decoders has to take the sender from the user operation, not from the
transaction, or `unionOfSlots` puts a bundler in the sender slot and the
third-party split reports somebody's infrastructure as a wallet the creator
let in tax free.

That is the same class of mistake as counting the exemptions array: a field
that looks like the answer and is a different thing. The exempt wallet list
itself would stay right, because it comes from the curve's own events, but the
split of the creator's slots against strangers would not.

## What to do now

Nothing. 422 rows of 478,610 is 0.09% of the index, they report as
undetermined rather than as a number, and undetermined is the correct answer
for a launch nobody has read. Adding a decoder before launch buys 0.09% of
coverage and risks the split that was just corrected.
