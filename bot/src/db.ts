import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
/**
 * Wait for a busy writer instead of failing on it.
 *
 * WAL lets readers and one writer coexist, but a SECOND writer gets SQLITE_BUSY
 * immediately with no timeout set, and that is a thrown error rather than a
 * wait. Two processes touch this database in normal use -- the bot and any CLI
 * command run beside it -- and the test suite runs a dozen files in parallel,
 * where it showed up as a single unreproducible failure. Five seconds is far
 * longer than any write here takes.
 */
db.pragma('busy_timeout = 5000');
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
  attempts       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (scan_id, offset_hours)
);
CREATE INDEX IF NOT EXISTS idx_rechecks_due ON rechecks(completed_at, due_at);

-- Private chats we know about, so an alert has somewhere to go.
--
-- Telegram gives no way to open a DM unprompted: the user must message first.
-- Recorded on any private message rather than inferred from scan history --
-- somebody whose only DM was /help still has a reachable chat, and inferring it
-- from scans told them to "message me first" when they already had.
CREATE TABLE IF NOT EXISTS dm_chats (
  user_id  INTEGER PRIMARY KEY,
  chat_id  INTEGER NOT NULL,
  seen_at  INTEGER NOT NULL
);

-- Alert subscriptions. One row per (user, kind, address).
--
-- Delivery is DM-only, so the chat is the user's own private chat and is
-- recorded when the watch is created: a watch set up from a group must still
-- fire privately, and firing into the group is what gets a bot removed.
CREATE TABLE IF NOT EXISTS watches (
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('deployer','wallet')),
  address    TEXT NOT NULL,
  dm_chat_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, address)
);
CREATE INDEX IF NOT EXISTS idx_watches_address ON watches(address);

-- Filter subscriptions. A separate table from the address watches because a
-- filter has no address: overloading that column with a filter name would make
-- every query against it ambiguous, and the CHECK on kind exists to stop that.
CREATE TABLE IF NOT EXISTS filter_watches (
  user_id    INTEGER NOT NULL,
  filter     TEXT NOT NULL,
  dm_chat_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, filter)
);

-- When a user was last told their hourly alert cap had been reached, so being
-- over the cap costs them one message rather than one per suppressed alert.
CREATE TABLE IF NOT EXISTS alert_cap_notices (
  user_id     INTEGER PRIMARY KEY,
  notified_at INTEGER NOT NULL
);

-- What has already been delivered, so one launch never fires twice to the same
-- user -- including when they watch both its deployer and one of its exempted
-- wallets, which is the case that would otherwise double-send.
CREATE TABLE IF NOT EXISTS watch_fired (
  user_id  INTEGER NOT NULL,
  token    TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, token)
);

-- Holder concentration observations, one per token, refreshed on every scan.
-- The distribution these rows form is where the concentration threshold comes
-- from; no threshold is hardcoded anywhere. Tokens with too few holders for the
-- top-five share to mean anything are never recorded, so they cannot drag a
-- band's percentile to the 100% every tiny launch reports by arithmetic.
CREATE TABLE IF NOT EXISTS holder_snapshots (
  token       TEXT PRIMARY KEY,
  top5_share  REAL NOT NULL,
  holders     INTEGER NOT NULL,
  -- How far past the most even distribution this holder count allows, 0-1.
  -- Scale-free, so one distribution serves every holder count; the raw share is
  -- not comparable between a six-holder token and a two-hundred-holder one.
  excess      REAL NOT NULL,
  measured_at INTEGER NOT NULL
);

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
-- The widest eth_getLogs range each endpoint will actually serve, discovered at
-- runtime. Keyed by endpoint so switching providers re-discovers instead of
-- inheriting a ceiling that was true of somewhere else. No API key is stored:
-- only scheme and host, because this file gets copied around.
CREATE TABLE IF NOT EXISTS provider_limits (
  endpoint      TEXT PRIMARY KEY,
  max_span      INTEGER NOT NULL,
  discovered_at INTEGER NOT NULL
);

