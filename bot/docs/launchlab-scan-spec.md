# Scanning LaunchLab launches

The specification for a second scan path, covering StonkFun and the other
front ends that launch through Raydium LaunchLab on Solana. Written before any
of it is built, so that the decisions in it are the thing implemented rather
than something reconstructed afterwards.

This path does not touch the pons path. It shares the card renderer, the flag
vocabulary and the rules below, and nothing else. Every rule the pons cards
already follow applies here unchanged: no score, no grade, no verdict, no
price, absence of a finding is never "clean", and a figure that could not be
read is undetermined rather than zero.

Everything stated as a fact in this document was read from chain or from a
public API on 2026-09-22 and 2026-09-23. Where something was inferred rather
than read, it says so.

---

## 1. What is actually being scanned

StonkFun is a front end. The launches run on **Raydium LaunchLab**, program
`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`, confirmed on three decoded
creation transactions. So this is a LaunchLab indexer that knows which front
end each launch came from, not a StonkFun indexer.

The creation instruction is `InitializeWithToken2022`. A dev buy is a
`BuyExactIn` appended to the same transaction, which makes the dev buy exactly
readable as the creator's post balance over total supply, and makes it
distinguishable from a snipe: a dev buy is the same transaction, a snipe is
merely the same slot.

Observed on every launch read so far: supply 1,000,000,000 at 6 decimals,
`mintAuthority` null and `freezeAuthority` null on the launched mint after
creation.

---

## 2. Platform identity

### The rule

**A pinned set of platform config pubkeys is the only thing that names a
platform.** Nothing else promotes a launch into a named platform: not the name
string, not the site string, not the API.

The platform config is account index `[3]` of the LaunchLab initialize
instruction. It is owned by LaunchLab, 944 bytes, discriminator
`a04e8000f853e6a0`, and carries a name and a site as plain strings.

### Why the strings cannot be trusted

There are 2,591 platform configs on LaunchLab under 2,253 distinct names, and
the name is free text chosen by whoever created the config. The lookalike
problem is already live:

- America.fun appears as `America.Fun`, `America.fun`, `America DOT Fun`,
  `America Fun`, `America` and `america.fun` across 46 configs.
- `BONKfun 2.0` at `bonk20.fun` is not `letsbonk.fun`.
- Configs exist named `test`, `TEST` and `your platform name`.

The site string is the field an impersonator copies character for character,
so it never promotes anything by itself. It is only ever compared against what
is pinned, never used to decide membership.

### The pinned set

StonkFun, 35 configs, every one carrying the site `https://www.stonkfun.xyz`.
Two of them are the modes seen in the decoded launches:
`4E876qZ...` is standard and `6BwHHDg3...` is reward.

```
3P5BVffvoKngKMBZuki6PtMdGeScFX2N1kpjJW15WMjd
3qiqsFPZgPFhzUK2vF4QwvWXnh5NTPKYDHYJAxYsvcu8
3xv3SBLLeWQryvLVeG4BwfLhnhfWYN1tdeSGx3F1QaCe
4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7
4jDsqJ8Wn2o2tE7F2HWCgAkTzm8cteBX6nn9Sgaix8aX
4LkQf3v3ukz4Rm8dpUckn8wKPji2CFmSfuPCLbo1pnHF
5f3S2roYYEdEGbyLmLhd3aDHoubaNtHtk7trX5Z7M1hh
5LNpBsmvaPovXErRUfV7ijdCeVkEHaRSpJ2RaQ5nNhX4
6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt
6SzhbA9AACoBmFfTsBGG5Bfj5XQzWR1kEP7ZxF4sqvdn
7Skv1Zut6JMHgfsBMDGKoTKtDvFivQYHrYnY2PcQzipT
7uCfLgLrH7RYkmBXiUduudsDGDwutCNdgzrMzuydm5L7
8DFxvoAqP1AX5ShVLPfhKtqiS5usENj3vzNiiUfBrbEz
8uzF7UKMxB43x6YDfUwsKqtmJYGMzbDLaUPBiPAXuyhp
9asa5tjM9Akt6pRCUXHCfvmhEkuGo8XJDipubwPMwYo3
AbfUdGULpcLmS6eCiSbmwf5h3xctJVqjLTXrkgLzeK9S
ANytinarxvDziPyKVvGU78TAtKVP4R9QYZPm4c8fWYzT
apwdwgRxEU3RrRAA4idkwn8sQQwDbKDSMxqMgCd7wEF
Au4s8A4FWr81sA6BybLcW9wqgLd2Js4AVUEvLpiTFiBV
BCN7kK9PH7VoDYdKHguG1YjmyMmFuLT9DYoSdqvXgcEQ
BhFhtURYqjzkK7A1ChgkS2uoSXuYHBo3qfZa5s4MioCU
ChVSt6yJVxhTn8vKpyYP6adnh3bSXG9FzzFdhizQCB8S
DAR1V5XCYad4jgzDUx5FaAd42ergBMWoETuYayrk8RaK
DJuS9KGAbwHVxNbmnX7HCtnDrRqpAD6spWntJnY5JdRZ
DxvoksLVEaGRGKD9nGc1oizqN9W4ycHxZqLoML1yfmsC
DZ1h7DdDubcYY5atjskrqcck2rpi37s59UL4c2jboNk5
EbS77E9fau1cqh1mRCmZJjMAe3gzZQ5wDE86FbgdEe3t
EFSEG7RUgsQgpyeiSfg3usdeeJEYhJG4h4gEXsXsP5Py
Etu1AV8ynsTVNQxAPMz9gKgzECDQUeGBgdoYYkzkP69f
GP8D5pqcQmuH71UpLCc4WvshLDXagDYYjzRK2bXasSNf
GPeRBoTGcdX5LY153duXkMxa6VW7BEnYcd2qsoTdrQgN
GTNFRgvNndgKTim9iSYo5oumKXiRcUHjoirwmE1yW38w
HEjWQtsHcJMv6y1W51GMRo5JX7XEpr9LUpcM8Rrhi2z7
HTMR9w3ypLLDzwMiah6Px1jqCByoSaG9EDCtU3DLdPZD
QFWKD4f3e8dgkYHYyhAqWfMtu5s316BP7MP97weXW8E
```

