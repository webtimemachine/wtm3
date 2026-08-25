import type {
  HistorySuggestion,
  IndexSnapshotResponse,
  SuggestResponse,
} from "@wtm/shared";
import type { Hono } from "hono";
import { hasLegacyPageColumns } from "../db";
import type { Env, Vars } from "../env";
import { toMatchQuery } from "../search";

type App = Hono<{ Bindings: Env; Variables: Vars }>;

interface SuggestionRow {
  id: string;
  url: string;
  title: string;
  visited_at: number;
  rank?: number;
}

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
]);

/** A conservative identity key: remove fragments and well-known tracking only. */
function suggestionUrlKey(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const name of [...url.searchParams.keys()]) {
      if (name.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(name.toLowerCase())) {
        url.searchParams.delete(name);
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function uniqueSuggestions(rows: SuggestionRow[], limit: number): HistorySuggestion[] {
  const seen = new Set<string>();
  const suggestions: HistorySuggestion[] = [];
  for (const row of rows) {
    const key = suggestionUrlKey(row.url);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      id: row.id,
      url: row.url,
      title: row.title || row.url,
      visitedAt: row.visited_at,
    });
    if (suggestions.length === limit) break;
  }
  return suggestions;
}

function privateMetadata(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
}

export function registerAssistRoutes(app: App): void {
  app.get("/suggest", async (c) => {
    privateMetadata(c);
    const query = (c.req.query("q") || "").trim().slice(0, 256);
    const limit = Math.min(
      10,
      Math.max(1, Number.parseInt(c.req.query("limit") || "6", 10) || 6),
    );
    const match = toMatchQuery(query);
    if (!match) {
      const response: SuggestResponse = { query, suggestions: [] };
      return c.json(response);
    }

    const active = (await hasLegacyPageColumns(c.env)) ? "AND p.deleted=0" : "";
    const candidateLimit = Math.min(60, limit * 8);
    const { results } = await c.env.DB.prepare(
      `SELECT p.id,p.url,p.title,p.visited_at,
              bm25(pages_fts,5.0,1.0,3.0,3.0,1.5,2.0) AS rank
       FROM pages_fts
       JOIN pages p ON p.id=pages_fts.page_id AND p.user_id=pages_fts.user_id
       WHERE pages_fts MATCH ?1 AND p.user_id=?2 AND p.sensitive=0 ${active}
       ORDER BY
         CASE WHEN lower(p.title) LIKE lower(?3) || '%' THEN 0 ELSE 1 END,
         CASE WHEN instr(lower(p.url),lower(?3)) > 0 THEN 0 ELSE 1 END,
         rank ASC,
         p.visited_at DESC
       LIMIT ?4`,
    )
      .bind(match, c.get("userId"), query, candidateLimit)
      .all<SuggestionRow>();

    const response: SuggestResponse = {
      query,
      suggestions: uniqueSuggestions(results, limit),
    };
    return c.json(response);
  });

  app.get("/index-snapshot", async (c) => {
    privateMetadata(c);
    const limit = Math.min(
      5000,
      Math.max(100, Number.parseInt(c.req.query("limit") || "2000", 10) || 2000),
    );
    const active = (await hasLegacyPageColumns(c.env)) ? "AND deleted=0" : "";
    const aggregate = await c.env.DB.prepare(
      `SELECT count(*) AS n,
              COALESCE(max(captured_at),0) AS max_captured,
              COALESCE(max(visited_at),0) AS max_visited
       FROM pages
       WHERE user_id=?1 AND sensitive=0 ${active}`,
    )
      .bind(c.get("userId"))
      .first<{ n: number; max_captured: number; max_visited: number }>();

    const { results } = await c.env.DB.prepare(
      `SELECT id,url,title,visited_at
       FROM pages
       WHERE user_id=?1 AND sensitive=0 ${active}
       ORDER BY visited_at DESC
       LIMIT ?2`,
    )
      .bind(c.get("userId"), Math.min(15_000, limit * 3))
      .all<SuggestionRow>();

    const response: IndexSnapshotResponse = {
      version: `v1:${aggregate?.n ?? 0}:${aggregate?.max_captured ?? 0}:${aggregate?.max_visited ?? 0}`,
      generatedAt: Date.now(),
      items: uniqueSuggestions(results, limit),
    };
    return c.json(response);
  });
}
