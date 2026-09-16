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
dev buy: 5% of supply
tax-free at launch: the deployer only
creator tax: 400 bps
tax split: [TREASURY RULES]
team tokens: none
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
- **The room pays the same tax as everyone else.** There are no exemptions
  beyond the deployer, which the protocol exempts on its own. Nobody in the
  room buys tax free, and the launch transaction is where that is checked
  rather than promised.
- **Seat numbers are public. Names are not.** The roster the room sees carries
  seat numbers and tiers. It carries no handle, no wallet and no user id, and
  the public payout post carries transaction hashes without handles.
- A seat that is given up is reused, and both occupants stay in the history.

### The fee sharing

[HOLDER FEE SHARING]

The mechanics that are already built and not placeholders: the creator fee
goes to one wallet, a fixed share of cumulative gross income is what the room
is owed, what has already been paid and anything swept out are subtracted
from that, and every payout is printed before it leaves and recorded with its
hash after. A run that dies part way through resumes without re-sending what
already went out.

The rules that decide the share itself are in [TREASURY RULES] and are not
written here yet. When they are, they go in as text that was signed, like
everything else on this page.

## Templates

Three posts are written before launch day rather than during it:

- [`template-self-scan-t15.md`](template-self-scan-t15.md), fifteen minutes in
- [`template-first-ledger-t4h.md`](template-first-ledger-t4h.md), four hours in
- [`template-declaration.md`](template-declaration.md), the declaration itself