These are pinned the way `FACTORY` and `EXPLORER_URL` are pinned in
`src/config.ts`, and for the same reason. A test asserts the count and the
contents.

### The startup diff

At startup, read every 944-byte LaunchLab account with the platform
discriminator and compare against the pinned set. Log the difference. **Never
add.** Three cases, all logged and none acted on:

1. **Appeared.** A pinned platform has a config we do not carry. Log it so it
   can be reviewed and pinned by hand.
2. **Disappeared.** A pinned pubkey no longer exists or no longer holds a
   platform config. Log it loudly: something we trust has changed shape.
3. **Renamed.** A pinned pubkey still exists but its name or site string is no
   longer what it was when it was pinned. Log the old and the new value.

The third case is the one an allowlist otherwise misses entirely. A pinned key
that starts saying something new passes every membership check, because
membership was decided by the key. So the pinned set stores the name and site
alongside each pubkey, and the diff compares all three.

### Rendering an unpinned platform

A launch whose platform config is not in the pinned set renders as the raw
pubkey with the words **`platform not recognised`**. It does not render the
config's self-declared name anywhere, in any position, including in a tooltip
or a link title. Naming it would be repeating an unverified claim in our own
voice.

---

## 3. Fact lines and flags

The rule: **a property shared by most launches on a platform is a fact line
carrying its share. A flag is for a deviation.**

A fact line states what was read and what it is normal against. A flag says
something is unusual. Rendering a platform's default as a flag makes every
card on that platform look alarming and teaches the reader to ignore the
markers, which is the failure mode that makes a scanner useless.

### The split

| reading | renders as |
|---|---|
| transfer fee, any rate including none | fact line with the share |
| dev buy percentage | fact line, and a flag only against the platform's own distribution |
| buys in the creation slot | fact line |
| first 30 minutes activity | fact line |
| pairing asset and its category | fact line |
| quote asset freeze authority | **fact line** |
| quote asset mint authority | fact line |
| quote asset permanent delegate | **flag** |
| quote asset pausable | **flag** |
| quote asset symbol shared with other mints | **flag** |
| platform not in the pinned set | **flag** |

Freeze authority is a fact because almost every serious quote asset on this
chain has one. Permanent delegate and pausable are flags because they mean the
issuer can take the asset or stop it moving, and that is a different order of
thing from being able to freeze one account.

---

## 4. The thirty observation floor

No share, no median and no "like N% of launches" is printed from fewer than
**30 observations**. Below the floor the line says what it is withholding and
how many observations it has, in the same words the hold time already uses:

```
not published under 30 observations (n=11)
```

This is the same floor as `MIN_HOLD_SAMPLES` and `MIN_BENCHMARK_SAMPLES` in
the pons path, and it exists for the same reason: a percentage computed from
four launches is a sentence that will be quoted without its denominator.

Every comparison figure is computed **from our own index at render time**,
never read from a platform's own statistics endpoint. A card that quotes a
number we did not measure is a card making a claim it cannot support.

---

## 5. The fee line

The transfer fee is a Token-2022 `transferFeeConfig` on the launched mint. It
is **not a constant**, so nothing about it may be hardcoded:

- Ten sampled reward launches read 100 basis points.
- One sampled reward launch read 300 basis points.
- Standard launches carry no `transferFeeConfig` at all.

In every case the `transferFeeConfigAuthority` is the LaunchLab authority
`WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh`, so the rate is set at launch
and remains changeable by the platform afterwards. The `maximumFee` observed
was the entire supply, which is to say uncapped.

The card prints the rate it read, and compares it against the distribution in
our index:

