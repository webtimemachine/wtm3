// Stateless MCP (Model Context Protocol) endpoint — streamable-HTTP transport,
// JSON responses only (no SSE stream, no sessions). Lets Claude Code / Claude
// Desktop / any MCP client search and recall the authenticated user's browsing
// history. index.ts accepts either an opaque WTM session or an OAuth access
// token before calling the protocol handler.
import type { Env } from "./env";
import { hasLegacyPageColumns, rowToPage, type PageRow } from "./db";
import { toMatchQuery } from "./search";

const PROTOCOL_VERSION = "2025-06-18";
const DAY_MS = 86_400_000;

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema advertised to clients)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "search_history",
    description:
      "Full-text search the user's captured browsing history (page titles and readable text). " +
      "Tokens are prefix-matched and AND-ed ('rust async' finds pages containing both). " +
      "Returns matching pages with id, title, URL, visit time, and a snippet. " +
      "Use get_page_text with a result id when the snippet isn't enough.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-form search terms" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results (default 10)" },
        from: { type: "string", description: "Only pages visited on/after this ISO date (e.g. 2026-07-01)" },
        to: { type: "string", description: "Only pages visited on/before this ISO date" },
        include_sensitive: {
          type: "boolean",
          description: "Include pages flagged as sensitive/adult (default false)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "recent_history",
    description:
      "List the user's most recently visited pages, newest first. Use for 'what was I reading " +
      "yesterday / this morning' style recall when there is no good search term.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", minimum: 0.04, maximum: 90, description: "Look-back window in days (default 1)" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 20)" },
        include_sensitive: {
          type: "boolean",
          description: "Include pages flagged as sensitive/adult (default false)",
        },
      },
    },
  },
  {
    name: "get_page_text",
    description:
      "Fetch the full readable text of one captured page by id (ids come from search_history / " +
      "recent_history results). Text is truncated to max_chars.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Page id from a previous result" },
        max_chars: { type: "integer", minimum: 100, maximum: 100_000, description: "Truncate text (default 20000)" },
      },
      required: ["id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function fmtPage(p: ReturnType<typeof rowToPage>, extra?: string): string {
  const lines = [
    `[${fmtTime(p.visitedAt)}] ${p.title || "(untitled)"}`,
    `  ${p.url}`,
    `  id: ${p.id}`,
  ];
  const gist = extra || p.summary;
  if (gist) lines.push(`  ${gist}`);
  return lines.join("\n");
}

