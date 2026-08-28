import { getAddress, isAddress } from 'viem';
import { printVerify } from './verify.js';
import { backfill, indexNew, decodePending, startDecodeLoop, startIndexLoop } from './indexer/launches.js';
import { scanToken } from './scan.js';
import { renderCardText, renderDefaultCard } from './card.js';
import { runDueRechecks, startRecheckLoop } from './recheck.js';
import { startBot } from './bot.js';
import { db } from './db.js';
import { BACKFILL_DAYS, BLOCKS_PER_DAY } from './config.js';

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
      const limit = rest[0] ? Number(rest[0]) : Infinity;
      const pending = (db.prepare('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count IS NULL').get() as any).n;
      if (!pending) {
        console.log('Every indexed launch already has its creation transaction decoded.');
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
      if (res.failed) console.log(`${res.failed} could not be decoded — recorded as undetermined, never as clean.`);
      if (res.remaining) console.log(`${res.remaining} still pending.`);
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
        console.error(`${addr} is not a pons v2 launch — the factory has no record of it.`);
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
      const hist = db.prepare('SELECT snipe_exemption_count c, COUNT(*) n FROM launches WHERE snipe_exemption_count IS NOT NULL GROUP BY c ORDER BY c').all() as any[];
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
      startIndexLoop();
      startRecheckLoop();
      const pending = (db.prepare('SELECT COUNT(*) n FROM launches WHERE snipe_exemption_count IS NULL').get() as any).n;
      if (pending) {
        console.log(`[decode] ${pending.toLocaleString()} launches pending decode; draining in the background at low priority.`);
        startDecodeLoop();
      }
      await startBot();
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