```
transfer fee 1%, the rate on 8 in 10 reward launches
transfer fee 3%, above the 1% on 8 in 10 reward launches
transfer fee none, like 24% of stonkfun launches
```

All three are fact lines. A rate above the platform's norm is still a fact
line, because the platform chose to allow the range.

Token-2022 transfer fees have **no allowlist mechanism**, so there is no
exempt list to look for. That is a determinable negative and the card may say
so plainly, unlike the pons exemption case where zero is impossible.

---

## 6. The quote asset

**Named by mint everywhere.** The symbol alone is never sufficient, because
the same symbol is already two different assets with different risk:

| symbol | mint | category | permanent delegate |
|---|---|---|---|
| OPENAI | `PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF` | prestock | yes |
| OPENAI | `oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ` | tessera | no |

When a symbol resolves to more than one launchable mint, the card carries
`symbol shared with N mints`, rendered exactly like the pons ticker collision
line and for the same reason. StonkFun's own API carries a `symbolAmbiguous`
flag, which is a second party reaching the same conclusion.

The quote mint is read on **every** card, not only when something looks wrong.
Readings taken on 2026-09-22:

| quote | freeze | mint auth | flag-worthy extensions |
|---|---|---|---|
| ANTHROPIC (prestock) | yes | yes | permanentDelegate, pausable |
| OPENAI (prestock) | yes | yes | permanentDelegate, pausable |
| SPYX (xStock) | yes | yes | permanentDelegate, pausable |
| OPENAI (tessera) | yes | yes | none |
| PUMP | no | no | transferHook |
| SUI | no | yes | none |
| Fartcoin | no | no | none |

The permanent delegate on ANTHROPIC is `WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc`,
which is also its pause authority.

---

## 7. What is read at launch, and what is not

Readable exactly, from the creation transaction and the mint:

- dev buy as a share of supply, and whether it was the same transaction
- transactions in the creation slot, separated from the dev buy
- activity in the first 30 minutes, from the pool's signatures
- the pairing asset and every Token-2022 extension on it
- the transfer fee rate and its authority
- the platform config

Not readable, and therefore undetermined rather than assumed:

- whether a same-slot buyer is related to the creator
- whether the creator funded the dev buy from a wallet they control elsewhere
- distinct buyers in the first 30 minutes, until each transaction is read;
  a count of transactions is not a count of people and must never be labelled
  as one

---

## 8. Build shape

A new path at `src/solana/`, parallel to `src/indexer/`. Different chain
client, different address validation, different rate limiter. It shares the
card renderer and the flag vocabulary and nothing else.

Seed from the platform API for metadata, which is free and paginated. Go to
RPC only for the creation transaction, the mint extensions and the quote mint.
Do not index trades; read the first 30 minutes on demand.

Backfill against StonkFun alone is roughly 108,666 tokens at two RPC calls
each. **A paid RPC is required, not merely faster:** `getProgramAccounts` is
what enumerates the platform configs for the startup diff, and one of the two
public endpoints refuses it outright.

Tests on fixtures, no network, in the range of 60 to 80: the three creation
shapes, the platform diff including the rename case, the unpinned rendering,
the fee line at and under the observation floor, the quote asset extensions,
same-slot separated from same-transaction, and the undetermined paths when
either the RPC or the API is unreachable.

---

## 9. Open items, to settle before or during the build

### Is pons v2 token metadata mutable after launch

If a launched token can rename itself, the card should print the name as it
was in the creation transaction and say that it has changed since. It is the
platform rename problem one layer down, and it applies to the pons path as
much as to this one.

What was checked on 2026-09-23, against the rehearsal token
`0xae3020888aEd39556469C8A8026672D781FF5f84`:

- Runtime bytecode is 3,248 bytes, which is the size of a plain token rather
  than something with an administrative surface.
- `name()`, `symbol()` and `getTokenInfo()` are present.
- None of twelve candidate setter selectors is present in the bytecode:
  `setName`, `setSymbol`, `setTokenInfo`, `updateMetadata`, `setMetadata`,
  `setURI`, `setTokenURI`, `rename`, `setSocials`, `setDescription`,
  `setLogo`, `initialize(string,string)`.
- Neither `upgradeTo` nor `upgradeToAndCall` is present, and the EIP-1967
  implementation slot is empty, so it is not a standard upgradeable proxy.

This is evidence, not a settled answer. Twelve guessed signatures is not the
set of all possible setters, and absence of a guessed selector is not proof of
immutability. The definitive check is the verified source: read the token's
ABI from the explorer and look for any non-view function that writes the name,
the symbol or the socials. That request returned 403 from this environment and
has not been completed.

Until it is completed, neither card claims the name is immutable.

### The pons fee escrow ABI

`/v1/revenue` reports unclaimed creator fees as undetermined because the
factory names a `feeEscrow` this build has no ABI for. Obtaining that ABI
fills the field. Unrelated to this path, recorded here because it is the other
open undetermined in the system.
