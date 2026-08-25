import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { hashOpaqueToken, hashPassword } from "../src/auth";
import { createPkcePair } from "@wtm/shared/auth";
import { isCapturableUrl, redactUrlCredentials } from "@wtm/shared/url";
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
    expect(names).toContain("extension_authorizations");
    expect(names).not.toContain("user_seq");
    expect(names).not.toContain("beta_signups");
    expect(names).not.toContain("diagnostic_reports");

    const authorizations = await env.DB.prepare(
      "PRAGMA table_info(extension_authorizations)",
    ).all<{ name: string }>();
    expect(authorizations.results.map((row) => row.name)).toContain("requested_scope");
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
      "SELECT token_hash,client,scope FROM sessions WHERE user_id=?1",
    )
      .bind(userId)
      .first<{ token_hash: string; client: string; scope: string }>();
    expect(row).toEqual({
      token_hash: tokenHash,
      client: "Backend test",
      scope: "full",
    });
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

describe("extension authorization", () => {
  it("uses web approval to mint a single-use capture token", async () => {
    const web = await register(
      `extension-${crypto.randomUUID()}@example.com`,
    );
    const pkce = await createPkcePair();
    const started = await jsonRequest("/auth/extension/start", "POST", {
      codeChallenge: pkce.challenge,
      client: "Safari extension",
    });
    expect(started.status).toBe(201);
    const grant = await started.json<{
      requestId: string;
      expiresAt: number;
    }>();
    expect(grant.requestId).toMatch(/^connect_/);
    expect(grant.expiresAt).toBeGreaterThan(Date.now());

    const before = await jsonRequest("/auth/extension/request", "POST", {
      requestId: grant.requestId,
    });
    expect(await before.json()).toMatchObject({
      client: "Safari extension",
      scope: "capture",
      status: "pending",
    });
    const pending = await jsonRequest(
      "/auth/extension/token",
      "POST",
      {
        requestId: grant.requestId,
        codeVerifier: pkce.verifier,
      },
    );
    expect(await pending.json()).toEqual({ status: "pending" });
    expect(
      (
        await jsonRequest("/auth/extension/approve", "POST", {
          requestId: grant.requestId,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await jsonRequest(
          "/auth/extension/approve",
          "POST",
          { requestId: grant.requestId },
          web.token,
        )
      ).status,
    ).toBe(200);

    const pendingWithWrongVerifier = await jsonRequest(
      "/auth/extension/token",
      "POST",
      {
        requestId: grant.requestId,
        codeVerifier: "x".repeat(43),
      },
    );
    expect(pendingWithWrongVerifier.status).toBe(400);

    const exchanged = await jsonRequest(
      "/auth/extension/token",
      "POST",
      {
        requestId: grant.requestId,
        codeVerifier: pkce.verifier,
      },
    );
    expect(exchanged.status).toBe(200);
    const extension = await exchanged.json<{
      status: string;
      token: string;
    }>();
    expect(extension.status).toBe("connected");
    expect((extension as { scope?: string }).scope).toBe("capture");

    const tokenHash = await hashOpaqueToken(extension.token);
    expect(
      await env.DB.prepare(
        "SELECT client,scope FROM sessions WHERE token_hash=?1",
      )
        .bind(tokenHash)
        .first(),
    ).toEqual({ client: "Safari extension", scope: "capture" });

    expect(
      (
        await jsonRequest("/auth/extension/token", "POST", {
          requestId: grant.requestId,
          codeVerifier: pkce.verifier,
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await jsonRequest(
          "/nodes",
          "POST",
          { id: crypto.randomUUID(), name: "Safari on iPhone", platform: "safari-ios" },
          extension.token,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request("/search?q=private", {
          headers: { Authorization: `Bearer ${extension.token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/suggest?q=private", {
          headers: { Authorization: `Bearer ${extension.token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await jsonRequest(
          "/auth/logout-everywhere",
          "POST",
          undefined,
          extension.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await jsonRequest("/auth/logout", "POST", undefined, extension.token)
      ).status,
    ).toBe(204);
  });

  it("mints a read-only assist token and returns metadata-only suggestions", async () => {
    const web = await register(`assist-${crypto.randomUUID()}@example.com`);
    const now = Date.now();
    const pages = [
      {
        id: crypto.randomUUID(),
        url: "https://example.com/story?utm_source=first#old",
        title: "Assistmarker older visit",
        visitedAt: now - 1000,
        text: "assistmarker body secret full text",
      },
      {
        id: crypto.randomUUID(),
        url: "https://example.com/story?utm_source=second#new",
        title: "Assistmarker newest visit",
        visitedAt: now,
        text: "assistmarker body secret full text",
      },
      {
        id: crypto.randomUUID(),
        url: "https://pornhub.com/hidden",
        title: "Assistmarker sensitive",
        visitedAt: now,
        text: "assistmarker body secret full text",
      },
    ];
    expect(
      (
        await jsonRequest(
          "/sync/push",
          "POST",
          { deviceId: "assist-device", pages },
          web.token,
        )
      ).status,
    ).toBe(200);
    const pkce = await createPkcePair();
    const started = await jsonRequest("/auth/extension/start", "POST", {
      codeChallenge: pkce.challenge,
      client: "Chrome extension",
      scope: "assist",
    });
    expect(started.status).toBe(201);
    const grant = await started.json<{ requestId: string }>();
    const info = await jsonRequest("/auth/extension/request", "POST", {
      requestId: grant.requestId,
    });
    expect(await info.json()).toMatchObject({ scope: "assist", status: "pending" });
    expect(
      (
        await jsonRequest(
          "/auth/extension/approve",
          "POST",
          { requestId: grant.requestId },
          web.token,
        )
      ).status,
    ).toBe(200);
    const exchanged = await jsonRequest("/auth/extension/token", "POST", {
      requestId: grant.requestId,
      codeVerifier: pkce.verifier,
    });
    const assist = await exchanged.json<{ token: string; scope: string }>();
    expect(assist.scope).toBe("assist");

    const suggested = await request("/suggest?q=assistmarker&limit=6", {
      headers: { Authorization: `Bearer ${assist.token}` },
    });
    expect(suggested.status).toBe(200);
    const suggestionBody = await suggested.json<{
      suggestions: Array<Record<string, unknown>>;
    }>();
    expect(suggestionBody.suggestions).toHaveLength(1);
    expect(suggestionBody.suggestions[0]).toMatchObject({
      title: "Assistmarker newest visit",
    });
    expect(suggestionBody.suggestions[0]).not.toHaveProperty("text");
    expect(suggestionBody.suggestions[0]).not.toHaveProperty("snippet");

    const snapshot = await request("/index-snapshot?limit=100", {
      headers: { Authorization: `Bearer ${assist.token}` },
    });
    expect(snapshot.status).toBe(200);
    const snapshotBody = await snapshot.json<{
      version: string;
      items: Array<{ title: string }>;
    }>();
    expect(snapshotBody.version).toMatch(/^v1:/);
    expect(snapshotBody.items).toHaveLength(1);
    expect(snapshotBody.items[0]?.title).toBe("Assistmarker newest visit");

    expect(
      (
        await request("/search?q=assistmarker", {
          headers: { Authorization: `Bearer ${assist.token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await jsonRequest(
          "/sync/push",
          "POST",
          { deviceId: "blocked", pages: [] },
          assist.token,
        )
      ).status,
    ).toBe(403);
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

  it("filters search by time and site and supports each sort order", async () => {
    const auth = await register(
      `filters-${crypto.randomUUID()}@example.com`,
    );
    const now = Date.now();
    const pages = [
      {
        id: crypto.randomUUID(),
        url: "https://www.example.com/new",
        title: "New example result",
        visitedAt: now - 2 * 86_400_000,
        text: "filterable chronology phrase",
      },
      {
        id: crypto.randomUUID(),
        url: "https://archive.example.com/old",
        title: "Old example result",
        visitedAt: now - 60 * 86_400_000,
        text: "filterable chronology phrase",
      },
      {
        id: crypto.randomUUID(),
        url: "https://unrelated.test/recent",
        title: "Unrelated recent result",
        visitedAt: now - 86_400_000,
        text: "filterable chronology phrase",
      },
    ];
    expect(
      (
        await jsonRequest(
          "/sync/push",
          "POST",
          { deviceId: "filter-device", pages },
          auth.token,
        )
      ).status,
    ).toBe(200);

    async function search(params: Record<string, string>) {
      const query = new URLSearchParams({ q: "filterable", ...params });
      const response = await request(`/search?${query}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      expect(response.status).toBe(200);
      return response.json<{ hits: { id: string; title: string }[]; total: number }>();
    }

    const site = await search({
      site: "https://example.com/a-page",
      sort: "oldest",
    });
    expect(site.total).toBe(2);
    expect(site.hits.map((hit) => hit.title)).toEqual([
      "Old example result",
      "New example result",
    ]);

    const recent = await search({
      site: "example.com",
      from: String(now - 7 * 86_400_000),
      sort: "newest",
    });
    expect(recent.hits.map((hit) => hit.title)).toEqual([
      "New example result",
    ]);

    const old = await search({
      to: String(now - 30 * 86_400_000),
      sort: "oldest",
    });
    expect(old.hits.map((hit) => hit.title)).toEqual([
      "Old example result",
    ]);

    const mcp = await jsonRequest(
      "/mcp",
      "POST",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_history",
          arguments: {
            query: "filterable",
            site: "example.com",
            sort: "oldest",
          },
        },
      },
      auth.token,
    );
    expect(mcp.status).toBe(200);
    const rpc = await mcp.json<{
      result: { content: { text: string }[] };
    }>();
    const content = rpc.result.content[0]?.text ?? "";
    expect(content.indexOf("Old example result")).toBeLessThan(
      content.indexOf("New example result"),
    );

    expect(
      (
        await request("/search?q=filterable&site=not%20a%20site", {
          headers: { Authorization: `Bearer ${auth.token}` },
        })
      ).status,
    ).toBe(400);
  });

  it("searches URLs, ranking an address match over a body mention", async () => {
    const auth = await register(`urls-${crypto.randomUUID()}@example.com`);
    const now = Date.now();
    const tweet =
      "https://x.com/NYCMayor/status/2079718073058091261/mediaViewer?currentTweet=207";
    // Each distinctive token below appears ONLY in a URL, never in the text —
    // that is the case the UNINDEXED url column used to miss entirely.
    const pages = [
      {
        id: crypto.randomUUID(),
        url: "http://localhost:58627/dashboard",
        title: "Dev server",
        visitedAt: now,
        text: "Local development preview with hot module reload.",
      },
      {
        id: crypto.randomUUID(),
        url: tweet,
        title: "Address match",
        visitedAt: now,
        text: "A mayor posted about city budget negotiations.",
      },
      {
        id: crypto.randomUUID(),
        url: "https://mail.google.com/mail/u/0/#inbox",
        title: "Body mention",
        visitedAt: now,
        text: `Forwarded link ${tweet} please look`,
      },
    ];
    expect(
      (
        await jsonRequest(
          "/sync/push",
          "POST",
          { deviceId: "url-device", pages },
          auth.token,
        )
      ).status,
    ).toBe(200);

    async function titles(q: string) {
      const response = await request(
        `/search?${new URLSearchParams({ q })}`,
        { headers: { Authorization: `Bearer ${auth.token}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.json<{ hits: { title: string }[] }>();
      return body.hits.map((hit) => hit.title);
    }

    // A port lives only in the address.
    expect(await titles("58627")).toEqual(["Dev server"]);
    // A path segment matches both pages, address first.
    expect(await titles("mediaViewer")).toEqual([
      "Address match",
      "Body mention",
    ]);
    // A handle carried in the URL path.
    expect(await titles("nycmayor")).toContain("Address match");
    // Text and title search keep working.
    expect(await titles("hot module reload")).toEqual(["Dev server"]);
  });

  it("redacts credentials out of captured URLs", async () => {
    const auth = await register(`redact-${crypto.randomUUID()}@example.com`);
    const cases = [
      // [pushed, stored]
      [
        "http://tdx2.example.net:58627/#token=NYLweUDXdH3QidN7YccZn0KziVKX",
        "http://tdx2.example.net:58627/#token=REDACTED",
      ],
      [
        "https://app.example.com/callback?code=abc123&state=xyz",
        "https://app.example.com/callback?code=REDACTED&state=xyz",
      ],
      // Ordinary params and plain anchors must survive untouched.
      [
        "https://www.youtube.com/watch?v=lPze7AA7gAA&utm_source=news#t=42",
        "https://www.youtube.com/watch?v=lPze7AA7gAA&utm_source=news#t=42",
      ],
      ["https://ph4.example.art/#climate", "https://ph4.example.art/#climate"],
    ];
    const pages = cases.map(([url], index) => ({
      id: crypto.randomUUID(),
      url: url as string,
      title: `Redaction case ${index}`,
      visitedAt: Date.now(),
      text: `redactioncase${index} body text`,
    }));
    expect(
      (
        await jsonRequest(
          "/sync/push",
          "POST",
          { deviceId: "redact-device", pages },
          auth.token,
        )
      ).status,
    ).toBe(200);

    for (const [index, [, expected]] of cases.entries()) {
      const response = await request(`/pages/${pages[index]!.id}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      expect(response.status).toBe(200);
      expect((await response.json<{ url: string }>()).url).toBe(expected);
    }

    // The secret is gone from the index, not merely hidden from the response.
    const leaked = await request("/search?q=NYLweUDXdH3QidN7YccZn0KziVKX", {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    expect((await leaked.json<{ hits: unknown[] }>()).hits).toHaveLength(0);
  });

  it("searches bylines, excerpts, and generated summaries", async () => {
    const auth = await register(`meta-${crypto.randomUUID()}@example.com`);
    const page = {
      id: crypto.randomUUID(),
      url: "https://example.com/feature",
      title: "Untitled shell",
      visitedAt: Date.now(),
      text: "Body copy that mentions none of the distinctive words below.",
      byline: "Zeynep Kowalczyk",
      excerpt: "A dispatch about riverboat cartography.",
    };
    expect(
      (
        await jsonRequest(
          "/sync/push",
          "POST",
          { deviceId: "meta-device", pages: [page] },
          auth.token,
        )
      ).status,
    ).toBe(200);

    async function titles(q: string) {
      const response = await request(
        `/search?${new URLSearchParams({ q })}`,
        { headers: { Authorization: `Bearer ${auth.token}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.json<{ hits: { title: string }[] }>();
      return body.hits.map((hit) => hit.title);
    }

    // Author and excerpt come from capture and are indexed at ingest.
    expect(await titles("kowalczyk")).toEqual(["Untitled shell"]);
    expect(await titles("riverboat cartography")).toEqual(["Untitled shell"]);

    // The summary arrives later, from the background summarizer; simulate that
    // write and confirm the index picks it up. Shell-titled pages depend on it.
    await env.DB.prepare(
      "UPDATE pages_fts SET summary=?1 WHERE page_id=?2 AND user_id=?3",
    )
      .bind("Explains quadrupedal locomotion in salamanders.", page.id, auth.user.id)
      .run();
    expect(await titles("salamanders")).toEqual(["Untitled shell"]);
  });
});

describe("url policy", () => {
  it("skips Web Time Machine's own surfaces", () => {
    for (const url of [
      "https://webtm.io/",
      "https://www.webtm.io/search?q=x",
      "https://api.webtm.io/health",
      "https://webtimemachine.io/",
    ]) {
      expect(isCapturableUrl(url)).toBe(false);
    }
    for (const url of [
      "https://example.com/webtm.io",
      "https://notwebtm.io/",
      "http://localhost:58627/dashboard",
    ]) {
      expect(isCapturableUrl(url)).toBe(true);
    }
  });

  it("redacts credential values and leaves everything else alone", () => {
    expect(redactUrlCredentials("https://x.test/?token=abc&v=7")).toBe(
      "https://x.test/?token=REDACTED&v=7",
    );
    expect(redactUrlCredentials("https://x.test/#access_token=abc&scope=r")).toBe(
      "https://x.test/#access_token=REDACTED&scope=r",
    );
    // Untouched: ordinary params, plain anchors, params merely containing a
    // credential word, and empty values.
    for (const url of [
      "https://x.test/watch?v=abc123&utm_source=news",
      "https://x.test/#climate",
      "https://x.test/?tokenizer=bpe",
      "https://x.test/?token=",
      "not a url at all",
    ]) {
      expect(redactUrlCredentials(url)).toBe(url);
    }
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
