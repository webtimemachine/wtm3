import type { AuthResponse, ExtensionAuthScope } from "@wtm/shared";
import { pkceChallenge } from "@wtm/shared/auth";
import type { Hono } from "hono";
import { normalizeEmail, revokeUserOAuthGrants, sendPasswordResetEmail, userInfo } from "../account";
import {
  DUMMY_PASSWORD_HASH,
  hashOpaqueToken,
  hashPassword,
  insertSessionStatement,
  prepareSession,
  randomOpaqueToken,
  verifyPassword,
} from "../auth";
import {
  DEFAULT_RETENTION_DAYS,
  EXTENSION_AUTH_TTL_MS,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_MIN_INTERVAL_MS,
  PASSWORD_RESET_TTL_MS,
} from "../constants";
import { purgeTextObjects } from "../db";
import type { Env, Vars } from "../env";

type App = Hono<{ Bindings: Env; Variables: Vars }>;

function clientName(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function weakPassword(password: string): boolean {
  return password.length < MIN_PASSWORD_LENGTH;
}

function authResponse(token: string, user: NonNullable<Awaited<ReturnType<typeof userInfo>>>): AuthResponse {
  return { token, user };
}

const EXTENSION_CLIENTS = new Set([
  "Chrome extension",
  "Firefox extension",
  "Safari extension",
]);

function extensionClient(value: unknown): string | null {
  return typeof value === "string" && EXTENSION_CLIENTS.has(value)
    ? value
    : null;
}

function requestId(value: unknown): string {
  return typeof value === "string" && value.startsWith("connect_")
    ? value
    : "";
}

function requestedScope(value: unknown): ExtensionAuthScope | null {
  if (value === undefined) return "capture";
  return value === "capture" || value === "assist" ? value : null;
}

export function registerAuthRoutes(app: App): void {
  app.post("/auth/extension/start", async (c) => {
    const body = await c.req.json().catch(() => null);
    const codeChallenge =
      typeof body?.codeChallenge === "string" ? body.codeChallenge : "";
    const client = extensionClient(body?.client);
    const scope = requestedScope(body?.scope);
    if (!client || !scope || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      return c.json(
        { error: "invalid_request", message: "A valid extension client and PKCE challenge are required." },
        400,
      );
    }

    const rawRequestId = randomOpaqueToken("connect");
    const requestHash = await hashOpaqueToken(rawRequestId);
    const createdAt = Date.now();
    const expiresAt = createdAt + EXTENSION_AUTH_TTL_MS;
    await c.env.DB.prepare(
      `INSERT INTO extension_authorizations
       (request_hash,code_challenge,client,requested_scope,created_at,expires_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    )
      .bind(requestHash, codeChallenge, client, scope, createdAt, expiresAt)
      .run();
    return c.json({ requestId: rawRequestId, expiresAt }, 201);
  });

  app.post("/auth/extension/request", async (c) => {
    const body = await c.req.json().catch(() => null);
    const rawRequestId = requestId(body?.requestId);
    if (!rawRequestId) {
      return c.json({ error: "invalid_request", message: "Connection request not found." }, 404);
    }
    const requestHash = await hashOpaqueToken(rawRequestId);
    const row = await c.env.DB.prepare(
      `SELECT client,requested_scope,user_id,expires_at FROM extension_authorizations
       WHERE request_hash=?1 AND expires_at>?2`,
    )
      .bind(requestHash, Date.now())
      .first<{
        client: string;
        requested_scope: ExtensionAuthScope;
        user_id: string | null;
        expires_at: number;
      }>();
    if (!row) {
      return c.json({ error: "invalid_request", message: "Connection request expired or was already used." }, 404);
    }
    return c.json({
      client: row.client,
      scope: row.requested_scope,
      expiresAt: row.expires_at,
      status: row.user_id ? "approved" : "pending",
    });
  });

  app.post("/auth/extension/approve", async (c) => {
    const body = await c.req.json().catch(() => null);
    const rawRequestId = requestId(body?.requestId);
    if (!rawRequestId) {
      return c.json({ error: "invalid_request", message: "Connection request not found." }, 404);
    }
    const now = Date.now();
    const requestHash = await hashOpaqueToken(rawRequestId);
    const result = await c.env.DB.prepare(
      `UPDATE extension_authorizations
       SET user_id=?1,approved_at=?2
       WHERE request_hash=?3 AND expires_at>?2 AND approved_at IS NULL`,
    )
      .bind(c.get("userId"), now, requestHash)
      .run();
    if (!result.meta.changes) {
      return c.json({ error: "invalid_request", message: "Connection request expired or was already approved." }, 409);
    }
    return c.json({ ok: true });
  });

  app.post("/auth/extension/token", async (c) => {
    const body = await c.req.json().catch(() => null);
    const rawRequestId = requestId(body?.requestId);
    const codeVerifier =
      typeof body?.codeVerifier === "string" ? body.codeVerifier : "";
    if (!rawRequestId || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
      return c.json({ error: "invalid_request", message: "Invalid connection request." }, 400);
    }

    const requestHash = await hashOpaqueToken(rawRequestId);
    const row = await c.env.DB.prepare(
      `SELECT code_challenge,client,requested_scope,user_id FROM extension_authorizations
       WHERE request_hash=?1 AND expires_at>?2`,
    )
      .bind(requestHash, Date.now())
      .first<{
        code_challenge: string;
        client: string;
        requested_scope: ExtensionAuthScope;
        user_id: string | null;
      }>();
    if (!row) {
      return c.json({ error: "invalid_request", message: "Connection request expired or was already used." }, 410);
    }
    if ((await pkceChallenge(codeVerifier)) !== row.code_challenge) {
      return c.json({ error: "invalid_request", message: "Invalid connection request." }, 400);
    }
    if (!row.user_id) return c.json({ status: "pending" });

    const consumed = await c.env.DB.prepare(
      `DELETE FROM extension_authorizations
       WHERE request_hash=?1 AND user_id=?2
       RETURNING client,requested_scope`,
    )
      .bind(requestHash, row.user_id)
      .first<{ client: string; requested_scope: ExtensionAuthScope }>();
    if (!consumed) {
      return c.json({ error: "invalid_request", message: "Connection request was already used." }, 410);
    }
    const sessionScope = requestedScope(consumed.requested_scope);
    if (!sessionScope) {
      return c.json({ error: "invalid_request", message: "Invalid extension permission." }, 400);
    }

    const session = await prepareSession(
      row.user_id,
      consumed.client,
      sessionScope,
    );
    await insertSessionStatement(c.env.DB, session).run();
    const info = await userInfo(c.env, row.user_id);
    if (!info) return c.json({ error: "not_found", message: "User not found." }, 404);
    return c.json({
      status: "connected",
      scope: sessionScope,
      ...authResponse(session.token, info),
    });
  });

  app.post("/auth/register", async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email) return c.json({ error: "invalid_email", message: "A valid email is required." }, 400);
    if (weakPassword(password))
      return c.json(
        { error: "weak_password", message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
        400,
      );

    const existing = await c.env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?1").bind(email).first();
    if (existing) return c.json({ error: "email_taken", message: "That email is already registered." }, 409);

    const id = crypto.randomUUID();
    const now = Date.now();
    const configuredRetention = Number.parseInt(c.env.DEFAULT_RETENTION_DAYS || "", 10);
    const retentionDays = Number.isInteger(configuredRetention) ? configuredRetention : DEFAULT_RETENTION_DAYS;
    const passwordHash = await hashPassword(password);
    const session = await prepareSession(id, clientName(body?.client));

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO users (id,email,password_hash,password_salt,iterations,retention_days,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)`,
      ).bind(
        id,
        email,
        passwordHash.hash,
        passwordHash.salt,
        passwordHash.iterations,
        retentionDays,
        now,
      ),
      insertSessionStatement(c.env.DB, session),
    ]);

    return c.json(
      authResponse(session.token, {
        id,
        email,
        createdAt: now,
        retentionDays,
        filterSensitive: false,
      }),
      201,
    );
  });

  app.post("/auth/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password)
      return c.json({ error: "invalid_credentials", message: "Email and password are required." }, 400);

    const row = await c.env.DB.prepare(
      `SELECT id,email,password_hash,password_salt,iterations,created_at,retention_days,filter_sensitive
       FROM users WHERE lower(email) = ?1`,
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
    const stored = row
      ? { hash: row.password_hash, salt: row.password_salt, iterations: row.iterations }
      : DUMMY_PASSWORD_HASH;
    const passwordOk = await verifyPassword(password, stored);
    if (!row || !passwordOk)
      return c.json({ error: "invalid_credentials", message: "Incorrect email or password." }, 401);

    const session = await prepareSession(row.id, clientName(body?.client));
    await insertSessionStatement(c.env.DB, session).run();
    return c.json(
      authResponse(session.token, {
        id: row.id,
        email: row.email,
        createdAt: row.created_at,
        retentionDays: row.retention_days,
        filterSensitive: !!row.filter_sensitive,
      }),
    );
  });

  app.post("/auth/password-reset/request", async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    if (!email) return c.json({ error: "invalid_email", message: "A valid email is required." }, 400);

    const row = await c.env.DB.prepare("SELECT id, email FROM users WHERE lower(email) = ?1")
      .bind(email)
      .first<{ id: string; email: string }>();
    if (row) {
      const now = Date.now();
      const recent = await c.env.DB.prepare(
        "SELECT created_at FROM password_reset_tokens WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 1",
      )
        .bind(row.id)
        .first<{ created_at: number }>();
      if (!recent || now - recent.created_at >= PASSWORD_RESET_MIN_INTERVAL_MS) {
        const token = randomOpaqueToken("reset");
        const tokenHash = await hashOpaqueToken(token);
        const resetId = crypto.randomUUID();
        await c.env.DB.batch([
          c.env.DB.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?1").bind(row.id),
          c.env.DB.prepare(
            `INSERT INTO password_reset_tokens (id,user_id,token_hash,created_at,expires_at)
             VALUES (?1,?2,?3,?4,?5)`,
          ).bind(resetId, row.id, tokenHash, now, now + PASSWORD_RESET_TTL_MS),
        ]);
        c.executionCtx.waitUntil(
          sendPasswordResetEmail(c.env, row.email, token).catch(async (error) => {
            console.error("password reset email failed:", error instanceof Error ? error.message : String(error));
            await c.env.DB.prepare("DELETE FROM password_reset_tokens WHERE id = ?1").bind(resetId).run();
          }),
        );
      }
    }
    return c.json({ ok: true }, 202);
  });

  app.post("/auth/password-reset/confirm", async (c) => {
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    if (!token || weakPassword(newPassword))
      return c.json(
        {
          error: "invalid_reset",
          message: `A valid reset token and password of at least ${MIN_PASSWORD_LENGTH} characters are required.`,
        },
        400,
      );

    const tokenHash = await hashOpaqueToken(token);
    const reset = await c.env.DB.prepare(
      `DELETE FROM password_reset_tokens
       WHERE token_hash = ?1 AND expires_at > ?2
       RETURNING user_id`,
    )
      .bind(tokenHash, Date.now())
      .first<{ user_id: string }>();
    if (!reset) return c.json({ error: "invalid_reset", message: "That reset link is invalid or expired." }, 400);

    const passwordHash = await hashPassword(newPassword);
    await revokeUserOAuthGrants(c.env, reset.user_id);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE users SET password_hash=?1,password_salt=?2,iterations=?3 WHERE id=?4",
      ).bind(passwordHash.hash, passwordHash.salt, passwordHash.iterations, reset.user_id),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(reset.user_id),
      c.env.DB.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?1").bind(reset.user_id),
    ]);
    return c.body(null, 204);
  });

  app.get("/auth/me", async (c) => {
    const info = await userInfo(c.env, c.get("userId"));
    if (!info) return c.json({ error: "not_found", message: "User not found." }, 404);
    return c.json(info);
  });

  app.post("/auth/logout", async (c) => {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?1 AND user_id = ?2")
      .bind(c.get("sessionId"), c.get("userId"))
      .run();
    return c.body(null, 204);
  });

  app.post("/auth/logout-everywhere", async (c) => {
    const userId = c.get("userId");
    await revokeUserOAuthGrants(c.env, userId);
    await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId).run();
    return c.body(null, 204);
  });

  app.post("/auth/password", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => null);
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    if (!currentPassword || weakPassword(newPassword))
      return c.json(
        {
          error: "invalid_password",
          message: `Current password and a new password of at least ${MIN_PASSWORD_LENGTH} characters are required.`,
        },
        400,
      );

    const row = await c.env.DB.prepare(
      "SELECT password_hash,password_salt,iterations FROM users WHERE id = ?1",
    )
      .bind(userId)
      .first<{ password_hash: string; password_salt: string; iterations: number }>();
    const passwordOk =
      !!row &&
      (await verifyPassword(currentPassword, {
        hash: row.password_hash,
        salt: row.password_salt,
        iterations: row.iterations,
      }));
    if (!passwordOk)
      return c.json({ error: "invalid_credentials", message: "Current password is incorrect." }, 401);

    const passwordHash = await hashPassword(newPassword);
    const session = await prepareSession(userId, clientName(body?.client));
    await revokeUserOAuthGrants(c.env, userId);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE users SET password_hash=?1,password_salt=?2,iterations=?3 WHERE id=?4",
      ).bind(passwordHash.hash, passwordHash.salt, passwordHash.iterations, userId),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId),
      c.env.DB.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?1").bind(userId),
      insertSessionStatement(c.env.DB, session),
    ]);
    const info = await userInfo(c.env, userId);
    if (!info) return c.json({ error: "not_found", message: "User not found." }, 404);
    return c.json(authResponse(session.token, info));
  });

  app.delete("/account", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => null);
    const password = typeof body?.password === "string" ? body.password : "";
    const row = await c.env.DB.prepare(
      "SELECT password_hash,password_salt,iterations FROM users WHERE id = ?1",
    )
      .bind(userId)
      .first<{ password_hash: string; password_salt: string; iterations: number }>();
    const passwordOk =
      !!row &&
      !!password &&
      (await verifyPassword(password, {
        hash: row.password_hash,
        salt: row.password_salt,
        iterations: row.iterations,
      }));
    if (!passwordOk)
      return c.json({ error: "invalid_credentials", message: "Password is incorrect." }, 401);

    const { results } = await c.env.DB.prepare("SELECT id FROM pages WHERE user_id = ?1")
      .bind(userId)
      .all<{ id: string }>();
    const ids = results.map((page) => page.id);
    await revokeUserOAuthGrants(c.env, userId);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM pages_fts WHERE user_id = ?1").bind(userId),
      c.env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId),
    ]);
    c.executionCtx.waitUntil(purgeTextObjects(c.env, userId, ids).then(() => undefined));
    return c.body(null, 204);
  });
}
