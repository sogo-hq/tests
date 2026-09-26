# Launch day runbook

Three days, in order. Thursday rehearses the transaction, Friday rehearses the
day, and the day itself runs the commands below in the order they appear.

Two rules hold throughout and nothing on this page overrides them:

- **No key ever reaches the server.** `launch.mjs` and `pay.mjs` run on the
  Mac, and read the key from the shell they are run in. The bot holds no key
  and sends nothing.
- **Every amount is printed before it leaves and recorded after.** A run that
  dies part way through resumes without re-sending what already went out.

---

## Before anything: the config

```
cp tools/launch.config.example.json tools/launch.config.json
node tools/launch.mjs --check
```

`--check` sends nothing, needs no key and ignores the launch window, so it can
be run at any point. It prints a verdict per field, fetches the logo from
ipfs.io and checks it is a square image under a megabyte, and prints the token
address the salt produces. It exits non-zero if any field fails.

Everything on it has to read `ok` before Thursday. `tools/launch.config.json`
is gitignored: the salt decides the token address, so it never enters the
repository.

### The launch time can only be set inside the cutoff

`/launch set` refuses a time past a cutoff. By default that is a rolling horizon
of `LAUNCH_HORIZON_DAYS` days from today, which cannot expire. Setting
`LAUNCH_DEADLINE` to a date replaces it with a hard stop at the end of that day.

A cutoff in the past refuses **every** date there is, so the bot says which it
is using at boot:

```
[launch] cutoff: 2026-10-10 00:00 CEST, from the 14 day horizon (LAUNCH_HORIZON_DAYS)
```

and warns instead if it has passed or will not parse. `/launch status` prints
the same line. If `/launch set` refuses a date that looks fine, read that line
first: an absolute `LAUNCH_DEADLINE` left over on the dashboard is the reason.

The time may be given with the zone on it, as the bot prints it back:

```
/launch set 2026-09-28 16:00 Europe/Bratislava
/launch set 2026-09-28 16:00 CEST
/launch set 2026-09-28 16:00
```

all mean the same instant. A **different** zone is refused rather than read as
local.

---

## Thursday: the rehearsal

The rehearsal launches a real token on the real chain with a throwaway key, so
the transaction path is tested by being run rather than by being read.

### What is needed

| thing | value |
| --- | --- |
| `REHEARSAL_PRIVATE_KEY` | a burner, in the shell only, never in a file |
| the burner's balance | **0.005 ETH**: the 0.001 dev buy, the 0.0005 launch fee, and gas with room to spare |
| the window | Mon to Thu, 15:00 to 18:00 Europe/Bratislava, or `--force` |

### The commands

```
node tools/launch.mjs --dry
REHEARSAL_PRIVATE_KEY=0x... node tools/launch.mjs --rehearse
```

Run `--dry` first. It simulates through `eth_call`, signs nothing and needs no
key, and it prints the token address the launch will have. That address is the
one the real launch produces only if the salt and the params are unchanged, so
read the diff it prints at the end.

### What to expect

- `curve calibrated: reproduces 0x2121ea24 to the wei`. If this line says
  anything else, stop: the curve model no longer describes the chain and the
  opening buy is being sized from something that is not true.
- The opening buy as a share of supply, from the curve rather than from a
  table. At the rehearsal's 0.001 ETH this is a fraction of a percent.
- `would succeed`, then the token address and the curve address.
- After `--rehearse`: the transaction hash, the mined block, and then the
  rehearsal token scanned by this repo's own scanner, with the card printed.

### Where the VITALSRH1 CA appears

The rehearsal never carries the production ticker. It launches **VITALSRH1**,
because a second VITALS on chain before launch is exactly what the collision
check exists to catch.

The CA appears in four places, and they must agree:

1. `--dry` prints it as `token (CA)` before anything is sent.
2. `--rehearse` prints it again from the receipt, with the transaction hash.
3. `tools/out/rehearse-<token address>.json`, the record the tool writes.
4. The scan card the tool then prints, which is the bot reading it back off
   the chain.

Keep that address. Friday runs against it.

### Also on Thursday: the payer

```
BURNER_PRIVATE_KEY=0x... node tools/pay.mjs --burner
```

A throwaway key, three throwaway recipients derived from it, and dust that
payplan caps at 0.001 ETH in total. It prints every transfer before it sends
and the hash after. To prove the nonce guard, kill it part way and run the
same command again:

```
BURNER_PRIVATE_KEY=0x... node tools/pay.mjs --burner --kill-after 2
BURNER_PRIVATE_KEY=0x... node tools/pay.mjs --burner
```

The second run resumes, reuses the nonces of the rows that already landed, and
sends only what is left. Nothing goes out twice.

