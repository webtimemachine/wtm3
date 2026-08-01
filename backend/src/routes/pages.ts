import {
  MAX_TEXT_CHARS,
  type CapturedPage,
  type SearchHit,
  type SearchResponse,
  type SyncPushRequest,
  type SyncPushResponse,
} from "@wtm/shared";
import type { Hono } from "hono";
import { userFilterSensitive } from "../account";
import {
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
  MAX_ITEMS_PER_PUSH,
  MAX_PAGES_PER_USER,
  MAX_TEXT_BYTES_PER_USER,
} from "../constants";
import {
  contentHash,
  deletePageStmts,
  hasLegacyPageColumns,
  purgeTextObjects,
  rowToPage,
  textKey,
  type PageRow,
} from "../db";
import type { Env, Vars } from "../env";
import {
  addSearchFilters,
  normalizeSiteFilter,
  parseSearchBoundary,
  parseSearchSort,
  searchOrder,
  toMatchQuery,
} from "../search";
import { isKnownAdultDomain, summarizePages } from "../summary";

type App = Hono<{ Bindings: Env; Variables: Vars }>;

interface ExistingPage {
  id: string;
  user_id: string;
  text_bytes: number;
}

function normalizedPages(value: unknown, now: number): CapturedPage[] {
  if (!Array.isArray(value)) return [];
  const pages = new Map<string, CapturedPage>();
  for (const candidate of value.slice(0, MAX_ITEMS_PER_PUSH)) {
    if (
      !candidate ||
      typeof candidate.id !== "string" ||
      candidate.id.length < 1 ||
      candidate.id.length > 128 ||
      typeof candidate.url !== "string" ||
      candidate.url.length > 2048 ||
      !/^https?:\/\//i.test(candidate.url)
    ) {
      continue;
    }
    const visitedAt = Number(candidate.visitedAt);
    pages.set(candidate.id, {
      id: candidate.id,
      url: candidate.url,
      title:
        typeof candidate.title === "string"
          ? candidate.title.slice(0, 1024)
          : "(untitled)",
      visitedAt: Number.isFinite(visitedAt)
        ? Math.min(Math.max(visitedAt, 0), now + DAY_MS)
        : now,
      text:
        typeof candidate.text === "string"
          ? candidate.text.slice(0, MAX_TEXT_CHARS)
          : "",
      excerpt:
        typeof candidate.excerpt === "string"
          ? candidate.excerpt.slice(0, 4096)
          : null,
      byline:
        typeof candidate.byline === "string"
          ? candidate.byline.slice(0, 512)
          : null,
      lang:
        typeof candidate.lang === "string"
          ? candidate.lang.slice(0, 32)
          : null,
    });
  }
  return [...pages.values()];
}

