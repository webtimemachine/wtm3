import { Hono } from "hono";
import { cors } from "hono/cors";
import type {
  AuthResponse,
  CapturedPage,
  NodeInfo,
  PageRecord,
  SearchHit,
  SearchResponse,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  UserInfo,
} from "@wtm/shared";
import { isValidRetentionDays, MAX_TEXT_CHARS, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from "@wtm/shared";
import type { Env, Vars } from "./env";
import { DUMMY_PASSWORD_HASH, hashPassword, signToken, verifyPassword, verifyToken } from "./auth";
import {
  contentHash,
  purgeTextObjects,
  reserveSeq,
  rowToNode,
  rowToPage,
  textKey,
  tombstonePageStmts,
  type NodeRow,
  type PageRow,
} from "./db";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { toMatchQuery } from "./search";
import { handleMcpPost, mcpRpc } from "./mcp";
import { authorizeForm, authorizeSubmit } from "./oauth";
import { isKnownAdultDomain, summarizePages } from "./summary";

const DAY_MS = 86_400_000;
/** Server-side caps for /sync/push (defense against oversized/abusive payloads). */
const MAX_ITEMS_PER_PUSH = 200;
/** Per-user resource quotas — bound the account (and the Cloudflare bill), not just the request. */
const MAX_NODES_PER_USER = 20;
const MAX_PAGES_PER_USER = 100_000;
const MAX_TEXT_BYTES_PER_USER = 2_000_000_000; // ~2 GB of readable text per user

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type", "MCP-Protocol-Version", "Mcp-Session-Id"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400,
  }),
);

app.get("/health", (c) => c.json({ ok: true, service: "wtm-backend", version: 3 }));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

async function userInfo(env: Env, userId: string): Promise<UserInfo | null> {
  const row = await env.DB.prepare(
    "SELECT id, email, created_at, retention_days, filter_sensitive FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      created_at: number;
      retention_days: number;
      filter_sensitive: number;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    retentionDays: row.retention_days,
    filterSensitive: !!row.filter_sensitive,
  };
}

/** Whether the user's sensitive filter is on (controls hiding in /pages + /search). */
async function userFilterSensitive(env: Env, userId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT filter_sensitive FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ filter_sensitive: number }>();
  return !!r?.filter_sensitive;
}

app.post("/auth/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email) return c.json({ error: "invalid_email", message: "A valid email is required." }, 400);
  if (password.length < 8)
    return c.json({ error: "weak_password", message: "Password must be at least 8 characters." }, 400);

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?1")
    .bind(email)
    .first();
  if (existing) return c.json({ error: "email_taken", message: "That email is already registered." }, 409);

  const id = crypto.randomUUID();
  const now = Date.now();
  const retentionDays = parseInt(c.env.DEFAULT_RETENTION_DAYS || "365", 10) || 365;
  const pw = await hashPassword(password);

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, password_salt, iterations, retention_days, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    ).bind(id, email, pw.hash, pw.salt, pw.iterations, retentionDays, now),
    c.env.DB.prepare("INSERT INTO user_seq (user_id, seq) VALUES (?1, 0)").bind(id),
  ]);

  const token = await signToken(c.env.JWT_SECRET, { userId: id, email });
  const res: AuthResponse = {
    token,
    user: { id, email, createdAt: now, retentionDays, filterSensitive: false },
  };
  return c.json(res, 201);
});

app.post("/auth/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password)
    return c.json({ error: "invalid_credentials", message: "Email and password are required." }, 400);

  const row = await c.env.DB.prepare(
    "SELECT id, email, password_hash, password_salt, iterations, created_at, retention_days, filter_sensitive FROM users WHERE lower(email) = ?1",
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      password_hash: string;
      password_salt: string;
      iterations: number;
      created_at: number;
      retention_days: number;
      filter_sensitive: number;
    }>();

  // Always run a real PBKDF2 verify (decoy hash for unknown emails) so response
  // timing doesn't reveal whether the email exists.
  const stored = row
    ? { hash: row.password_hash, salt: row.password_salt, iterations: row.iterations }
    : DUMMY_PASSWORD_HASH;
  const passwordOk = await verifyPassword(password, stored);
  if (!row || !passwordOk)
    return c.json({ error: "invalid_credentials", message: "Incorrect email or password." }, 401);

  const token = await signToken(c.env.JWT_SECRET, { userId: row.id, email: row.email });
  const res: AuthResponse = {
    token,
    user: {
      id: row.id,
      email: row.email,
      createdAt: row.created_at,
      retentionDays: row.retention_days,
      filterSensitive: !!row.filter_sensitive,
    },
  };
  return c.json(res);
});

