# tools

Two scripts that run on a laptop, never on the server.

The bot process holds no private key, and neither does its environment. These
read one from the shell for the length of a single transaction and refuse to
run if they find one in a `.env` file beside the code.

Both need the repo built first: `npm run build`.

| script | what it sends |
|---|---|
| `launch.mjs` | the launch transaction |
| `pay.mjs` | the ledger's transfers |
| `fomo_intersect.mjs` | nothing on chain, but it spends USDC on paid robinx calls |

## launch.mjs

Every value comes from `launch.config.json`, so the dry run, the rehearsal and
the launch are the same launch. Every mode ends with a diff of that file
against what the chain says.

That file is **not in git**. The salt in it decides the token address, so a
salt in a public repository is a token address anyone can take before we do.
Copy the example and fill in every `CHANGE ME`:

```
cp tools/launch.config.example.json tools/launch.config.json
node tools/launch.mjs --check
```

`--check` validates that file and nothing else: it never signs, never sends,
needs no key, and does not care what time it is, so the config can be checked
on a Sunday. It prints a verdict per field, fetches the logo from ipfs.io and
checks it is a square image under a megabyte, and prints the token address the
salt produces. It exits non-zero when a field fails.

```
node tools/launch.mjs --dry
REHEARSAL_PRIVATE_KEY=0x... node tools/launch.mjs --rehearse
LAUNCH_PRIVATE_KEY=0x...    node tools/launch.mjs --go
```

| flag | what it does |
|---|---|
| `--check` | validates the config only. No key, no send, no launch window. Prints every field with a verdict and the address the salt produces. |
| `--dry` | simulates through `eth_call`. Sends nothing, signs nothing, needs no key, and still prints the token address the launch will have. |
| `--rehearse` | launches a throwaway token on a burner key, then scans it with this repo's own scanner and prints the card. |
| `--go` | the launch, after a typed confirmation of the symbol. |
| `--force` | go outside Mon to Thu, 15:00 to 18:00 Europe/Bratislava. |
| `--config <path>` | a config file other than `tools/launch.config.json`. |
| `--as <address>` | in `--dry` only: simulate as this address rather than the config's recipient. |

### What it refuses

- **A curve model that no longer describes the chain.** Before it sizes the
  opening buy it reproduces a launch that already happened: ZZZ's, 0.5 ETH in
  for 227,586,206.896551724137931034 tokens. It has to land within 1%. It
  currently lands on the wei.
- **An opening buy over 5% of supply**, measured as the share the curve will
  actually pay out, not as an ETH figure. The same ETH is a different share at
  a different creator tax.
- **Outside the launch window**, from the same constants the bot uses, by zone
  name rather than a fixed offset. A dry run reports the window and continues,
  because it sends nothing.
- **A config with a zero fee recipient or buy recipient**, a non-ETH pair (the
  curve model is calibrated on ETH alone), a creator tax over the factory
  maximum, or a rehearsal that would carry the production ticker.
- **A transaction from a previous run whose receipt was never recorded.** The
  record is written between sending and awaiting the receipt, so a crash in
  that gap cannot become a second launch.
- **An `expectedEconomics` the factory rejects.** `bytes32(0)` would switch the
  check off; it is deliberately not used, because that is the one guard against
  the factory's economics changing between writing the config and sending.

### What it prints before it sends

The dev buy in ETH and as a share of supply computed from the curve, the full
exemption list, the creator tax and its recipient, the gas, and the total
leaving the wallet. Then it asks for the symbol, typed.

### Afterwards

`tools/out/<mode>-<token>.json` holds the token address, the curve, the tx, the
block and what the opening buy actually bought. The `/launch watch <deployer>`
line to paste into the bot is printed by every mode: arm it **before** the
launch, so the CA is posted the moment it lands.

## The token address is known in advance

It is decided by the sender, the salt and the parameters, so `--dry` prints the
exact address `--go` will produce. Changing the salt changes it; so does
changing the symbol or the sender, which is why a rehearsal never lands on the
real one.

## pay.mjs

Reads the CSV `/ledger csv` produced, prints what it is about to do, asks for
the total to be typed back, and sends one transfer per row.

```
FEE_WALLET_PRIVATE_KEY=0x... node tools/pay.mjs --csv vitals-ledger-run-3.csv --run 3
```

### A crash cannot pay twice

