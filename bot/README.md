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
Telegram token required (`--compact` for the short one). `npm test` runs the
unit suite; `node test/integration.mjs` exercises the service layer against the
live chain.

## Three surfaces

| surface | trigger | card |
|---|---|---|
| DM | `/scan <address>`, or a bare address | default |
| Group / supergroup | `/scan <address>` only | default, sent as a reply |
| Inline | `@thebot <address>` in any chat | default |
| any of the above | `/full <address>` | the long technical card |

All three go through one entry point (`src/service.ts`), so the cache, the
per-user quota and the concurrency limit apply identically and no surface can
be used to bypass the others.

**Groups never auto-scan.** A bare address is only treated as a scan in a DM.
In a group the bot acts solely when addressed with `/scan` — unsolicited
scanning of every address someone posts is what gets a bot removed from a
group, so it is deliberately absent.

**Privacy mode stays ON.** It is a BotFather setting rather than an API call,
so the bot cannot enforce it — instead it reads `getMe().can_read_all_group_messages`
at startup and warns loudly if privacy mode is off, naming the fix
(`BotFather -> /setprivacy -> Enable`). It also warns if inline mode is not
enabled. The bot never acts on unaddressed group messages either way.

## Cache, quota and concurrency

A scan costs about 1.5s and a burst of RPC against a rate-limited node. Inline
mode makes repeats the normal case, not the exception — Telegram re-issues an
inline query on nearly every keystroke.

- **Cache**: rendered cards, keyed by token, 60s TTL, capped at 500 entries,
  oldest evicted. Re-reading a hot token refreshes its position so it is not
  evicted ahead of a colder entry written later. Hit rate is logged every five
  minutes and shown in `/stats`. Measured: a hit serves in **0ms** against
  ~1.5–3s uncached.
- **Quota**: 10 scans/minute and 100/hour per user, sliding windows. Over the
  limit the reply is explicit — `rate limited, try again in 60s` — never a
  silent drop, and the rejection is still logged.
- **Concurrency**: 5 global scan slots; the rest queue rather than fail.

A cache hit consumes no quota. That is both what "10 scans per minute" literally
means and a hard requirement for inline mode, where one pasted address can
produce a dozen query events. It remains sound as abuse protection: hammering
distinct tokens produces cache misses, which is exactly what the counter sees.

Quota is checked *before* queueing on the semaphore. If a spammer could queue
first, their requests would occupy slots that legitimate users wait behind, and
rejecting them at the front of the queue would already have cost the wait.

**Single-flight.** Concurrent requests for the same uncached token share one
scan rather than each running their own. This does three jobs at once:

- kills the thundering herd — five people pasting the same trending token no
  longer run five identical scans, or occupy all five global slots with them
- keeps the concurrency cap honest — the slot is released when the *scan*
  finishes, not when a caller gives up, so an abandoned scan can no longer be
  running outside the cap
- makes the timeout message true (below)

Verified: 8 concurrent requests for one uncached token produce exactly **1**
scan row and identical cards for all 8.

Inline answers carry a 10s deadline, under Telegram's ~15s cut-off; past it the
bot returns a "still indexing, try again in a moment" article rather than
letting the query expire. The deadline abandons the *caller*, never the work:
the shared scan keeps running and writes to the cache when it finishes, so the
retry it promises lands instantly.

That last part was a real bug found while testing this. The cache write
originally sat after the awaited deadline, so a timed-out scan was discarded —
"try again in a moment" sent the user back to an empty cache to pay full price
again. A test now asserts the abandoned scan populates the cache and that the
retry is served from it.

## Two deliberate deviations from the brief

Both are flagged rather than hidden, because both are places where following the
instruction literally would have made the bot worse.

**Inline answers are not all cached the same way.** The brief specifies
`cache_time: 60, is_personal: false` on `answerInlineQuery`. That is right for a
scan result — a token's card is identical for everyone — and it is used there.
It is wrong for a rate-limit, busy or error answer: those are per-user and
momentary, and answering one with shared settings hands Telegram a single user's
state to serve to *everyone else* asking the same thing for the next minute. One
user exhausting their quota would show "rate limited" to the whole platform.
Those three outcomes answer with `cache_time: 0, is_personal: true`.

**The hourly rate-limit message says minutes, not seconds.** The brief's wording
is "try again in Ns". The per-minute window — the case users actually hit — can
never exceed 60 seconds and always reads as `try again in 60s`. The hourly window
can be nearly an hour, and `try again in 3400s` is not usable, so anything above
90 seconds is rendered as minutes.

