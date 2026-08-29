import { indexWindows } from './dist/indexer/windows.js';
import { concentrationCoverage, concentrationCoverageLine } from './dist/metrics/concentration.js';
import { benchmarkCoverageLine } from './dist/metrics/benchmark.js';
const t0 = Date.now();
for (let i = 1; i <= 60; i++) {
  const p = await indexWindows(25);
  if (!p.attempted) { console.log(`pass ${i}: selection stopped on its own`); break; }
  if (i % 4 === 0) console.log(`pass ${i} (${((Date.now()-t0)/1000).toFixed(0)}s): trades=${p.trades} obs=${concentrationCoverage()}`);
  if (Date.now() - t0 > 260_000) { console.log('time budget'); break; }
}
console.log(benchmarkCoverageLine());
console.log(concentrationCoverageLine());
