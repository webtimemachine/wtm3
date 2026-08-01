# Web Time Machine (v4)

Web Time Machine passively captures the URL, title, timestamp, and readable
text of pages you visit. It syncs that history to one account, makes the full
text searchable, adds a one-line AI summary, and exposes the same history to
Claude and Codex through MCP.

This is a Cloudflare-native rebuild. Earlier projects named `wtm`, `wtm2`, and
`timemachine` used a central NestJS/Postgres/OpenAI backend; this repository
does not fork them.

## Architecture

```text
Chrome ─┐
Firefox ├── push captures ──► Cloudflare Worker
Safari ─┘                     ├─ D1: accounts, sessions, metadata, FTS5
Web dashboard ◄───────────────┼─ R2: readable-text blobs
Claude / Codex ◄── MCP ───────┼─ Workers AI: summaries and classification
                              ├─ Email Service: password resets
                              └─ Cron: retention and credential cleanup
```

Devices only push captured pages. The dashboard, extensions, and MCP tools read
the canonical server state directly. Deletes are permanent; v4 has no pull
cursor, mutation sequence, or tombstone layer.

## Packages

| Path | Purpose |
| --- | --- |
| `shared/` | Wire types, API client, formatting, and on-device capture |
| `backend/` | Hono Worker, D1/R2/AI/email bindings, OAuth MCP, retention |
| `extension-chrome/` | Shared browser-extension source and Chrome MV3 build |
| `extension-firefox/` | Firefox for Android build and AMO publishing |
| `extension-safari/` | iOS Safari build and Xcode wrapper |
| `web/` | React search/timeline dashboard at `webtm.io` |
| `skills/` | Canonical recall skill, generated for Claude and Codex |

## Accounts and sessions

Passwords use PBKDF2-HMAC-SHA256. Successful logins issue random opaque
90-day session tokens; D1 stores only their SHA-256 hashes. The account UI
supports ordinary logout, log out everywhere, password change, single-use
30-minute password reset links, and self-service account deletion. Password
changes, resets, and account deletion also revoke MCP OAuth grants.

Upgrading from v3 intentionally invalidates the old stateless JWTs, so every
client signs in once after the v4 rollout.

## MCP recall

`https://api.webtm.io/mcp` exposes:

- `search_history`
- `recent_history`
- `get_page_text`

Remote clients can authenticate through OAuth 2.1. A v4 Web Time Machine
session token also works as a direct Bearer token for local tools. The
canonical usage skill is [`skills/wtm-recall/SKILL.md`](skills/wtm-recall/SKILL.md);
`pnpm sync:skills` generates the repo-scoped Claude and Codex copies.

## Develop and verify

```bash
pnpm install
pnpm typecheck
pnpm -r --if-present test
pnpm build
```

Backend setup and the required phased v4 deployment order are documented in
[`backend/README.md`](backend/README.md).

## Product constants

- Cloudflare Workers + D1 + R2 + Workers AI; no application servers
- Full readable text extracted on-device with Mozilla Readability
- D1 FTS5 search with BM25 ranking
- Email/password identity
- GitHub organization: <https://github.com/webtimemachine>
- Domains: `webtm.io`, `webtimemachine.io`, and `api.webtm.io`
- iOS bundle id: `com.ttt246llc.wtm`; Apple ID: `6477404511`

Toolchain: pnpm workspace, TypeScript, Wrangler, Hono, React, Node 20 or newer.
