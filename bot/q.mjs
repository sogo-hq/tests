const Database = (await import('better-sqlite3')).default;
const db = new Database('/tmp/bull.db', { readonly: true });
const T='0x2ca41249485eb6f71981872461d0fca32058fd78';
const l = db.prepare("SELECT block_number, trades_indexed_to FROM launches WHERE token=?").get(T);
const span = db.prepare("SELECT MIN(block_number) lo, MAX(block_number) hi, COUNT(*) n FROM trades WHERE token=?").get(T);
console.log('launch block', l.block_number, 'indexed_to', l.trades_indexed_to);
console.log('trades span', span.lo, '->', span.hi, 'n=', span.n, ' window ends at', l.block_number+18000);
console.log('sells beyond window:', db.prepare("SELECT COUNT(*) c FROM trades WHERE token=? AND side='sell' AND block_number > ?").get(T, l.block_number+18000).c);
