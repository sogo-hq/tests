/**
 * launch.mjs --check
 *
 * Reads launch.config.json and says what is wrong with it. Never signs, never
 * sends, never reads a key, and does not care what time it is: the point is to
 * be able to ask the question on a Sunday and get the same answer as at 15:00
 * on a Thursday.
 *
 * Two things here touch the network, both read-only: the logo is fetched from
 * a public gateway, and the chain is asked what address the salt produces.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const MARK = {
  pass: () => green('ok  '),
  fail: () => red('FAIL'),
  warn: () => yellow('warn'),
  unknown: () => dim('??  '),
};

/** One request. The policy around it lives in launchcheck.ts, where it is tested. */
async function getOnce(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000), redirect: 'follow' });
  // The body is only read on a 200: there is no point buffering an error page.
  return {
    ok: res.ok,
    status: res.status,
    bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(),
  };
}

export async function runCheck({ configPath, as }) {
  const {
    checkConfig, imageInfo, checkImage, EXPECTED_DEPLOYER,
    gatewayUrls, fetchLogo, gatewayNote, gatewayHost,
  } = await import(join(ROOT, 'dist/launchcheck.js'));
  const { calibrate } = await import(join(ROOT, 'dist/curve.js'));
  const { client } = await import(join(ROOT, 'dist/chain.js'));
  const { factoryAbi, forwarderAbi } = await import(join(ROOT, 'dist/abi.js'));
  const { FACTORY, LAUNCH_FORWARDER } = await import(join(ROOT, 'dist/config.js'));

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`\n  ${red('cannot read the config')}  ${configPath}`);
    console.error(`  ${err.message}`);
    console.error(dim('  the real config is not in git. copy tools/launch.config.example.json'));
    console.error(dim('  to tools/launch.config.json and fill in every CHANGE ME.\n'));
    process.exit(1);
  }

  console.log(`\n${bold('  launch config check')}`);
  console.log(dim(`  ${configPath}`));
  console.log(dim(`  nothing is signed or sent by this mode, and the launch window is not checked`));

  // The curve config, so the dev buy is stated as a share of supply rather than
  // compared against a number someone typed into a table.
  let curve = null;
  let launchEnabled = null;
  let calLine = null;
  try {
    const [chainCfg, enabled] = await Promise.all([
      client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getLaunchConfig', args: [BigInt(raw.launchConfigId ?? 0)] }),
      client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'launchEnabled' }),
    ]);
    launchEnabled = enabled;
    curve = { supply: chainCfg.supply, phantomQuote: chainCfg.phantomQuote, curveFeeBps: chainCfg.curveFeeBps };
    // The curve is only allowed to size the dev buy if it still reproduces the
    // launch it was calibrated against.
    const cal = calibrate(curve);
    calLine = cal.line;
    if (!cal.ok) curve = null;
  } catch (err) {
    console.log(dim(`\n  the factory could not be read: ${String(err.shortMessage ?? err.message).split('\n')[0]}`));
  }

  if (calLine) console.log(dim(`  ${calLine}`));

  const rows = checkConfig(raw, curve);

  // --------------------------------------------------------- the ticker
  // The same query the card runs, asked now rather than at T+15. Read-only,
  // and it reads the index rather than the chain: if the index is not there,
  // that is what it says. A collision is never a reason to refuse the config,
  // so this row cannot fail it.
  try {
    const { collisionCheckRow } = await import(join(ROOT, 'dist/collision.js'));
    const { indexCoverage, coverageReason } = await import(join(ROOT, 'dist/coverage.js'));
    const cov = indexCoverage();
    const { field, value, verdict, note } = collisionCheckRow(raw.name ?? '', raw.symbol ?? '', cov, coverageReason(cov));
    rows.push({ field, value, verdict, note });
  } catch (err) {
    rows.push({
      field: 'ticker collision', value: 'undetermined', verdict: 'unknown',
      note: `the index could not be read: ${String(err.message).split('\n')[0]}`,
    });
  }

  // ------------------------------------------------------------- the image
  const candidates = gatewayUrls(raw.logo);
  if (!candidates.length) {
    rows.push({ field: 'logo image', value: '(no reference)', verdict: 'fail', note: 'nothing to fetch' });
  } else {
    if (candidates.length > 1) {
      console.log(dim(`\n  fetching the logo, ${candidates.length} gateways in order, one retry each`));
    }
    const got = await fetchLogo(raw.logo, getOnce);
    for (const a of got.attempts) {
      if (!a.ok) console.log(dim(`  ${gatewayHost(a.url)} ${a.reason}${a.retried ? ' on the retry' : ''}`));
    }
    if (got.ok) {
      const v = checkImage(imageInfo(got.bytes));
      rows.push({
        field: 'logo image', value: got.url, verdict: v.verdict,
        note: `${v.note}, ${gatewayNote(got)}`,
      });
    } else {
      // Every gateway refused. That is a fact about the gateways as much as
      // about the image, so it is undetermined rather than a failed logo,
      // unless one of them gave a straight answer that the cid is not there.
      const found404 = got.attempts.some((a) => a.status === 404 || a.status === 410);
      rows.push({
        field: 'logo image', value: candidates[0], verdict: found404 ? 'fail' : 'unknown',
        note: gatewayNote(got),
      });
    }
  }

  // ------------------------------------------------------------- the output
  const width = Math.max(...rows.map((r) => r.field.length));
  console.log('');
  for (const r of rows) {
    const value = r.value.length > 46 ? `${r.value.slice(0, 43)}...` : r.value;
    const line = `  ${MARK[r.verdict]()}  ${r.field.padEnd(width)}  ${value}`;
    console.log(r.verdict === 'fail' ? line : line);
    // A note may run to more than one line. Continuations line up under the
    // first so the column the eye is following does not move.
    if (r.note) for (const l of r.note.split('\n')) console.log(dim(`        ${' '.repeat(width)}  ${l}`));
  }

  // --------------------------------------------------- the address the salt makes
  console.log(`\n${bold('  the address this config produces')}`);
  const deployer = (() => {
    try { return getAddress(as ?? EXPECTED_DEPLOYER); } catch { return null; }
  })();
  if (!deployer) {
    console.log(`  ${red('the deployer address is not an address')}`);
  } else {
    console.log(dim(`  deployer ${deployer}${as ? '  (--as)' : '  (the configured deployer)'}`));
    try {
      const exemptions = [deployer, ...(raw.extraExemptions ?? []).map(getAddress)]
        .filter((a, i, all) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);
      const params = {
        name: raw.name, symbol: raw.symbol, logo: raw.logo, description: raw.description,
        socials: raw.socials,
        creatorFeeRecipient: getAddress(raw.creatorFeeRecipient),
        creatorTaxBps: raw.creatorTaxBps,
        buybackEnabled: raw.buybackEnabled,
        expectedEconomics: raw.expectedEconomics,
        salt: raw.salt,
      };
      const [whole, frac = ''] = String(raw.devBuyEth).split('.');
      const devBuyWei = BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
      const launchFee = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'launchFee' });
      const call = {
        address: LAUNCH_FORWARDER, abi: forwarderAbi, functionName: 'launchAndBuy',
        args: [params, BigInt(raw.launchConfigId), getAddress(raw.pairToken), devBuyWei,
               BigInt(raw.minTokensOut), getAddress(raw.recipient), exemptions],
        account: deployer, value: launchFee + devBuyWei,
      };
      let sim;
      let funded = false;
      try {
        sim = await client.simulateContract(call);
      } catch (err) {
        // An empty wallet is not a fact about the config. Ask again with the
        // balance overridden, which is still a read: nothing is signed, and the
        // chain's own state does not move.
        if (!/exceeds the balance/i.test(String(err.shortMessage ?? err.message))) throw err;
        sim = await client.simulateContract({
          ...call,
          stateOverride: [{ address: deployer, balance: launchFee + devBuyWei + 10n ** 18n }],
        });
        funded = true;
      }
      if (funded) console.log(dim('  simulated with the deployer balance overridden: it does not hold the dev buy yet'));
      console.log(`  token (CA)   ${bold(sim.result[0])}`);
      console.log(`  curve        ${sim.result[1]}`);
      console.log(dim('  the salt fixes this address. change the salt and it changes.'));
    } catch (err) {
      const msg = String(err.shortMessage ?? err.message).split('\n').filter(Boolean)[0];
      console.log(`  ${yellow('undetermined')}  ${dim(msg)}`);
      if (launchEnabled === false) console.log(dim('  launchEnabled is false on the factory right now, which is enough on its own'));
      console.log(dim('  the address is only knowable from a simulation the chain accepts'));
    }
  }

  // ------------------------------------------------------------------ socials
  console.log(`\n${bold('  socials')}`);
  console.log('  the pons create path does carry them: the launch params tuple has a socials');
  console.log('  struct (twitter, telegram, discord, website, farcaster) and 28 of the last 30');
  console.log('  launches on this chain filled at least one. what is above goes on chain.');

  const fails = rows.filter((r) => r.verdict === 'fail');
  const warns = rows.filter((r) => r.verdict === 'warn');
  const unknowns = rows.filter((r) => r.verdict === 'unknown');
  console.log('');
  console.log(`  ${rows.length} fields checked, ${fails.length} failing, ${warns.length} to look at, ${unknowns.length} undetermined`);
  if (fails.length) console.log(`  ${red('this config is not ready to send')}`);
  else if (unknowns.length) console.log(`  ${dim('no failures, and something could not be determined. read it before sending.')}`);
  else console.log(dim('  no field failed. --dry is what tells you the chain accepts it.'));
  console.log('');
  return fails.length === 0;
}
