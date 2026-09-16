import { getAddress, isAddress } from 'viem';
import { printVerify } from './verify.js';
import { backfill, indexNew, decodePending, decodeBacklog, startDecodeLoop, startIndexLoop, retryUndeterminedOnce, MAX_DECODE_ATTEMPTS_LABEL } from './indexer/launches.js';
import { startRecovery } from './recovery.js';
import { scanToken } from './scan.js';
import { renderCardText, renderDefaultCard } from './card.js';
import { runDueRechecks, startRecheckLoop } from './recheck.js';
import { startWindowLoop, windowBacklog, indexWindows } from './indexer/windows.js';
import { deliverAlerts, deliverLaunch } from './bot.js';
import { initBot, startBot } from './bot.js';
import { startWatchdog } from './watchdog.js';
import { startApi } from './api/server.js';
import { db } from './db.js';
import { BACKFILL_DAYS, BLOCKS_PER_DAY } from './config.js';

/**
 * Medians over the measured set.
 *
 * Taken by ordering rather than by averaging: an exemption count is a small
 * integer with a long tail, and a mean of 1.4 describes no launch that exists.
 */
function medianExemptions(hasBeyond: boolean): { all: number | null; beyond: number | null } {
  const pick = (where: string): number | null => {
    const rows = db.prepare(
      `SELECT snipe_exemption_count AS c FROM launches
        WHERE exemption_source = 'logs' AND snipe_exemption_count IS NOT NULL ${where}
        ORDER BY c`,
    ).all() as { c: number }[];
    if (!rows.length) return null;
    return rows[Math.floor((rows.length - 1) / 2)]!.c;
  };
  return { all: pick(''), beyond: hasBeyond ? pick('AND snipe_exemption_count > 1') : null };
}

