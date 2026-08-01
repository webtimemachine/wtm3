-- Web Time Machine v4, phase 2: destructive removal of retired sync, beta,
-- and diagnostic infrastructure. Apply only after the v4 Worker is deployed.

-- Permanently discard retired beta signups, client diagnostics, and page
-- tombstones, as selected for the v4 cleanup.
DROP TABLE beta_signups;
DROP TABLE diagnostic_reports;

DELETE FROM pages_fts
WHERE page_id IN (SELECT id FROM pages WHERE deleted = 1);
DELETE FROM pages WHERE deleted = 1;

DROP INDEX idx_pages_user_seq;
DROP INDEX idx_pages_expires;
DROP INDEX idx_pages_summary;
DROP TABLE user_seq;

ALTER TABLE pages DROP COLUMN has_text;
ALTER TABLE pages DROP COLUMN deleted;
ALTER TABLE pages DROP COLUMN seq;
ALTER TABLE pages DROP COLUMN updated_at;

CREATE INDEX idx_pages_expires ON pages(expires_at);
