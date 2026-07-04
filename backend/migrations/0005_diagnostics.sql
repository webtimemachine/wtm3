-- Self-reported client diagnostics (e.g. "sync looks stuck" from the popup's
-- report button). Lets us see the CLIENT's view of a sync problem — queue
-- size, learned quota ceiling, last error — instead of only ever inferring
-- it from server-side D1 state.
CREATE TABLE IF NOT EXISTS diagnostic_reports (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT,
  payload      TEXT NOT NULL,   -- JSON DiagnosticReport, capped/validated server-side
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diagnostic_reports_user ON diagnostic_reports(user_id, created_at DESC);
