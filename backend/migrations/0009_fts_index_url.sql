-- Make page URLs searchable. `url` was created UNINDEXED, so a page's own
-- address never matched a query: searching "58627" missed
-- http://localhost:58627/, and "mediaViewer" returned only pages whose *body*
-- quoted that link, not the x.com page whose URL contains it.
--
-- fts5 cannot flip a column to indexed in place, so rebuild. pages_fts is a
-- regular (non-contentless) fts5 table — it stores its own copy of title/body
-- — so the rebuild reads entirely from D1; page text never leaves R2.
-- Column order is preserved: snippet(pages_fts, 1, ...) still points at body.

CREATE VIRTUAL TABLE pages_fts_v2 USING fts5(
  title,
  body,
  url,
  page_id  UNINDEXED,
  user_id  UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO pages_fts_v2 (title, body, url, page_id, user_id)
SELECT title, body, url, page_id, user_id FROM pages_fts;

DROP TABLE pages_fts;

ALTER TABLE pages_fts_v2 RENAME TO pages_fts;