Every row is given a nonce when the plan is first written, and a resumed run
reuses it. A row that already landed is rejected by the chain the second time
rather than mined again, and the script says so and carries on rather than
stopping. The plan is written to `tools/out/pay-run-<id>.json` before the first
transfer and updated after every one, so an interruption at any point loses
nothing: run the same command again and it picks up where it stopped.

A stored plan whose rows no longer match the file is refused rather than
merged. A CSV with a duplicate wallet, a bad address or a zero amount stops the
run rather than skipping the row, because a skipped row is a person who
silently does not get paid.

### The burner rehearsal

`--burner` runs all of the above against a throwaway key and three throwaway
recipients, for dust. It is not a second code path: it writes a real CSV and
then falls into the same parser, the same plan, the same typed confirmation and
the same send loop, because a rehearsal down a different path proves nothing
about the one that moves the money.

```
BURNER_PRIVATE_KEY=0x... node tools/pay.mjs --burner                 # run, or resume
BURNER_PRIVATE_KEY=0x... node tools/pay.mjs --burner --kill-after 2  # die after two
BURNER_PRIVATE_KEY=0x... node tools/pay.mjs --burner                 # resumes, sends the third
BURNER_PRIVATE_KEY=0x... node tools/pay.mjs --burner --reset         # start over
```

Fund the burner with about **0.001 ETH**; a run needs roughly 0.0000073 of it,
three transfers of 0.000001 plus gas. Anything over 0.001 ETH in total is
refused: a rehearsal exists to prove the path, not to move money.

The three recipients are derived from the burner's own address, so a resumed
run targets the same three, and so the dust can be swept back rather than
burned. The command to recompute their keys is printed at the top of the run.

`--kill-after <n>` exits after the nth transfer, immediately after the plan has
been written, which is where a real kill would land. Running the same command
again resumes: the rows that went out keep the nonces that paid them, so a
second attempt at one of them collides with a nonce the chain has already
spent and is rejected rather than mined. Ctrl-C at any moment does the same
thing; the plan is written after every single transfer.

### Afterwards

It prints one line to paste back into the bot:

```
/ledger tx 3 0xwallet:0xhash 0xwallet:0xhash ...
```

That is what makes the payment real to the ledger. Until the hashes are in,
`/ledger preview` counts the run as unpaid and says so, because the next
preview would otherwise distribute the same money again.

## fomo_intersect.mjs

Scored traders who hold our tokens. Two sources, neither of them this chain's
node: the fomoradar leaderboard, which is public and keyless, and robinx's
`smart_holders`, which is paid and settles over x402 from the wallet in
`ROBINX_WALLET_KEY`.

```
node tools/fomo_intersect.mjs --dry                    # leaderboard only, nothing paid
ROBINX_WALLET_KEY=0x... node tools/fomo_intersect.mjs  # the whole thing
```

| flag | what it does |
|---|---|
| `--dry` | the leaderboard and `fomo_top.csv`, no paid calls |
| `--token SYMBOL:0x…` | a token to check, repeatable. Overrides the defaults |
| `--limit <n>` | leaderboard page size, default 400 |
| `--min-score <n>` | the cut for `fomo_top.csv`, default 74 |
| `--robinx-cmd <cmd>` | how to reach robinx, default `npx -y robinx-mcp` |

### The tokens

ZZZ and CHIPPER are fixed. The third is the newest graduated launch in the
bot's own index, which means the machine running this needs `pons.db`. It does
not have to: name all three with `--token` instead and the index is never
opened.

### Outputs

`tools/out/fomo_top.csv` is every trader at or above the cut, highest score
first: username, score, style, wallet, pnl, red flags.

`tools/out/t1_candidates.csv` is the overlap: username, score, style, wallet,
which of the tokens they hold, how many, and the robinx receipt for the calls
that found them.

The raw answer to each paid call is kept beside them as
`robinx-<symbol>.json`, so a call that was paid for is never spent twice to
look at it again. A call whose answer had no readable holders in it is kept as
`robinx-<symbol>-unparsed.json`, which is what to send me if the shape has
moved.

### What it will not do

The leaderboard host is pinned as a constant in `src/fomo.ts` and never
derived from a redirect or a search result, the same rule the RPC and explorer
hosts follow. The robinx key is read from the shell and refused if it is found
in a `.env` beside the code. Neither file is written anywhere but
`tools/out/`.