function bar(done: number, total: number, width = 28): string {
  const pct = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(pct * width);
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${(pct * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'verify': {
      const ok = await printVerify();
      process.exit(ok ? 0 : 1);
    }

    case 'backfill': {
      const days = rest[0] ? Number(rest[0]) : BACKFILL_DAYS;
      console.log(`Backfilling ${days} days of TokenLaunched (~${Math.round(days * BLOCKS_PER_DAY).toLocaleString()} blocks).`);
      console.log(
        rest.includes('--decode')
          ? 'Decoding every creation transaction inline (slow, rate-limited).\n'
          : 'Recording launches only. Creation-transaction decoding runs separately via `npm run decode`.\n',
      );
      const t0 = Date.now();
      let last = 0;
      const res = await backfill(days, {
        decode: rest.includes('--decode'),
        onProgress: (done, total, found) => {
          const now = Date.now();
          if (now - last < 2000) return;
          last = now;
          process.stdout.write(`\r  ${bar(Number(done), Number(total))}  ${found} launches`);
        },
      });
      process.stdout.write('\r' + ' '.repeat(74) + '\r');
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`Indexed ${res.launches} launches from block ${res.fromBlock} to ${res.toBlock} in ${secs}s.`);
      if (res.undecodable) {
        console.log(`${res.undecodable} launch transaction(s) could not be decoded; recorded as undetermined, never as clean.`);
      }
      if (res.pendingDecode) {
        console.log(
          `\n${res.pendingDecode.toLocaleString()} launches still need their creation transaction decoded for` +
          `\nsnipe-tax exemptions. Run:  npm run decode` +
          `\n\n/scan decodes on demand, so scans work correctly right now without it.`,
        );
      }
      break;
    }

    case 'decode': {
      // `decode retry` clears the attempt counters, for when a new entry point's
      // ABI has been added and the rows that were given up on are worth another
      // look. Nothing else resets them: a row is left alone precisely so it
      // stops costing requests.
      if (rest[0] === 'retry') {
        const n = db.prepare('UPDATE launches SET decode_attempts = 0 WHERE decode_attempts > 0').run().changes;
        console.log(`Reset ${n.toLocaleString()} attempt counters. Run \`decode\` to try them again.`);
        break;
      }
      const limit = rest[0] ? Number(rest[0]) : Infinity;
      const backlog = decodeBacklog();
      const pending = backlog.pending;
      if (!pending) {
        // Carefully worded. Rows that were given up on are NOT decoded, and
        // saying they were would turn "we stopped asking" into an answer.
        console.log(
          backlog.exhausted
            ? `Nothing left to attempt. ${backlog.exhausted.toLocaleString()} launches remain undetermined: ` +
              'their creation transactions use entry points this build has no ABI for. ' +
              'Add one and run `decode retry` to attempt them again.'
            : 'Every indexed launch already has its creation transaction decoded.',
        );
        break;
      }
      console.log(`Decoding creation transactions for ${Math.min(pending, Number(limit)).toLocaleString()} launches.`);
      console.log('One request per launch, paced to stay inside the node\'s rate limit. Resumable.\n');
      const t0 = Date.now();
      let last = 0;
      const res = await decodePending(limit, (done, total) => {
        const now = Date.now();
        if (now - last < 2000) return;
        last = now;
        const rate = done / ((now - t0) / 1000);
        const eta = rate > 0 ? (total - done) / rate : 0;
        process.stdout.write(`\r  ${bar(done, total)}  ${done}/${total}  ${rate.toFixed(1)}/s  eta ${Math.round(eta)}s   `);
      });
      process.stdout.write('\r' + ' '.repeat(78) + '\r');
      console.log(`Decoded ${res.decoded} launches in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
      if (res.failed) console.log(`${res.failed} could not be decoded, recorded as undetermined, never as clean.`);
      if (res.remaining) console.log(`${res.remaining.toLocaleString()} still pending.`);
      if (res.exhausted) {
        console.log(
          `${res.exhausted.toLocaleString()} left as undetermined after ${MAX_DECODE_ATTEMPTS_LABEL} attempts, ` +
          'not retried again, and never reported as clean.',
        );
      }
      break;
    }

    case 'index': {
      const res = await indexNew();
      console.log(`Indexed ${res.launches} new launches (${res.fromBlock} -> ${res.toBlock}).`);
      break;
    }

    case 'scan': {
      const addr = rest[0];
      if (!addr || !isAddress(addr)) {
        console.error('Usage: npm run scan -- <token address>');
        process.exit(1);
      }
      const t0 = Date.now();
      const result = await scanToken(getAddress(addr));
      if (!result) {
        console.error(`${addr} is not a pons v2 launch: the factory has no record of it.`);
        process.exit(1);
      }
      // Same split as the bot: the default card unless --full is asked for.
      const full = rest.includes('--full');
      console.log(full ? renderCardText(result) : renderDefaultCard(result, 'vitalscheck_bot'));
      console.log(`\n[scan ${Date.now() - t0}ms · stored as scan #${result.scanId} · rechecks queued at +1h/+6h/+24h/+7d]`);
      break;
    }

    case 'recheck': {
      if (rest[0] === '--loop') {
        console.log('Recheck worker running. Rechecks fire at +1h, +6h, +24h and +7d after each scan.');
        startRecheckLoop();
        return; // keep the process alive
      }
      const n = await runDueRechecks(Number(rest[0] ?? 50));
      console.log(n ? `Processed ${n} due recheck(s).` : 'No rechecks are due.');
      break;
    }

    case 'stats': {
      const q = (sql: string) => (db.prepare(sql).get() as any).n;
      const launches = q('SELECT COUNT(*) n FROM launches');
      const known = q('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count IS NOT NULL');
      console.log(`launches indexed      ${launches}`);
      console.log(`creation tx decoded   ${known}${launches ? ` (${((known / launches) * 100).toFixed(1)}%)` : ''}`);
      console.log(`with exemptions > 0   ${q('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count > 0')}`);
      console.log(`curve trades          ${q('SELECT COUNT(*) n FROM trades')}`);
      console.log(`scans recorded        ${q('SELECT COUNT(*) n FROM scans')}`);
      console.log(`rechecks done         ${q('SELECT COUNT(*) n FROM rechecks WHERE completed_at IS NOT NULL')}`);
      console.log(`rechecks pending      ${q('SELECT COUNT(*) n FROM rechecks WHERE completed_at IS NULL')}`);
      const { snipeTaxPolicy } = await import('./metrics/opening.js');
      const policy = await snipeTaxPolicy();
      console.log(
        policy
          ? `opening tax policy    ${(policy.startBps / 100).toFixed(0)}% for ${policy.seconds}s (live from the factory)`
          : 'opening tax policy    could not be read, undetermined',
      );
            const entry = db.prepare('SELECT entry_point, COUNT(*) n FROM launches GROUP BY entry_point ORDER BY n DESC').all() as any[];
      if (entry.length) {
        console.log('\nlaunch entry points:');
        for (const e of entry) console.log(`  ${String(e.entry_point).padEnd(16)} ${e.n}`);
      }
      const ev = db.prepare('SELECT source, COUNT(*) n, SUM(cache_hit) hits, AVG(duration_ms) ms FROM scan_events GROUP BY source ORDER BY n DESC').all() as any[];
      if (ev.length) {
        console.log('\nscan requests by source:');
        for (const e of ev) console.log(`  ${String(e.source).padEnd(8)} ${String(e.n).padStart(5)}  ${e.hits} cached  ${Math.round(e.ms)}ms mean`);
      }
      const oc = db.prepare('SELECT outcome, COUNT(*) n FROM scan_events GROUP BY outcome ORDER BY n DESC').all() as any[];
      if (oc.length) {
        console.log('\nscan outcomes:');
        for (const o of oc) console.log(`  ${String(o.outcome).padEnd(22)} ${o.n}`);
      }
      // Exemptions, counted only over rows read from the curve's own events.
      //
      // A count decoded from calldata omits the deployer, which the protocol
      // exempts automatically, so mixing the two would average two different
      // quantities. The pending figure is printed beside the answer rather than
      // left out, because a share computed over part of the index is only worth
      // as much as the reader knows the part to be.
      const ex = db.prepare(
        `SELECT COUNT(*) AS measured,
                SUM(CASE WHEN snipe_exemption_count > 1 THEN 1 ELSE 0 END) AS beyond
           FROM launches WHERE exemption_source = 'logs' AND snipe_exemption_count IS NOT NULL`,
      ).get() as { measured: number; beyond: number | null };
      const pendingEx = (db.prepare(
        "SELECT COUNT(*) AS n FROM launches WHERE exemption_source IS NULL OR exemption_source <> 'logs'",
      ).get() as any).n;

      console.log('\nsnipe-tax exemptions (from the curve\'s own events):');
      if (!ex.measured) {
        console.log('  none read from events yet; the re-read is still running');
      } else {
        const beyond = ex.beyond ?? 0;
        const pct = (beyond / ex.measured) * 100;
        console.log(`  launches measured            ${ex.measured.toLocaleString()}`);
        console.log(`  with wallets beyond the dev  ${beyond.toLocaleString()} (${pct.toFixed(1)}%)`);
        const med = medianExemptions(beyond > 0);
        console.log(`  median count, all launches   ${med.all ?? 'n/a'}`);
        console.log(`  median count where beyond>0  ${med.beyond ?? 'n/a'}`);
        console.log('  every launch exempts its deployer, so 1 is the floor, not a finding');
      }
      if (pendingEx) {
        console.log(`  ${pendingEx.toLocaleString()} launches not yet re-read from events, and excluded above`);
      }

      const hist = db.prepare(
        "SELECT snipe_exemption_count c, COUNT(*) n FROM launches WHERE exemption_source = 'logs' AND snipe_exemption_count IS NOT NULL GROUP BY c ORDER BY c",
      ).all() as any[];
      if (hist.length) {
        console.log('\nsnipe-tax exemption counts:');
        for (const h of hist) console.log(`  ${String(h.c).padStart(3)} exemptions  ${h.n}`);
      }
      break;
    }

    case 'bot': {
      // All background jobs run in this process on purpose: request priority is
      // per-process, so an interactive /scan only preempts bulk indexing when
      // they share one rate limiter.
      // Rebuild the index if the container came up without one. Returns
      // immediately; the bot answers scans throughout, and any check that
      // depends on the index reports undetermined until it can be trusted.
      // The bot is built and INITED first. Everything below reaches for its
      // identity the moment a launch lands, and starting the loops before it
      // existed is what produced "Bot information unavailable" from [launch]
      // and [alerts] in production: the first launches after every boot were
      // detected and then dropped.
      const bot = await initBot();
      // The read-only HTTP API, in this process on purpose: an API answer and a
      // /scan answer then come from one cache and one index and cannot
      // disagree, and API requests sit below the bot in the same rate limiter
      // rather than competing with it from outside. No PORT, no API.
      startApi();
      startRecovery();
      // Alerts ride the index loop rather than polling: it already sees every
      // launch within three seconds, and a second poller would compete for the
      // same rate limit to learn what this one already knows.
      startIndexLoop(3_000, async (tokens) => {
      // The launch post first: it is the only message here with a published
      // three second budget, and the alert pass yields to interactive work.
      await deliverLaunch(tokens);
      await deliverAlerts(tokens);
    });
      startRecheckLoop();
      // Started unconditionally. It used to start only when a backlog already
      // existed, which meant a container that came up with an empty database
      // had no decoder running when recovery's backfill then created eighteen
      // thousand undecoded rows -- so the snipe-exemption flag, the highest
      // value check here, would have stayed undetermined forever. The loop
      // no-ops when there is nothing pending.
      retryUndeterminedOnce();
      const pending = (db.prepare('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count IS NULL').get() as any).n;
      if (pending) {
        console.log(`[decode] ${pending.toLocaleString()} launches pending decode; draining in the background at low priority.`);
      }
      startDecodeLoop();
      // Fills the trade history three shipped features are computed over. Runs
      // at the same bulk priority as the decoder, and reads only the first
      // thirty minutes of each launch it picks -- the cap the buyer count
      // already uses.
      const backlog = windowBacklog();
      if (backlog.total) {
        console.log(
          `[windows] ${backlog.exempt.toLocaleString()} exempted-wallet launches and ` +
            `${backlog.total.toLocaleString()} total without an indexed opening window; ` +
            `reading them in the background at low priority.`,
        );
      }
      startWindowLoop();
      // The bot watching itself. Everything it says rests on the index being
      // current, and an index that falls behind answers in the same words
      // about a chain it read an hour ago.
      startWatchdog(bot.api);
      await startBot(bot);
      return;
    }

    default:
      console.log(`pons v2 launch scanner

  npm run verify              re-assert every chain fact this bot depends on
  npm run backfill [days]     index TokenLaunched, default ${BACKFILL_DAYS} days
  npm run decode [n]          decode creation txs for snipe-tax exemptions
  npm run index               index launches since the stored cursor
  npm run scan -- <address>   scan one token and print the card
  npm run recheck [n]         run due rechecks once ( --loop to stay running )
  node dist/index.js stats    index and scan statistics
  npm run bot                 start the Telegram bot and recheck worker
`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
