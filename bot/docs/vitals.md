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
| telegram | https://t.me/vitalsofficial |
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
tax split: [TREASURY RULES]
the room: 50 seats. the room is owed 10% of the fee wallet's cumulative gross income, paid daily in ETH for 30 days by shares (T1 5, T2 2, T3 1), every payout printed before it leaves and recorded with its hash. a seat is given by the deployer, its tier is fixed when taken and reviewed once after the 30 days. a seat given up is reused and both occupants stay in the history. 10% of gross income goes to ecosystem integrations, 80% to the build.
[HOLDER FEE SHARING]
docs: https://checkvitals.xyz/declared/001
nonce: <issued by the bot>
```

Every line is a number or an address that the launch transaction either
matches or does not. After the launch, the card carries the declaration and
whether the chain agreed with it.

### The room

Fifty seats. That is the whole room and the number does not move.

- **The CA goes into the room at T+3s**, after the opening tax window has
  closed. Not before. The window is the three seconds the protocol charges a
  snipe tax for, and posting the address inside it would be handing fifty
  people a tax bill.
- **The dev buy is the team allocation and is declared as one.** 5% of supply,
  held by the deployer wallet, 2% team and 3% partnerships, vesting contracts
  in october, nothing distributed at launch. There is no separate team tokens
  line, because ours would have said none and that would have been false.
- **The room pays the same tax as everyone else.** There are no exemptions
  beyond the deployer, which the protocol exempts on its own. Nobody in the
  room buys tax free, and the launch transaction is where that is checked
  rather than promised.
- **Seat numbers are public. Names are not.** The roster the room sees carries
  seat numbers and tiers. It carries no handle, no wallet and no user id, and
  the public payout post carries transaction hashes without handles.
- A seat that is given up is reused, and both occupants stay in the history.

### The fee sharing

The room's share is in the signed text above:

```
the room: 50 seats. the room is owed 10% of the fee wallet's cumulative gross income, paid daily in ETH for 30 days by shares (T1 5, T2 2, T3 1), every payout printed before it leaves and recorded with its hash. a seat is given by the deployer, its tier is fixed when taken and reviewed once after the 30 days. a seat given up is reused and both occupants stay in the history. 10% of gross income goes to ecosystem integrations, 80% to the build.
```

[HOLDER FEE SHARING] covers what is still not written: how a seat is earned
beyond being given, and what the review after the 30 days is allowed to
change.

The mechanics behind it are already built. The creator fee goes to one wallet,
a fixed share of cumulative gross income is what the room is owed, what has
already been paid and anything swept out are subtracted from that, and every
payout is printed before it leaves and recorded with its hash after. A run
that dies part way through resumes without re-sending what already went out.

Every number in the line above is checkable after the fact: the 10% is what
`/ledger preview` computes and prints every term of, the shares are what the
roster holds, the hashes are in the public post at the end of each run, and a
seat changing hands is in the seat history.

### What the treasury does with $VITALS

One line of [TREASURY RULES] is written, and it carries a choice that is still
open:

```
<a: the treasury does not trade $VITALS.> or <b: it buys $VITALS on dips, never sells in the first 30 days, and after that at most 5% of its $VITALS per day, never within 24h of a room post or partner news.>
```

a and b are opposite promises. a says the treasury never touches the token; b
says it buys it under stated limits. One of them has to go before anything is
signed, because signing the pair says neither.

The rest of [TREASURY RULES], which decides the share itself, is not written
here yet. When it is, it goes in as text that was signed, like everything else
on this page.

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
