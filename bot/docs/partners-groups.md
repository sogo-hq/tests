# VITALS in your group

## The install

Add [@vitalscheck_bot](https://t.me/vitalscheck_bot) to the group and make it
an admin. It posts three lines saying what it reads and then stays quiet. An
admin turns on `/autoscan on`, and from then on every contract address posted
in the room gets a card: who was tax free at launch, what the deployer took
for itself, what the holders look like, and the reference point each of those
is measured against. It is off by default in every group, because a bot that
scans everything it sees in somebody else's room was not asked to. Anyone can
also ask for one scan at a time with `/scan <address>`, in the group or in a
DM, and `/full <address>` for the detail behind every line.

## What it does not do

- No score, no grade, no traffic light, no verdict. The card states facts and
  what they are measured against, and the reader decides.
- A card with no finding on it is **not** a clean bill. It is the list of
  questions that could be answered from the data available, and everything
  else on it says undetermined.
- No price, no direction, no targets, no entry, no exit, in any message.
- No wallet, no handle and no user id is ever printed in a group.

## What the room controls

| command | who | what |
| --- | --- | --- |
| `/autoscan on` / `/autoscan off` | a group admin | whether pasted addresses get a card |
| `/scan <address>` | anyone | one card |
| `/full <address>` | anyone | the detail behind every line |
| `/position <wallet> <ca>` | anyone | where one wallet stood in one launch |
| `/leaderboard` | anyone | who called what here, and how far it ran afterwards |

Turning autoscan off leaves it off. A licence does not turn it back on: an
admin who decided has decided.

## Licences

A group licence opens the premium commands to everyone in the room, and a
licensed group has autoscan on unless an admin has said otherwise. A licence
comes from holding, or from an admin grant with a date on it. `/license
status` in the group says which, and how long it has left.

## Removing it

Remove the bot. Nothing is kept about the group except which chats it has
been in, and the scan history it would have had anyway from the chain.
