-- Beta tester signups collected from the public "Join the beta" form.
CREATE TABLE IF NOT EXISTS beta_signups (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,   -- stored normalized (lowercased)
  platform   TEXT,                   -- ios | chrome | web | any
  note       TEXT,
  ip         TEXT,                   -- for light abuse review / rate limiting
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_beta_signups_ip ON beta_signups(ip, created_at);
