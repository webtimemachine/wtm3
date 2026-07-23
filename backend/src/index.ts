import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { app } from "./app";
import { verifySession } from "./auth";
import type { Env } from "./env";
import { purgeExpiredCredentials, runRetention } from "./maintenance";
import { mcpRpc } from "./mcp";

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      if (request.method !== "POST")
        return new Response(
          JSON.stringify({
            error: "method_not_allowed",
            message: "POST JSON-RPC to /mcp.",
          }),
          {
            status: 405,
            headers: { "Content-Type": "application/json" },
          },
        );
      const props = (
        ctx as ExecutionContext & { props?: { userId?: string } }
      ).props;
      if (!props?.userId)
        return new Response("Unauthorized", { status: 401 });
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
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const authorization = request.headers.get("Authorization") || "";
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      const session = token
        ? await verifySession(env.DB, token)
        : null;
      if (session) {
        if (request.method !== "POST")
          return new Response(
            JSON.stringify({
              error: "method_not_allowed",
              message: "POST JSON-RPC to /mcp.",
            }),
            {
              status: 405,
              headers: { "Content-Type": "application/json" },
            },
          );
        return mcpRpc(env, session.userId, request);
      }
    }
    return provider.fetch(request, env, ctx);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runRetention(env).then((count) => {
        if (count) console.log(`retention: purged ${count} expired pages`);
      }),
    );
    ctx.waitUntil(purgeExpiredCredentials(env));
    ctx.waitUntil(provider.purgeExpiredData(env).then(() => undefined));
  },
};
