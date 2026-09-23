# Template: the declaration, DECLARED #001

The text VITALS signs with the deployer wallet before its own launch. It goes
through `/declare` in DM like anybody else's, and the bot stores the exact
bytes that were signed together with the signature.

Both blocks that were placeholders are written. Nothing in the signed text is
marked any more, which is the condition for signing it at all: a placeholder
signed is a promise on chain that nobody decided the content of, and that is
the exact thing a declaration exists to prevent.

## The canonical text

This is what the bot builds and what the wallet signs. Nothing is added to it
by hand; the fields come from the answers given to `/declare`.

One line is missing from the block below and is added by the bot at draft
time: `docs sha256:`, the hash of the page the `docs:` line names, read as it
was at that moment. It cannot be written here, because the page is generated
from this document and the hash of a page cannot be part of the page. A page
that does not answer produces no line at all, which says nothing about the
page rather than something false about it.

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
nonce: <issued by the bot, one per draft>
```

Field by field, and what the launch transaction has to show for each to hold:

| line | what the chain shows |
| --- | --- |
| deployer | the sender of the launch transaction |
| dev buy | the opening buy as a share of supply, 5% is 0.0930 ETH at a 4% tax, and where those tokens sit afterwards |
| tax-free at launch | the wallets the launch transaction pre-exempts |
| creator tax | `creatorTaxBps` in the launch parameters |
| tax split | the payout hashes and the sweep hashes, against the three shares stated |
| the room | the payout hashes, against the seats held that day and the 30 days stated |
| holder fee share | off, so nothing is paid to a holder who did not take a seat |
| docs | a page that exists before the launch, not after |

There is no `team tokens` line. There used to be, and ours said `none`, which
was false: the dev buy **is** the team allocation, sitting in the deployer
wallet under no lock at all. It was the one line on the form that could be
answered quickly and still mislead everyone reading it. What the dev buy holds
now belongs to the line that declares the dev buy, and `/declare` refuses
`none` there from anybody who declared a buy.

## The two blocks that were placeholders

### Treasury rules

Written, and signed as part of the declaration:

```
treasury: 0x138826536Ca720C4D614550D5DB2b22216d136ad.
funded by sweeps from the fee wallet after each room payout, every sweep recorded with its hash.
it may hold up to 10% of its ETH in other robinhood chain tokens. positions are discussed in BLOCK ZERO, executed and signed by one wallet, and every trade is posted with its hash on X within the hour.
realized gains return to the treasury and count as income, so the room receives its 10% through the same ledger. no separate profit share, no promises.
the treasury does not trade $VITALS.
one signer. no other wallets. no OTC.
```

The choice that was open is closed: the treasury does not trade $VITALS. The
alternative, buying it under stated limits, is deleted rather than left beside
it, because signing both would have said neither.

Every clause names the thing that would show it was broken. The sweeps carry
hashes and `/ledger sweep` records them, so what left the fee wallet is
countable. Realized gains returning as income means the room's 10% is computed
over them by the same `/ledger preview` as everything else, with no second
mechanism to audit. One signer and no OTC are claims about the address above,
readable off its transaction list by anyone.

### Holder fee sharing

Written, and signed as part of the declaration:

```
holder fee share is off at launch. the token is access, not yield: 250k = watch, 1M = the holder feed, 10M = desk.
nothing changes in the first 10 days. the room reviews it with holders on 9 oct. any change is announced 7 days ahead.
```

Off at launch, and stated as off rather than left unsaid. A token that pays
holders a share of fees is a different thing from a token that opens a tool,
and saying which one this is before the launch is worth more than saying it
after. The three tiers are what `/tiers` reads and what the holder checks gate
on today.

The 9 oct review is a date, not an intention. Any change to it is announced
seven days ahead, which is the part that can be held against us: a change that
appears without the notice is a broken declaration, and the declaration is
stored with its signature so that is checkable.

## The room, stated in the declaration

Three seats today, and no seat is sold.

- The seats are the deployer and two others. They say they are crew whenever
  they post about a launch this room is behind.
- The CA goes into the room at T+3s, after the opening tax window has closed,
  and reaches BLOCK ZERO and THE FLOOR in the same second.
- The room pays the same tax as everyone else. No exemptions beyond the
  deployer, which the protocol exempts on its own.
- The 10% is split equally between the seats held that day. When a seat is
  added the split is recomputed from that day's payout forward and printed
  with it, so nobody is diluted quietly.
- Seats are added after the launch, on what people actually did. Never for a
  payment, never for supply, never in advance.
- Seat numbers are public. A seat holder names themselves when they post; the
  deployer does not name them.
- A seat given up is reused, and both occupants stay in the history.

## Rules for this text

- No claim that cannot be read off the launch transaction or off a payout
  hash.
- No partner, no backer, no exchange, no name that has not agreed in writing
  to be named. There are none, so there are none in the text.
- No price, no supply burn, no promise about what a token will do.
- Nothing in the signed text is a placeholder. A signed declaration with a
  marker still in it is a bug, not a draft, and there are none left.