## The card

Concerns first, measurements last. A reader in the first minute of a launch gets
the part that is actually decidable that early — what was fixed at creation —
rather than scrolling past a traction block that cannot say anything yet.

```
VITALS  $GHATS · 47s

🚩 8 wallets got in tax-free before you could
🚩 same ticker as the asset it trades against
🚩 deployer launched 91 tokens this week

2 buyers · both already sold · 0.00%

@vitalscheck_bot · not financial advice
```

```
VITALS  $TOKEN · 20m

no concerns raised · 6 of 8 checked · 2 undetermined

38 buyers · 3 sold · 12.4%
buyers 12 → 38 in 20 min

@vitalscheck_bot · not financial advice
```

At most three flags, highest severity first; a fourth becomes `+N more · /full`.
**Undetermined is never hidden** — it appears beside the checked count, or on the
overflow line when the three flag slots are full.

There is no grade and no score. There is also no "clean", "safe" or "looks good":
the absence of a raised flag is not an all-clear, it means the checks that ran
found nothing, which is why the card states how many ran and how many could not
be determined.

The traction *verdict* is gone entirely. A label like `TRACTION none` was what
made a seconds-old launch read as a judgement when it was really an absence of
data; raw counts carry the same information without pretending to a conclusion.

**Every flag carries a second register.** The plain line is what the card shows;
the technical wording still exists and appears in `/full`.

| technical | plain |
|---|---|
| `8 wallets pre-exempted from the opening tax` | 8 wallets got in tax-free before you could |
| `ticker matches its pair asset NVDA` | same ticker as the asset it trades against |
| `name collides with 11 tokens after homoglyph normalisation` | 11 other tokens use this exact ticker |
| `deployer launched 331 other tokens in 7d` | deployer launched 331 tokens this week |
| `creator tax 100 bps vs 90 bps median` | creator takes 1% of every trade |
| `only 20% of deployer's priors alive at +24h` | 4 of deployer's last 5 tokens died in 24h |
| `buyback enabled — 5-year linear vest` | creator locked fees into a 5-year buyback |
| `custom pair NVDA — inherits that asset's risk` | priced in NVDA, not ETH — inherits its risk |

### Built to be forwarded

The card is the unit of distribution: someone reads it and sends it to a group.
So it is sent with **no `parse_mode` at all** — no tags to strip, no `&amp;`
where an ampersand belongs, and a copy-paste of what is on screen is exactly what
was rendered. That also removes the injection surface entirely, since there is no
markup for an attacker-controlled ticker to break out of. Angle brackets are
stripped from tickers anyway, so a token called `<b>` cannot even *look* like it
carries formatting.

Under 12 lines so it never truncates in a Telegram preview, footer always last,
and the same shape on all three surfaces — DM, group and inline.

### /full

Renders exactly the previous card, unchanged: the technical wording of every
flag, the traction block, early mode, phase, pair and links. Nothing was lost;
it stopped being the default.

## Ticker impersonating the pair asset

A launch can take the ticker of the very asset it is paired against. Live
example: `0xAa0C1171…` launches as **$NVDA**, name *"No Value Dog Agent"*, paired
against `0xd0601CE1…` whose symbol is also **NVDA** and whose name is *"NVIDIA •
Robinhood Token"*. Different contracts, identical ticker. Someone reading "$NVDA"
in a group cannot tell which one they are looking at, and the pair asset is the
one with a real price to anchor to.

Compared after the same homoglyph normalisation the collision flag uses, so a
Cyrillic or mathematical-alphanumeric spelling of the pair's ticker is caught
too. Ranked **above** a plain name collision: colliding with some other launch is
common noise, whereas wearing the ticker of the asset on the other side of your
own pool is aimed at the person about to trade it.

## Surviving a redeploy

The container has no persistent volume, so every deploy starts from an empty
SQLite file. Untreated that is worse than it sounds: the bot comes back up
answering scans from a handful of rows, and every index-backed check quietly
turns into a confident negative — `no match against indexed pons tokens` derived
from zero rows is a false all-clear, which is the one failure mode this tool
exists to prevent.

**On boot** the index is assessed and the decision is logged either way:

```
[boot] index has 36,190 decoded launches — skipping recovery
[boot] index empty — backfilling, then decoding in background
```