// ---------------------------------------------------------------------------
// Beta tester signup (public — the "Join the beta" form)
// ---------------------------------------------------------------------------

app.post("/beta/signup", async (c) => {
  const body = await c.req.json().catch(() => null);
  // Honeypot: real users never fill these hidden fields; bots do. Pretend success.
  if (body?.website || body?.company) return c.json({ ok: true });

  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ error: "invalid_email", message: "A valid email is required." }, 400);
  const allowed = ["ios", "chrome", "web", "any"];
  const platform = allowed.includes(body?.platform) ? body.platform : "any";
  const note = typeof body?.note === "string" ? body.note.slice(0, 500) : null;
  const ip = c.req.header("CF-Connecting-IP") || "";
  const now = Date.now();

  // Light per-IP rate limit: at most 5 signups/minute from one address.
  if (ip) {
    const recent = await c.env.DB.prepare(
      "SELECT count(*) AS n FROM beta_signups WHERE ip = ?1 AND created_at > ?2",
    )
      .bind(ip, now - 60_000)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= 5)
      return c.json({ error: "rate_limited", message: "Too many signups — try again shortly." }, 429);
  }

  await c.env.DB.prepare(
    `INSERT INTO beta_signups (id, email, platform, note, ip, created_at) VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(email) DO UPDATE SET platform=excluded.platform, note=excluded.note, created_at=excluded.created_at`,
  )
    .bind(crypto.randomUUID(), email, platform, note, ip, now)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Auth middleware for everything below
// ---------------------------------------------------------------------------

