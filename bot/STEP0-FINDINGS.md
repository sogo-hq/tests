# Step 0 — Data access verification (pons v2 / Robinhood Chain 4663)

All results below are from the two hardcoded hosts only:
`https://rpc.mainnet.chain.robinhood.com` and `https://robinhoodchain.blockscout.com`.

## a) REST v2 /api/v2/stats — LIVE (200, 4.66s)
Returns coin price, gas, totals. `average_block_time: 101.0` is **milliseconds**, not seconds.

## b) eth_chainId — PASS
`0x1237` = 4663. Matches.

## c) eth_getLogs TokenLaunched, last 1000 blocks — 16 launches (69ms)
topic0 `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607`

## d) getLaunchedToken — PASS (returns the full 15-field struct)

---

## CORRECTION 1 — the factory address in the spec is wrong (1 character)

    spec:  0x7eD598BcEf0bd9Edd8C97A195C6d13f40801EC7e   <- no code, nonce 0, never used
    chain: 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e   <- 24,177 bytes, verified
                          ^ position 12: 0 -> 8

Verified three independent ways:
1. `V2BuybackVault.factory()` (verified contract at the spec's own vault address) returns the 8-variant.
2. The `...8bd9...` address is baked as an immutable into every per-launch curve's bytecode.
3. Only the 8-variant has code; the spec's address has nonce 0 and zero balance.

## CORRECTION 2 — meme hook address contains a letter O, not a zero

    spec:  0xE5e702641Ea86F4ae6cC3cDaeD2B886f976BeO44   <- not valid hex
    chain: 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044   <- confirmed by factory.memeHook()

The other three addresses (fee escrow, buyback vault, launch locker) match the factory's own
getters exactly. Locker verified as `V2LaunchLocker`.

---

## GAP — a fourth launch entry point the spec does not mention

The spec names the `launchToken(..., address[])` overload as the source of the snipe-tax
exemption flag. There are in fact **four** entry points, and the spec's is not the common one:

| selector     | entry point                                    | share of sample |
|--------------|------------------------------------------------|-----------------|
| `0xf85f8e41` | `launchForwarder.launchAndBuy(..., address[])` | **71%**         |
| `0xa72101af` | `factory.launchToken(..., address[])`          | 16%             |
| `0xf35abbcf` | `factory.launchToken(...)` (no array)          | 13%             |
| `0xd6a0eef5` | `factory.launchTokenFor(..., address[])`       | seen in ABI     |

`launchAndBuy` (forwarder `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`, confirmed by
`factory.launchForwarder()`) launches **and buys in the same transaction**, and carries its
own `address[]` of exemptions. Decoding only the spec's overload would report a false
"0 exemptions — clean" for 71% of launches, on the flag the spec calls highest-value.

Measured over 120 launches spanning ~11h: 104 clean, and 16 with exemptions clustered at
**1, 3, 7, 13** — deliberate bundle sizes, never noise. Every single one came in via
`launchAndBuy`. One recipient appeared three times with n=3 and near-identical buy amounts.

---

## Confirmed by keccak match, not assumed

    CurveBuy(address,address,uint256,uint256,uint256,uint256)   2 indexed
    CurveSell(address,address,uint256,uint256,uint256,uint256)  2 indexed
    CurveBuyRefunded(address,uint256)
    CurveCompleted(address,uint256,uint256)

Live decode confirms the 6th param is `creatorTax`, reported separately from `fee`, exactly
as the spec states. All 13 spec-claimed curve reads are present in the dispatch table.

## The phantom reserve is real and large

On a freshly launched token with **zero** buys:

    getReserves().quoteReserve = 10655602752807139311   -> would read as ~40% progress
    realQuoteReserve()         = 0                      -> correct: 0%

Using `quoteReserve` would show 40% traction on a token nobody has bought.

---

## Chosen data path: raw eth_getLogs, always address-scoped

| path                              | same job          | result |
|-----------------------------------|-------------------|--------|
| raw getLogs, address-scoped       | 1M blocks         | 832ms — **fastest, complete** |
| etherscan-compat `logs&getLogs`   | one curve, 100k   | 875ms — complete, good fallback |
| REST v2 `/addresses/{a}/logs`     | one curve         | 6969ms — 8x slower, paginated, decoded only 3 of 4 |

Hard constraint found: **topic-only queries with no address filter time out above ~20k
blocks** (`log query timed out`). Address-scoped queries accept ~3.9M-block spans. So:
- factory events -> scoped to the factory, chunked at 500k blocks (7d = 6,048,000 blocks = 13 calls)
- curve trades   -> multi-address batches of curves, <=20k blocks per call

Etherscan-compat is retained for one job only: fetching verified ABIs (0.5-0.9s, reliable).
REST v2 is not used on any hot path.

## Chain facts that drive the design
- block time **0.1s** (measured across 10,000 blocks) -> 30 min = 18,000 blocks; 7 days = 6,048,000
- launch rate ~3,400/day; ~1,245 launches per 11h observed
- `snipeTaxSeconds` = 3, `snipeTaxStartBps` = 9900 (99% decaying over 3s)
- `maxCreatorTaxBps` = 1000, `launchFee` = 0.0005 ETH, `launchConfigCount` = 1
- ticker collisions in the wild are **homoglyphs** (`b`, `B`, `Ⴆ`, `Ხ`, `𝔟`, `𝓫`, `b̶̶`),
  so the collision flag must normalise, not string-compare.