Recovery runs at bulk priority, the same treatment as the decode drip, so an
interactive scan always preempts it. The bot answers throughout — the point is
that a scan during recovery gets an honest *undetermined*, not that it waits.
Measured: a full rebuild indexes ~36,000 launches in about 46 seconds, and the
decode of those rows then drains in the background.

**Index-backed negatives are gated on coverage.** A finding is always reported —
a collision found against a partial index is still a real collision. It is only
the *absence* of one that needs a population behind it:

| check | negative needs |
|---|---|
| ticker collision | decoded rows (only those carry the normalised keys) |
| deployer launch rate | indexed rows spanning the window |
| creator tax vs median | indexed rows to take a median from |

On an empty index those three report undetermined; `pair ticker` and
`custom pair` still answer, because they read the chain rather than the index.
So the card degrades to *"no concerns raised · 2 of 8 checked · 6 undetermined"*
rather than pretending to an all-clear.

One design note. `markRecovering` covers the **backfill only**, not the decode
that follows it. The decode loop runs for the life of the process draining
whatever is undecoded, so a flag tied to "decode is running" would never clear
and every index-derived negative would be suppressed forever. Once the backfill
lands, the coverage thresholds take over and gate each negative on the rows that
actually exist behind it — a sharper test than a process-wide flag, since it
distinguishes checks that need decoded rows from those that only need indexed
ones. The log says which state it ended in:

```
[boot] recovery finished — 36,268 indexed, 0 decoded; index-derived negatives still withheld until decode catches up
```

## Staying at the chain head

`npm run bot` tails the factory every 3 seconds, so a launch is in the index
within seconds of its event rather than on first scan. Marked bulk like the
decode drip, so interactive scans always preempt it.

Without it, a scan of an unindexed token falls back to walking the factory's own
logs — a topic-filtered `getLogs` per 500k-block chunk, measured at **0.7–9s per
chunk** with wide variance and up to 18 chunks before giving up. The tail loop
removes that path for anything it has seen.

Two details the measurements forced:

- **A pass costs two requests, four on the lifecycle sweep.** Block-time anchors
  are primed lazily, only when a chunk actually yielded launches — priming up
  front spent `getBlock` calls on every empty poll. The `LaunchSwept` /
  `PoolGraduated` sweep is two more `getLogs` and runs one pass in ten rather
  than every pass: graduation is not time-critical the way a new launch is,
  since nothing about a scan changes in the thirty seconds it takes to notice
  one. Steady state is **0.73 req/s** of a 10 req/s budget.
- **`getBlockNumber` is read with `cacheTime: 0`.** viem caches it for its
  polling interval (4s by default), which is longer than this loop's own
  interval, so the tail would otherwise act on a head it had already seen.
- **A catch-up pass is bounded to 30,000 blocks.** After downtime the cursor can
  be far behind, and closing the whole gap in one pass — decoding a creation
  transaction per launch — would block the poller for minutes, which is exactly
  the responsiveness it exists to provide.

## Scan logging

One line per scan request on stdout, `key=value` so it greps:

```
[scan] source=dm token=0xd384…1B76 age=180101s cache=miss duration=3738ms early=no outcome=ok
[scan] source=inline token=0xd384…1B76 age=180101s cache=hit duration=0ms early=no outcome=ok
[scan] source=group token=0x0000…beef age=? cache=miss duration=652ms early=? outcome=not_found
```

A request with no age or early verdict — a rate-limited one, or an address that
is not a launch — prints `?` rather than `0`, which would be a measurement
nobody took.

## Early mode

Degens scan the moment a launch opens. A token five seconds old has no traction
because nobody has had time to buy it — but rendering that as `TRACTION none`
reads as a finding about the token rather than an absence of data, which is a
false negative on the most-scanned case there is.

Under **180 seconds** the card switches to early mode:

```
VITALS  $COIN
launched 3s ago · too early for traction
🚩 deployer launched 86 other tokens in 7d
🚩 name collides with 4 tokens after homoglyph normalisation
re-scan in 2 min
via @vitalscheck_bot · signals only, not financial advice
```

The traction block is replaced by one line — *traction unavailable — the snipe
tax window is still open. re-scan in 2 minutes.* — and round-trippers, buyer
growth and progress velocity are **absent**, not zeroed. They are structurally
undefined this early: buyer growth needs two points in time to exist, velocity
needs elapsed time in the denominator, and the snipe tax window has barely shut.

