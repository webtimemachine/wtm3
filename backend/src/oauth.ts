// OAuth 2.1 authorization UI for the MCP endpoint. The heavy lifting (dynamic
// client registration, PKCE, token issuance/refresh, KV storage, metadata
// endpoints) is done by @cloudflare/workers-oauth-provider in index.ts; this
// module renders the login/consent screen and completes the grant after
// verifying the user's WTM email + password.
import type { Context } from "hono";
import type { ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { Env, Vars } from "./env";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "./auth";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function page(clientName: string, oauthQuery: string, error?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Web Time Machine</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;background:#f5f6f8;color:#1a1d21;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:2rem;width:min(92vw,380px)}
  h1{font-size:1.15rem;margin:0 0 .25rem}
  p.sub{margin:0 0 1.25rem;color:#5c636b;font-size:.9rem}
  label{display:block;font-size:.85rem;font-weight:600;margin:.75rem 0 .25rem}
  input{width:100%;box-sizing:border-box;padding:.55rem .7rem;border:1px solid #cfd4da;border-radius:8px;font-size:1rem}
  button{width:100%;margin-top:1.25rem;padding:.65rem;border:0;border-radius:8px;background:#1a73e8;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
  .err{background:#fdecea;color:#b3261e;border-radius:8px;padding:.6rem .8rem;font-size:.88rem;margin-bottom:.5rem}
  .scope{background:#f1f3f5;border-radius:8px;padding:.6rem .8rem;font-size:.85rem;color:#3c434a;margin-top:1rem}
</style></head><body><div class="card">
<h1>Web Time Machine</h1>
<p class="sub"><strong>${esc(clientName)}</strong> is asking to access your browsing history.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="oauth_query" value="${esc(oauthQuery)}">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in &amp; allow</button>
</form>
<div class="scope">Grants read access to your captured pages (search, timeline, page text). Sensitive-flagged pages stay excluded by default. You can revoke access any time by changing your password.</div>
</div></body></html>`;
}

async function clientForRequest(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  query: string,
): Promise<{ clientName: string; reqInfo: Awaited<ReturnType<Env["OAUTH_PROVIDER"]["parseAuthRequest"]>> } | Response> {
  const url = new URL(c.req.url);
  const parseReq = new Request(`${url.origin}/oauth/authorize?${query}`);
  let reqInfo;
  try {
    reqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(parseReq);
  } catch {
    return c.text("Invalid authorization request.", 400);
  }
  const client: ClientInfo | null = await c.env.OAUTH_PROVIDER.lookupClient(reqInfo.clientId).catch(() => null);
  if (!client) return c.text("Unknown OAuth client.", 400);
  // Belt-and-braces: the redirect target must be one the client registered.
  if (!client.redirectUris?.includes(reqInfo.redirectUri))
    return c.text("Redirect URI does not match the registered client.", 400);
  return { clientName: client.clientName || reqInfo.clientId, reqInfo };
}

/** GET /oauth/authorize — render the login/consent form. */
export async function authorizeForm(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const query = new URL(c.req.url).searchParams.toString();
  const res = await clientForRequest(c, query);
  if (res instanceof Response) return res;
  return c.html(page(res.clientName, query));
}

/** POST /oauth/authorize — verify credentials, complete the grant, redirect back. */
export async function authorizeSubmit(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const form = await c.req.formData().catch(() => null);
  const query = String(form?.get("oauth_query") ?? "");
  const email = String(form?.get("email") ?? "").trim().toLowerCase();
  const password = String(form?.get("password") ?? "");
  const res = await clientForRequest(c, query);
  if (res instanceof Response) return res;

  const row = await c.env.DB.prepare(
    "SELECT id, email, password_hash, password_salt, iterations FROM users WHERE lower(email) = ?1",
  )
    .bind(email)
    .first<{ id: string; email: string; password_hash: string; password_salt: string; iterations: number }>();

  // Same decoy-hash timing defense as /auth/login.
  const stored = row
    ? { hash: row.password_hash, salt: row.password_salt, iterations: row.iterations }
    : DUMMY_PASSWORD_HASH;
  const passwordOk = await verifyPassword(password, stored);
  if (!row || !passwordOk) return c.html(page(res.clientName, query, "Incorrect email or password."), 401);

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: res.reqInfo,
    userId: row.id,
    scope: res.reqInfo.scope ?? [],
    metadata: { client: res.clientName, at: Date.now() },
    props: { userId: row.id, email: row.email },
  });
  return c.redirect(redirectTo, 302);
}
