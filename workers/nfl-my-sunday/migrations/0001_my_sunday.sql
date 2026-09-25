-- My Sunday v1 (pbe-my-sunday/v1). D1, private to the nfl-my-sunday Worker.
-- Additive: creates three new tables and touches nothing else.
--
-- owner_key is an HMAC of the verified session email computed by the Vercel
-- boundary (api/my-sunday.js) with MY_SUNDAY_OWNER_SECRET. The Worker never
-- receives an email, and every statement below is scoped by owner_key in the
-- Worker's own code: D1 has no RLS and the binding is privileged.

CREATE TABLE IF NOT EXISTS saved_items (
  owner_key          TEXT    NOT NULL,
  item_key           TEXT    NOT NULL,
  item_type          TEXT    NOT NULL CHECK (item_type IN ('game','player','prop','pick','td_target','scenario')),
  season             INTEGER,
  event_id           TEXT,
  odds_event_id      TEXT,
  player_espn_id     TEXT,
  player_gsis_id     TEXT,
  team               TEXT,
  market             TEXT,
  side               TEXT,
  saved_line         REAL,
  saved_price        INTEGER,
  saved_book         TEXT,
  market_captured_at TEXT,
  pick_ref           TEXT,
  label              TEXT    NOT NULL,
  context            TEXT    NOT NULL DEFAULT '{}',
  saved_at           TEXT    NOT NULL,
  PRIMARY KEY (owner_key, item_key)
);
CREATE INDEX IF NOT EXISTS saved_items_player ON saved_items (player_espn_id);
CREATE INDEX IF NOT EXISTS saved_items_event  ON saved_items (event_id);
CREATE INDEX IF NOT EXISTS saved_items_odds   ON saved_items (odds_event_id) WHERE item_type = 'prop';

-- One row per (owner, source change, saved item). The primary key IS the
-- deduplication identity: a change delivered twice, or matched by two
-- refreshes, is inserted once (INSERT OR IGNORE).
CREATE TABLE IF NOT EXISTS alerts (
  owner_key     TEXT NOT NULL,
  alert_id      TEXT NOT NULL,
  item_key      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  observed_at   TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  read_at       TEXT,
  PRIMARY KEY (owner_key, alert_id, item_key)
);
CREATE INDEX IF NOT EXISTS alerts_owner_seen ON alerts (owner_key, first_seen_at);

-- The shared refresh ledger: one row per lane. One read of each source per
-- refresh for everyone, never one per user.
CREATE TABLE IF NOT EXISTS refresh_state (
  lane        TEXT PRIMARY KEY,
  ran_at      TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  detail      TEXT
);