What early mode still shows is everything fixed at creation or drawn from the
index of *other* launches — the snipe-tax exemption count, the creator's own buy
inside the launch transaction, creator tax against the median, buyback, deployer
history, and ticker collisions. That is real signal: the live example above is a
three-second-old token already carrying four flags.

Three details worth knowing:

- **Three clocks disagree at this boundary, and the code says so.** The curve's
  own `launchedAt()` is exact but read through the optional-read helper, so it
  can be absent. The indexed launch time is an interpolated block timestamp that
  drifts up to about seven seconds — fine for a seven-day window, not for a
  180-second one. And this host's wall clock supplies "now" and can be wrong by
  any amount after a VM resume. So: prefer the exact time; widen the window by
  the known drift when only the interpolated one is available (always in the safe
  direction — a token that *might* still be early is never handed a traction
  verdict); and cross-check elapsed time against block progression, which no host
  clock can skew. A negative age is a clock fault, not a brand-new token, and is
  logged rather than clamped to a confident "launched 0s ago".
- **Early results cache for 10s, capped by the window itself.** The same launch
  at 5s and at 90s are different answers. A card rendered at 179s gets a
  one-second life, not ten, so it can never still be saying "too early" after the
  token settled. Telegram's own inline answer cache — which is shared across
  every user — is set from the same computation, or it would re-open the exact
  overhang the server-side cap closes.
- **An early scan stores NULL for every traction metric and the label `early`.**
  Writing zeros would be worse than useless: the scans table exists to pair an
  early signal against a later outcome, and a row claiming "0 buyers, traction
  none" for a token nobody could have bought yet would train that pairing on a
  measurement never taken.

Undetermined stays undetermined here too. `launchBuyAmount` is null both when
there was genuinely no creator buy and when the creation transaction could not be
decoded, so the card distinguishes them explicitly — and because the compact
early card carries no "N undetermined" counter, an undecodable launch says so on
its own line rather than rendering identically to a clean one.

One wording note: the replacement line says *the snipe tax window is still open*,
as specified. On this chain `snipeTaxSeconds` is **3**, so that is literally true
only for the first few seconds of the 180-second window. The copy is kept as
given — worth a second look if the precision matters.

Three deviations, all deliberate:

- The compact early card also counts the **custom pair** flag, which
  the brief's list omitted. It meets the stated criterion — fixed at creation,
available now, not traction-derived — and dropping it would make the same token
report a different flag total before and after 180s.

## Two bugs the review found in the write path

Worth recording because both were silent and one was self-inflicting.

**A decoded row could lose the creator's opening buy.** `ensureLaunchRow`'s
`ON CONFLICT DO UPDATE` refreshed `snipe_exemption_count` and `entry_point` but
omitted `launch_buy_amount` — the fields all come from the same decode. Since
`token` is the primary key, any row already present (and `npm run backfill`
records rows without decoding by default) took the update branch and kept a stale
NULL buy amount beside a freshly decoded exemption count. The early card's
"undetermined" guard read the *count*, so it waved through a confident
`creator opening buy: none` for launches that opened with one; the snipe flag
also quietly lost its "alongside a creator buy in the same transaction" clause.
Worse, the row was then permanently unrepairable, because the repair pass selects
`WHERE snipe_exemption_count IS NULL`. Reproduced against the live index on a
token whose real opening buy was 0.009 ETH.

Fixed in three places: both upserts now persist those columns, the repair pass
also picks up `launchAndBuy` rows with a missing buy amount, and the renderer's
guard keys on whether the creation transaction was decoded at all rather than on
a column that can be fresh while its sibling is stale.

**Quote amounts were printed with a hardcoded 18 decimals.** Every
quote-denominated figure — the creator's opening buy, the median buy, the
strongest-signal line — is in the *pair token's* units. Most pairs are 18
decimals so this was invisible, but `USDG` on this chain has **6**: a 5 USDG buy
rendered as `0.000000000005 USDG`. All three now take `pairDecimals`.

## Failure behaviour

Every failure produces a reply, on all three surfaces. A DM's "Scanning…"
notice is always resolved by **editing** it — a fresh message would leave the
notice sitting above the answer, still reading as in-progress.

| case | what the user sees |
|---|---|
| not a pons v2 launch | `not a pons v2 launch. this bot only covers pons v2 on Robinhood Chain.` |
| anything else | `scan failed, try again` |

The full error goes to the server log; an RPC stack trace in a group chat helps
nobody and leaks internals. Neither a not-found nor a failed scan consumes scan
quota — a user should not be charged for a token that does not exist. Abuse is
still bounded, because the flood cap counts every request either way.

