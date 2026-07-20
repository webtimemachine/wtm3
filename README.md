# Web Time Machine (v3)

Passively record every page you visit — URL, title, timestamp, and the **readable
text** of the page — across all your devices, then full-text search the content,
see a one-line AI summary per page, and have history expire on a retention schedule
or be manually deleted with deletes propagating everywhere.

Cloudflare-native rebuild. Earlier attempts (`wtm`, `wtm2`, `timemachine`) were a
single central NestJS/Postgres/OpenAI backend — this is **not** a fork of them.

## Topology

```
            ┌──────────────────────────────────────────────┐
            │              Cloudflare (one backend)          │
 nodes ───► │  Worker (Hono)                                 │
 (devices)  │   ├─ D1 (SQLite): users, nodes, pages, FTS5    │
            │   ├─ R2: full readable-text blobs              │
            │   ├─ Workers AI: one-line per-page summaries    │
            │   └─ Cron: retention purge                     │
            └──────────────────────────────────────────────┘
                 ▲             ▲              ▲                  ▲
   ┌─────────────┘    ┌────────┘     ┌────────┘         ┌────────┘
 Chrome ext      Firefox Android  iOS Safari ext      Web dashboard
 (Readability)   (Readability)    (Readability)       (search + timeline)
```

A **node** is one of your devices. Every node syncs to the single Cloudflare
backend (not peer-to-peer): it pushes captured pages + deletes and pulls changes
since a per-user sequence cursor, so new pages, generated summaries, and deletions
all converge across devices.

## Packages

| Path                | What                                                            |
| ------------------- | --------------------------------------------------------------- |
| `shared/`           | Wire-protocol types + on-device capture (`@mozilla/readability`) |
| `backend/`          | Cloudflare Worker: auth, ingest, search, sync, summaries, MCP, cron |
| `extension-chrome/` | Manifest V3 extension (passive capture)                         |
| `extension-firefox/`| Firefox for Android extension (passive capture)                  |
| `extension-safari/` | iOS Safari Web Extension + Xcode wrapper                        |
| `web/`              | Web dashboard (search + timeline), deploys to `webtm.io`        |

## MCP recall interface

The backend exposes an MCP server at **`POST https://api.webtm.io/mcp`**
(stateless streamable HTTP) so Claude and other MCP clients can search your
history: `search_history`, `recent_history`, `get_page_text`. Auth is the same
Bearer JWT as the REST API (`POST /auth/login` → `token`). Pages flagged
sensitive are excluded from results unless a call opts in. Connect from
Claude Code:

```sh
claude mcp add --transport http wtm https://api.webtm.io/mcp \
  --header "Authorization: Bearer <token>"
```

A companion skill teaching Claude when/how to use these tools lives at
`.claude/skills/wtm-recall/`.

## Locked product decisions (§1 of the spec)

- **Backend:** Cloudflare Workers + D1 + R2 + Workers AI. No servers.
- **Capture:** full readable text on-device (Readability) + URL/title/timestamp.
- **Search:** D1 FTS5 over page content, BM25 ranked.
- **Identity:** traditional email/password.
- **Sync:** nodes → one Cloudflare backend.
- **GitHub org:** https://github.com/webtimemachine · **Domains:** webtm.io / webtimemachine.io
- **iOS:** bundle id `com.ttt246llc.wtm`, SKU `wtm2`, Apple ID `6477404511`.

> The spec handed off (§0–§1) was truncated before §2–§13 (architecture, data
> model, milestone order, verification). The architecture/data-model here was
> designed from the locked decisions; see `backend/migrations` and `shared/src`.

## Quick start

```bash
pnpm install
# Backend (provision + deploy): see backend/README.md
pnpm --filter @wtm/backend deploy
```

## Toolchain

pnpm workspace · TypeScript · Wrangler · Hono. Node ≥ 20.
