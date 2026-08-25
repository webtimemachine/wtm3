-- Search Assist is a separately approved, read-only extension capability.
-- Existing pending authorizations remain capture grants.

ALTER TABLE extension_authorizations
  ADD COLUMN requested_scope TEXT NOT NULL DEFAULT 'capture';