---

## Friday: the day, in a private group

```
node tools/dayrun.mjs --token <VITALSRH1 CA> --room <private group id> --fast
```

`--fast` compresses every wait to seconds, so the whole timeline runs in under
a minute. With `BURNER_PRIVATE_KEY` in the shell the payer step runs for real
against the burner; without it, the plan is built and printed and nothing is
sent.

Eight steps, in the order launch day runs them: detect, pin, self scan, ledger
preview, csv, payer, hashes, public post. Every step writes to
`tools/out/dayrun-<ca>.json` the moment it finishes.

What Friday is for:

- The room gets exactly one CA message and one pin.
- The self scan card posts as rendered, undetermined lines included.
- The ledger preview prints every term.
- The csv the ledger writes is the csv the payer parses.
- The public post carries the hashes and no handle and no wallet. The harness
  checks that against the live roster before sending, and refuses if it fails.

Run it twice. The second run must do nothing at all: that is the test.

Seed the roster first if the group has none, or the ledger step stops with
`the roster is empty`:

```
/seat add <handle> T1 0x...
```

---

## Launch day

Times are from T+0, the moment the launch transaction is mined.

### T minus 30: arm the room

```
/launch name $VITALS
/tge
```

Run `/tge` **in BLOCK ZERO, from a named admin account**, and read both halves
of that.

*In BLOCK ZERO*, because that one command is what sets `ready_chat`, and
`ready_chat` is where the countdown posts, the fake-CA guard, the self-scan
cards at T+15 and T+4h, and the cancel notice all go. Run it in the wrong room
and the guard is watching the wrong room: a fake address posted in BLOCK ZERO at
T+3s is not deleted and its poster is not muted.

*From a named admin*, because an anonymous admin is attributed to
GroupAnonymousBot, which is in no `ADMIN_IDS` list. Posting anonymously is the
default for admins in most crypto groups. The bot answers and says so rather
than doing nothing, but turn off "send as group" before running it.

`/ready` and `/tge` in a group are admin-only. A member gets silence, and cannot
move `ready_chat` out of the launch room.

If a room should stay quiet between now and launch, `/ready off` in that room
turns the READY block off there and nothing else. The CA, the pin and the guard
are untouched, and the countdown still posts there, pinned, carrying the two
lines that are about the launch rather than about registration:

```
launch: 2026-09-28 16:00 CEST
CA lands here 3 s after launch. anything before that is fake.
```

Do it **before** `/launch set`. It is refused while a launch is armed, because a
countdown already pinned in that room carries the block it was posted with and
muting does not reach backwards. Cancelling and re-setting retires that pin.

Then, **in each chat that should get the CA**, with that chat's own delay in
seconds:

```
/launch watch 0x447c8dc55B88C09830E123f9fB3e7C484714ED93        in BLOCK ZERO
/launch watch 0x447c8dc55B88C09830E123f9fB3e7C484714ED93 7      in THE FLOOR
```

BLOCK ZERO takes the CA the moment the launch lands, which is the room running
it. THE FLOOR takes it seven seconds later, so it is not reading the other
room's screenshot and nobody there is waiting.

```
/launch status
```

lists every watching chat, its delay, and whether it has the CA yet. It also
prints the chat the launch posts go to, by id and title, whether that chat's
READY block is on, and the date the launch time may still be set inside. Run it
before T-5 and check all four: a chat that never ran `/launch watch` gets
nothing, silently, and the first anyone notices is that the room is empty at
T+3s. `/launch unwatch` in a chat takes it back out.

`/launch watch` matches on the deployer and on the launch time, so a token that
wallet shipped last week is not announced as this one. Each chat is recorded
separately: one room refusing a send does not stop the others, and a room that
already has the CA is never sent it twice.

Check the bot before arming:

```
/status
```

Indexer head against chain head. If the lag is more than a few hundred blocks,
fix that before launching: a launch the index has not read is a launch the bot
cannot scan.

### T minus 5: the last check

```
node tools/launch.mjs --check
node tools/launch.mjs --dry
```

The address `--dry` prints is the CA. Write it down. Anything posted before
T+3s claiming to be it is fake, and the room guard says so.

### T+0: send it

```
LAUNCH_PRIVATE_KEY=0x... node tools/launch.mjs --go
```

It asks for the symbol to be typed before it sends. It prints the transaction
hash, the block, the token address and the diff between the config and what
the chain now says.

### T+3s: the CA in the room

The opening tax window closes at three seconds. `/launch watch` posts and pins
the CA within a few seconds of the launch landing, by itself.

