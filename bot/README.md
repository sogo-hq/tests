# pons v2 launch scanner

A Telegram bot that scores token launches on the pons v2 launchpad on Robinhood
Chain (chain id 4663). It reports **observations and flags only** — never price
targets, never a buy or sell recommendation.

```
/scan 0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67
```

## Quick start

```bash
npm install
npm run build

npm run verify              # re-assert every chain fact the bot depends on
npm run backfill 7          # index 7 days of launches (~45s)
npm run decode              # decode creation txs for snipe-tax exemptions (resumable)

export TELEGRAM_BOT_TOKEN=...
npm run bot                 # Telegram bot + recheck worker
```

`npm run scan -- <address>` prints the same card on the command line, no
Telegram token required.

## What the card reports

**Traction** — measured over the token's first 30 minutes (truncated, and
labelled as such, for a younger token):

- unique buyers, counted by recipient
- buyer growth: unique count at +10 min versus +30 min
- buy/sell transaction ratio
- median buy size in the pair asset
- graduation progress
- progress velocity, % per 10 min

**Flags** — seven negative signals, plus `buybackEnabled` reported separately as
a positive one:

| flag | source |
|---|---|
| snipe-tax exemptions at creation | launch transaction calldata |
| creator tax vs median across indexed launches | factory + local index |
| deployer launches in the last 7 days | local index |
| deployer median peak mcap of prior launches | recheck history |
| deployer share of priors still trading at +24h | recheck history |
| name/ticker collision with an existing pons token | local index, homoglyph-normalised |
| custom pair asset | `getLaunchedToken().pairToken` |

Each flag is `clean`, `raised`, or **`undetermined`**. Undetermined is never
rendered as clean — if a creation transaction cannot be decoded, the card says
so rather than claiming zero exemptions.

## Notes from building this

Everything below was measured against the chain, not assumed. `npm run verify`
re-asserts all of it.

**The factory address in the original brief was wrong by one character.**
`0x7eD598BcEf0bd9…` has no code, nonce 0, and has never been used. The real
factory is `0x7eD598BcEf8bd9…` (`0` → `8` at position 12), confirmed three ways:
`V2BuybackVault.factory()` returns it, it is baked as an immutable into every
per-launch curve's bytecode, and it is the only one of the two with code. The
brief's meme-hook address also contained a letter `O` instead of a zero. The
other three addresses matched.

**The snipe-tax exemption flag has four sources, not one.** The brief names the
`launchToken(..., address[])` overload. In practice 71% of launches arrive
through `launchForwarder.launchAndBuy(..., address[])`, which launches *and
buys* in one transaction. Decoding only the documented overload would report a
false "0 exemptions — clean" on most launches, on the flag the brief calls
highest-value. All four entry points are decoded:

| selector | entry point |
|---|---|
| `0xf85f8e41` | `launchForwarder.launchAndBuy(…, address[])` |
| `0xa72101af` | `factory.launchToken(…, address[])` |
| `0xf35abbcf` | `factory.launchToken(…)` — no array, a structural zero |
| `0xd6a0eef5` | `factory.launchTokenFor(…, address[])` |

Exemption counts in the wild cluster at 1, 3, 7 and 13 — deliberate bundle
sizes, not noise.

**`quoteReserve` is not progress.** It includes a phantom reserve seeded at
launch. On a freshly launched token with zero buys, `quoteReserve` read
`10.66e18` against a `26.6e18` threshold — about 40% — while `realQuoteReserve`
was `0`. Progress uses `realQuoteReserve`; price uses `quoteReserve`, because
that is the reserve the curve itself prices against.

**Progress is reconstructed exactly, not interpolated.** Replaying trade events
as `Σbuys(quoteIn − fee − creatorTax) − Σsells(quoteOut + fee + creatorTax)`
reproduced `realQuoteReserve()` to the wei across 66 trades, so progress at any
historical block is exact. Curve event signatures were confirmed by matching
keccak256 against topic constants in the deployed bytecode, then re-confirmed
against live logs.

