#!/usr/bin/env node
/**
 * What is behind "entry points this build has no ABI for".
 *
 * Read-only. It fetches launch transactions the decoder gave up on, groups
 * them by the first four bytes of their input, and says what each group is:
 * a call to a contract with a selector we do not know, or a contract creation,
 * which has no ABI to add because the input is constructor bytecode.
 *
 *   node tools/undecodable.mjs [--limit 400] [--all]
 *
 * --all looks at every undecoded row rather than only the exhausted ones,
 * which is what to use on a database whose decode run has not finished.
 * Nothing is written, nothing is signed, nothing is sent.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { client } = await import(join(ROOT, 'dist/chain.js'));
const { db } = await import(join(ROOT, 'dist/db.js'));
const { bulk } = await import(join(ROOT, 'dist/ratelimit.js'));
const { decodeLaunchCalldata } = await import(join(ROOT, 'dist/indexer/exemptions.js'));

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', '400')) || 400;
const ALL = argv.includes('--all');
const MAX_ATTEMPTS = Number(process.env.MAX_DECODE_ATTEMPTS || 2) || 2;

const where = ALL
  ? 'snipe_exemption_count IS NULL'
  : `snipe_exemption_count IS NULL AND decode_attempts >= ${MAX_ATTEMPTS}`;
const rows = db.prepare(
  `SELECT token, tx_hash FROM launches WHERE ${where} AND tx_hash IS NOT NULL
   ORDER BY launched_at DESC LIMIT ?`,
).all(LIMIT);

const total = db.prepare(`SELECT COUNT(*) n FROM launches WHERE ${where}`).get().n;
console.log(`\n  ${total.toLocaleString()} launches ${ALL ? 'undecoded' : 'out of attempts'}, reading ${rows.length.toLocaleString()} of them\n`);

const groups = new Map();
let read = 0;
let failed = 0;
for (const r of rows) {
  let tx;
  try {
    tx = await bulk(() => client.getTransaction({ hash: r.tx_hash }));
  } catch (err) {
    failed++;
    continue;
  }
  read++;
  const input = String(tx.input ?? '0x');
  const creation = tx.to === null || tx.to === undefined;
  // For a creation the first bytes are constructor bytecode, not a selector,
  // so it is grouped as one kind rather than as a fake selector each.
  const key = creation ? 'contract creation' : input.slice(0, 10);
  const g = groups.get(key) ?? {
    key, count: 0, creation, to: new Set(), sample: r.tx_hash,
    // The question that matters: does the ABI this build carries decode it?
    // Asked of the input directly rather than inferred from the selector.
    decodes: creation ? false : decodeLaunchCalldata(input, tx.from).exemptionCount !== null,
  };
  g.count++;
  if (!creation && tx.to) g.to.add(String(tx.to).toLowerCase());
  groups.set(key, g);
  if (read % 50 === 0) process.stdout.write(`\r  read ${read}/${rows.length}   `);
}
process.stdout.write('\r' + ' '.repeat(40) + '\r');

const { FACTORY, LAUNCH_FORWARDER } = await import(join(ROOT, 'dist/config.js'));
const known = { [FACTORY.toLowerCase()]: 'the pons factory', [LAUNCH_FORWARDER.toLowerCase()]: 'the pons forwarder' };

const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
console.log('  selector      count   share   decodes  sent to');
console.log('  ' + '-'.repeat(78));
for (const g of sorted) {
  const share = `${((g.count / Math.max(1, read)) * 100).toFixed(1)}%`;
  const to = g.creation
    ? 'nothing, it deploys a contract'
    : [...g.to].map((a) => known[a] ?? a).join(', ').slice(0, 40);
  console.log(`  ${g.key.padEnd(20)} ${String(g.count).padStart(5)}  ${share.padStart(6)}   ${(g.decodes ? 'yes' : 'no').padEnd(7)}  ${to}`);
}
const undecodable = sorted.filter((g) => !g.decodes);
console.log('');
console.log(`  ${undecodable.reduce((a, g) => a + g.count, 0)} of ${read} do not decode with the ABI this build carries`);
console.log('');
console.log(`  read ${read}, unreadable ${failed}, distinct kinds ${sorted.length}`);
console.log('');
for (const g of sorted) console.log(`  ${g.key}  sample tx ${g.sample}`);
console.log('');