async function existingPages(
  env: Env,
  ids: string[],
): Promise<Map<string, ExistingPage>> {
  if (!ids.length) return new Map();
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
  const { results } = await env.DB.prepare(
    `SELECT id,user_id,text_bytes FROM pages WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<ExistingPage>();
  return new Map(results.map((row) => [row.id, row]));
}

export function registerPageRoutes(app: App): void {
  app.post("/sync/push", async (c) => {
    const userId = c.get("userId");
    const body = (await c.req.json().catch(() => null)) as SyncPushRequest | null;
    const now = Date.now();
    const legacySchema = await hasLegacyPageColumns(c.env);
    const deviceId =
      typeof body?.deviceId === "string"
        ? body.deviceId.slice(0, 128)
        : null;
    let pages = normalizedPages(body?.pages, now);

    if (deviceId) {
      await c.env.DB.prepare(
        "UPDATE nodes SET last_seen_at=?1 WHERE id=?2 AND user_id=?3",
      )
        .bind(now, deviceId, userId)
        .run();
    }
    if (!pages.length) {
      const response: SyncPushResponse = { accepted: 0 };
      return c.json(response);
    }

    const existing = await existingPages(
      c.env,
      pages.map((page) => page.id),
    );
    pages = pages.filter((page) => {
      const row = existing.get(page.id);
      return !row || row.user_id === userId;
    });
    if (!pages.length) {
      const response: SyncPushResponse = { accepted: 0 };
      return c.json(response);
    }

    const textBytes = new Map<string, number>();
    for (const page of pages) {
      textBytes.set(page.id, new TextEncoder().encode(page.text).length);
    }
    const usage = await c.env.DB.prepare(
      `SELECT count(*) AS n, COALESCE(SUM(text_bytes),0) AS bytes
       FROM pages WHERE user_id=?1 ${legacySchema ? "AND deleted=0" : ""}`,
    )
      .bind(userId)
      .first<{ n: number; bytes: number }>();
    let addedPages = 0;
    let addedBytes = 0;
    for (const page of pages) {
      const previous = existing.get(page.id);
      if (!previous) addedPages++;
      addedBytes += (textBytes.get(page.id) ?? 0) - (previous?.text_bytes ?? 0);
    }
    if (
      (usage?.n ?? 0) + addedPages > MAX_PAGES_PER_USER ||
      (usage?.bytes ?? 0) + addedBytes > MAX_TEXT_BYTES_PER_USER
    ) {
      return c.json(
        {
          error: "storage_quota_exceeded",
          message:
            "Account storage is full. Delete pages or shorten history retention, then sync again.",
        },
        413,
      );
    }

    const retentionDays =
      (
        await c.env.DB.prepare(
          "SELECT retention_days FROM users WHERE id=?1",
        )
          .bind(userId)
          .first<{ retention_days: number }>()
      )?.retention_days ?? DEFAULT_RETENTION_DAYS;

    await Promise.all(
      pages.map((page) => {
        const key = textKey(userId, page.id);
        return page.text
          ? c.env.BUCKET.put(key, page.text, {
              httpMetadata: { contentType: "text/plain; charset=utf-8" },
            })
          : c.env.BUCKET.delete(key);
      }),
    );

    const statements: D1PreparedStatement[] = [];
    for (const page of pages) {
      const r2Key = page.text ? textKey(userId, page.id) : null;
      const hash = contentHash(page.text);
      const expiresAt = now + retentionDays * DAY_MS;
      const upsert = legacySchema
        ? c.env.DB.prepare(
            `INSERT INTO pages
              (id,user_id,url,title,visited_at,captured_at,device_id,excerpt,byline,lang,
               r2_key,has_text,content_hash,text_bytes,summary,summary_status,deleted,
               sensitive,seq,expires_at,updated_at)
             VALUES
              (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,NULL,'pending',0,
               ?15,0,?16,?17)
             ON CONFLICT(id) DO UPDATE SET
               url=excluded.url,
               title=excluded.title,
               visited_at=excluded.visited_at,
               captured_at=excluded.captured_at,
               device_id=excluded.device_id,
               excerpt=excluded.excerpt,
               byline=excluded.byline,
               lang=excluded.lang,
               r2_key=excluded.r2_key,
               has_text=excluded.has_text,
               text_bytes=excluded.text_bytes,
               deleted=0,
               seq=0,
               expires_at=excluded.expires_at,
               updated_at=excluded.updated_at,
               summary=CASE
                 WHEN pages.content_hash IS NOT excluded.content_hash THEN NULL
                 ELSE pages.summary
               END,
               summary_status=CASE
                 WHEN pages.content_hash IS NOT excluded.content_hash THEN 'pending'
                 ELSE pages.summary_status
               END,
               sensitive=CASE
                 WHEN pages.content_hash IS NOT excluded.content_hash THEN excluded.sensitive
                 ELSE pages.sensitive
               END,
               content_hash=excluded.content_hash
             WHERE pages.user_id=excluded.user_id`,
          ).bind(
            page.id,
            userId,
            page.url,
            page.title || "(untitled)",
            page.visitedAt,
            now,
            deviceId,
            page.excerpt ?? null,
            page.byline ?? null,
            page.lang ?? null,
            r2Key,
            page.text ? 1 : 0,
            hash,
            textBytes.get(page.id) ?? 0,
            isKnownAdultDomain(page.url) ? 1 : 0,
            expiresAt,
            now,
          )
        : c.env.DB.prepare(
            `INSERT INTO pages
              (id,user_id,url,title,visited_at,captured_at,device_id,excerpt,byline,lang,
               r2_key,content_hash,text_bytes,summary,summary_status,sensitive,expires_at)
             VALUES
              (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,'pending',?14,?15)
             ON CONFLICT(id) DO UPDATE SET
               url=excluded.url,
               title=excluded.title,
               visited_at=excluded.visited_at,
               captured_at=excluded.captured_at,
               device_id=excluded.device_id,
               excerpt=excluded.excerpt,
               byline=excluded.byline,
               lang=excluded.lang,
               r2_key=excluded.r2_key,
               text_bytes=excluded.text_bytes,
               expires_at=excluded.expires_at,
               summary=CASE
                 WHEN pages.content_hash IS NOT excluded.content_hash THEN NULL
                 ELSE pages.summary
               END,
               summary_status=CASE
                 WHEN pages.content_hash IS NOT excluded.content_hash THEN 'pending'
                 ELSE pages.summary_status
               END,
               sensitive=CASE
                 WHEN pages.content_hash IS NOT excluded.content_hash THEN excluded.sensitive
                 ELSE pages.sensitive
               END,
               content_hash=excluded.content_hash
             WHERE pages.user_id=excluded.user_id`,
          ).bind(
            page.id,
            userId,
            page.url,
            page.title || "(untitled)",
            page.visitedAt,
            now,
            deviceId,
            page.excerpt ?? null,
            page.byline ?? null,
            page.lang ?? null,
            r2Key,
            hash,
            textBytes.get(page.id) ?? 0,
            isKnownAdultDomain(page.url) ? 1 : 0,
            expiresAt,
          );
      statements.push(
        upsert,
        c.env.DB.prepare(
          "DELETE FROM pages_fts WHERE page_id=?1 AND user_id=?2",
        ).bind(page.id, userId),
        c.env.DB.prepare(
          `INSERT INTO pages_fts (title,body,url,page_id,user_id)
           VALUES (?1,?2,?3,?4,?5)`,
        ).bind(
          page.title || "",
          page.text,
          page.url,
          page.id,
          userId,
        ),
      );
    }
    await c.env.DB.batch(statements);

    c.executionCtx.waitUntil(
      summarizePages(
        c.env,
        userId,
        pages.map((page) => ({
          id: page.id,
          title: page.title,
          url: page.url,
          text: page.text,
          contentHash: contentHash(page.text),
        })),
      ),
    );

    const response: SyncPushResponse = { accepted: pages.length };
    return c.json(response);
  });

  app.get("/search", async (c) => {
    const userId = c.get("userId");
    const query = c.req.query("q") || "";
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(c.req.query("limit") || "25", 10) || 25),
    );
    const offset = Math.max(
      0,
      Number.parseInt(c.req.query("offset") || "0", 10) || 0,
    );
    const rawFrom = c.req.query("from");
    const rawTo = c.req.query("to");
    const rawSite = c.req.query("site");
    const rawSort = c.req.query("sort") || "relevance";
    const from = parseSearchBoundary(rawFrom);
    const to = parseSearchBoundary(rawTo);
    const site = normalizeSiteFilter(rawSite);
    const sort = parseSearchSort(rawSort);
    if (
      (rawFrom?.trim() && from === null) ||
      (rawTo?.trim() && to === null) ||
      (rawSite?.trim() && site === null) ||
      !sort ||
      (from !== null && to !== null && from >= to)
    ) {
      return c.json(
        {
          error: "invalid_search_filter",
          message: "Check the time range, site, and sort filters.",
        },
        400,
      );
    }
    const match = toMatchQuery(query);
    if (!match) {
      const response: SearchResponse = { query, hits: [], total: 0 };
      return c.json(response);
    }
    const sensitive = (await userFilterSensitive(c.env, userId))
      ? "AND p.sensitive=0"
      : "";
    const active = (await hasLegacyPageColumns(c.env))
      ? "AND p.deleted=0"
      : "";
    const conditions = ["pages_fts MATCH ?1", "p.user_id=?2"];
    const bindings: unknown[] = [match, userId];
    addSearchFilters(conditions, bindings, { from, to, site });
    const where = conditions.join(" AND ");
    const { results } = await c.env.DB.prepare(
      `SELECT p.*,
              snippet(pages_fts,1,'<mark>','</mark>','…',16) AS snippet,
              bm25(pages_fts,5.0,1.0) AS rank
       FROM pages_fts
       JOIN pages p ON p.id=pages_fts.page_id AND p.user_id=pages_fts.user_id
       WHERE ${where} ${sensitive} ${active}
       ORDER BY ${searchOrder(sort)}
       LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`,
    )
      .bind(...bindings, limit, offset)
      .all<PageRow & { snippet: string; rank: number }>();
    const total =
      (
        await c.env.DB.prepare(
          `SELECT count(*) AS n
           FROM pages_fts
           JOIN pages p ON p.id=pages_fts.page_id AND p.user_id=pages_fts.user_id
           WHERE ${where} ${sensitive} ${active}`,
        )
          .bind(...bindings)
          .first<{ n: number }>()
      )?.n ?? results.length;
    const hits: SearchHit[] = results.map((row) => ({
      ...rowToPage(row),
      snippet: row.snippet ?? "",
      rank: row.rank ?? 0,
    }));
    const response: SearchResponse = { query, hits, total };
    return c.json(response);
  });

  app.get("/pages", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(c.req.query("limit") || "50", 10) || 50),
    );
    const before = Math.max(
      0,
      Number.parseInt(c.req.query("before") || "0", 10) || 0,
    );
    const sensitive = (await userFilterSensitive(c.env, userId))
      ? "AND sensitive=0"
      : "";
    const active = (await hasLegacyPageColumns(c.env))
      ? "AND deleted=0"
      : "";
    const statement =
      before > 0
        ? c.env.DB.prepare(
            `SELECT * FROM pages
             WHERE user_id=?1 ${sensitive} ${active} AND visited_at<?2
             ORDER BY visited_at DESC LIMIT ?3`,
          ).bind(userId, before, limit)
        : c.env.DB.prepare(
            `SELECT * FROM pages
             WHERE user_id=?1 ${sensitive} ${active}
             ORDER BY visited_at DESC LIMIT ?2`,
          ).bind(userId, limit);
    const { results } = await statement.all<PageRow>();
    const pages = results.map(rowToPage);
    return c.json({
      pages,
      cursor: pages.length ? pages[pages.length - 1]!.visitedAt : null,
    });
  });

  app.get("/pages/:id", async (c) => {
    const active = (await hasLegacyPageColumns(c.env))
      ? "AND deleted=0"
      : "";
    const row = await c.env.DB.prepare(
      `SELECT * FROM pages WHERE id=?1 AND user_id=?2 ${active}`,
    )
      .bind(c.req.param("id"), c.get("userId"))
      .first<PageRow>();
    if (!row)
      return c.json({ error: "not_found", message: "Page not found." }, 404);
    return c.json(rowToPage(row));
  });

  app.get("/pages/:id/text", async (c) => {
    const active = (await hasLegacyPageColumns(c.env))
      ? "AND deleted=0"
      : "";
    const row = await c.env.DB.prepare(
      `SELECT r2_key FROM pages WHERE id=?1 AND user_id=?2 ${active}`,
    )
      .bind(c.req.param("id"), c.get("userId"))
      .first<{ r2_key: string | null }>();
    if (!row?.r2_key)
      return c.json(
        { error: "not_found", message: "No text for this page." },
        404,
      );
    const object = await c.env.BUCKET.get(row.r2_key);
    if (!object)
      return c.json(
        { error: "not_found", message: "Text object missing." },
        404,
      );
    return new Response(object.body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, max-age=300",
      },
    });
  });

  app.delete("/pages/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const active = (await hasLegacyPageColumns(c.env))
      ? "AND deleted=0"
      : "";
    const exists = await c.env.DB.prepare(
      `SELECT id FROM pages WHERE id=?1 AND user_id=?2 ${active}`,
    )
      .bind(id, userId)
      .first();
    if (!exists)
      return c.json({ error: "not_found", message: "Page not found." }, 404);
    await c.env.DB.batch(deletePageStmts(c.env, userId, [id]));
    c.executionCtx.waitUntil(
      purgeTextObjects(c.env, userId, [id]).then(() => undefined),
    );
    return c.json({ ok: true, id });
  });
}
