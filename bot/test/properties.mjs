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
import { renderCard, renderCardText, renderDefaultCard } from '../dist/card.js';
import { DISCLAIMER } from '../dist/config.js';

const BANNED = /price target|will pump|safe to buy|good entry|buy now|sell now|to the moon|\bmoon\b|recommend (buy|sell)|should buy|should sell|guaranteed/i;
const tokens = JSON.parse(readFileSync('/tmp/picks.json', 'utf8'));
let checked = 0, failures = 0;

for (const t of tokens) {
  const r = await scanToken(t);
  if (!r) { console.log(`  skip ${t} (not resolvable)`); continue; }
  const full = renderCard(r), fullText = renderCardText(r);
  const comp = renderDefaultCard(r, 'vitalscheck_bot'), compText = comp;
  const sym = (r.reads.symbol || '?').slice(0, 10);
  const problems = [];

  if (!fullText.trim().endsWith(DISCLAIMER)) problems.push('full card missing disclaimer');
  if (!compText.trim().endsWith('not financial advice')) problems.push('default card missing disclaimer');
  if (BANNED.test(fullText)) problems.push('banned language in full card');
  if (BANNED.test(compText)) problems.push('banned language in compact card');

  const cl = compText.split('\n');
  // 13 is the maximum the renderer can produce: header, blank, three flags, the
  // "+N more" line, blank, the benchmarked buyer count, concentration, what
  // happened to those buyers, growth, blank, footer. It grew by one when
  // concentration was added; anything past that is a regression in a card whose
  // whole point is being readable when forwarded into a group.
  if (cl.length > 13) problems.push(`default card ${cl.length} lines`);
  if (cl.filter((l) => l.startsWith('🚩')).length > 3) problems.push('more than 3 flag lines');
  if (!/^VITALS /.test(cl[0])) problems.push('default card header malformed');
  if (/<[a-z/]/i.test(comp)) problems.push('markup in the default card');
  if (/\b(clean|safe)\b|looks good/i.test(comp)) problems.push('all-clear language in the default card');

  // the compact card must never claim fewer raised flags than the full card
  const fullRaised = r.flags.raised;
  const shown = cl.filter((l) => l.startsWith('🚩')).length;
  const more = compText.match(/\+(\d+) more/);
  const accounted = shown + (more ? Number(more[1]) : 0);
  if (fullRaised > 0 && accounted !== fullRaised) problems.push(`default card accounts for ${accounted} raised flags, full card has ${fullRaised}`);
  if (fullRaised === 0 && !/no concerns raised/.test(compText)) problems.push('no-flags card missing its summary line');

  // undetermined must never be rendered as a finding
  for (const fl of r.flags.flags) {
    if (fl.state === 'unknown' && compText.includes(`🚩 ${fl.plain}`)) {
      problems.push(`undetermined flag "${fl.key}" rendered as a finding`);
    }
  }
  // unbalanced HTML would make Telegram reject the message
  for (const [name, html] of [['full', full]]) {
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
