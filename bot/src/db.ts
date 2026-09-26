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
-- Rebuilt verbatim by migrateScanEventSource; see SCAN_EVENTS_DDL below.
CREATE TABLE IF NOT EXISTS scan_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('dm','group','inline','cli','api')),
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

-- ---------------------------------------------------------------------------
-- The roster. One row per seat, occupied or freed.
--
-- The shares column is stored rather than derived from the tier, so changing what a
-- tier is worth changes what people earn NEXT run and leaves every run already
-- paid exactly as it was paid. A ledger that recomputes history is a ledger
-- nobody can check against their own wallet.
--
-- A freed seat keeps its row: the history of who sat in it is the point, and a
-- deleted row would take the reason for a past payout with it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seats (
  seat        INTEGER PRIMARY KEY,
  handle      TEXT NOT NULL,
  -- Lowercased, for the uniqueness the handle itself cannot carry.
  handle_key  TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('T1','T2','T3')),
  shares      INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  joined_at   INTEGER NOT NULL,
  removed_at  INTEGER
);
-- One live seat per handle. A handle that sat before and left may return.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seats_live ON seats(handle_key) WHERE removed_at IS NULL;

-- Everything that ever happened to a seat, including the tier it used to be.
CREATE TABLE IF NOT EXISTS seat_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seat       INTEGER NOT NULL,
  handle     TEXT NOT NULL,
  event      TEXT NOT NULL CHECK (event IN ('add','tier','remove')),
  from_tier  TEXT,
  to_tier    TEXT,
  wallet     TEXT,
  at         INTEGER NOT NULL,
  by_user    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_seat_events ON seat_events(seat, at);

-- ---------------------------------------------------------------------------
-- The ledger. One row per run, one row per payment inside it.
--
-- A run is written at preview and stays 'preview' until money actually moved:
-- what has been paid is what has a transaction hash against it, never what was
-- once computed. Every amount is wei in a TEXT column, because a payout is not
-- a float.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  -- What the fee wallet held when the run was computed.
  balance_wei     TEXT NOT NULL,
  -- What had already gone out, from this table's own record of it.
  paid_before_wei TEXT NOT NULL,
  remainder_wei   TEXT NOT NULL,
  pool_wei        TEXT NOT NULL,
  total_shares    INTEGER NOT NULL,
  per_share_wei   TEXT NOT NULL,
  distributed_wei TEXT NOT NULL,
  dust_wei        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('preview','sent')),
  posted_at       INTEGER,
  -- True when the balance was supplied by hand rather than read from chain.
  hypothetical    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledger_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL,
  seat       INTEGER NOT NULL,
  handle     TEXT NOT NULL,
  wallet     TEXT NOT NULL,
  tier       TEXT NOT NULL,
  shares     INTEGER NOT NULL,
  amount_wei TEXT NOT NULL,
  tx_hash    TEXT,
  sent_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ledger_payments_run ON ledger_payments(run_id);