function parseDay(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

async function searchHistory(env: Env, userId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const match = toMatchQuery(typeof args.query === "string" ? args.query : "");
  if (!match) return err("Provide at least one alphanumeric search term.");
  const limit = clampInt(args.limit, 1, 50, 10);
  const from = parseDay(args.from);
  // An ISO date means the whole day — make the upper bound inclusive.
  const to = parseDay(args.to);
  const toEnd = to !== null ? to + DAY_MS : null;
  const sens = args.include_sensitive === true ? "" : "AND p.sensitive = 0";
  const active = (await hasLegacyPageColumns(env)) ? "AND p.deleted = 0" : "";

  const conds = [`pages_fts MATCH ?1`, `p.user_id = ?2`];
  const binds: unknown[] = [match, userId];
  if (from !== null) {
    binds.push(from);
    conds.push(`p.visited_at >= ?${binds.length}`);
  }
  if (toEnd !== null) {
    binds.push(toEnd);
    conds.push(`p.visited_at < ?${binds.length}`);
  }
  binds.push(limit);
  const { results } = await env.DB.prepare(
    `SELECT p.*, snippet(pages_fts, 1, '', '', '…', 16) AS snippet, bm25(pages_fts, 5.0, 1.0) AS rank
     FROM pages_fts
     JOIN pages p ON p.id = pages_fts.page_id AND p.user_id = pages_fts.user_id
     WHERE ${conds.join(" AND ")} ${sens} ${active}
     ORDER BY rank LIMIT ?${binds.length}`,
  )
    .bind(...binds)
    .all<PageRow & { snippet: string; rank: number }>();

  if (!results.length) return ok(`No pages matched "${args.query}".`);
  const body = results.map((r) => fmtPage(rowToPage(r), r.snippet || undefined)).join("\n\n");
  return ok(`${results.length} page(s) matched "${args.query}" (best match first):\n\n${body}`);
}

async function recentHistory(env: Env, userId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const days = typeof args.days === "number" && Number.isFinite(args.days) ? Math.min(90, Math.max(0.04, args.days)) : 1;
  const limit = clampInt(args.limit, 1, 100, 20);
  const sens = args.include_sensitive === true ? "" : "AND sensitive = 0";
  const active = (await hasLegacyPageColumns(env)) ? "AND deleted = 0" : "";
  const since = Date.now() - days * DAY_MS;

  const { results } = await env.DB.prepare(
    `SELECT * FROM pages WHERE user_id = ?1 ${sens} ${active} AND visited_at >= ?2
     ORDER BY visited_at DESC LIMIT ?3`,
  )
    .bind(userId, since, limit)
    .all<PageRow>();

  if (!results.length) return ok(`No pages captured in the last ${days} day(s).`);
  const body = results.map((r) => fmtPage(rowToPage(r))).join("\n\n");
  return ok(`${results.length} page(s) in the last ${days} day(s), newest first:\n\n${body}`);
}

async function getPageText(env: Env, userId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) return err("Missing page id.");
  const maxChars = clampInt(args.max_chars, 100, 100_000, 20_000);
  const active = (await hasLegacyPageColumns(env)) ? "AND deleted = 0" : "";

  const row = await env.DB.prepare(
    `SELECT * FROM pages WHERE id = ?1 AND user_id = ?2 ${active}`,
  )
    .bind(id, userId)
    .first<PageRow>();
  if (!row) return err("Page not found.");
  if (!row.r2_key) return err("No stored text for this page (it may have been purged by retention).");

  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) return err("Text object missing from storage.");
  const text = await obj.text();
  const truncated = text.length > maxChars;
  const page = rowToPage(row);
  return ok(
    `${page.title || "(untitled)"}\n${page.url}\nVisited: ${fmtTime(page.visitedAt)}\n\n` +
      text.slice(0, maxChars) +
      (truncated ? `\n\n[truncated at ${maxChars} of ${text.length} chars — raise max_chars for more]` : ""),
  );
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? Math.floor(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Core JSON-RPC handler, independent of how the caller authenticated —
 * reached with a WTM session token (index.ts) or an OAuth access token
 * (OAuthProvider apiHandler in index.ts).
 */
export async function mcpRpc(env: Env, userId: string, request: Request): Promise<Response> {
  const req = (await request.json().catch(() => null)) as RpcRequest | RpcRequest[] | null;
  if (!req || Array.isArray(req) || typeof req.method !== "string")
    return json(rpcError(null, -32600, "Expected a single JSON-RPC request object."), 400);

  // Notifications (no id) get acknowledged with 202 and no body.
  if (req.id === undefined || req.id === null) return new Response(null, { status: 202 });

  switch (req.method) {
    case "initialize": {
      const requested = (req.params as { protocolVersion?: string } | undefined)?.protocolVersion;
      return json(
        rpcResult(req.id, {
          protocolVersion: requested === "2025-03-26" ? requested : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "wtm", title: "Web Time Machine", version: "4.0.0" },
          instructions:
            "Search and recall the user's captured browsing history. Start with search_history; " +
            "use recent_history for time-based recall and get_page_text to read a full page.",
        }),
      );
    }
    case "ping":
      return json(rpcResult(req.id, {}));
    case "tools/list":
      return json(rpcResult(req.id, { tools: TOOLS }));
    case "tools/call": {
      const name = (req.params as { name?: string } | undefined)?.name;
      const args = ((req.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {}) as Record<
        string,
        unknown
      >;
      try {
        let result: ToolResult;
        if (name === "search_history") result = await searchHistory(env, userId, args);
        else if (name === "recent_history") result = await recentHistory(env, userId, args);
        else if (name === "get_page_text") result = await getPageText(env, userId, args);
        else return json(rpcError(req.id, -32602, `Unknown tool: ${String(name)}`));
        return json(rpcResult(req.id, result));
      } catch (e) {
        console.error("mcp tool failed:", e instanceof Error ? e.message : String(e));
        return json(rpcResult(req.id, err("Tool execution failed.")));
      }
    }
    default:
      return json(rpcError(req.id, -32601, `Method not found: ${req.method}`));
  }
}
