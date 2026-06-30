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
import type { Env, Vars } from "./env";
import { DUMMY_PASSWORD_HASH, hashPassword, signToken, verifyPassword, verifyToken } from "./auth";
import { contentHash, reserveSeq, rowToPage, textKey, type PageRow } from "./db";
import { toMatchQuery } from "./search";
import { summarizePages } from "./summary";

const DAY_MS = 86_400_000;
/** Server-side caps for /sync/push (defense against oversized/abusive payloads). */
const MAX_TEXT_CHARS = 200_000;
const MAX_ITEMS_PER_PUSH = 200;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
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
    "SELECT id, email, created_at, retention_days FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{ id: string; email: string; created_at: number; retention_days: number }>();
  if (!row) return null;
  return { id: row.id, email: row.email, createdAt: row.created_at, retentionDays: row.retention_days };
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
    user: { id, email, createdAt: now, retentionDays },
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
    "SELECT id, email, password_hash, password_salt, iterations, created_at, retention_days FROM users WHERE lower(email) = ?1",
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
    user: { id: row.id, email: row.email, createdAt: row.created_at, retentionDays: row.retention_days },
  };
  return c.json(res);
});

// ---------------------------------------------------------------------------
// Auth middleware for everything below
// ---------------------------------------------------------------------------

const protectedPaths = ["/auth/me", "/nodes", "/sync/*", "/search", "/pages", "/pages/*"];
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

// ---------------------------------------------------------------------------
// Nodes (devices)
// ---------------------------------------------------------------------------

app.post("/nodes", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : "Unnamed device";
  const platform = typeof body?.platform === "string" ? body.platform : "unknown";
  const id = typeof body?.id === "string" && body.id ? body.id : crypto.randomUUID();
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO nodes (id, user_id, name, platform, created_at, last_seen_at)
     VALUES (?1,?2,?3,?4,?5,?5)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, platform=excluded.platform, last_seen_at=excluded.last_seen_at
     WHERE nodes.user_id = ?2`,
  )
    .bind(id, userId, name, platform, now)
    .run();

  const node: NodeInfo = { id, name, platform, createdAt: now, lastSeenAt: now };
  return c.json(node, 201);
});

app.get("/nodes", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, platform, created_at, last_seen_at FROM nodes WHERE user_id = ?1 ORDER BY last_seen_at DESC",
  )
    .bind(userId)
    .all<{ id: string; name: string; platform: string; created_at: number; last_seen_at: number }>();
  const nodes: NodeInfo[] = results.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }));
  return c.json({ nodes });
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
    const expiresAt = p.visitedAt + retentionDays * DAY_MS;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO pages
          (id,user_id,url,title,visited_at,captured_at,device_id,excerpt,byline,lang,r2_key,has_text,content_hash,summary,summary_status,deleted,seq,expires_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,'pending',0,?14,?15,?16)
         ON CONFLICT(id) DO UPDATE SET
           url=excluded.url, title=excluded.title, visited_at=excluded.visited_at,
           captured_at=excluded.captured_at, device_id=excluded.device_id,
           excerpt=excluded.excerpt, byline=excluded.byline, lang=excluded.lang,
           r2_key=excluded.r2_key, has_text=excluded.has_text,
           deleted=0, seq=excluded.seq, expires_at=excluded.expires_at, updated_at=excluded.updated_at,
           summary = CASE WHEN pages.content_hash IS NOT excluded.content_hash THEN NULL ELSE pages.summary END,
           summary_status = CASE WHEN pages.content_hash IS NOT excluded.content_hash THEN 'pending' ELSE pages.summary_status END,
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

  for (const id of deletes) {
    seq++;
    stmts.push(
      c.env.DB.prepare(
        "UPDATE pages SET deleted=1, has_text=0, r2_key=NULL, seq=?1, updated_at=?2 WHERE id=?3 AND user_id=?4",
      ).bind(seq, now, id, userId),
      c.env.DB.prepare("DELETE FROM pages_fts WHERE page_id = ?1 AND user_id = ?2").bind(id, userId),
    );
  }

  await c.env.DB.batch(stmts);

  // Purge R2 for deleted pages (best effort, in background).
  if (deletes.length) {
    c.executionCtx.waitUntil(
      Promise.all(deletes.map((id) => c.env.BUCKET.delete(textKey(userId, id)).catch(() => {}))).then(
        () => undefined,
      ),
    );
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

  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
            snippet(pages_fts, 1, '<mark>', '</mark>', '…', 16) AS snippet,
            bm25(pages_fts, 5.0, 1.0) AS rank
     FROM pages_fts
     JOIN pages p ON p.id = pages_fts.page_id AND p.user_id = pages_fts.user_id
     WHERE pages_fts MATCH ?1 AND p.user_id = ?2 AND p.deleted = 0
     ORDER BY rank
     LIMIT ?3 OFFSET ?4`,
  )
    .bind(match, userId, limit, offset)
    .all<PageRow & { snippet: string; rank: number }>();

  const total =
    (await c.env.DB.prepare(
      `SELECT count(*) AS n FROM pages_fts
       JOIN pages p ON p.id = pages_fts.page_id AND p.user_id = pages_fts.user_id
       WHERE pages_fts MATCH ?1 AND p.user_id = ?2 AND p.deleted = 0`,
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

  const stmt =
    before > 0
      ? c.env.DB.prepare(
          "SELECT * FROM pages WHERE user_id=?1 AND deleted=0 AND visited_at < ?2 ORDER BY visited_at DESC LIMIT ?3",
        ).bind(userId, before, limit)
      : c.env.DB.prepare(
          "SELECT * FROM pages WHERE user_id=?1 AND deleted=0 ORDER BY visited_at DESC LIMIT ?2",
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
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE pages SET deleted=1, has_text=0, r2_key=NULL, seq=?1, updated_at=?2 WHERE id=?3 AND user_id=?4",
    ).bind(seq, Date.now(), id, userId),
    c.env.DB.prepare("DELETE FROM pages_fts WHERE page_id = ?1 AND user_id = ?2").bind(id, userId),
  ]);
  c.executionCtx.waitUntil(c.env.BUCKET.delete(textKey(userId, id)).catch(() => {}));

  return c.json({ ok: true, id, seq });
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
      let seq = top - ids.length;
      const stmts: D1PreparedStatement[] = [];
      for (const id of ids) {
        seq++;
        stmts.push(
          env.DB.prepare(
            "UPDATE pages SET deleted=1, has_text=0, r2_key=NULL, seq=?1, updated_at=?2 WHERE id=?3 AND user_id=?4",
          ).bind(seq, now, id, userId),
          env.DB.prepare("DELETE FROM pages_fts WHERE page_id = ?1 AND user_id = ?2").bind(id, userId),
        );
      }
      await env.DB.batch(stmts);
      await Promise.all(ids.map((id) => env.BUCKET.delete(textKey(userId, id)).catch(() => {})));
      purged += ids.length;
    }
  }
  return purged;
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runRetention(env).then((n) => {
        if (n) console.log(`retention: purged ${n} expired pages`);
      }),
    );
  },
};