**Ticker collisions here are homoglyphs.** The chain carries `b`, `B`, `Ⴆ`, `Ხ`,
`𝔟`, `𝓫`, `b̶̶`, `ᖯ` and `ბ` all competing as "b". A string compare finds none of
them, so both sides are NFKD-folded, stripped of combining marks, and mapped
through a curated confusables table before comparison.

**Data path: raw `eth_getLogs`, always address-scoped.** Measured against the
alternatives for the same job:

| path | result |
|---|---|
| raw `getLogs`, address-scoped | 1M blocks in 832ms — fastest and complete |
| etherscan-compatible `logs&getLogs` | 875ms — complete, used only for fetching verified ABIs |
| REST v2 `/addresses/{a}/logs` | 6969ms — 8× slower, paginated, decoded 3 of 4 logs |

Topic-only queries with no address filter time out above ~20k blocks;
address-scoped queries accept ~3.9M-block spans. `getLogsAdaptive` halves the
range and retries on timeout rather than hardcoding a constant per call site.

**The RPC rate-limits, and its batching drops requests.** Bursting uncapped
concurrency returns HTTP 429 after ~158 requests; paced at 10 req/s it sustains
indefinitely. JSON-RPC batching is disabled entirely: this node accepts batches
but silently drops entries from them under load, which surfaces as an
unmatchable response id. It fails loudly rather than corrupting data, but an
indexer whose whole job is decoding every launch transaction should not run on a
transport that intermittently drops requests.

**Request priority is per-process, so the bot drains its own backlog.** An
interactive `/scan` and a bulk decode share one rate budget. Inside a single
process, scans preempt bulk work — 79ms mean scan latency measured against 264
concurrent bulk requests. Run as two processes they simply contend at the node,
and the same scans took 10–25s. So `npm run bot` runs the recheck worker *and*
the decode backlog in-process rather than expecting them to be started
separately. Run `npm run decode` on its own only when the bot is not running.

**Holder counts come from the chain, not the explorer.** The explorer's token
endpoints return 500 for freshly launched tokens. Replaying `Transfer` events and
summing balances is exact — spot-checked against `balanceOf()` to the wei — and
protocol-owned addresses (the curve, pool manager, vault, locker) are excluded,
since counting them would inflate every token.

## Not implemented, deliberately

pons v2 makes these structurally impossible, so checking them would be noise:
mint authority (supply is fixed), freeze/blacklist (does not exist), LP lock
(permanent at graduation, with no unlock function), and deployer supply share
(the entire supply mints straight to the curve).

## Storage

Every scan writes a row with all traction metrics, all flag values, mcap,
unique buyers, snipe-exemption count, creator tax, buyback state and progress.
A background worker rechecks each scanned token at **+1h, +6h, +24h and +7d**,
recording `still_trading`, `peak_mcap`, `current_mcap`, `graduated` and
`holder_count`.

Pairing the early signal against the later outcome is the point of the product.
The deployer-history flags (prior peak mcap, prior survival at +24h) read
directly from this table, so they get sharper the longer the bot runs.

Tables: `launches`, `trades`, `scans`, `rechecks`, `token_peaks`, `cursors`.

## Commands

| command | what it does |
|---|---|
| `npm run verify` | re-assert every chain fact against the live chain |
| `npm run backfill [days]` | index `TokenLaunched` (add `--decode` to decode inline) |
| `npm run decode [n]` | decode creation txs for exemptions; resumable |
| `npm run index` | index launches since the stored cursor |
| `npm run scan -- <addr>` | scan one token, print the card |
| `npm run recheck [n]` | run due rechecks once (`--loop` to stay running) |
| `node dist/index.js stats` | index and scan statistics |
| `npm run bot` | Telegram bot plus recheck worker |

## Configuration

| variable | default | meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | required for `npm run bot` |
| `DB_PATH` | `./pons.db` | SQLite file |
| `BACKFILL_DAYS` | `7` | default backfill window |
| `LOOKBACK_DAYS` | `10` | how far `/scan` hunts for an unindexed launch |
| `RPC_RATE_PER_SEC` | `10` | client-side pacing |

The RPC and explorer hosts are hardcoded in `src/config.ts` and are never
resolved from search results — lookalike RPCs and fake explorers exist for this
chain.
