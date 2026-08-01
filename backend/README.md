# Web Time Machine backend

Hono Worker using D1 for account/page metadata and FTS5, R2 for readable page
text, Workers AI for page summaries, Cloudflare Email Service for password
resets, and KV-backed OAuth for the MCP endpoint.

## Bindings

| Binding | Purpose |
| --- | --- |
| `DB` | Users, opaque sessions, reset tokens, nodes, pages, and FTS5 |
| `BUCKET` | Readable text at `text/<userId>/<pageId>` |
| `AI` | Summary and sensitive-content classification |
| `EMAIL` | Transactional password-reset email |
| `OAUTH_KV` | MCP OAuth clients, grants, and tokens |

Email Sending must be onboarded for `webtm.io` before production deployment.
Cloudflare adds the sending-domain SPF, DKIM, DMARC, and `cf-bounce` records.
The Worker sends as `Web Time Machine <noreply@webtm.io>` with
`Reply-To: info@webtm.io`. Email Routing alone only supports sends to verified
destination addresses; password resets require arbitrary-recipient Email
Sending on a Workers Paid plan.

## Endpoints

```text
GET    /health
POST   /auth/register
POST   /auth/login
GET    /auth/me
POST   /auth/logout
POST   /auth/logout-everywhere
POST   /auth/password
POST   /auth/password-reset/request
POST   /auth/password-reset/confirm
DELETE /account

PATCH  /settings
POST   /nodes
GET    /nodes
PATCH  /nodes/:id
POST   /sync/push
GET    /search?q=&limit=&offset=&from=&to=&site=&sort=
GET    /pages?limit=&before=<visitedAt>
GET    /pages/:id
GET    /pages/:id/text
DELETE /pages/:id
POST   /mcp
```

There is deliberately no `/sync/pull`, page mutation cursor, tombstone, public
beta-signup endpoint, or diagnostic-report endpoint in v4.

## Local development

```bash
pnpm --filter @wtm/backend migrate:local
pnpm --filter @wtm/backend dev -c wrangler.dev.jsonc
```

The development config simulates email locally and omits Workers AI. Run the
Worker-runtime integration suite with:

```bash
pnpm --filter @wtm/backend test
```

The suite applies the real D1 migrations inside workerd and exercises account
sessions, reset-token consumption, hard page deletion, R2, and the temporary
legacy schema compatibility needed during rollout.

## Safe v4 production rollout

Do not apply all migrations before the compatible Worker is live.

1. Onboard `webtm.io` in Cloudflare Email Sending.
2. Apply only additive migration `0006_v4_sessions.sql`:
   `pnpm --filter @wtm/backend migrate:v4:additive`.
3. Deploy the v4 backend Worker. It accepts both the legacy and trimmed page
   schemas.
4. Verify `/health`, registration/login, a page push, search, password-reset
   delivery, and MCP OAuth.
5. Apply destructive migration `0007_v4_cleanup.sql`. This permanently deletes
   beta signups, diagnostics, tombstones, sequence infrastructure, and retired
   page columns.
6. Deploy the v4 web dashboard and browser extensions. Existing v3 JWTs will
   receive `401` and prompt one intentional re-login.

After the additive phase and Worker deployment, the normal migration command
applies only destructive migration 0007:

```bash
pnpm --filter @wtm/backend exec wrangler d1 migrations apply wtm --remote
pnpm --filter @wtm/backend deploy
```
