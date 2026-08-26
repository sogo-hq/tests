/**
 * Property check: renders both cards for a set of real, varied tokens and
 * asserts the invariants that must hold for every token -- disclaimers present,
 * no prediction or trade language, compact card never rosier than the full one,
 * undetermined never shown as a finding, HTML balanced.
 * Needs network. Run: node test/properties.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { scanToken } from '../dist/scan.js';
import { renderCard, renderCardText, renderCompactCard, renderCompactText, COMPACT_DISCLAIMER } from '../dist/card.js';
import { DISCLAIMER } from '../dist/config.js';

const BANNED = /price target|will pump|safe to buy|good entry|buy now|sell now|to the moon|\bmoon\b|recommend (buy|sell)|should buy|should sell|guaranteed/i;
const tokens = JSON.parse(readFileSync('/tmp/picks.json', 'utf8'));
let checked = 0, failures = 0;

for (const t of tokens) {
  const r = await scanToken(t);
  if (!r) { console.log(`  skip ${t} (not resolvable)`); continue; }
  const full = renderCard(r), fullText = renderCardText(r);
  const comp = renderCompactCard(r, 'vitalscheck_bot'), compText = renderCompactText(r, 'vitalscheck_bot');
  const sym = (r.reads.symbol || '?').slice(0, 10);
  const problems = [];

  if (!fullText.trim().endsWith(DISCLAIMER)) problems.push('full card missing disclaimer');
  if (!compText.trim().endsWith(COMPACT_DISCLAIMER)) problems.push('compact card missing disclaimer');
  if (BANNED.test(fullText)) problems.push('banned language in full card');
  if (BANNED.test(compText)) problems.push('banned language in compact card');

  const cl = compText.split('\n');
  if (cl.length > 8) problems.push(`compact card ${cl.length} lines`);
  if (cl.filter((l) => l.startsWith('🚩')).length > 2) problems.push('more than 2 flag lines');
  if (!compText.includes('traction ')) problems.push('compact missing traction');
  if (!compText.includes('round-trippers')) problems.push('compact missing round-trippers');

  // the compact card must never claim fewer raised flags than the full card
  const fullRaised = r.flags.raised;
  const m = compText.match(/flags (\d+) of (\d+)/);
  if (!m || Number(m[1]) !== fullRaised) problems.push(`compact flag count ${m && m[1]} != full ${fullRaised}`);

  // undetermined must never be rendered as a finding
  for (const fl of r.flags.flags) {
    if (fl.state === 'unknown' && compText.includes(`🚩 ${fl.compactDetail}`)) {
      problems.push(`undetermined flag "${fl.key}" rendered as a finding`);
    }
  }
  // unbalanced HTML would make Telegram reject the message
  for (const [name, html] of [['full', full], ['compact', comp]]) {
    for (const tag of ['b', 'i', 'code', 'a']) {
      const open = (html.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'g')) || []).length;
      const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      if (open !== close) problems.push(`${name} card unbalanced <${tag}>: ${open} open / ${close} close`);
    }
  }

  checked++;
  if (problems.length) { failures++; console.log(`  FAIL ${sym.padEnd(10)} ${t}\n        - ${problems.join('\n        - ')}`); }
  else console.log(`  ok   ${sym.padEnd(10)} full ${fullText.split('\n').length}L / compact ${cl.length}L / flags ${fullRaised}+${r.flags.unknown}? / traction ${r.traction.label}`);
}
console.log(`\n${checked} tokens checked, ${failures} with problems.`);
process.exit(failures ? 1 : 0);
