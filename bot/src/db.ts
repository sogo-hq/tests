import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- ---------------------------------------------------------------------------
-- Indexed launches (from factory TokenLaunched + creation-transaction decode)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS launches (
  token                  TEXT PRIMARY KEY,
  curve                  TEXT NOT NULL,
  deployer               TEXT NOT NULL,
  pair_token             TEXT NOT NULL,
  launch_config_id       INTEGER NOT NULL,
  graduation_threshold   TEXT NOT NULL,
  block_number           INTEGER NOT NULL,
  tx_hash                TEXT NOT NULL,
  launched_at            INTEGER NOT NULL,
  name                   TEXT,
  symbol                 TEXT,
  name_key               TEXT,
  symbol_key             TEXT,
  -- the highest-value flag: how many wallets were pre-exempted from the
  -- opening snipe tax at creation. NULL means the creation tx could not be
  -- decoded -- which is NOT the same as 0, and is never reported as clean.
  snipe_exemption_count  INTEGER,
  snipe_exemptions       TEXT,
  entry_point            TEXT,
  creator_tax_bps        INTEGER,
  buyback_enabled        INTEGER,
  -- launchAndBuy only: the creator's own opening buy, same transaction
  launch_buy_amount      TEXT,
  launch_buy_recipient   TEXT,
  phase                  INTEGER DEFAULT 0,
  graduated_at           INTEGER,
  swept_at               INTEGER
);
CREATE INDEX IF NOT EXISTS idx_launches_deployer ON launches(deployer);
CREATE INDEX IF NOT EXISTS idx_launches_time     ON launches(launched_at);
CREATE INDEX IF NOT EXISTS idx_launches_curve    ON launches(curve);
CREATE INDEX IF NOT EXISTS idx_launches_symkey   ON launches(symbol_key);
CREATE INDEX IF NOT EXISTS idx_launches_namekey  ON launches(name_key);
CREATE INDEX IF NOT EXISTS idx_launches_tax      ON launches(creator_tax_bps);

-- ---------------------------------------------------------------------------
-- Curve trades (CurveBuy / CurveSell)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  token        TEXT NOT NULL,
  curve        TEXT NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('buy','sell')),
  trader       TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  quote_amount TEXT NOT NULL,
  token_amount TEXT NOT NULL,
  fee          TEXT NOT NULL,
  creator_tax  TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_time   INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token, block_number);
CREATE INDEX IF NOT EXISTS idx_trades_curve ON trades(curve, block_number);

-- ---------------------------------------------------------------------------
-- Scans. Every /scan writes one row. This pairing of early signal to later
-- outcome (via rechecks) is the entire product.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scans (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  token                     TEXT NOT NULL,
  curve                     TEXT NOT NULL,
  deployer                  TEXT NOT NULL,
  symbol                    TEXT,
  name                      TEXT,
  scanned_at                INTEGER NOT NULL,
  scanned_block             INTEGER NOT NULL,
  launched_at               INTEGER,
  age_seconds               INTEGER,
  requested_by              INTEGER,

  -- traction
  unique_buyers_30m         INTEGER,
  unique_buyers_10m         INTEGER,
  buyer_growth_ratio        REAL,
  buy_tx_count              INTEGER,
  sell_tx_count             INTEGER,
  buy_sell_ratio            REAL,
  median_buy_size           TEXT,
  progress_pct              REAL,
  progress_velocity_per_10m REAL,
  traction                  TEXT,

  -- flags
  snipe_exemption_count     INTEGER,
  creator_tax_bps           INTEGER,
  creator_tax_median_bps    INTEGER,
  deployer_launches_7d      INTEGER,
  deployer_median_peak_mcap TEXT,
  deployer_survival_24h     REAL,
  name_collision            INTEGER,
  buyback_enabled           INTEGER,
  custom_pair               INTEGER,
  flags_raised              INTEGER,
  flags_total               INTEGER,

  -- state at scan time
  mcap_at_scan              TEXT,
  unique_buyers_at_scan     INTEGER,
  pair_token                TEXT,
  phase                     INTEGER,
  real_quote_reserve        TEXT,
  graduation_threshold      TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_token ON scans(token);
CREATE INDEX IF NOT EXISTS idx_scans_time  ON scans(scanned_at);

-- ---------------------------------------------------------------------------
-- Outcome rechecks at +1h, +6h, +24h, +7d
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rechecks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id        INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  token          TEXT NOT NULL,
  offset_hours   INTEGER NOT NULL,
  due_at         INTEGER NOT NULL,
  completed_at   INTEGER,
  still_trading  INTEGER,
  peak_mcap      TEXT,
  current_mcap   TEXT,
  graduated      INTEGER,
  holder_count   INTEGER,
  progress_pct   REAL,
  trades_since   INTEGER,
  error          TEXT,
  UNIQUE (scan_id, offset_hours)
);
CREATE INDEX IF NOT EXISTS idx_rechecks_due ON rechecks(completed_at, due_at);