Two detectors run: the index callback every three seconds and a reconcile pass
every twenty, and either one announces it. A chat on a delay gets a timer as
well, so its stagger is seconds rather than whenever the next pass lands, and
the pass still covers it if the process restarts in between. If nothing has
posted by T+60s,
post the address as an ordinary message and pin it by hand. There is no
command that sets the CA: it is read off the chain or it is not claimed at
all, which is the point.

Do not post the CA before T+3s. Fifty people buying inside the tax window is
fifty people paying the opening tax.

### T+15min: the self scan

The bot posts the card itself. If it has not:

```
/scan <CA>
/image <CA>
```

Post the card as rendered. A line that says undetermined goes out saying
undetermined. `docs/template-self-scan-t15.md` is the post around it.

### T+4h: the ledger

In DM, in this order, reading each one before running the next:

```
/ledger preview
/ledger csv
```

`preview` prints every term: the wallet balance, **what is credited in the fee
escrow and not yet claimed**, gross income, the room's share of it, what has
already been paid, what this run pays, total shares, and the dust that stays
for next time.

Expect the escrow line to carry almost all of it, and expect the first run to
refuse because of it. v2 revenue is not transferred: the curve and the hook
credit `PonsV2FeeEscrow` per recipient, and the fee wallet does not move until
somebody calls `claim()`. Measured on a live launch: a fee wallet holding
0.0157 ETH that had earned 0.5240 ETH.

So the order at T+4h is **claim, then preview**:

```
claim the fee wallet's escrow balance      (escrow 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e, claim())
/ledger preview
```

If it refuses, it says why, and the refusal is right: the pool cannot exceed
what is in the wallet. It now distinguishes the two reasons. Money still in the
escrow says "claim it, then run this again". Money that left the wallet says so
instead. An escrow it could not read at all refuses everything, because a gross
missing a term is not a number to pay a tenth of.

Then, on the Mac, with the key in the shell and nowhere else:

```
FEE_WALLET_PRIVATE_KEY=0x... node tools/pay.mjs --csv <file> --run <id>
```

It prints every transfer and asks for the total to be typed before it sends.
It writes each hash to `tools/out/pay-run-<id>.json` the moment it comes back.
When it finishes it prints a line to paste into the bot:

```
/ledger tx <id> 0xwallet:0xhash 0xwallet:0xhash ...
/ledger post
```

`/ledger post` goes in the room. It carries the hashes and no handles. The
template is `docs/template-first-ledger-t4h.md`.

---

## Abort rules

### The launch transaction reverts

Nothing was launched and the fee was not taken: a revert costs gas and nothing
else. Do not send it again blind.

1. Read the revert reason the tool prints. `0xecb27319` is the economics hash:
   the factory's terms changed and the config is refusing to launch on terms
   nobody agreed to. That is the guard working.
2. `node tools/launch.mjs --check` and `--dry`. `--dry` reproduces the revert
   without sending anything.
3. Fix the config field it names. Do not change the salt: the CA is already
   written down and, on the wrong day, already posted.
4. If it cannot be fixed inside the window, say so in the room in one line and
   stop. A launch pushed out an hour is a launch. A launch sent on terms
   nobody read is not recoverable.

### The indexer is lagging at T+0

The bot scans from the index, so a lagging index means the self scan at T+15
has nothing to read.

1. `/status`. It gives the lag in blocks and in seconds of chain.
2. Under about 600 blocks, a minute of chain, do nothing: it catches up inside
   the fifteen minutes.
3. Further behind, post the CA and pin it, and say in the room that the scan
   is coming when the index reaches it. Do not post a card built on a partial
   read. A card that says undetermined everywhere is honest but useless; a card
   that says nothing was found because nothing was read is worse than useless.
4. The watchdog DMs every admin when the lag holds over 60 blocks for two
   minutes, so this should be known before T+0 rather than discovered at T+15.

### A payout run dies part way through

This is the case the payer was built for, and the answer is to run the same
command again.

1. **Do not** change the csv, and **do not** start a new run. The plan in
   `tools/out/pay-run-<id>.json` is the record of what went out.
2. Run the identical command. It resumes: the rows that landed are skipped and
   their nonces reused, so a row cannot be paid twice even if the chain saw a
   transaction the tool did not.
3. If it refuses with `the stored plan does not match this file`, the csv has
   changed since the run started. Restore the csv the run was built from.
   `/ledger csv` regenerates it from the stored run.
4. Record what did land before doing anything else:
   ```
   /ledger tx <id> <the pairs the tool printed>
   ```
   Hashes recorded are hashes counted, and the next preview subtracts them
   from what the room is owed. A run that half finished and was never recorded
   pays those seats twice.
5. If the wallet is short, stop. `/ledger preview` says how short. Move funds
   back in and resume, rather than editing the table to fit.
