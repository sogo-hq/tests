# Template: the declaration, DECLARED #001

The text VITALS signs with the deployer wallet before its own launch. It goes
through `/declare` in DM like anybody else's, and the bot stores the exact
bytes that were signed together with the signature.

Two blocks are marked placeholders and are **not** to be signed until they are
written: `[TREASURY RULES]` and `[HOLDER FEE SHARING]`. Signing a placeholder
would put a promise on chain that nobody has decided the content of yet, which
is the exact thing a declaration exists to prevent.

## The canonical text

This is what the bot builds and what the wallet signs. Nothing is added to it
by hand; the fields come from the answers given to `/declare`.

```
vitals declaration
deployer: 0x447c8dc55B88C09830E123f9fB3e7C484714ED93
dev buy: 5% of supply
tax-free at launch: the deployer only
creator tax: 400 bps
tax split: [TREASURY RULES]
team tokens: none
docs: https://checkvitals.xyz/declared/001
nonce: <issued by the bot, one per draft>
```

Field by field, and what the launch transaction has to show for each to hold:

| line | what the chain shows |
| --- | --- |
| deployer | the sender of the launch transaction |
| dev buy | the opening buy as a share of supply, 5% is 0.0930 ETH at a 4% tax |
| tax-free at launch | the wallets the launch transaction pre-exempts |
| creator tax | `creatorTaxBps` in the launch parameters |
| tax split | [TREASURY RULES], of which the $VITALS line is written below |
| team tokens | none, so nothing vests and nothing unlocks later |
| docs | a page that exists before the launch, not after |

## The placeholders

### [TREASURY RULES]

The $VITALS line, as supplied, with the choice between a and b still open:

```
<a: the treasury does not trade $VITALS.> or <b: it buys $VITALS on dips, never sells in the first 30 days, and after that at most 5% of its $VITALS per day, never within 24h of a room post or partner news.>
```

The rest is not written. When it is, it states where the creator fee goes, in
what proportions, and what else the treasury may and may not do with its part.
It has to be specific enough that a transaction either matches it or does not,
because a declaration that cannot be checked is a slogan.

**a and b are alternatives and one of them has to go.** They are opposite
promises: a says the treasury never touches the token, b says it buys it under
stated limits. Signing the pair says neither. Until one is struck out and the
rest of the block is written, `/declare` is answered with the split as a number
or the declaration is not signed at all.

### [HOLDER FEE SHARING]

Not written. When it is, it states the share of gross income the room is owed,
how a seat is earned and lost, and what happens to a seat when its holder
leaves.

What already exists and is not a placeholder: one wallet receives the creator
fee, a fixed share of cumulative gross income is what the room is owed, what
has already been paid out and anything swept out are subtracted before a run
pays anything, every amount is printed before it leaves and recorded with its
hash after, and a run that dies part way through resumes without re-sending.

## The room, stated in the declaration

Fifty seats, and the number does not move.

- The CA goes into the room at T+3s, after the opening tax window has closed.
- The room pays the same tax as everyone else. No exemptions beyond the
  deployer, which the protocol exempts on its own.
- Seat numbers are public. Names are not.
- A seat given up is reused, and both occupants stay in the history.

## Rules for this text

- No claim that cannot be read off the launch transaction or off a payout
  hash.
- No partner, no backer, no exchange, no name that has not agreed in writing
  to be named. There are none, so there are none in the text.
- No price, no supply burn, no promise about what a token will do.
- Placeholders stay visibly marked until they are replaced. A signed
  declaration with `[TREASURY RULES]` still in it is a bug, not a draft.
