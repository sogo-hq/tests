# Launch configs on the pons v2 factory

Measured live on 2026-09-14 against `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
(chain 4663), with the reads in `scripts/` reproducible from `dist/`.

## What exists

`launchConfigCount()` returns **1**. `getLaunchConfig(0)`:

| field | value |
|---|---|
| `supply` | 1,000,000,000 (1e27 wei) |
| `curveFeeBps` | 100 |
| `phantomQuote` | 1.68 ETH |
| `graduationThreshold` | 4.2 ETH |
| `poolFee` | 0 |
| `tickSpacing` | 200 |
| `enabled` | true |

`getLaunchConfig(1)` and `getLaunchConfig(2)` revert. All 18,100 indexed
launches carry `launchConfigId = 0`.

`launchToken(params, 1, ETH)` simulated with `eth_call` **reverts**;
`launchToken(params, 0, ETH)` would succeed. There is no config that mints
anything but 1,000,000,000, and no launch path that accepts another id.

## ZZZ (`0x7dbf38976f6D3b9c529e7D9484A71898B409eE6a`)

`TokenLaunched` at block 54,672,454, tx
`0x2121ea2495afcd6898eb181a13e59efda25c636100d79e70afe5b784fae76029`, via the
forwarder's `launchAndBuy` (selector `0xf85f8e41`), `launchConfigId = 0`,
graduation threshold 4.2 ETH, pair ETH. Config 0 minted 1,000,000,000.

`totalSupply()` now reads **840,000,000** because the deployer
(`0x5F799f365Fa8A2B60ac0429C48B153cA5a6f0Cf8`) burned 160,000,000 after
launch, in three transfers to the zero address:

| block | amount | tx |
|---|---|---|
| 54,709,484 | 10,000,000 | `0xede3fde5…` |
| 54,709,752 | 100,000,000 | `0x320ed125…` |
| 54,761,978 | 50,000,000 | `0x5128770d…` |

Those are true burns: 1,000,000,000 minus 160,000,000 is exactly what
`totalSupply` returns. A further 10,000,000 went to `0x…dEaD` at block
54,696,170, which does not reduce `totalSupply`.

Where the deployer's balance came from: the `CurveBuy` inside the launch
transaction, 0.5 ETH in, **227,586,206.9 tokens out** to the deployer, 22.8%
of supply, before anyone else could buy. The burns removed 160M of that.

## For our own deploy

Every launch path (`launchToken` x2, `launchTokenFor`, the forwarder's
`launchAndBuy`) takes `launchConfigId`, and the only value that does not revert
is `0`. Our launch mints 1,000,000,000. A smaller circulating supply is only
reachable the way ZZZ did it: hold tokens after launch and burn them, which
this bot would report on the holder and deployer-activity lines as exactly
what it is.
