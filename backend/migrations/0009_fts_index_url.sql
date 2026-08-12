-- Widen the search index to everything worth recalling a page by.
--
-- `url` was UNINDEXED, so a page's own address never matched a query:
-- searching "58627" missed http://localhost:58627/, and "mediaViewer" returned
-- only pages whose *body* quoted that link, not the x.com page whose URL
-- contains it. byline / excerpt / summary were never in the index at all —
-- costly because shell-titled pages (YouTube, dashboards, SPAs) are often
-- described only by their generated summary.
--
-- fts5 cannot add or re-index columns in place, so rebuild. pages_fts is a
-- regular (non-contentless) fts5 table holding its own copy of title/body, and
-- the new columns live in `pages`, so the whole rebuild reads from D1 — page
-- text is never refetched from R2. title and body keep positions 0 and 1, so
-- snippet(pages_fts, 1, ...) still quotes the body.

CREATE VIRTUAL TABLE pages_fts_v2 USING fts5(
  title,
  body,
  url,
  byline,
  excerpt,
  summary,
  page_id  UNINDEXED,
  user_id  UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO pages_fts_v2 (title, body, url, byline, excerpt, summary, page_id, user_id)
SELECT f.title,
       f.body,
       f.url,
       COALESCE(p.byline, ''),
       COALESCE(p.excerpt, ''),
       COALESCE(p.summary, ''),
       f.page_id,
       f.user_id
FROM pages_fts f
JOIN pages p ON p.id = f.page_id AND p.user_id = f.user_id;

DROP TABLE pages_fts;

ALTER TABLE pages_fts_v2 RENAME TO pages_fts;
