# VITALS

## The description line

> VITALS reads pons v2 launches on Robinhood Chain and prints what the chain
> shows. Facts and their reference points. No score, no grade, no verdict.

One line, used on the site, in the bot bio and anywhere a sentence is needed.
It says what the bot does and what it refuses to do, because the refusal is
the product: anybody can print a number, and most things that print a number
about a token are selling something.

The shorter form, where only a few words fit:

> pons v2 launch scanner. facts, and what they are measured against.

## What it never says

These are not style preferences. They are the reason the tool is worth
reading, and they hold in every message, every card, every document here.

- No score, no grade, no traffic light, no verdict.
- Absence of a finding is never "clean". Undetermined when the data cannot
  support a negative.
- No price targets, no direction, no "safe to buy", no entry, no exit.
- Nothing that did not finish reads as a fact about the chain.
- A missing marker is not an all clear.

## Socials

| where | what |
| --- | --- |
| site | https://checkvitals.xyz |
| x | https://x.com/vitalsxyz |
| telegram | https://t.me/vitals_official |
| bot | https://t.me/vitalscheck_bot |

All three go into the launch calldata. The pons create path carries a socials
struct (twitter, telegram, discord, website, farcaster), so what is on the
token page is what was signed at launch and not something edited afterwards.

## DECLARED #001

A declaration is a statement a deployer signs with the wallet that will
deploy, before the launch, about what the launch will do. The bot stores the
exact bytes that were signed and the signature, so the claim stays checkable
against the launch that follows.

It is a claim. Nothing in it was checked against a chain at the time it was
made, and the badge on a card says a claim exists and nothing more. What
makes it worth anything is that it was made before the launch and cannot be
changed afterwards.

VITALS declares its own launch under the same rules as anyone else, and it is
the first: **DECLARED #001**.

### The format

```
vitals declaration
deployer: 0x447c8dc55B88C09830E123f9fB3e7C484714ED93
dev buy: 5% of supply, held by the deployer wallet, 2% team and 3% partnerships, vesting contracts in october, nothing distributed at launch
tax-free at launch: the deployer only
creator tax: 400 bps
tax split: 10% the room, 10% ecosystem, 80% the build, treasury rules as declared
the room: BLOCK ZERO is 3 seats today, the deployer and two others, who say they are crew whenever they post. the room is owed 10% of the fee wallet's cumulative gross income, paid daily in ETH for 30 days, split equally between the seats held that day, every payout printed before it leaves and recorded with its hash. seats are added after launch on what people actually did, given by the deployer, never sold and never given for a payment. when a seat is added the split is recomputed from that day's payout forward and printed with it. a seat given up is reused and both occupants stay in the history. 10% of gross income goes to ecosystem integrations, 80% to the build: development, infrastructure, integrations and the dev's pay.
holder fee share is off at launch. the token is access, not yield: 250k = watch, 1M = the holder feed, 10M = desk.
nothing changes in the first 10 days. the room reviews it with holders on 9 oct. any change is announced 7 days ahead.
docs: https://checkvitals.xyz/declared/001
nonce: <issued by the bot>
```

Every line is a number or an address that the launch transaction either
matches or does not. After the launch, the card carries the declaration and
whether the chain agreed with it.

### The room

Three seats today: the deployer and two others, who say they are crew whenever
they post. Seats are added after the launch, on what people actually did. The
10% is split equally between the seats held that day, and when a seat is added
the split is recomputed from that day's payout forward and printed with it.

- **The CA goes into the room at T+3s**, after the opening tax window has
  closed. Not before. The window is the three seconds the protocol charges a
  snipe tax for, and posting the address inside it would be handing the room a
  tax bill.
- **The dev buy is the team allocation and is declared as one.** 5% of supply,
  held by the deployer wallet, 2% team and 3% partnerships, vesting contracts
  in october, nothing distributed at launch. There is no separate team tokens
  line, because ours would have said none and that would have been false.
- **The room pays the same tax as everyone else.** There are no exemptions
  beyond the deployer, which the protocol exempts on its own. Nobody in the
  room buys tax free, and the launch transaction is where that is checked
  rather than promised.
