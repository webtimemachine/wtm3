-- Per-page stored text size (UTF-8 bytes of the R2 blob), used to enforce the
-- per-user storage quota on /sync/push. Existing rows backfill to 0, so a
-- user's counted usage starts from their next pushes and self-corrects as old
-- pages expire or are re-pushed — fine for enforcement, which only needs to
-- stop unbounded growth, not bill by the byte.
ALTER TABLE pages ADD COLUMN text_bytes INTEGER NOT NULL DEFAULT 0;
