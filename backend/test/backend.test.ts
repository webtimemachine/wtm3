import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { hashOpaqueToken, hashPassword } from "../src/auth";
import type { Env } from "../src/env";

const origin = "https://api.webtm.io";
const password = "correct horse battery staple";

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return exports.default.fetch(`${origin}${path}`, init);
}

async function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  return request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function register(email: string): Promise<{
  token: string;
  user: { id: string; email: string };
}> {
  const response = await jsonRequest("/auth/register", "POST", {
    email,
    password,
    client: "Backend test",
  });
  expect(response.status).toBe(201);
  return response.json();
}

describe("v4 schema", () => {
  it("keeps only the current page fields and creates revocable credentials", async () => {
    const pages = await env.DB.prepare("PRAGMA table_info(pages)").all<{
      name: string;
    }>();
    const columns = pages.results.map((row) => row.name);
    expect(columns).toContain("captured_at");
    expect(columns).not.toContain("seq");
    expect(columns).not.toContain("deleted");
    expect(columns).not.toContain("has_text");
    expect(columns).not.toContain("updated_at");

    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all<{ name: string }>();
    const names = tables.results.map((row) => row.name);
    expect(names).toContain("sessions");
    expect(names).toContain("password_reset_tokens");
    expect(names).not.toContain("user_seq");
    expect(names).not.toContain("beta_signups");
    expect(names).not.toContain("diagnostic_reports");
  });

  it("accepts pushes before the destructive cleanup migration", async () => {
    const legacyEnv = { ...env, DB: env.LEGACY_DB } as Env;
    const context = createExecutionContext();
    const email = `legacy-${crypto.randomUUID()}@example.com`;
    const registered = await app.fetch(
      new Request(`${origin}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          client: "Legacy test",
        }),
      }),
      legacyEnv,
      context,
    );
    expect(registered.status).toBe(201);
    const auth = await registered.json<{ token: string }>();
    const pushed = await app.fetch(
      new Request(`${origin}/sync/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({
          deviceId: "legacy-device",
          pages: [
            {
              id: crypto.randomUUID(),
              url: "https://example.com/legacy-rollout",
              title: "Legacy rollout",
              visitedAt: Date.now(),
              text: "",
            },
          ],
        }),
      }),
      legacyEnv,
      context,
    );
    expect(pushed.status).toBe(200);
    expect(await pushed.json()).toEqual({ accepted: 1 });
    await waitOnExecutionContext(context);
  });
});

