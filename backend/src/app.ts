import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifySession } from "./auth";
import type { Env, Vars } from "./env";
import { authorizeForm, authorizeSubmit } from "./oauth";
import { registerAuthRoutes } from "./routes/auth";
import { registerNodeRoutes } from "./routes/nodes";
import { registerPageRoutes } from "./routes/pages";
import { registerAssistRoutes } from "./routes/assist";
import { registerSettingsRoutes } from "./routes/settings";

export const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "MCP-Protocol-Version",
      "Mcp-Session-Id",
    ],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86_400,
  }),
);

app.get("/health", (c) =>
  c.json({ ok: true, service: "wtm-backend", version: 4 }),
);

const protectedPaths = [
  "/auth/me",
  "/auth/logout",
  "/auth/logout-everywhere",
  "/auth/password",
  "/auth/extension/approve",
  "/account",
  "/settings",
  "/nodes",
  "/nodes/*",
  "/sync/*",
  "/search",
  "/suggest",
  "/index-snapshot",
  "/pages",
  "/pages/*",
];
for (const path of protectedPaths) {
  app.use(path, async (c, next) => {
    const authorization = c.req.header("Authorization") || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const session = token
      ? await verifySession(c.env.DB, token)
      : null;
    if (!session)
      return c.json(
        { error: "unauthorized", message: "Missing or invalid session." },
        401,
      );
    c.set("userId", session.userId);
    c.set("email", session.email);
    c.set("sessionId", session.sessionId);
    c.set("sessionScope", session.scope);
    if (session.scope === "capture" && !captureSessionAllowed(c.req.method, c.req.path)) {
      return c.json(
        { error: "insufficient_scope", message: "This device token can only upload captured pages." },
        403,
      );
    }
    if (session.scope === "assist" && !assistSessionAllowed(c.req.method, c.req.path)) {
      return c.json(
        { error: "insufficient_scope", message: "This Search Assist token can only read history suggestions." },
        403,
      );
    }
    await next();
  });
}

function assistSessionAllowed(method: string, path: string): boolean {
  return (
    (method === "GET" && path === "/auth/me") ||
    (method === "POST" && path === "/auth/logout") ||
    (method === "GET" && path === "/suggest") ||
    (method === "GET" && path === "/index-snapshot")
  );
}

function captureSessionAllowed(method: string, path: string): boolean {
  return (
    (method === "GET" && path === "/auth/me") ||
    (method === "POST" && path === "/auth/logout") ||
    (method === "POST" && path === "/nodes") ||
    (method === "POST" && path === "/sync/push")
  );
}

registerAuthRoutes(app);
registerSettingsRoutes(app);
registerNodeRoutes(app);
registerPageRoutes(app);
registerAssistRoutes(app);

app.get("/oauth/authorize", authorizeForm);
app.post("/oauth/authorize", authorizeSubmit);

app.notFound((c) =>
  c.json({ error: "not_found", message: "No such route." }, 404),
);
app.onError((error, c) => {
  console.error("unhandled", error);
  return c.json(
    { error: "internal", message: "Something went wrong." },
    500,
  );
});
