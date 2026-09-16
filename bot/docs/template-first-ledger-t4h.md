# Template: the first ledger, T+4h

Four hours after launch, the first payout run. The point of posting it is not
the amount, it is that the room can check the arithmetic and check that the
money moved, without anyone's wallet or handle being on screen.

## What to run

In order, and each one is checked before the next:

```
/ledger preview                     the table, nothing sent
/ledger csv                         the exact rows pay.mjs will read
node tools/pay.mjs --csv <file>     from the Mac, key in the shell only
/ledger tx <hashes>                 the hashes, keyed by wallet
/ledger post                        the public version, no handles
```

`/ledger preview` prints every term: gross income, the room's share of it,
what has already been paid, what this run pays, total shares, and the dust
that stays in the wallet for next time. Read those before running pay.mjs,
because pay.mjs is the step that moves money.

## The post

`/ledger post` writes this. It is not typed by hand.

```
ledger, <date>

gross income      <A> ETH, everything the fee wallet has taken in
the room's 10%    <B> ETH of it, in total
already paid      <C> ETH
this run          <D> ETH
total shares      <N>

T1  <n> seats · <x> ETH each · <total> ETH
T2  <n> seats · <x> ETH each · <total> ETH
T3  <n> seats · <x> ETH each · <total> ETH

paid out          <E> ETH
undistributed     <F> ETH, left in the wallet for the next run

<k> transfers:
  0x...
  0x...
```

## What goes around it

```
First ledger, four hours in. Every term is printed so the room can do the
arithmetic itself: gross income, the room's share of it, what was already
paid, what this run paid.

The hashes are below. They carry no handles on purpose: a hash next to a name
is that name's wallet, and anyone can open the transaction and read the
recipient.

Seat numbers are public. Names are not. That does not change later.
```

## Rules for this post

- Every term stays in. A post that prints only the total is asking to be
  trusted rather than checked.
- Hashes without handles, always.
- No wallet, no handle, no user id, no seat holder's name.
- If a payment failed or is still pending, say so and say which seat number.
  A run that half finished is not reported as a run that finished.
- Dust carries to the next run and is named, not quietly kept.
- No price, no "this is what holding pays", no annualised anything.
