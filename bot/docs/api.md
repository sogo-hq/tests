# VITALS API v1

Read-only facts about pons v2 launches on Robinhood Chain (chain id `4663`),
read from the chain.

Base URL: `https://api.checkvitals.xyz/v1`
Machine-readable: `GET /v1/openapi.json`

---

## The two guarantees

These are the reason the API has this shape, and they are enforced by tests
that run on every build rather than by convention.

**1. There is no score, and there will not be one.**

Every check reports a `state` that is exactly one of three words:

| state | means |
|---|---|
| `finding` | the chain shows this, stated as a fact |
| `undetermined` | the check could not be answered from the data available |
| `none` | the check ran and found nothing |

There is no grade, no rating, no risk level, no confidence and no `safe`
boolean anywhere in any response. A consumer who wants to rank launches decides
for themselves what matters; publishing the checks instead of a number is the
whole design. If you need a single number for your own UI, build it from the
checks you care about, but it will be yours, and you will know what is in it.

**2. `none` is not an all-clear, and `undetermined` never carries a value.**

`state: "none"` means this particular check found nothing. It is never
described as clean, in any field or message, because the absence of one finding
says nothing about the launch as a whole.

`state: "undetermined"` means the check could not be answered. Such a check has
`value: null` and `reference: null`, always. A zero there would be read as a
measurement, and it is not one.

A launch with `summary.findings === 0` and `summary.undetermined === 4` has not
passed anything. It has four unanswered questions.

---

## Check ids are permanent

A consumer keys their own logic off `check.id`. **Adding a check is a
compatible change. Renaming or removing one is not**, and will not happen.

`summary.checks_run` is 11 on a launch with no declaration, and 12 on one with
a declaration. Nine of those ids are the committed v1 set; the rest were added
after v1 and a client written against the nine can ignore them.

Every `value` and every `reference` is **an object or null**, never a number,
a string or a boolean. A bare scalar cannot gain a second field later without
breaking every client that read it. The keys below are part of the contract.

**Shares are fractions, not percentages: `0.174` is 17.4% of supply.**

| id | v1 | what it reports | `value` keys |
|---|---|---|---|
| `snipe_tax_exemptions` | ✓ | wallets pre-exempted from the opening tax, and their share of supply | `wallets`, `beyond_deployer`, `supply_share`, `slots` |
| `creator_opening_buy` | ✓ | what the deployer took for itself in the opening window | `supply_share` |
| `deployer_history` | ✓ | how often this wallet has launched recently | `launches_7d` |
| `ticker_collision` | ✓ | **other** indexed launches using this ticker | `matches` |
| `ticker_vs_pair` | ✓ | the token wearing the ticker of the asset it trades against | `differs` |
| `creator_tax` | ✓ | the creator's cut per trade, against the index median | `bps` |
| `buyback_vesting` | ✓ | whether creator fees are locked into a 5-year vest | `enabled` |
| `pair_asset` | ✓ | what the launch is priced in | `asset`, `address` |
| `holder_concentration` | ✓ | what the largest wallets hold | `top5_share`, `largest_share`, `holders` |
| `deployer_prior_peaks` | added after v1 | how far this deployer's previous tokens got | `median_peak_mcap`, `priors` |
| `deployer_prior_survival` | added after v1 | whether those tokens still traded a day later | `still_trading_share`, `priors` |
| `launch_vs_declaration` | added after v1 | the chain against what the deployer declared beforehand, **present only on a declared launch** | `mismatches`, `fields` |

The `reference` object is the thing the value is measured against, and is
`null` whenever there is nothing to measure against yet:

| id | `reference` keys |
|---|---|
| `creator_tax` | `median_bps`, `n` |
| `creator_opening_buy` | `median_share`, `n`, null until the index has 30 measured launches |
| `ticker_collision` | `indexed`, `flag_at_or_above` |
| `deployer_history` | `flag_above` |
| `deployer_prior_peaks` | `index_median_peak_mcap` |
| `deployer_prior_survival` | `flag_below` |
| `launch_vs_declaration` | `declared_at_block` |
| `ticker_vs_pair` | `pair_symbol` |
| `pair_asset` | `native` |
| `holder_concentration` | `flag_at_share`, `percentile`, `n`, null until a distribution exists |
| `snipe_tax_exemptions` | always null: the count is the finding, there is no baseline for it |

### A measurement with no reference is not undetermined

If the window was read and the number is real, the check states it, with
`reference: null` and the reason in the headline:

