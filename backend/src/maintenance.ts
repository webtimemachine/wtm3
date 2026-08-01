import {
  deletePageStmts,
  hasLegacyPageColumns,
  purgeTextObjects,
} from "./db";
import type { Env } from "./env";

export async function runRetention(env: Env): Promise<number> {
  const now = Date.now();
  let purged = 0;
  const active = (await hasLegacyPageColumns(env))
    ? "AND deleted=0"
    : "";

  for (let round = 0; round < 20; round++) {
    const { results } = await env.DB.prepare(
      `SELECT id,user_id FROM pages
       WHERE expires_at IS NOT NULL AND expires_at<?1 ${active}
       LIMIT 500`,
    )
      .bind(now)
      .all<{ id: string; user_id: string }>();
    if (!results.length) break;

    const byUser = new Map<string, string[]>();
    for (const row of results) {
      const ids = byUser.get(row.user_id) ?? [];
      ids.push(row.id);
      byUser.set(row.user_id, ids);
    }
    for (const [userId, ids] of byUser) {
      await env.DB.batch(deletePageStmts(env, userId, ids));
      await purgeTextObjects(env, userId, ids);
      purged += ids.length;
    }
  }
  return purged;
}

export async function purgeExpiredCredentials(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?1").bind(now),
    env.DB.prepare(
      "DELETE FROM password_reset_tokens WHERE expires_at<=?1",
    ).bind(now),
  ]);
}