-- Wallets registered as ready for launch.
--
-- Two sources. A member registers their own in a DM; an admin adds an external
-- one for somebody ready but not in the group. A wallet exists once across
-- both, and the member record wins -- see claimWallet().
--
-- No wallet, label or user id ever appears in a group message. This table is
-- read for totals and for the admin CSV, and for nothing else.
CREATE TABLE IF NOT EXISTS ready_wallets (
  wallet       TEXT PRIMARY KEY,
  user_id      INTEGER,
  label        TEXT,
  source       TEXT NOT NULL CHECK (source IN ('member','external')),
  balance_wei  TEXT NOT NULL DEFAULT '0',
  invite_link  TEXT,
  first_seen   INTEGER NOT NULL,
  last_checked INTEGER NOT NULL
);
-- One wallet per Telegram user; re-registering replaces rather than adds.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ready_user
  ON ready_wallets(user_id) WHERE user_id IS NOT NULL;

-- Small key/value for the launch settings an admin sets: gate targets, the kol
-- count, whether self-registration is open, the launch time.
CREATE TABLE IF NOT EXISTS ready_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per day, so "since yesterday" is a comparison against a recorded
-- fact rather than a number held in memory across a deploy.
CREATE TABLE IF NOT EXISTS ready_snapshots (
  day     INTEGER PRIMARY KEY,
  wallets INTEGER NOT NULL,
  wei     TEXT NOT NULL
);

-- Proof that a Telegram user controls a wallet.
--
-- Separate from ready_wallets on purpose: that table records who an ADMIN says
-- is ready, which is a statement about the launch, while this one records a
-- signature the holder produced. A tier is access, so it needs the second kind
-- even when the first already names the same address.
CREATE TABLE IF NOT EXISTS holder_links (
  user_id   INTEGER PRIMARY KEY,
  wallet    TEXT NOT NULL,
  method    TEXT NOT NULL CHECK (method IN ('signature','transfer')),
  linked_at INTEGER NOT NULL
);
-- One wallet, one holder. Without this, one whale's balance grants a tier to
-- everybody who names it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_holder_wallet ON holder_links(wallet);

-- Outstanding link challenges. One per user; issuing a new one retires the old.
CREATE TABLE IF NOT EXISTS holder_nonces (
  user_id   INTEGER PRIMARY KEY,
  nonce     TEXT NOT NULL,
  issued_at INTEGER NOT NULL
);

-- Time-boxed access that does not depend on a balance.
CREATE TABLE IF NOT EXISTS tier_grants (
  user_id    INTEGER PRIMARY KEY,
  tier       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('payment','admin')),
  granted_at INTEGER NOT NULL
);