```json
{
  "id": "creator_opening_buy",
  "state": "none",
  "headline": "creator opened with 1.0% of supply · no index median yet, n=12, needs 30",
  "value": { "supply_share": 0.0103 },
  "reference": null,
  "severity": 0,
  "source": "CurveBuy events over the first 40 blocks, against the index median"
}
```

`undetermined` is reserved for a window that was **not read**. Such a check
states no number at all, in any field, including the headline.

---

## Endpoints

### `GET /v1/launch/{address}`

One launch, as structured checks.

```bash
curl -s https://api.checkvitals.xyz/v1/launch/0xd384722f6adfe7d79e8e6623896df199afd31b76 \
  -H 'Authorization: Bearer YOUR_KEY'
```

Full response: [`examples/sample-response.json`](../examples/sample-response.json).
Abridged:

```json
{
  "token": "0xd384722f6adfe7d79e8e6623896df199afd31b76",
  "chain": 4663,
  "launchpad": "pons_v2",
  "symbol": "CHIPPER",
  "launch_block": 45790066,
  "launch_tx": "0xf2185b971c3b2a996c62dbedeeed19f3fc562b9be50625f113a3ce2761461f43",
  "age_seconds": 1560043,
  "pair": {
    "asset": "ETH",
    "address": "0x0000000000000000000000000000000000000000"
  },
  "checks": [
    {
      "id": "snipe_tax_exemptions",
      "state": "finding",
      "headline": "9 wallets tax-free at launch, 1 of them the deployer, together 17.4% of supply",
      "value": {
        "wallets": 9,
        "beyond_deployer": 8,
        "supply_share": 0.173623,
        "slots": 32
      },
      "reference": null,
      "severity": 917,
      "source": "the curve's own SnipeTaxExempted events, from the launch transaction receipt"
    },
    {
      "id": "creator_opening_buy",
      "state": "none",
      "headline": "creator opened with 1.0% of supply · no index median yet, n=1, needs 30",
      "value": {
        "supply_share": 0.010322
      },
      "reference": null,
      "severity": 0,
      "source": "CurveBuy events over the first 40 blocks, against the index median"
    },
    {
      "id": "holder_concentration",
      "state": "none",
      "headline": "top 5 hold 92.9% (no reference yet)",
      "value": {
        "top5_share": 0.929,
        "largest_share": null,
        "holders": 9
      },
      "reference": null,
      "severity": 0,
      "source": "the token's Transfer log, excluding the curve and the protocol"
    },
    {
      "id": "ticker_collision",
      "state": "undetermined",
      "headline": "can't check this ticker against other launches yet",
      "value": null,
      "reference": null,
      "severity": 110,
      "source": "indexed launch symbols and names, homoglyph-normalised"
    }
  ],
  "summary": {
    "checks_run": 11,
    "findings": 1,
    "undetermined": 5
  },
  "as_of": "2026-09-12T15:32:29.797Z",
  "index": {
    "launches": 18100
  }
}
```

Four of the eleven checks are shown. `examples/sample-response.json` in the
repository is the full response, byte for byte as the endpoint returned it.

**About this capture.** It was taken against an index that was a long way behind
the chain head, which is why `ticker_collision` and the deployer checks come
back `undetermined` rather than `none`: the index had not read the window those
questions are about, so it does not answer them. That is the guarantee working,
not a gap in the data, and against a current index those same checks resolve.
Regenerate at any time with `node scripts/gen-examples.mjs`.

Field notes:

- **`value`** is the measured quantity, apart from the sentence, and is always
  **an object or null**, never a bare number, string or boolean. Use this, not
  `headline`. Keys are per check id and listed above. Shares are fractions:
  `0.174` is 17.4% of supply. A key whose quantity was not read is `null`, never
  `0`, because a zero there is indistinguishable from a measurement.
- **`reference`** is what the value is measured against, also an object or null:
  an index median with its sample size, a threshold, a denominator. Null when
  there is nothing to measure against yet, in which case the headline says so.
- **`severity`** orders the checks, highest first. It is an **integer**, it is
  **not a score**, and it is not comparable between launches; it exists so you
  can render the same order the cards do. The quantity that drove it is in
  `value`, never encoded in the severity's own digits.
- **`source`** is what the check was read from. It is published because it
  varies in a way that matters: an exemption count read from the curve's own
  events includes the deployer, one decoded from calldata does not, and they are
  different quantities.

Status codes:

