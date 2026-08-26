/** Minimal ScanResult shaped like the real thing, for renderer tests. */
export function makeScan(over = {}) {
  const flags = over.flags ?? [];
  const raised = flags.filter((f) => f.state === 'raised').length;
  const unknown = flags.filter((f) => f.state === 'unknown').length;
  return {
    scanId: 1,
    launchBlock: 100,
    launchedAt: 1_700_000_000,
    ageSeconds: over.ageSeconds ?? 1800,
    currentBlock: 18_100,
    reads: {
      token: '0x147Bbaa458Ab7Cd11E1E478B87f08FE5A42A9E67',
      curve: '0x0000000000000000000000000000000000000002',
      deployer: '0x0000000000000000000000000000000000000003',
      symbol: 'symbol' in over ? over.symbol : 'GHATS',
      name: 'name' in over ? over.name : 'Ghats',
      pairSymbol: 'ETH',
      pairToken: '0x0000000000000000000000000000000000000000',
      phaseName: 'NotGraduated',
      progressPct: over.progressPct ?? 0,
      ...(over.reads ?? {}),
    },
    traction: {
      label: over.traction ?? 'none',
      windowMinutes: over.windowMinutes ?? 30,
      windowTruncated: false,
      uniqueBuyers30m: over.buyers ?? 2,
      uniqueBuyers10m: 2,
      buyerGrowthRatio: 1,
      buyTxCount: 2,
      sellTxCount: 2,
      buySellRatio: 1,
      medianBuySize: 0n,
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
    },
  };
}

export const flag = (key, state, compactDetail, severity) => ({
  key, label: key, state, detail: compactDetail, compactDetail, severity,
});