-- ---------------------------------------------------------------------------
-- Manual transfers out of the fee wallet, to the treasury or anywhere else.
--
-- Fees arrive in the same wallet the payouts leave from, so the balance alone
-- cannot tell new income from a remainder nobody has distributed yet. What
-- reconstructs it is everything that ever left: the payouts, and these. Each
-- one is verified against the chain before it is recorded, so the figure the
-- pool is computed from is a sum of transactions rather than of assertions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_sweeps (
  tx_hash     TEXT PRIMARY KEY,
  to_address  TEXT NOT NULL,
  value_wei   TEXT NOT NULL,
  gas_wei     TEXT NOT NULL,
  block       INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  by_user     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_payments_once ON ledger_payments(run_id, seat);

-- Which chats the bot is a member of, from my_chat_member updates. One row
-- per chat; status is the bot's last known membership state there. Rows seeded
-- from group activity before the handler existed carry status 'seen', which
-- counts as present until an update says otherwise.
-- Chats that asked to be told when the armed launch lands.
--
-- One row per chat, with its own delay in seconds. The CA goes into the room
-- that runs the launch at T+3s and into a second room a few seconds later, so
-- neither is reading the other's screenshot, and each is recorded as posted
-- separately: a send that fails in one chat must not stop the others and must
-- not be retried into a chat that already has it.
CREATE TABLE IF NOT EXISTS launch_watchers (
  chat_id       INTEGER PRIMARY KEY,
  delay_seconds INTEGER NOT NULL DEFAULT 0,
  added_by      INTEGER,
  added_at      INTEGER NOT NULL,
  -- The CA this chat was last told about, and the message it went out as.
  posted_ca     TEXT,
  posted_msg    INTEGER,
  posted_at     INTEGER
);

CREATE TABLE IF NOT EXISTS bot_chats (
  chat_id    INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,
  title      TEXT,
  status     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

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

-- Access granted by an admin: no holding, no payment, and an expiry.
--
-- Separate from licences and from premium_payments on purpose. Those two
-- record a thing that happened (a holder licensed a group, a wallet paid), and
-- neither expires; this records a decision someone took, which does. Keeping
-- them apart means a grant can lapse without touching a payment record, and a
-- holder who stops holding is not confused with a wallet an admin let in.
--
-- subject is a lowercased wallet for kind 'wallet' and a chat id as text for
-- kind 'chat'. expires_at is unix seconds and is compared, never trusted to
-- have been cleaned up: an expired row is the same as no row.
CREATE TABLE IF NOT EXISTS access_grants (
  kind       TEXT NOT NULL CHECK (kind IN ('wallet','chat')),
  subject    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  granted_by INTEGER NOT NULL,
  granted_at INTEGER NOT NULL,
  note       TEXT,
  PRIMARY KEY (kind, subject)
);
CREATE INDEX IF NOT EXISTS idx_grants_expiry ON access_grants(kind, expires_at);

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

-- A launch its team has declared to this bot.
--
-- The card shows a badge when a row exists here and nothing when it does not,
-- which is the whole contract: a declaration is a claim somebody made, never a
-- judgement this bot formed, and the badge says only that the claim exists.
-- A declaration was keyed on a token before it was built. It could not be: the
-- statement is made before the token exists, by a wallet, about a launch that
-- has not happened. Nothing ever wrote a row, so the table goes.
DROP TABLE IF EXISTS declarations;

-- ---------------------------------------------------------------------------
-- Declared launches.
--
-- A declaration is a signed statement made BEFORE a launch exists, so it is
-- keyed on the deployer wallet and its block, never on a token. What it claims
-- is compared against what the launch transaction actually did; a mismatch is a
-- finding of its own and never suppresses the check it contradicts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS launch_declarations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  deployer        TEXT NOT NULL,
  declared_by     INTEGER NOT NULL,
  declared_at     INTEGER NOT NULL,
  -- The chain head when the declaration was stored. A declaration only counts
  -- for a launch mined after it.
  block_number    INTEGER NOT NULL,
  dev_buy_pct     REAL NOT NULL,
  -- JSON array of the addresses named besides the deployer.
  exempt_list     TEXT NOT NULL,
  -- What the curve should emit: the named wallets plus the deployer itself.
  exempt_count    INTEGER NOT NULL,
  creator_tax_bps INTEGER NOT NULL,
  tax_split       TEXT NOT NULL,
  vesting         TEXT NOT NULL,
  docs_url        TEXT NOT NULL,
  -- The exact bytes that were signed, kept so the signature stays checkable.
  canonical       TEXT NOT NULL,
  signature       TEXT NOT NULL,
  -- The founding number, 1..DECLARE_FREE_UNTIL, or NULL when it was paid for.
  free_slot       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_decl_deployer ON launch_declarations(deployer, block_number);

-- One open form per user, so the questions survive a restart.
CREATE TABLE IF NOT EXISTS declare_drafts (
  user_id    INTEGER PRIMARY KEY,
  step       INTEGER NOT NULL,
  answers    TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Group auto-reply.
--
-- OFF for every chat until an admin turns it on. The row exists only once a
-- decision has been made, so "no row" and "off" are the same thing and a bot
-- added to a new group scans nothing until asked.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_settings (
  chat_id  INTEGER NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  set_by   INTEGER,
  set_at   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, key)
);

-- One row per (chat, address) the auto-reply has answered, so a token pasted
-- five times in a minute costs one card rather than five.
CREATE TABLE IF NOT EXISTS auto_replies (
  chat_id   INTEGER NOT NULL,
  address   TEXT NOT NULL,
  last_at   INTEGER NOT NULL,
  hits      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (chat_id, address)
);

-- ---------------------------------------------------------------------------
-- First callers.
--
-- Who put an address in front of a group first, and what the token was worth at
-- that moment. A record, not a recommendation: the leaderboard states multiples
-- from the call to the peak that followed it and never a profit, because a
-- multiple is a fact about the token and a profit is a claim about somebody.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS first_calls (
  chat_id    INTEGER NOT NULL,
  token      TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  username   TEXT,
  called_at  INTEGER NOT NULL,
  -- Market cap in the quote asset, as wei, and the block it was read at.
  mcap_quote TEXT,
  block_number INTEGER,
  PRIMARY KEY (chat_id, token)
);
CREATE INDEX IF NOT EXISTS idx_first_calls_chat ON first_calls(chat_id, called_at);

CREATE TABLE IF NOT EXISTS cursors (
  name         TEXT PRIMARY KEY,
  block_number INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Standing watches for a name or ticker landing on chain.
--
-- A lookalike of our own launch is an impersonation the room guard cannot see:
-- that one checks addresses posted in our chats, and this one is a token
-- nobody has posted yet. The keys are stored normalised so the watch compares
-- what the card compares, and the row keeps the strings as typed so the alert
-- can say what was being watched for.
--
-- Deliveries are recorded per watch and token, because the notice must go out
-- once whatever the indexer does with a block it has already seen.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Premium granted to a Telegram account, with no wallet and nothing on chain.
--
-- The KOLs in a room are reachable by user id and by nothing else: they have
-- no wallet linked, they are not going to link one to read a card, and an
-- invitation that needs an on-chain step is an invitation most of them decline.
--
-- The id is all that is stored about the person. No handle, no name, no chat.
-- A user id is what the grant is keyed on and what an admin was given, and
-- anything else here would be a record nobody asked us to keep.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS premium_tg_grants (
  user_id    INTEGER PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  note       TEXT,
  granted_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The ending-soon DM, recorded so it goes out once per expiry rather than
-- once per pass. Keyed on the expiry it was sent about, so extending a grant
-- arms the reminder again for the new date without any cleanup.
CREATE TABLE IF NOT EXISTS premium_tg_reminders (
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, expires_at)
);

CREATE TABLE IF NOT EXISTS collision_watches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  symbol_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  by_user    INTEGER,
  stopped_at INTEGER
);

CREATE TABLE IF NOT EXISTS collision_watch_hits (
  watch_id INTEGER NOT NULL,
  token    TEXT NOT NULL,
  seen_at  INTEGER NOT NULL,
  PRIMARY KEY (watch_id, token)
);
`);

const SCAN_EVENTS_DDL = `CREATE TABLE scan_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('dm','group','inline','cli','api')),
  chat_id      INTEGER,
  user_id      INTEGER,
  token        TEXT,
  cache_hit    INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL,
  outcome      TEXT NOT NULL,
  scan_id      INTEGER
);`;

/**
 * A CHECK constraint cannot be altered in place, so the table is rebuilt.
 *
 * scan_events.source gained 'api' when the HTTP API landed. Every API scan on
 * an existing database was refused by the old constraint and logged, which cost
 * nothing at the time -- the insert is wrapped -- but silently lost the usage
 * telemetry the whole table exists for.
 *
 * Guarded on the constraint text rather than on a version number: it runs once
 * on a database that predates the change and never again, and it is a no-op on
 * a fresh one because the table is created with the new constraint above.
 */
function migrateScanEventSource(): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scan_events'")
    .get() as { sql: string } | undefined;
  if (!row?.sql || row.sql.includes("'api'")) return;

  console.log('[db] rebuilding scan_events to accept the api source');
  const columns = (db.prepare('PRAGMA table_info(scan_events)').all() as { name: string }[])
    .map((c) => c.name)
    .join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`ALTER TABLE scan_events RENAME TO scan_events_old`);
    db.exec(SCAN_EVENTS_DDL);
    db.exec(`INSERT INTO scan_events (${columns}) SELECT ${columns} FROM scan_events_old`);
    db.exec('DROP TABLE scan_events_old');
  })();
  db.exec('PRAGMA foreign_keys = ON');
}
migrateScanEventSource();

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
  // Which launch notice this user has already been shown, as a digest of the
  // line itself. A timestamp would have meant a user who saw "launching on the
  // 24th" never saw "is live".
  ['dm_chats', 'launch_notice_seen', 'TEXT'],
  // Where this row's exemption count came from. NULL means the calldata-only
  // decoder, which is measurably wrong: the curve auto-exempts the deployer and
  // never says so in the calldata, so 61 of 64 cross-checked launches had one
  // more tax-free wallet than the array the caller passed. Rows without a
  // source are re-read from the curve's own events in the background; their
  // existing answer stands until it is replaced, because withdrawing a figure
  // that is merely one short and showing "undetermined" for a day would be a
  // worse answer than the one it replaces.
  ['launches', 'exemption_source', 'TEXT'],
  // What was credited to the fee wallet in the fee escrow and unclaimed at the
  // moment the run was computed. NULL on every run stored before this column
  // existed, and NULL is the correct reading for them: those runs computed a
  // gross that did not include the term at all, and a zero here would claim
  // they had read it and found nothing.
  ['ledger_runs', 'escrow_wei', 'TEXT'],
  // The two optional declaration blocks, and the hash of the page the docs
  // line names. All three are absent on every declaration made before they
  // existed, and absent is the correct reading: those declarations said
  // nothing about a room, a fee share or a page's contents.
  // The creator's own slots, kept so "who was exempt" can be split into the
  // creator's wallets and everybody else. The fee recipient is in the launch
  // calldata and was never stored, so this cannot be filled by arithmetic over
  // existing rows: it needs the launch transaction read again.
  // What a seat is for, in the admin's own words. Shown in /seat list and in
  // nothing that can reach a group: a note is the kind of thing written about
  // somebody rather than to them.
  ['seats', 'note', 'TEXT'],
  ['launches', 'creator_fee_recipient', 'TEXT'],
  // Exempt wallets that are none of the three creator slots. NULL means the
  // row predates the column, which is not the same as zero.
  ['launches', 'third_party_exempt', 'INTEGER'],
  ['launch_declarations', 'room', 'TEXT'],
  ['launch_declarations', 'holder_fee_share', 'TEXT'],
  ['launch_declarations', 'docs_sha256', 'TEXT'],
  // What the pre-exempted wallets took in the tax-free opening window, and the
  // deployer's own share of it, as percentages of total supply. Measured by
  // metrics/opening.ts over the first forty blocks, NOT from the launch
  // receipt: the exempted wallets buy after the launch transaction, not inside
  // it, and the receipt alone reported 1.0% where the window reported 17.4%.
  // NULL is undetermined, and a finding sized by a share it does not have falls
  // back to its count.
  ['launches', 'exempt_open_pct', 'REAL'],
  ['launches', 'creator_open_pct', 'REAL'],
  // The socials named in the launch calldata, kept as given. NULL is "not
  // read", which the lazy fill in socials.ts resolves from the token's own
  // getTokenInfo; an empty string is "read, and none was given".
  ['launches', 'social_x', 'TEXT'],
  ['launches', 'social_tg', 'TEXT'],
  ['launches', 'social_web', 'TEXT'],
  ['launches', 'socials_read_at', 'INTEGER'],
  // The block a graduated launch's curve trades are read through by the
  // curve-life pass. Separate from trades_indexed_to on purpose: that column
  // is the buyer benchmark's population key, and this read must not enrol
  // launches in it by outcome.
  ['launches', 'curve_indexed_to', 'INTEGER'],
  // What a payout cost to send. It left the wallet too, so gross income
  // cannot be reconstructed without it. NULL is "the receipt was not read",
  // which the preview reports rather than treating as zero.
  ['ledger_payments', 'gas_wei', 'TEXT'],
  ['ledger_runs', 'gross_income_wei', 'TEXT'],
  ['ledger_runs', 'swept_to_date_wei', 'TEXT'],
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

/**
 * Clear opening-window shares that cannot be true.
 *
 * The window used to be read from whatever block the scan had, estimated or
 * not, and a window that misses the launch returns zeros indistinguishable from
 * a launch where nothing happened. Two of those zeros are provably wrong and
 * can be found without touching the chain:
 *
 *   the curve's own events counted N exempted wallets and the window saw 0% of
 *   supply go to them -- the exemptions are emitted in the launch transaction,
 *   which is the first block of the window, so a zero means the window was not
 *   there
 *
 *   the launch transaction carried a creator buy and the window saw the creator
 *   take 0% -- the same argument
 *
 * Cleared rather than corrected: NULL reads as undetermined, the next scan
 * re-reads the window, and the new guard refuses to write it again from an
 * estimated block. A wrong number that looks measured is worse than no number,
 * which is the whole reason this runs.
 */
export function repairFalseOpeningZeros(): void {
  const cols = columnsOf('launches');
  if (!cols.includes('exempt_open_pct') || !cols.includes('creator_open_pct')) return;

  const impossible = `
    (exempt_open_pct = 0 AND exemption_source = 'logs' AND snipe_exemption_count > 0)
    OR (creator_open_pct = 0 AND launch_buy_amount IS NOT NULL AND CAST(launch_buy_amount AS INTEGER) > 0)
  `;
  const n = (db.prepare(
    `SELECT COUNT(*) AS n FROM launches WHERE (exempt_open_pct IS NOT NULL OR creator_open_pct IS NOT NULL) AND (${impossible})`,
  ).get() as { n: number }).n;
  if (!n) return;

  db.prepare(
    `UPDATE launches SET exempt_open_pct = NULL, creator_open_pct = NULL WHERE ${impossible}`,
  ).run();
  console.log(`[db] cleared opening-window shares on ${n} launches whose zeros contradict their own launch receipt`);
}
repairFalseOpeningZeros();


export function normaliseKey(input: string | null | undefined): string {
  if (!input) return '';
  let s = input.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  s = [...s].map((ch) => CONFUSABLES[ch] ?? ch).join('');
  s = s.normalize('NFKD').replace(/\p{M}+/gu, '');
  return [...s].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');
}