| code | body | when |
|---|---|---|
| `200` | the launch | |
| `400` | `{"error":"invalid_address","resolved_as":null}` | not a 20-byte hex address |
| `404` | `{"error":"not_a_pons_v2_launch","resolved_as":"deployer"\|"curve"\|null}` | the factory has no record of this token |
| `429` | `{"error":"rate_limited",...}` + `Retry-After` | over your rate |
| `503` | `{"error":"index_lagging","lag_blocks":N,"max_lag_blocks":500}` | the index is more than 500 blocks behind |
| `503` | `{"error":"scan_unavailable"}` | the chain could not be read well enough to answer |

`resolved_as` is worth handling. A deployer address and a curve address are both
things people paste expecting a token; a 404 that says which one you have is the
difference between a useful error and a dead end.

### `POST /v1/launches`

Up to **50** addresses. Partial results: one bad address does not fail the
batch.

```bash
curl -s https://api.checkvitals.xyz/v1/launches \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"addresses":["0xd384722f6adfe7d79e8e6623896df199afd31b76","0x5a05ff9c0d10e89701bae5b35d64adf99903073b"]}'
```

Returns an array, in the order given:

```json
[
  { "address": "0xd384…1b76", "ok": true,  "launch": { "...": "the same object as above" } },
  { "address": "0x5a05…073b", "ok": false, "error": { "error": "not_a_pons_v2_launch", "resolved_as": null } }
]
```

Addresses are scanned in sequence, not concurrently: fifty at once would put the
API ahead of the Telegram bot by sheer count. Budget accordingly.

### `GET /v1/stats`

```bash
curl -s https://api.checkvitals.xyz/v1/stats
```

```json
{
  "index": { "launches": 18099, "decoded": 3400, "read_from_curve_events": 1 },
  "exemptions": {
    "with_any": 232,
    "beyond_deployer": 1,
    "beyond_deployer_pct": 100,
    "median_count_beyond_deployer": null,
    "median_sample": 1
  },
  "declarations": 0,
  "as_of": "2026-09-12T10:41:07.000Z"
}
```

`median_count_beyond_deployer` is `null` below 30 observations. No median is
published on a sample too small to mean anything, here or anywhere else in this
product.

### `GET /v1/health`

```bash
curl -s https://api.checkvitals.xyz/v1/health
```

```json
{
  "ok": true,
  "head_block": 45830412,
  "indexed_to_block": 45830401,
  "lag_blocks": 11,
  "as_of": "2026-09-12T10:41:07.000Z"
}
```

`ok` goes false once `lag_blocks` exceeds 500, which is the same condition that
makes the launch endpoints return 503. `lag_blocks: null` means one end could
not be read, which is not the same as zero.

`/v1/health` and `/v1/stats` keep answering while the index lags. They are how
you find out that the rest will not.

### `GET /v1/openapi.json`

```bash
curl -s https://api.checkvitals.xyz/v1/openapi.json
```

OpenAPI 3.1, generated from the same constants the handlers branch on. The
check ids, the states, the batch ceiling and the rates in that document are the
identifiers in the code, not a copy of them. Served without a key.

---

## Auth and rate limits

Pass a key as `Authorization: Bearer KEY`, `X-API-Key: KEY`, or `?key=KEY`.

| tier | rate | how |
|---|---|---|
| keyless | 1 rps | no key. Enough to evaluate the contract, not enough to build on. |
| public | 5 rps | a public key |
| partner | 60 rps | a partner key |

- Token bucket per key, with a 2-second burst.
- An **unrecognised key is not an error**, it is served as keyless. A 401 in
  the way of an evaluation is worse than a low rate.
- `429` carries `Retry-After` in whole seconds, plus `X-RateLimit-Limit` and
  `X-RateLimit-Tier`.
- Answers are cached **30 seconds per token**. A burst of requests for one
  address costs one scan.
- CORS is open for GET. There is nothing here that is not public.

**Priority.** The API runs in the same process as the Telegram bot and shares
its rate limiter, deliberately: an API answer and a `/scan` answer then come
from one cache and one index and cannot disagree. API requests sit *below* the
bot in that limiter: they are served only when no interactive request is
waiting, and they stop short of a reserve so a fanned-out batch cannot empty the
bucket in the instant before somebody's card renders. In practice you will not
notice; under load, the person who typed a command wins.

---

## What this API will not do

- It will not tell you whether to buy something.
- It will not score, grade or rank a launch.
- It will not describe the absence of a finding as clean or safe.
- It will not report a number it did not read from the chain. There is no price
  oracle behind any of it, and every market figure this project publishes is
  denominated in the asset the token actually trades against.

If any response ever violates the two guarantees at the top of this document,
that is a bug. Report it and it will be fixed as one.