const protectedPaths = [
  "/auth/me",
  "/settings",
  "/nodes",
  "/nodes/*",
  "/sync/*",
  "/search",
  "/pages",
  "/pages/*",
  "/diagnostics",
  "/mcp",
];
for (const p of protectedPaths) {
  app.use(p, async (c, next) => {
    const header = c.req.header("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const claims = token ? await verifyToken(c.env.JWT_SECRET, token) : null;
    if (!claims) return c.json({ error: "unauthorized", message: "Missing or invalid token." }, 401);
    c.set("userId", claims.userId);
    c.set("email", claims.email);
    await next();
  });
}

app.get("/auth/me", async (c) => {
  const info = await userInfo(c.env, c.get("userId"));
  if (!info) return c.json({ error: "not_found", message: "User not found." }, 404);
  return c.json(info);
});

app.patch("/settings", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const sets: string[] = [];
  const binds: unknown[] = [];
  let retentionChanged: number | null = null;

  if (body?.retentionDays !== undefined) {
    const d = Number(body.retentionDays);
    if (!isValidRetentionDays(d))
      return c.json(
        { error: "invalid_retention", message: `Retention must be ${RETENTION_MIN_DAYS}–${RETENTION_MAX_DAYS} days.` },
        400,
      );
    sets.push(`retention_days = ?${binds.length + 1}`);
    binds.push(d);
    retentionChanged = d;
  }
  if (body?.filterSensitive !== undefined) {
    sets.push(`filter_sensitive = ?${binds.length + 1}`);
    binds.push(body.filterSensitive ? 1 : 0);
  }
  if (sets.length) {
    binds.push(userId);
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?${binds.length}`)
      .bind(...binds)
      .run();
  }
  // Recompute existing pages' expiry when retention changes.
  if (retentionChanged !== null) {
    await c.env.DB.prepare("UPDATE pages SET expires_at = visited_at + ?1 WHERE user_id = ?2")
      .bind(retentionChanged * DAY_MS, userId)
      .run();
  }

  const info = await userInfo(c.env, userId);
  if (!info) return c.json({ error: "not_found", message: "User not found." }, 404);
  return c.json(info);
});

// ---------------------------------------------------------------------------
// Nodes (devices)
// ---------------------------------------------------------------------------

app.post("/nodes", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 128) : "Unnamed device";
  const platform = typeof body?.platform === "string" ? body.platform.slice(0, 64) : "unknown";
  const supplied = typeof body?.id === "string" && body.id ? body.id.slice(0, 128) : null;
  const now = Date.now();

  // Re-registering a node this user already owns: refresh it in place.
  if (supplied) {
    const res = await c.env.DB.prepare(
      "UPDATE nodes SET name=?1, platform=?2, last_seen_at=?3 WHERE id=?4 AND user_id=?5",
    )
      .bind(name, platform, now, supplied, userId)
      .run();
    if (res.meta.changes) {
      const node: NodeInfo = { id: supplied, name, platform, createdAt: now, lastSeenAt: now };
      return c.json(node, 201);
    }
  }

  // New node: cap devices per user. At the cap, reuse the most recent node with
  // the same name+platform so repeat registrations (misbehaving or pre-3.0.2
  // clients that lost their deviceId) converge instead of growing the table.
  const count =
    (await c.env.DB.prepare("SELECT count(*) AS n FROM nodes WHERE user_id = ?1")
      .bind(userId)
      .first<{ n: number }>())?.n ?? 0;
  if (count >= MAX_NODES_PER_USER) {
    const reuse = await c.env.DB.prepare(
      "SELECT id, created_at FROM nodes WHERE user_id=?1 AND name=?2 AND platform=?3 ORDER BY last_seen_at DESC LIMIT 1",
    )
      .bind(userId, name, platform)
      .first<{ id: string; created_at: number }>();
    if (reuse) {
      await c.env.DB.prepare("UPDATE nodes SET last_seen_at=?1 WHERE id=?2 AND user_id=?3")
        .bind(now, reuse.id, userId)
        .run();
      const node: NodeInfo = { id: reuse.id, name, platform, createdAt: reuse.created_at, lastSeenAt: now };
      return c.json(node, 201);
    }
    return c.json(
      { error: "too_many_devices", message: `Device limit (${MAX_NODES_PER_USER}) reached. Remove an unused device first.` },
      409,
    );
  }

  const id = supplied ?? crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO nodes (id, user_id, name, platform, created_at, last_seen_at)
     VALUES (?1,?2,?3,?4,?5,?5)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(id, userId, name, platform, now)
    .run();
  const owned = await c.env.DB.prepare("SELECT id FROM nodes WHERE id=?1 AND user_id=?2").bind(id, userId).first();
  if (!owned) return c.json({ error: "node_id_taken", message: "That device id is unavailable." }, 409);

  const node: NodeInfo = { id, name, platform, createdAt: now, lastSeenAt: now };
  return c.json(node, 201);
});

app.get("/nodes", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, platform, created_at, last_seen_at FROM nodes WHERE user_id = ?1 ORDER BY last_seen_at DESC",
  )
    .bind(userId)
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

  const res = await c.env.DB.prepare("UPDATE nodes SET name = ?1 WHERE id = ?2 AND user_id = ?3")
    .bind(name, id, userId)
    .run();
  if (!res.meta.changes) return c.json({ error: "not_found", message: "Device not found." }, 404);

  const row = await c.env.DB.prepare(
    "SELECT id, name, platform, created_at, last_seen_at FROM nodes WHERE id = ?1 AND user_id = ?2",
  )
    .bind(id, userId)
    .first<NodeRow>();
  return c.json(rowToNode(row!));
});

// ---------------------------------------------------------------------------
// Sync — push
// ---------------------------------------------------------------------------

app.post("/sync/push", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => null)) as SyncPushRequest | null;
  const now = Date.now();
  const deviceId = typeof body?.deviceId === "string" ? body!.deviceId.slice(0, 128) : null;

  // Validate + clamp client input (don't trust payload size/shape).
  const rawPages = Array.isArray(body?.pages) ? body!.pages.slice(0, MAX_ITEMS_PER_PUSH) : [];
  const pages: CapturedPage[] = [];
  for (const p of rawPages) {
    if (!p || typeof p.id !== "string" || p.id.length < 1 || p.id.length > 128) continue;
    if (typeof p.url !== "string" || p.url.length > 2048 || !/^https?:\/\//i.test(p.url)) continue;
    const vt = Number(p.visitedAt);
    pages.push({
      id: p.id,
      url: p.url,
      title: typeof p.title === "string" ? p.title.slice(0, 1024) : "(untitled)",
      visitedAt: Number.isFinite(vt) ? Math.min(Math.max(vt, 0), now + DAY_MS) : now,
      text: typeof p.text === "string" ? p.text.slice(0, MAX_TEXT_CHARS) : "",
      excerpt: typeof p.excerpt === "string" ? p.excerpt.slice(0, 4096) : null,
      byline: typeof p.byline === "string" ? p.byline.slice(0, 512) : null,
      lang: typeof p.lang === "string" ? p.lang.slice(0, 32) : null,
    });
  }
  const deletes: string[] = (Array.isArray(body?.deletes) ? body!.deletes : [])
    .filter((d): d is string => typeof d === "string" && d.length >= 1 && d.length <= 128)
    .slice(0, MAX_ITEMS_PER_PUSH);

  if (deviceId) {
    await c.env.DB.prepare("UPDATE nodes SET last_seen_at = ?1 WHERE id = ?2 AND user_id = ?3")
      .bind(now, deviceId, userId)
      .run();
  }

  const changeCount = pages.length + deletes.length;
  if (changeCount === 0) {
    const cur = await c.env.DB.prepare("SELECT seq FROM user_seq WHERE user_id = ?1")
      .bind(userId)
      .first<{ seq: number }>();
    const res: SyncPushResponse = { accepted: 0, deleted: 0, seq: cur?.seq ?? 0 };
    return c.json(res);
  }

  // Per-user storage quota. Checked only when the push adds pages — deletes
  // always go through, so a full account can still free space by syncing.
  // Re-pushed pages count their new size on top of the old row's until the
  // upsert lands (slight overcount, fine for a growth bound).
  const textBytes = new Map<string, number>();
  for (const p of pages) textBytes.set(p.id, p.text ? new TextEncoder().encode(p.text).length : 0);
  if (pages.length) {
    const usage = await c.env.DB.prepare(
      "SELECT count(*) AS n, COALESCE(SUM(text_bytes),0) AS bytes FROM pages WHERE user_id = ?1 AND deleted = 0",
    )
      .bind(userId)
      .first<{ n: number; bytes: number }>();
    const incoming = [...textBytes.values()].reduce((a, b) => a + b, 0);
    if (
      (usage?.n ?? 0) + pages.length > MAX_PAGES_PER_USER ||
      (usage?.bytes ?? 0) + incoming > MAX_TEXT_BYTES_PER_USER
    ) {
      return c.json(
        {
          error: "storage_quota_exceeded",
          message: "Account storage is full. Delete pages or shorten history retention, then sync again.",
        },
        413,
      );
    }
  }

  const retentionDays =
    (await c.env.DB.prepare("SELECT retention_days FROM users WHERE id = ?1")
      .bind(userId)
      .first<{ retention_days: number }>())?.retention_days ?? 365;

  // Reserve a contiguous seq range; assign incrementally.
  const top = await reserveSeq(c.env, userId, changeCount);
  let seq = top - changeCount;

  // Store full readable text in R2 (parallel), keyed per user+page.
  await Promise.all(
    pages.map((p) =>
      p.text
        ? c.env.BUCKET.put(textKey(userId, p.id), p.text, {
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
          })
        : Promise.resolve(null),
    ),
  );

  const stmts: D1PreparedStatement[] = [];
  for (const p of pages) {
    seq++;
    const hasText = p.text ? 1 : 0;
    const r2key = p.text ? textKey(userId, p.id) : null;
    const ch = contentHash(p.text || "");
    const sensSeed = isKnownAdultDomain(p.url) ? 1 : 0;
    const expiresAt = p.visitedAt + retentionDays * DAY_MS;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO pages
          (id,user_id,url,title,visited_at,captured_at,device_id,excerpt,byline,lang,r2_key,has_text,content_hash,text_bytes,summary,summary_status,deleted,sensitive,seq,expires_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,NULL,'pending',0,?15,?16,?17,?18)
         ON CONFLICT(id) DO UPDATE SET
           url=excluded.url, title=excluded.title, visited_at=excluded.visited_at,
           captured_at=excluded.captured_at, device_id=excluded.device_id,
           excerpt=excluded.excerpt, byline=excluded.byline, lang=excluded.lang,
           r2_key=excluded.r2_key, has_text=excluded.has_text, text_bytes=excluded.text_bytes,
           deleted=0, seq=excluded.seq, expires_at=excluded.expires_at, updated_at=excluded.updated_at,
           summary = CASE WHEN pages.content_hash IS NOT excluded.content_hash THEN NULL ELSE pages.summary END,
           summary_status = CASE WHEN pages.content_hash IS NOT excluded.content_hash THEN 'pending' ELSE pages.summary_status END,
           sensitive = CASE WHEN pages.content_hash IS NOT excluded.content_hash THEN excluded.sensitive ELSE pages.sensitive END,
           content_hash = excluded.content_hash
         WHERE pages.user_id = excluded.user_id`,
      ).bind(
        p.id,
        userId,
        p.url,
        p.title || "(untitled)",
        p.visitedAt,
        now,
        deviceId,
        p.excerpt ?? null,
        p.byline ?? null,
        p.lang ?? null,
        r2key,
        hasText,
        ch,
        textBytes.get(p.id) ?? 0,
        sensSeed,
        seq,
        expiresAt,
        now,
      ),
      c.env.DB.prepare("DELETE FROM pages_fts WHERE page_id = ?1 AND user_id = ?2").bind(p.id, userId),
      c.env.DB.prepare(
        "INSERT INTO pages_fts (title, body, url, page_id, user_id) VALUES (?1,?2,?3,?4,?5)",
      ).bind(p.title || "", p.text || "", p.url, p.id, userId),
    );
  }

  stmts.push(...tombstonePageStmts(c.env, userId, deletes, seq + 1, now));
  seq += deletes.length;

  await c.env.DB.batch(stmts);

  // Purge R2 for deleted pages (best effort, in background).
  if (deletes.length) {
    c.executionCtx.waitUntil(purgeTextObjects(c.env, userId, deletes).then(() => undefined));
  }

  // Generate summaries in the background; this bumps seq further as they land.
  const toSummarize = pages.map((p) => ({
    id: p.id,
    title: p.title,
    url: p.url,
    text: p.text,
    contentHash: contentHash(p.text || ""),
  }));
  if (toSummarize.length) {
    c.executionCtx.waitUntil(summarizePages(c.env, userId, toSummarize));
  }

  const res: SyncPushResponse = { accepted: pages.length, deleted: deletes.length, seq: top };
  return c.json(res);
});

