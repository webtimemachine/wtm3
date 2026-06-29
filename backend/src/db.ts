import type { PageRecord, SummaryStatus } from "@wtm/shared";
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
  deleted: number;
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
    seq: r.seq,
    expiresAt: r.expires_at ?? null,
    hasText: !!r.has_text,
  };
}

/** R2 object key for a page's full readable text. */
export function textKey(userId: string, pageId: string): string {
  return `text/${userId}/${pageId}`;
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
