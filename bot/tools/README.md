# tools

Two scripts that run on a laptop, never on the server.

The bot process holds no private key, and neither does its environment. These
read one from the shell for the length of a single transaction and refuse to
run if they find one in a `.env` file beside the code.

Both need the repo built first: `npm run build`.

## launch.mjs

Every value comes from `launch.config.json`, so the dry run, the rehearsal and
the launch are the same launch. Every mode ends with a diff of that file
against what the chain says.

```
node tools/launch.mjs --dry
REHEARSAL_PRIVATE_KEY=0x... node tools/launch.mjs --rehearse
LAUNCH_PRIVATE_KEY=0x...    node tools/launch.mjs --go
```

| flag | what it does |
|---|---|
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