-- Running peak market cap per token, updated by every recheck.
CREATE TABLE IF NOT EXISTS token_peaks (
  token     TEXT PRIMARY KEY,
  peak_mcap TEXT NOT NULL,
  peak_at   INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Usage telemetry: one row per user-facing scan request, including cache hits
-- and rejections. Deliberately separate from the scans table, which holds one
-- row per distinct observation and must not be padded with duplicates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('dm','group','inline','cli')),
  chat_id      INTEGER,
  user_id      INTEGER,
  token        TEXT,
  cache_hit    INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL,
  outcome      TEXT NOT NULL,
  scan_id      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON scan_events(ts);
CREATE INDEX IF NOT EXISTS idx_events_source ON scan_events(source, ts);
CREATE INDEX IF NOT EXISTS idx_events_user   ON scan_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_token  ON scan_events(token);

-- Indexer cursors, so restarts resume rather than re-scan.
CREATE TABLE IF NOT EXISTS cursors (
  name         TEXT PRIMARY KEY,
  block_number INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
`);

export function getCursor(name: string): bigint | null {
  const row = db.prepare('SELECT block_number FROM cursors WHERE name = ?').get(name) as
    | { block_number: number }
    | undefined;
  return row ? BigInt(row.block_number) : null;
}

export function setCursor(name: string, block: bigint): void {
  db.prepare(
    `INSERT INTO cursors (name, block_number, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET block_number = excluded.block_number, updated_at = excluded.updated_at`,
  ).run(name, Number(block), Math.floor(Date.now() / 1000));
}

/**
 * Normalise a name or ticker for collision detection.
 *
 * Real collisions on this chain are homoglyphs, not exact duplicates -- the live
 * data is full of b / B / Ⴆ / Ხ / 𝔟 / 𝓫 / b̶̶ all competing as "b". A plain
 * string compare finds none of them, so: NFKD-fold (which flattens mathematical
 * alphanumerics), strip combining marks (the strikethrough variants), lowercase,
 * map confusable Cyrillic/Greek/Georgian letters onto Latin, and drop anything
 * that is not a letter or digit.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'ь': 'b', 'ъ': 'b', 'с': 'c', 'ԁ': 'd', 'е': 'e', 'ѕ': 's',
  'һ': 'h', 'і': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p',
  'т': 't', 'у': 'y', 'х': 'x', 'ᴏ': 'o', 'ᴄ': 'c', 'ғ': 'f', 'ԛ': 'q', 'ѡ': 'w',
  // Greek
  'ρ': 'p', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'τ': 't',
  'υ': 'u', 'χ': 'x', 'γ': 'y', 'β': 'b', 'ϲ': 'c', 'ϳ': 'j', 'μ': 'u', 'σ': 'o',
  // Georgian -- heavily used on this chain to impersonate a Latin "b"
  'ბ': 'b', 'ⴆ': 'b', 'ხ': 'b', 'ⴈ': 'b', 'ლ': 'l', 'ს': 's', 'მ': 'm', 'ო': 'o',
  'წ': 'w', 'ჩ': 'ch', 'ძ': 'dz', 'ე': 'e', 'ი': 'i',
  // Canadian syllabics / phonetic / Latin extended b-lookalikes
  'ᖯ': 'b', 'Ƅ': 'b', 'ƅ': 'b', 'ѣ': 'b', 'ᑲ': 'b', 'ᖴ': 'f', 'ᒿ': '2',
  'ı': 'i', 'ȷ': 'j', 'ɑ': 'a', 'ɡ': 'g', 'ɩ': 'i', 'ɿ': 'r', 'ʏ': 'y',
  // fullwidth / misc
  '０': '0', '１': '1', 'ǃ': '', '‐': '', '‑': '',
};

export function normaliseKey(input: string | null | undefined): string {
  if (!input) return '';
  let s = input.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  s = [...s].map((ch) => CONFUSABLES[ch] ?? ch).join('');
  s = s.normalize('NFKD').replace(/\p{M}+/gu, '');
  return [...s].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');
}
