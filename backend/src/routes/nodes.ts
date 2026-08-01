import type { NodeInfo, Platform } from "@wtm/shared";
import type { Hono } from "hono";
import { MAX_NODES_PER_USER } from "../constants";
import { rowToNode, type NodeRow } from "../db";
import type { Env, Vars } from "../env";

type App = Hono<{ Bindings: Env; Variables: Vars }>;

function platform(value: unknown): Platform | null {
  return value === "chrome" ||
    value === "firefox-android" ||
    value === "safari-ios" ||
    value === "web" ||
    value === "cli"
    ? value
    : null;
}

export function registerNodeRoutes(app: App): void {
  app.post("/nodes", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => null);
    const name =
      typeof body?.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, 128)
        : "Unnamed device";
    const nodePlatform = platform(body?.platform);
    const supplied =
      typeof body?.id === "string" && body.id
        ? body.id.slice(0, 128)
        : null;
    const now = Date.now();
    if (!nodePlatform)
      return c.json({ error: "invalid_platform", message: "Unknown device platform." }, 400);

    if (supplied) {
      const result = await c.env.DB.prepare(
        "UPDATE nodes SET name=?1, platform=?2, last_seen_at=?3 WHERE id=?4 AND user_id=?5",
      )
        .bind(name, nodePlatform, now, supplied, userId)
        .run();
      if (result.meta.changes) {
        const row = await c.env.DB.prepare(
          "SELECT id,name,platform,created_at,last_seen_at FROM nodes WHERE id=?1 AND user_id=?2",
        )
          .bind(supplied, userId)
          .first<NodeRow>();
        return c.json(rowToNode(row!), 201);
      }
    }

    const count =
      (
        await c.env.DB.prepare("SELECT count(*) AS n FROM nodes WHERE user_id = ?1")
          .bind(userId)
          .first<{ n: number }>()
      )?.n ?? 0;
    if (count >= MAX_NODES_PER_USER) {
      const reuse = await c.env.DB.prepare(
        `SELECT id,name,platform,created_at,last_seen_at FROM nodes
         WHERE user_id=?1 AND name=?2 AND platform=?3
         ORDER BY last_seen_at DESC LIMIT 1`,
      )
        .bind(userId, name, nodePlatform)
        .first<NodeRow>();
      if (reuse) {
        await c.env.DB.prepare(
          "UPDATE nodes SET last_seen_at=?1 WHERE id=?2 AND user_id=?3",
        )
          .bind(now, reuse.id, userId)
          .run();
        return c.json(rowToNode({ ...reuse, last_seen_at: now }), 201);
      }
      return c.json(
        {
          error: "too_many_devices",
          message: `Device limit (${MAX_NODES_PER_USER}) reached. Remove an unused device first.`,
        },
        409,
      );
    }

    const id = supplied ?? crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO nodes (id,user_id,name,platform,created_at,last_seen_at)
       VALUES (?1,?2,?3,?4,?5,?5)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(id, userId, name, nodePlatform, now)
      .run();
    const owned = await c.env.DB.prepare(
      "SELECT id FROM nodes WHERE id=?1 AND user_id=?2",
    )
      .bind(id, userId)
      .first();
    if (!owned)
      return c.json({ error: "node_id_taken", message: "That device id is unavailable." }, 409);

    const node: NodeInfo = {
      id,
      name,
      platform: nodePlatform,
      createdAt: now,
      lastSeenAt: now,
    };
    return c.json(node, 201);
  });

  app.get("/nodes", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id,name,platform,created_at,last_seen_at
       FROM nodes WHERE user_id=?1 ORDER BY last_seen_at DESC`,
    )
      .bind(c.get("userId"))
      .all<NodeRow>();
    return c.json({ nodes: results.map(rowToNode) });
  });

  app.patch("/nodes/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 128)
      return c.json({ error: "invalid_name", message: "Name must be 1–128 characters." }, 400);

    const result = await c.env.DB.prepare(
      "UPDATE nodes SET name=?1 WHERE id=?2 AND user_id=?3",
    )
      .bind(name, id, userId)
      .run();
    if (!result.meta.changes)
      return c.json({ error: "not_found", message: "Device not found." }, 404);

    const row = await c.env.DB.prepare(
      "SELECT id,name,platform,created_at,last_seen_at FROM nodes WHERE id=?1 AND user_id=?2",
    )
      .bind(id, userId)
      .first<NodeRow>();
    return c.json(rowToNode(row!));
  });
}
