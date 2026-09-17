# VITALS

A scanner for pons v2 launches on Robinhood Chain. It reads the chain and
prints what the chain shows, with the reference point each number is measured
against. It does not score, grade or rank, and it never says a launch is fine.

Version 1, 17 september 2026.

## The problem this is for

A launch on this chain is fully described by its creation transaction and the
seconds after it. Who was exempted from the opening tax, what the deployer
bought for itself, what the creator tax is, who holds the supply: all of it is
on chain within a few hundred milliseconds of the token existing, and all of it
is unreadable to somebody watching a group chat.

What fills the gap is almost always a number with no denominator. A score out
of ten with nothing behind it. A green tick. A claim that a token is "clean",
which means only that whoever said it did not find anything, in a search they
did not describe, over data they did not name.

The design here starts from the opposite end. Every line is a measurement with
its source, or it is the word undetermined.

## What it refuses to do

These are enforced by tests that run on every build, not by convention.

**No score, no grade, no traffic light, no verdict.** Every check reports one
of three states: a finding, undetermined, or nothing found. There is no number
that combines them, because combining them is where the information goes.

**Absence of a finding is never "clean".** A check that found nothing found
nothing. The card says how many checks ran and how many could not be answered,
and the words clean, safe and good appear nowhere in any output.

**Nothing that did not finish reads as a fact about the chain.** A read that
timed out, a window that was not covered, a decode that failed: each reports
as undetermined, and undetermined never carries a value. A zero that came from
a failed read is a lie in the shape of a measurement.

**No median under thirty observations.** A reference point drawn from four
launches is not a reference point, and the sample size is printed beside every
one that is published.

**No price data of any kind.** No targets, no direction, no entry, no exit.
Volume and market capitalisation appear as quantities where they are measured;
what anybody should do about them does not.

## What it reads

Robinhood Chain, chain id 4663, block time about 0.1 seconds. Two addresses
are compiled in and are never resolved from a search result, because lookalike
factories and fake explorers exist for this chain:

| | |
| --- | --- |
| factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| launch forwarder | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |

Launch configuration 0 is the only one the factory accepts today: one billion
tokens of supply, a 1% curve fee, a phantom quote reserve of 1.68 ETH and a
graduation threshold of 4.2 ETH.

## The bonding curve, calibrated rather than assumed

The curve is an invariant product against a phantom reserve. For a buy of
`qIn`:

```
qNet      = qIn - floor(qIn * feeBps / 10000) - floor(qIn * creatorTaxBps / 10000)
tokensOut = tokenReserve * qNet / (quoteReserve + qNet)
```

Both fees come off the input before it reaches the curve, and the creator tax
is one of them. That is not obvious from the outside, and getting it wrong
mis-sizes an opening buy by the size of the tax.

The model is not trusted because it is plausible. It is checked, on every run
of the launch tool, against a launch that already happened: ZZZ, 0.5 ETH in
for 227,586,206.896551724137931034 tokens out. It reproduces that to the wei.
A model that drifts from the chain by more than one percent stops the tool
rather than sizing anything.

## The opening tax exemption, and what it took to get right

The factory charges a steep tax on buys in the first seconds after a launch,
and exempts a set of wallets from it. Who is in that set is the highest-value
thing a scanner can tell somebody about a launch that is thirty seconds old.

The factory exempts **four slots**, each emitting one event:

1. the wallet that sent the launch transaction
2. the `creatorFeeRecipient`
3. the wallet that receives the opening buy
4. every entry of the `exemptions` array

Duplicates are emitted rather than collapsed, so the number of events is the
number of slots filled and the number of exempt wallets is the size of the
union. A launch where all three named slots are the same wallet emits three
events for one wallet.

This was established by simulating a launch against the live factory with a
distinct address in each slot and reading which slot produced which event. No
protocol contract is ever in the set: no curve, no router, no hook, no locker.

**It was wrong here for months.** The decoder counted the `exemptions` array,
which names none of the first three slots, so a launch that exempted only its
deployer was recorded as exempting nobody. Every launch on this chain exempts
at least one wallet; a count of zero was never possible. The correction is
published at `/correction`, with what the earlier numbers actually counted.

Over 478,610 launches read back from the curve's own events:

| | |
| --- | --- |
| exactly the deployer | 331,678 (69.3%) |
| beyond the deployer | 146,932 (30.7%) |
| entry points with no ABI, undetermined | 422 (0.09%) |

## The index, and when it is allowed to say no

Every check that reports an absence depends on the index being current, and an
index that falls behind does not look broken from outside: every command still
answers, in the same words, about a chain it read an hour ago.

So a negative is withheld whenever the index cannot support it. Three separate
conditions do this: a rebuild in progress, a cursor that has stopped moving,
and a cursor that is moving but more than five minutes of chain behind the
head. The third was added because the first two cannot see it, and during the
window it was missing every scan was entitled to say "the deployer's only
launch this week" about seven days it had read six of.

Counts published from the index carry the sample size and, where the index is
behind, a line saying so above them.

## The token

$VITALS is access, not yield. Holding it opens parts of the tool; it does not
pay a share of anything.

| holding | opens |
| --- | --- |
| 250,000 | watch: alerts on a deployer or a wallet |
| 1,000,000 | the holder feed, and the premium commands |
| 10,000,000 | desk, and a group licence |

There is no holder fee share at launch. That is stated in the signed
declaration rather than left unsaid, because a token that pays holders a share
of fees and a token that opens a tool are different things, and the difference
is worth knowing on the day rather than a month later.

## The room, and how it is paid

Fifty seats. A seat is given by the deployer, its tier is fixed when taken,
and a seat given up is reused with both occupants kept in the history.

The room is owed a tenth of the fee wallet's **cumulative gross income**, not
a tenth of its balance. Fees and payouts share one wallet, so the balance
alone cannot separate new income from a remainder already accounted for:

```
gross income = balance now + everything paid out + everything swept out
pool now     = 0.10 * gross income - everything paid out
```

Paid daily in ETH for thirty days, by shares: five for a first-tier seat, two
for a second, one for a third. Every amount is printed before it leaves and
recorded with its transaction hash after. A run that dies part way through
resumes without re-sending what already went out.

The public ledger post carries the hashes and no handles. A hash next to a
name is that name's wallet, and anyone can open the transaction and read the
recipient.

## Declarations

A deployer can state what a launch will do before it happens and sign it with
the wallet that will deploy. The bot stores the exact bytes that were signed
together with the signature, so the claim stays checkable against the launch
that follows.

It is a claim, and the badge says a claim exists and nothing more. Nothing in
it was checked against a chain at the time it was made. A declaration never
softens a check: where the launch differs from what was signed, the card says
so and the original finding still stands.

The page a declaration's `docs:` line points at is pinned by its sha256 inside
the signed text, so a page rewritten after signing is reported as changed
rather than quietly standing in for what was agreed.

## What it does not do

It does not tell anybody what to buy. It has no opinion on any token, and
there is no path through the code that produces one.

It does not scan what it was not asked to. Automatic scanning in a group is
off by default and is turned on by an admin of that group.

It does not hold a private key. Nothing in the running service can move funds:
the two scripts that send anything run on a laptop and read their key from the
shell they are run in.

It does not print a wallet in a group, ever.

## Where the numbers in this document come from

Everything above is either a constant in the source, a figure printed by a
command in the tool, or a measurement recorded with the method that produced
it. The exemption slots come from `tools/exemption-slots.mjs`, which simulates
against the live factory and signs nothing. The distribution comes from
`/stats tax`. The curve calibration runs on every use of the launch tool and
stops it if it fails.
