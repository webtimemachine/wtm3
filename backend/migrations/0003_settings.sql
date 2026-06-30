-- Settings: per-user sensitive filter + per-page sensitive flag.
ALTER TABLE users ADD COLUMN filter_sensitive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;