// ---------------------------------------------------------------------------
// Sync — pull
// ---------------------------------------------------------------------------

app.get("/sync/pull", async (c) => {
  const userId = c.get("userId");
  const since = Math.max(0, parseInt(c.req.query("since") || "0", 10) || 0);
  const limit = Math.min(1000, Math.max(1, parseInt(c.req.query("limit") || "500", 10) || 500));

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM pages WHERE user_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
  )
    .bind(userId, since, limit)
    .all<PageRow>();

  const changes: PageRecord[] = results.map(rowToPage);
  const cursor = changes.length ? changes[changes.length - 1]!.seq : since;
  const res: SyncPullResponse = { changes, cursor, hasMore: changes.length === limit };
  return c.json(res);
});

// ---------------------------------------------------------------------------
// MCP — recall interface for Claude and other MCP clients (see mcp.ts)
// ---------------------------------------------------------------------------

app.post("/mcp", handleMcpPost);
// Stateless server: no SSE listen stream, no sessions to delete.
app.get("/mcp", (c) => c.json({ error: "method_not_allowed", message: "POST JSON-RPC messages to /mcp." }, 405));
app.delete("/mcp", (c) => c.json({ error: "method_not_allowed", message: "Stateless server — no session to delete." }, 405));

// OAuth login/consent screen (token/register/metadata endpoints are handled by
// OAuthProvider in the default export below and never reach this app).
app.get("/oauth/authorize", authorizeForm);
app.post("/oauth/authorize", authorizeSubmit);