-- Holder feed subscriptions. DM only; there is no chat id here by design.
CREATE TABLE IF NOT EXISTS feed_subs (
  user_id    INTEGER PRIMARY KEY,
  filters    TEXT,
  paused     INTEGER NOT NULL DEFAULT 0,
  -- The last launch this user was actually sent, and how many were skipped
  -- because they were too far behind to catch up.
  last_sent  INTEGER NOT NULL DEFAULT 0,
  missed     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- A DESK holder's one group licence.
CREATE TABLE IF NOT EXISTS licences (
  chat_id    INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  granted_at INTEGER NOT NULL
);
-- One licence per holder, not one per group they can type in.
CREATE UNIQUE INDEX IF NOT EXISTS idx_licence_user ON licences(user_id);

-- Premium paid for, not held.
--
-- Keyed on the transaction hash so one payment entitles one wallet once: a hash
-- replayed by a second user, or by the same user twice, collides on the primary
-- key rather than granting twice. Verified against chain before it is written,
-- never on a user's say-so.
CREATE TABLE IF NOT EXISTS premium_payments (
  tx_hash TEXT PRIMARY KEY,
  wallet  TEXT NOT NULL,
  wei     TEXT NOT NULL,
  paid_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_premium_wallet ON premium_payments(wallet);

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

/**
 * Columns added after the first release.
 *
 * The container has no persistent volume so the schema above usually creates
 * everything, but a database that survives a restart must not be left behind by
 * a deploy. Adding a column that already exists is an error, not a no-op, so it
 * is checked first.
 */
const columnsOf = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

for (const [table, column, decl] of [
  ['rechecks', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['holder_snapshots', 'excess', 'REAL NOT NULL DEFAULT 0'],
  ['launches', 'trades_indexed_to', 'INTEGER'],
  ['launches', 'holders_read_at', 'INTEGER'],
  ['launches', 'decode_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['holder_snapshots', 'balances', 'TEXT'],
  ['holder_snapshots', 'read_to_block', 'INTEGER'],
  ['holder_snapshots', 'top1_share', 'REAL'],
  ['holder_snapshots', 'deployer_activity', 'TEXT'],
  ['holder_snapshots', 'early_sells', 'TEXT'],
  // When this user was last shown the legend. Persisted rather than held in
  // memory: this container has no volume, so an in-memory "seen" set would
  // re-send the legend to everyone after every deploy.
  ['dm_chats', 'legend_at', 'INTEGER'],
  // Where this row's exemption count came from. NULL means the calldata-only
  // decoder, which is measurably wrong: the curve auto-exempts the deployer and
  // never says so in the calldata, so 61 of 64 cross-checked launches had one
  // more tax-free wallet than the array the caller passed. Rows without a
  // source are re-read from the curve's own events in the background; their
  // existing answer stands until it is replaced, because withdrawing a figure
  // that is merely one short and showing "undetermined" for a day would be a
  // worse answer than the one it replaces.
  ['launches', 'exemption_source', 'TEXT'],
] as const) {
  if (!columnsOf(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    if (table === 'holder_snapshots') {
      // DEFAULT 0 would enter every existing observation into the threshold
      // distribution as the most even value there is, dragging the percentile
      // down and flagging tokens that do not deserve it. The excess is pure
      // arithmetic over two columns the row already has, so it is derived
      // rather than guessed:  (share - floor) / (100 - floor),  floor = 500/H.
      db.exec(`
        UPDATE holder_snapshots
           SET excess = MAX(0.0, MIN(1.0,
                 (top5_share - (100.0 * MIN(5, holders) / holders))
                 / (100.0 - (100.0 * MIN(5, holders) / holders))))
         WHERE holders > 5
      `);
      // Rows below the holder floor could never have been recorded under either
      // rule; if one exists it has no excess to contribute.
      db.exec('DELETE FROM holder_snapshots WHERE holders <= 5');
    }
    if (table === 'launches' && column === 'trades_indexed_to') {
      // How far each launch's trade history has actually been read, in blocks
      // from its own launch block. Until now this was inferred: a launch was
      // assumed covered as far as the last scan of it reached. That inference
      // only works while scanning is the only thing that indexes trades, and it
      // is about to stop being true. Existing rows are seeded from exactly the
      // inference they were being judged by, so nothing shifts underfoot.
      db.exec(`
        UPDATE launches
           SET trades_indexed_to = block_number + MIN(18000, MAX(0,
                 ((SELECT MAX(s.scanned_at) FROM scans s WHERE s.token = launches.token) - launched_at) * 10))
         WHERE EXISTS (SELECT 1 FROM scans s WHERE s.token = launches.token)
      `);
    }
  }
}

/**
 * Columns removed after the first release.
 *
 * `holder_snapshots.band` held the holder band a token was judged in, back when
 * the concentration threshold was a percentile of raw top-5 shares taken within
 * a band. That measure was wrong in both directions and was replaced by
 * `excess`; the column is NOT NULL with no default, so leaving it in place makes
 * every insert fail on a database that predates the change.
 */
for (const stale of ['idx_holder_snapshots_band']) {
  // An index over the column has to go first: SQLite refuses the drop while
  // anything still references it.
  db.exec(`DROP INDEX IF EXISTS ${stale}`);
}
for (const [table, column] of [['holder_snapshots', 'band']] as const) {
  if (columnsOf(table).includes(column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

// Indexes last: these name columns the migrations above may have just added, and
// CREATE INDEX on a column that does not exist yet throws at module load.
db.exec('CREATE INDEX IF NOT EXISTS idx_holder_snapshots_excess ON holder_snapshots(excess)');

export function normaliseKey(input: string | null | undefined): string {
  if (!input) return '';
  let s = input.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  s = [...s].map((ch) => CONFUSABLES[ch] ?? ch).join('');
  s = s.normalize('NFKD').replace(/\p{M}+/gu, '');
  return [...s].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');
}
