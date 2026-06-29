-- Web Time Machine v3 — initial schema (D1 / SQLite).
-- Metadata + full-text index live in D1; full readable text lives in R2.

-- Users: traditional email/password identity (PBKDF2-HMAC-SHA256).
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,            -- base64
  password_salt  TEXT NOT NULL,            -- base64
  iterations     INTEGER NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 365,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));

-- Nodes = the user's devices. Everything syncs to the one backend.
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id);

-- Per-user monotonic sequence allocator. Bumped atomically (UPDATE ... RETURNING)
-- to assign each page mutation a unique, increasing `seq` used as the sync cursor.
CREATE TABLE IF NOT EXISTS user_seq (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL DEFAULT 0
);

-- Captured pages. Full readable text is NOT stored here (it lives in R2 at r2_key);
-- the searchable copy lives in the pages_fts index below.
CREATE TABLE IF NOT EXISTS pages (
  id             TEXT PRIMARY KEY,         -- client-generated UUID (idempotency key)
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  title          TEXT NOT NULL,
  visited_at     INTEGER NOT NULL,
  captured_at    INTEGER NOT NULL,
  device_id      TEXT,
  summary        TEXT,
  summary_status TEXT NOT NULL DEFAULT 'pending',  -- pending|ready|skipped|error
  excerpt        TEXT,
  byline         TEXT,
  lang           TEXT,
  r2_key         TEXT,                     -- full-text object key in R2 (NULL once purged)
  has_text       INTEGER NOT NULL DEFAULT 0,
  content_hash   TEXT,
  deleted        INTEGER NOT NULL DEFAULT 0,  -- tombstone; deleted pages still sync
  seq            INTEGER NOT NULL,         -- per-user change sequence
  expires_at     INTEGER,                  -- retention purge time (epoch ms)
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_user_seq     ON pages(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_pages_user_visited ON pages(user_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_expires      ON pages(expires_at) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_pages_summary      ON pages(summary_status) WHERE deleted = 0;

-- Full-text search over title + readable body. BM25 ranked, prefix-capable.
-- page_id / url / user_id are stored UNINDEXED so we can scope + join cheaply.
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  body,
  url      UNINDEXED,
  page_id  UNINDEXED,
  user_id  UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