// ---------------------------------------------------------------------------
// Search (FTS5, BM25)
// ---------------------------------------------------------------------------

app.get("/search", async (c) => {
  const userId = c.get("userId");
  const q = c.req.query("q") || "";
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "25", 10) || 25));
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10) || 0);

  const match = toMatchQuery(q);
  if (!match) {
    const empty: SearchResponse = { query: q, hits: [], total: 0 };
    return c.json(empty);
  }

  const sens = (await userFilterSensitive(c.env, userId)) ? "AND p.sensitive = 0" : "";

  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
            snippet(pages_fts, 1, '<mark>', '</mark>', '…', 16) AS snippet,
            bm25(pages_fts, 5.0, 1.0) AS rank
     FROM pages_fts
     JOIN pages p ON p.id = pages_fts.page_id AND p.user_id = pages_fts.user_id
     WHERE pages_fts MATCH ?1 AND p.user_id = ?2 AND p.deleted = 0 ${sens}
     ORDER BY rank
     LIMIT ?3 OFFSET ?4`,
  )
    .bind(match, userId, limit, offset)
    .all<PageRow & { snippet: string; rank: number }>();

  const total =
    (await c.env.DB.prepare(
      `SELECT count(*) AS n FROM pages_fts
       JOIN pages p ON p.id = pages_fts.page_id AND p.user_id = pages_fts.user_id
       WHERE pages_fts MATCH ?1 AND p.user_id = ?2 AND p.deleted = 0 ${sens}`,
    )
      .bind(match, userId)
      .first<{ n: number }>())?.n ?? results.length;

  const hits: SearchHit[] = results.map((r) => ({
    ...rowToPage(r),
    snippet: r.snippet ?? "",
    rank: r.rank ?? 0,
  }));
  const res: SearchResponse = { query: q, hits, total };
  return c.json(res);
});

// ---------------------------------------------------------------------------
// Pages — fetch, full text, delete
// ---------------------------------------------------------------------------

app.get("/pages", async (c) => {
  const userId = c.get("userId");
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") || "50", 10) || 50));
  const before = Math.max(0, parseInt(c.req.query("before") || "0", 10) || 0);
  const sens = (await userFilterSensitive(c.env, userId)) ? "AND sensitive = 0" : "";

  const stmt =
    before > 0
      ? c.env.DB.prepare(
          `SELECT * FROM pages WHERE user_id=?1 AND deleted=0 ${sens} AND visited_at < ?2 ORDER BY visited_at DESC LIMIT ?3`,
        ).bind(userId, before, limit)
      : c.env.DB.prepare(
          `SELECT * FROM pages WHERE user_id=?1 AND deleted=0 ${sens} ORDER BY visited_at DESC LIMIT ?2`,
        ).bind(userId, limit);

  const { results } = await stmt.all<PageRow>();
  const pages = results.map(rowToPage);
  const cursor = pages.length ? pages[pages.length - 1]!.visitedAt : null;
  return c.json({ pages, cursor });
});

app.get("/pages/:id", async (c) => {
  const userId = c.get("userId");
  const row = await c.env.DB.prepare("SELECT * FROM pages WHERE id = ?1 AND user_id = ?2")
    .bind(c.req.param("id"), userId)
    .first<PageRow>();
  if (!row || row.deleted) return c.json({ error: "not_found", message: "Page not found." }, 404);
  return c.json(rowToPage(row));
});

app.get("/pages/:id/text", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT r2_key, has_text FROM pages WHERE id = ?1 AND user_id = ?2 AND deleted = 0",
  )
    .bind(id, userId)
    .first<{ r2_key: string | null; has_text: number }>();
  if (!row || !row.r2_key) return c.json({ error: "not_found", message: "No text for this page." }, 404);

  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) return c.json({ error: "not_found", message: "Text object missing." }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, max-age=300" },
  });
});

app.delete("/pages/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const exists = await c.env.DB.prepare(
    "SELECT id FROM pages WHERE id = ?1 AND user_id = ?2 AND deleted = 0",
  )
    .bind(id, userId)
    .first();
  if (!exists) return c.json({ error: "not_found", message: "Page not found." }, 404);

  const seq = await reserveSeq(c.env, userId, 1);
  await c.env.DB.batch(tombstonePageStmts(c.env, userId, [id], seq, Date.now()));
  c.executionCtx.waitUntil(purgeTextObjects(c.env, userId, [id]).then(() => undefined));

  return c.json({ ok: true, id, seq });
});

// ---------------------------------------------------------------------------
// Diagnostics — self-reported client state (e.g. the popup's "report a
// stuck sync" button). Stored as opaque JSON; only lightly validated, since
// the whole point is to see whatever the client actually observed.
// ---------------------------------------------------------------------------

const MAX_DIAGNOSTIC_BYTES = 8_000;

app.post("/diagnostics", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_body", message: "A JSON diagnostic report is required." }, 400);
  }
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.slice(0, 128) : null;
  // Over-cap reports are stored as a VALID JSON wrapper with the head inside
  // a string value — a raw slice() would cut mid-token and store unparseable
  // JSON, defeating the entire "opaque but readable" purpose.
  const serialized = JSON.stringify(body);
  const payload =
    serialized.length <= MAX_DIAGNOSTIC_BYTES
      ? serialized
      : JSON.stringify({
          truncated: true,
          originalChars: serialized.length,
          head: serialized.slice(0, MAX_DIAGNOSTIC_BYTES - 200),
        });

  await c.env.DB.prepare(
    "INSERT INTO diagnostic_reports (id, user_id, device_id, payload, created_at) VALUES (?1,?2,?3,?4,?5)",
  )
    .bind(crypto.randomUUID(), userId, deviceId, payload, Date.now())
    .run();

  return c.json({ ok: true }, 201);
});

app.notFound((c) => c.json({ error: "not_found", message: "No such route." }, 404));
app.onError((err, c) => {
  console.error("unhandled", err);
  return c.json({ error: "internal", message: "Something went wrong." }, 500);
});

// ---------------------------------------------------------------------------
// Retention cron — tombstone expired pages and purge their text from R2.
// ---------------------------------------------------------------------------

async function runRetention(env: Env): Promise<number> {
  const now = Date.now();
  let purged = 0;

  for (let round = 0; round < 20; round++) {
    const { results } = await env.DB.prepare(
      `SELECT id, user_id FROM pages
       WHERE deleted = 0 AND expires_at IS NOT NULL AND expires_at < ?1
       LIMIT 500`,
    )
      .bind(now)
      .all<{ id: string; user_id: string }>();
    if (results.length === 0) break;

    // Group by user so each gets a contiguous seq range.
    const byUser = new Map<string, string[]>();
    for (const r of results) {
      const arr = byUser.get(r.user_id) ?? [];
      arr.push(r.id);
      byUser.set(r.user_id, arr);
    }

    for (const [userId, ids] of byUser) {
      const top = await reserveSeq(env, userId, ids.length);
      await env.DB.batch(tombstonePageStmts(env, userId, ids, top - ids.length + 1, now));
      await purgeTextObjects(env, userId, ids);
      purged += ids.length;
    }
  }
  return purged;
}

// ---------------------------------------------------------------------------
// Worker entry: OAuth wrapper + dual-auth /mcp
// ---------------------------------------------------------------------------

// OAuthProvider owns /oauth/token, /oauth/register, the .well-known metadata
// endpoints, and — for OAuth bearer tokens — /mcp (validated tokens land in
// mcpApiHandler with the grant's props). Everything else falls through to the
// Hono app above.
const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      if (request.method !== "POST")
        return new Response(JSON.stringify({ error: "method_not_allowed", message: "POST JSON-RPC to /mcp." }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        });
      const props = (ctx as ExecutionContext & { props?: { userId?: string } }).props;
      if (!props?.userId) return new Response("Unauthorized", { status: 401 });
      return mcpRpc(env, props.userId, request);
    },
  },
  defaultHandler: { fetch: app.fetch },
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["history:read"],
});

export default {
  /**
   * Dual auth for /mcp: a WTM session JWT in the Authorization header (Claude
   * Code / Desktop with --header) bypasses the OAuth layer straight into the
   * Hono route; anything else — including OAuth access tokens and
   * unauthenticated discovery probes — goes through OAuthProvider, which
   * serves the 401 + WWW-Authenticate challenge that OAuth clients (claude.ai)
   * use to find the authorization server.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const header = request.headers.get("Authorization") || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (token && (await verifyToken(env.JWT_SECRET, token))) return app.fetch(request, env, ctx);
    }
    return provider.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runRetention(env).then((n) => {
        if (n) console.log(`retention: purged ${n} expired pages`);
      }),
    );
    // Garbage-collect expired OAuth tokens/grants alongside page retention.
    ctx.waitUntil(provider.purgeExpiredData(env).then(() => undefined));
  },
};
