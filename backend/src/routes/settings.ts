import {
  isValidRetentionDays,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
} from "@wtm/shared";
import type { Hono } from "hono";
import { userInfo } from "../account";
import { DAY_MS } from "../constants";
import type { Env, Vars } from "../env";

export function registerSettingsRoutes(
  app: Hono<{ Bindings: Env; Variables: Vars }>,
): void {
  app.patch("/settings", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => null);
    const sets: string[] = [];
    const binds: unknown[] = [];
    let retentionDays: number | null = null;

    if (body?.retentionDays !== undefined) {
      const days = Number(body.retentionDays);
      if (!isValidRetentionDays(days))
        return c.json(
          {
            error: "invalid_retention",
            message: `Retention must be ${RETENTION_MIN_DAYS}–${RETENTION_MAX_DAYS} days.`,
          },
          400,
        );
      sets.push(`retention_days = ?${binds.length + 1}`);
      binds.push(days);
      retentionDays = days;
    }
    if (body?.filterSensitive !== undefined) {
      sets.push(`filter_sensitive = ?${binds.length + 1}`);
      binds.push(body.filterSensitive ? 1 : 0);
    }
    if (sets.length) {
      binds.push(userId);
      await c.env.DB.prepare(
        `UPDATE users SET ${sets.join(", ")} WHERE id = ?${binds.length}`,
      )
        .bind(...binds)
        .run();
    }

    if (retentionDays !== null) {
      await c.env.DB.prepare(
        "UPDATE pages SET expires_at = captured_at + ?1 WHERE user_id = ?2",
      )
        .bind(retentionDays * DAY_MS, userId)
        .run();
    }

    const info = await userInfo(c.env, userId);
    if (!info) return c.json({ error: "not_found", message: "User not found." }, 404);
    return c.json(info);
  });
}
