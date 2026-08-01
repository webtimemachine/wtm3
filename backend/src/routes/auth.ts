import type { AuthResponse } from "@wtm/shared";
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

export function registerAuthRoutes(app: App): void {
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
