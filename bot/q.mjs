const Database = (await import('better-sqlite3')).default;
const db = new Database('/tmp/pop.db', { readonly: true });
const dec = db.prepare("SELECT COUNT(*) c FROM launches WHERE snipe_exemption_count IS NOT NULL").get().c;
const z = db.prepare("SELECT COUNT(*) c FROM launches WHERE snipe_exemption_count = 0").get().c;
const bbdec = db.prepare("SELECT COUNT(*) c FROM launches WHERE buyback_enabled IS NOT NULL").get().c;
const bb = db.prepare("SELECT COUNT(*) c FROM launches WHERE buyback_enabled = 1").get().c;
console.log(`exemption decoded   ${dec}`);
console.log(`  of those, zero    ${z}  (${(z/dec*100).toFixed(1)}%)`);
console.log(`buyback decoded     ${bbdec}`);
console.log(`  of those, on      ${bb}  (1 in ${Math.round(bbdec/bb)})`);
console.log('distribution of exemption counts (decoded):');
for (const r of db.prepare("SELECT snipe_exemption_count k, COUNT(*) c FROM launches WHERE snipe_exemption_count IS NOT NULL GROUP BY k ORDER BY c DESC LIMIT 6").all())
  console.log(`   ${String(r.k).padStart(4)} exemptions: ${r.c}`);