- **Every seat is paid the same.** The tier a seat carries is a label on the
  roster. It does not decide money, and a run whose table would divide the
  10% by any rule other than the one signed above is refused before it is
  paid.
- **Seat numbers are public. Names are not.** The roster the room sees carries
  seat numbers and tiers. It carries no handle, no wallet and no user id, and
  the public payout post carries transaction hashes without handles.
- A seat that is given up is reused, and both occupants stay in the history.

### The fee sharing

Two things are signed here, and they answer different questions. The room's
share says what a seat is owed. The holder fee share says what holding the
token is owed, and the answer is nothing.

```
the room: BLOCK ZERO is 3 seats today, the deployer and two others, who say they are crew whenever they post. the room is owed 10% of the fee wallet's cumulative gross income, paid daily in ETH for 30 days, split equally between the seats held that day, every payout printed before it leaves and recorded with its hash. seats are added after launch on what people actually did, given by the deployer, never sold and never given for a payment. when a seat is added the split is recomputed from that day's payout forward and printed with it. a seat given up is reused and both occupants stay in the history. 10% of gross income goes to ecosystem integrations, 80% to the build: development, infrastructure, integrations and the dev's pay.
holder fee share is off at launch. the token is access, not yield: 250k = watch, 1M = the holder feed, 10M = desk.
nothing changes in the first 10 days. the room reviews it with holders on 9 oct. any change is announced 7 days ahead.
```

The token is access, not yield. That is stated before the launch rather than
explained after it, because a token that pays holders a share of fees and a
token that opens a tool are different things and the difference is worth
knowing on the day rather than a month later. The three tiers are what
`/tiers` reads and what the holder checks gate on today. The 9 oct review is a
date, and any change to it is announced seven days ahead, which is the part
that can be held against us.

The mechanics behind the room's share are already built. The creator fee goes
to one wallet, a fixed share of cumulative gross income is what the room is
owed, what has already been paid and anything swept out are subtracted from
that, and every payout is printed before it leaves and recorded with its hash
after. A run that dies part way through resumes without re-sending what
already went out.

Every number in it is checkable after the fact: the 10% is what
`/ledger preview` computes and prints every term of, the shares are what the
roster holds, the hashes are in the public post at the end of each run, and a
seat changing hands is in the seat history.

### The treasury

```
treasury: 0x138826536Ca720C4D614550D5DB2b22216d136ad.
funded by sweeps from the fee wallet after each room payout, every sweep recorded with its hash.
it may hold up to 10% of its ETH in other robinhood chain tokens. positions are discussed in BLOCK ZERO, executed and signed by one wallet, and every trade is posted with its hash on X within the hour.
realized gains return to the treasury and count as income, so the room receives its 10% through the same ledger. no separate profit share, no promises.
the treasury does not trade $VITALS.
one signer. no other wallets. no OTC.
```

The treasury does not trade $VITALS. That was a choice between not touching
the token at all and buying it under stated limits, and the first is what is
signed; the second is deleted rather than left beside it, because signing both
would have said neither.

What it may do is hold up to a tenth of its ETH in other tokens on this chain,
under conditions that each name the thing that would show the rule was broken:
one signer, no other wallets, no OTC, every trade posted with its hash within
the hour, and every sweep into the treasury recorded with its hash by
`/ledger sweep`. Realized gains go back in as income, so the room's 10% is
computed over them by the same ledger as everything else. There is no second
mechanism and no separate profit share to audit.

## Launch day

[`launch-day-runbook.md`](launch-day-runbook.md) is the day itself: the
Thursday rehearsal, the Friday test in a private group, the launch minute by
minute with the exact commands, and what to do when the transaction reverts,
when the index is lagging at T+0, or when a payout run dies part way through.

[`partners-groups.md`](partners-groups.md) is the install for a group admin.

## Templates

Three posts are written before launch day rather than during it:

- [`template-self-scan-t15.md`](template-self-scan-t15.md), fifteen minutes in
- [`template-first-ledger-t4h.md`](template-first-ledger-t4h.md), four hours in
- [`template-declaration.md`](template-declaration.md), the declaration itself