describe("sessions and account lifecycle", () => {
  const email = `sessions-${crypto.randomUUID()}@example.com`;
  let token = "";
  let userId = "";

  beforeAll(async () => {
    const auth = await register(email);
    token = auth.token;
    userId = auth.user.id;
  });

  it("stores only the session hash and revokes an ordinary logout", async () => {
    const tokenHash = await hashOpaqueToken(token);
    const row = await env.DB.prepare(
      "SELECT token_hash,client FROM sessions WHERE user_id=?1",
    )
      .bind(userId)
      .first<{ token_hash: string; client: string }>();
    expect(row).toEqual({ token_hash: tokenHash, client: "Backend test" });
    expect(row?.token_hash).not.toBe(token);

    expect(
      (await request("/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      })).status,
    ).toBe(200);
    expect(
      (await jsonRequest("/auth/logout", "POST", undefined, token)).status,
    ).toBe(204);
    expect(
      (await request("/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      })).status,
    ).toBe(401);
  });

  it("logs out every active session", async () => {
    const first = await jsonRequest("/auth/login", "POST", {
      email,
      password,
      client: "First",
    }).then((response) => response.json<{ token: string }>());
    const second = await jsonRequest("/auth/login", "POST", {
      email,
      password,
      client: "Second",
    }).then((response) => response.json<{ token: string }>());
    expect(
      (
        await jsonRequest(
          "/auth/logout-everywhere",
          "POST",
          undefined,
          first.token,
        )
      ).status,
    ).toBe(204);
    for (const activeToken of [first.token, second.token]) {
      expect(
        (
          await request("/auth/me", {
            headers: { Authorization: `Bearer ${activeToken}` },
          })
        ).status,
      ).toBe(401);
    }
  });

  it("consumes reset tokens once and revokes existing sessions", async () => {
    const login = await jsonRequest("/auth/login", "POST", {
      email,
      password,
      client: "Reset test",
    }).then((response) => response.json<{ token: string }>());
    const resetToken = `reset_${crypto.randomUUID()}`;
    const resetHash = await hashOpaqueToken(resetToken);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO password_reset_tokens
       (id,user_id,token_hash,created_at,expires_at)
       VALUES (?1,?2,?3,?4,?5)`,
    )
      .bind(crypto.randomUUID(), userId, resetHash, now, now + 30 * 60_000)
      .run();
    const newPassword = "a different secure password";
    expect(
      (
        await jsonRequest("/auth/password-reset/confirm", "POST", {
          token: resetToken,
          newPassword,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request("/auth/me", {
          headers: { Authorization: `Bearer ${login.token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await jsonRequest("/auth/password-reset/confirm", "POST", {
          token: resetToken,
          newPassword,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await jsonRequest("/auth/login", "POST", {
          email,
          password: newPassword,
        })
      ).status,
    ).toBe(200);
  });
});

describe("page lifecycle", () => {
  it("ingests idempotently and hard-deletes metadata, search, and text", async () => {
    const auth = await register(
      `pages-${crypto.randomUUID()}@example.com`,
    );
    const pageId = crypto.randomUUID();
    const page = {
      id: pageId,
      url: "https://example.com/recall",
      title: "Recall this page",
      visitedAt: Date.now(),
      text: "a uniquely searchable integration test phrase",
    };
    for (const title of [page.title, "Recall this updated page"]) {
      const response = await jsonRequest(
        "/sync/push",
        "POST",
        {
          deviceId: "test-device",
          pages: [{ ...page, title }],
        },
        auth.token,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: 1 });
    }
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM pages WHERE id=?1 AND user_id=?2",
    )
      .bind(pageId, auth.user.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect(await env.BUCKET.get(`text/${auth.user.id}/${pageId}`)).not.toBeNull();

    const search = await request(
      "/search?q=uniquely+searchable",
      { headers: { Authorization: `Bearer ${auth.token}` } },
    );
    expect(search.status).toBe(200);
    expect(
      await search.json<{ hits: { id: string; title: string }[] }>(),
    ).toMatchObject({
      hits: [{ id: pageId, title: "Recall this updated page" }],
    });
    const text = await request(`/pages/${pageId}/text`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    expect(text.status).toBe(200);
    expect(await text.text()).toBe(page.text);

    expect(
      (
        await request(`/pages/${pageId}`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await jsonRequest(
          `/pages/${pageId}`,
          "DELETE",
          undefined,
          auth.token,
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM pages WHERE id=?1")
        .bind(pageId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT page_id FROM pages_fts WHERE page_id=?1",
      )
        .bind(pageId)
        .first(),
    ).toBeNull();
    const afterDelete = await request(
      "/search?q=uniquely+searchable",
      { headers: { Authorization: `Bearer ${auth.token}` } },
    ).then((response) => response.json<{ total: number }>());
    expect(afterDelete.total).toBe(0);
  });
});

describe("password hashes", () => {
  it("uses randomized salts", async () => {
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
  });
});

describe("password and account security", () => {
  it("changes the password, revokes old sessions, and keeps one replacement session", async () => {
    const email = `password-${crypto.randomUUID()}@example.com`;
    const first = await register(email);
    const second = await jsonRequest("/auth/login", "POST", {
      email,
      password,
      client: "Second session",
    }).then((response) => response.json<{ token: string }>());
    const nextPassword = "new correct horse battery staple";
    const changed = await jsonRequest(
      "/auth/password",
      "POST",
      {
        currentPassword: password,
        newPassword: nextPassword,
        client: "Replacement session",
      },
      first.token,
    );
    expect(changed.status).toBe(200);
    const replacement = await changed.json<{ token: string }>();

    for (const revoked of [first.token, second.token]) {
      expect(
        (
          await request("/auth/me", {
            headers: { Authorization: `Bearer ${revoked}` },
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await request("/auth/me", {
          headers: { Authorization: `Bearer ${replacement.token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await jsonRequest("/auth/login", "POST", {
          email,
          password,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await jsonRequest("/auth/login", "POST", {
          email,
          password: nextPassword,
        })
      ).status,
    ).toBe(200);
  });

  it("accepts reset requests generically and persists only a token hash", async () => {
    const email = `email-${crypto.randomUUID()}@example.com`;
    const auth = await register(email);
    expect(
      (
        await jsonRequest("/auth/password-reset/request", "POST", {
          email,
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await jsonRequest("/auth/password-reset/request", "POST", {
          email: `missing-${crypto.randomUUID()}@example.com`,
        })
      ).status,
    ).toBe(202);
    const token = await env.DB.prepare(
      `SELECT token_hash FROM password_reset_tokens WHERE user_id=?1`,
    )
      .bind(auth.user.id)
      .first<{ token_hash: string }>();
    expect(token?.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("deletes an account and immediately invalidates its session", async () => {
    const email = `delete-${crypto.randomUUID()}@example.com`;
    const auth = await register(email);
    expect(
      (
        await jsonRequest(
          "/account",
          "DELETE",
          { password: "wrong password" },
          auth.token,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await jsonRequest(
          "/account",
          "DELETE",
          { password },
          auth.token,
        )
      ).status,
    ).toBe(204);
    expect(
      await env.DB.prepare("SELECT id FROM users WHERE id=?1")
        .bind(auth.user.id)
        .first(),
    ).toBeNull();
    expect(
      (
        await request("/auth/me", {
          headers: { Authorization: `Bearer ${auth.token}` },
        })
      ).status,
    ).toBe(401);
  });
});
