-- Passwordless extension connection. Existing sessions remain full-access;
-- extensions receive a narrowly scoped capture token after web approval.

ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';

CREATE TABLE extension_authorizations (
  request_hash   TEXT PRIMARY KEY,
  code_challenge TEXT NOT NULL,
  client         TEXT NOT NULL,
  user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  approved_at    INTEGER
);
CREATE INDEX idx_extension_authorizations_expires
  ON extension_authorizations(expires_at);
