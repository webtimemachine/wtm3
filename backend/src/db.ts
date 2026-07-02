import type { NodeInfo, PageRecord, SummaryStatus } from "@wtm/shared";
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
  has_text: number;
  content_hash: string | null;
  text_bytes: number;
  deleted: number;
  sensitive: number;
  seq: number;
  expires_at: number | null;
  updated_at: number;
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
    deleted: !!r.deleted,
    sensitive: !!r.sensitive,
    seq: r.seq,
    expiresAt: r.expires_at ?? null,
    hasText: !!r.has_text,
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
    platform: r.platform,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

/** R2 object key for a page's full readable text. */
export function textKey(userId: string, pageId: string): string {
  return `text/${userId}/${pageId}`;
}

/**
 * Statements that soft-delete pages: tombstone the row (clearing text
 * bookkeeping) and drop it from the FTS index. The single definition all three
 * delete paths (sync push, DELETE /pages/:id, retention cron) share — pass the
 * first seq of a range already reserved via reserveSeq. Pair with
 * purgeTextObjects for the R2 side.
 */
export function tombstonePageStmts(
  env: Env,
  userId: string,
  ids: string[],
  firstSeq: number,
  now: number,
): D1PreparedStatement[] {
  return ids.flatMap((id, i) => [
    env.DB.prepare(
      "UPDATE pages SET deleted=1, has_text=0, r2_key=NULL, text_bytes=0, seq=?1, updated_at=?2 WHERE id=?3 AND user_id=?4",
    ).bind(firstSeq + i, now, id, userId),
    env.DB.prepare("DELETE FROM pages_fts WHERE page_id = ?1 AND user_id = ?2").bind(id, userId),
  ]);
}

/** Best-effort R2 cleanup of deleted pages' text blobs. */
export function purgeTextObjects(env: Env, userId: string, ids: string[]): Promise<unknown> {
  return Promise.all(ids.map((id) => env.BUCKET.delete(textKey(userId, id)).catch(() => {})));
}

/**
 * Atomically reserve `n` change sequence numbers for a user.
 * Returns the new high-water mark; the reserved range is (result - n, result].
 */
export async function reserveSeq(env: Env, userId: string, n: number): Promise<number> {
  const row = await env.DB.prepare(
    "UPDATE user_seq SET seq = seq + ?1 WHERE user_id = ?2 RETURNING seq",
  )
    .bind(n, userId)
    .first<{ seq: number }>();
  if (!row) throw new Error(`no user_seq row for ${userId}`);
  return row.seq;
}

/** Cheap, stable 53-bit content hash (FNV-1a style) for change detection. */
export function contentHash(text: string): string {
  let h = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