There are no bare catches: every catch handles the error or logs it, and a test
fails the build if one is reintroduced.

Two bugs this behaviour came from:

- `performScan` was called outside any try/catch, so anything it threw escaped to
  `bot.catch` and left "Scanning…" on screen permanently, with no reply and no
  way for the user to tell the scan had ended.
- Worse, `readToken` wrapped its *primary* read — `getLaunchedToken`, the call
  that decides whether a token is a pons launch at all — in the same
  fallback-on-error helper as the optional reads around it. An RPC outage was
  therefore indistinguishable from a genuine miss, and the bot answered "not a
  pons v2 launch": asserting a fact about a chain it had just failed to reach.
  That read is now allowed to throw, so "the chain says no" and "we could not
  ask the chain" are different answers.

## Known limitation

**There is no per-user concurrency cap.** One user pasting ten distinct
addresses at once can occupy all five global slots and briefly delay everyone
else. This is bounded — the 10/min quota caps the burst and each scan is a
second or two — and closing it means a second queueing layer above the global
semaphore, which buys a couple of seconds of fairness in exchange for real
deadlock surface. The brief asks for a global limit, and that is what is built.
Worth revisiting if group traffic ever makes the delay visible.

## Storage of usage

`scan_events` records one row per user-facing request — source, chat, user,
token, cache hit, duration and outcome — including cache hits and rejections.
It is deliberately separate from `scans`: that table holds one row per distinct
observation of a token, and padding it with byte-identical duplicates written
seconds apart would corrupt the very early-signal-to-outcome pairing it exists
for. So a cache hit logs an event and does not write a scan row.

## What the card reports

**Traction** — measured over the token's first 30 minutes (truncated, and
labelled as such, for a younger token):

- unique buyers, counted by recipient
- buyer growth: unique count at +10 min versus +30 min
- buy/sell transaction ratio
- median buy size in the pair asset
- graduation progress
- progress velocity, % per 10 min

**Flags** — eight negative signals, plus `buybackEnabled` reported separately as
a positive one:

| flag | source |
|---|---|
| snipe-tax exemptions at creation | launch transaction calldata |
| creator tax vs median across indexed launches | factory + local index |
| deployer launches in the last 7 days | local index |
| deployer median peak mcap of prior launches | recheck history |
| deployer share of priors still trading at +24h | recheck history |
| name/ticker collision with an existing pons token | local index, homoglyph-normalised |
| ticker matches the asset it is paired against | pair token's own `symbol()`, homoglyph-normalised |
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

**Attacker-controlled text is clamped where it is rendered.** Token names,
tickers, pair-token symbols and the symbols of colliding tokens all come from
launch calldata or another token's own metadata, and nothing on chain caps their
length. A single 5,000-character ticker would push a card past Telegram's
4096-character limit, and a rejected inline answer leaves the client spinning
forever. Each field is clamped at the point of use, and a final guard drops whole
lines rather than slicing — slicing raw HTML lands mid-tag and Telegram rejects
the entire message, and truncating from the tail would remove the disclaimer,
which must never be dropped from a card.

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
| `npm test` | unit suite (cache, quota, semaphore, compact card) |
| `node test/integration.mjs` | end-to-end service check against the live chain |

## Configuration

| variable | default | meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | required for `npm run bot` |
| `DB_PATH` | `./pons.db` | SQLite file |
| `BACKFILL_DAYS` | `7` | default backfill window |
| `LOOKBACK_DAYS` | `10` | how far `/scan` hunts for an unindexed launch |
| `RPC_RATE_PER_SEC` | `10` | client-side pacing |
| `MIN_INDEX_ROWS_FOR_NEGATIVE` | `1000` | rows required before an index-backed negative is asserted |
| `RECOVERY_STALE_SECONDS` | `21600` | index age past which boot rebuilds it |
| `SCAN_CACHE_TTL_MS` | `60000` | rendered-card cache TTL |
| `SCAN_CACHE_MAX` | `500` | cache entry cap |
| `SCANS_PER_MINUTE` | `10` | per-user quota |
| `SCANS_PER_HOUR` | `100` | per-user quota |
| `MAX_CONCURRENT_SCANS` | `5` | global scan slots |

The RPC and explorer hosts are hardcoded in `src/config.ts` and are never
resolved from search results — lookalike RPCs and fake explorers exist for this
chain.
