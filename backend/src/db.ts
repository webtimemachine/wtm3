import type { NodeInfo, PageRecord, Platform, SummaryStatus } from "@wtm/shared";
import type { Env } from "./env";

/** Shape of a `pages` row as returned by D1. */
export interface PageRow {
  id: string;
  user_id: string;
  url: string;
  title: string;
  visited_at: number;
  captured_at: number;
  device_id: string | null;
  summary: string | null;
  summary_status: string;
  excerpt: string | null;
  byline: string | null;
  lang: string | null;
  r2_key: string | null;
  content_hash: string | null;
  text_bytes: number;
  sensitive: number;
  expires_at: number | null;
}

export function rowToPage(r: PageRow): PageRecord {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    visitedAt: r.visited_at,
    capturedAt: r.captured_at,
    summary: r.summary ?? null,
    summaryStatus: (r.summary_status as SummaryStatus) ?? "pending",
    excerpt: r.excerpt ?? null,
    byline: r.byline ?? null,
    lang: r.lang ?? null,
    deviceId: r.device_id ?? null,
    sensitive: !!r.sensitive,
    expiresAt: r.expires_at ?? null,
    hasText: !!r.r2_key,
  };
}

/** Shape of a `nodes` row as returned by D1. */
export interface NodeRow {
  id: string;
  name: string;
  platform: string;
  created_at: number;
  last_seen_at: number;
}

export function rowToNode(r: NodeRow): NodeInfo {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform as Platform,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

/** True during the brief v4 rollout window before migration 0007 lands. */
export async function hasLegacyPageColumns(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM pragma_table_info('pages') WHERE name='deleted'",
  ).first<{ present: number }>();
  return !!row;
}

/**
 * Whether the search index carries byline/excerpt/summary (migration 0009).
 * Lets a Worker deploy land before its migration without failing ingest.
 */
export async function hasWideFtsColumns(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM pragma_table_info('pages_fts') WHERE name='summary'",
  ).first<{ present: number }>();
  return !!row;
}

/** R2 object key for a page's full readable text. */
export function textKey(userId: string, pageId: string): string {
  return `text/${userId}/${pageId}`;
}

/**
 * Statements that permanently delete pages and their FTS rows. R2 keys are
 * deterministic and are removed separately with purgeTextObjects().
 */
export function deletePageStmts(
  env: Env,
  userId: string,
  ids: string[],
): D1PreparedStatement[] {
  return ids.flatMap((id) => [
    env.DB.prepare("DELETE FROM pages_fts WHERE page_id = ?1 AND user_id = ?2").bind(id, userId),
    env.DB.prepare("DELETE FROM pages WHERE id = ?1 AND user_id = ?2").bind(id, userId),
  ]);
}

/** Best-effort R2 cleanup of deleted pages' text blobs. */
export function purgeTextObjects(env: Env, userId: string, ids: string[]): Promise<unknown> {
  return Promise.all(ids.map((id) => env.BUCKET.delete(textKey(userId, id)).catch(() => {})));
}

/** Cheap, stable 32-bit FNV-1a-style content hash for stale-analysis guards. */
export function contentHash(text: string): string {
  let h = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
