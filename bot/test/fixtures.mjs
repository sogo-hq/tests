/** Minimal ScanResult shaped like the real thing, for renderer tests. */
const EARLY_WINDOW_SECONDS = 180;

export function makeScan(over = {}) {
  const flags = over.flags ?? [];
  const raised = flags.filter((f) => f.state === 'raised').length;
  const unknown = flags.filter((f) => f.state === 'unknown').length;
  const ageSeconds = over.ageSeconds ?? 1800;
  return {
    scanId: 1,
    launchBlock: 100,
    launchedAt: 1_700_000_000,
    ageSeconds,
    // derived exactly as production does, so a fixture cannot assert against an
    // age/mode pair the real code would never produce
    isEarly: ageSeconds < EARLY_WINDOW_SECONDS,
    earlyThresholdSeconds: over.earlyThresholdSeconds ?? EARLY_WINDOW_SECONDS,
    creation: {
      entryPoint: over.entryPoint ?? 'launchToken',
      launchBuyAmount: over.launchBuyAmount ?? null,
      launchBuyRecipient: over.launchBuyRecipient ?? null,
      snipeExemptionCount: 'snipeExemptionCount' in over ? over.snipeExemptionCount : 0,
    },
    currentBlock: 18_100,
    reads: {
      token: '0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67',
      curve: '0x0000000000000000000000000000000000000002',
      deployer: '0x0000000000000000000000000000000000000003',
      symbol: 'symbol' in over ? over.symbol : 'GHATS',
      name: 'name' in over ? over.name : 'Ghats',
      pairSymbol: over.pairSymbol ?? 'ETH',
      pairDecimals: over.pairDecimals ?? 18,
      pairToken: '0x0000000000000000000000000000000000000000',
      phaseName: 'NotGraduated',
      progressPct: over.progressPct ?? 0,
      mcapInQuote: 'mcapInQuote' in over ? over.mcapInQuote : 0,
      phaseName: over.phaseName ?? 'NotGraduated',
      graduationThreshold: over.graduationThreshold ?? 4_200000000000000000n,
      realQuoteReserve: over.realQuoteReserve ?? 0n,
      ...(over.reads ?? {}),
    },
    traction: {
      label: over.traction ?? 'none',
      // derived as production does: the window cannot exceed the token's age
      windowMinutes: over.windowMinutes ?? Math.min(30, ageSeconds / 60),
      windowTruncated: false,
      uniqueBuyers30m: over.buyers ?? 2,
      uniqueBuyers10m: 2,
      buyerGrowthRatio: 1,
      buyTxCount: 2,
      sellTxCount: 2,
      buySellRatio: 1,
      medianBuySize: over.medianBuySize ?? 0n,
      meanBuySize: 0n,
      progressAt10m: 0,
      progressAt30m: 0,
      peakProgressPct: 0,
      progressVelocityPer10m: 0,
      forwarderBuys: 0,
      roundTrippers: over.roundTrippers ?? 2,
      totalBuyVolume: 0n,
      totalSellVolume: 0n,
    },
    flags: {
      flags,
      raised,
      total: over.flagsTotal ?? 7,
      unknown,
      buyback: { enabled: false, detail: 'buyback not enabled' },
      worst: flags.filter((f) => f.state !== 'clean').sort((a, b) => b.severity - a.severity)[0] ?? null,
      snipeExemptionCount: 0,
      creatorTaxMedianBps: 90,
      deployerLaunches7d: 0,
      deployerMedianPeakMcap: null,
      deployerSurvival24h: null,
      nameCollision: false,
      // null unless a test supplies one: an unreadable concentration is the
      // default state, and the card must be correct in it.
      concentration: over.concentration ?? null,
    },
    benchmark: {
      bucket: over.benchmarkBucket ?? { key: 'to30m', fromSeconds: 300, toSeconds: 1800, label: '5-30m' },
      median: 'benchmarkMedian' in over ? over.benchmarkMedian : null,
      n: over.benchmarkN ?? 0,
      windowMinutes: over.windowMinutes ?? Math.min(30, ageSeconds / 60),
      // derived as production does: the window is the token's life until the
      // 30-minute cap, and only then can the card say "at this age"
      measuredAtAge: 'measuredAtAge' in over ? over.measuredAtAge : ageSeconds / 60 <= 30.001,
    },
    // Null unless a test supplies one: a first scan has no history to report,
    // and that is the state the card must be correct in.
    firstScan: over.firstScan ?? null,
  };
}

export const flag = (key, state, compactDetail, severity) => ({
  key, label: key, state, detail: compactDetail, compactDetail, severity,
});
