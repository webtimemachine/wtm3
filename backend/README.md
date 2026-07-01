# Web Time Machine — backend (Cloudflare Worker)

Hono Worker on **D1** (metadata + FTS5) + **R2** (full readable text) + **Workers AI**
(one-line summaries) + a retention **cron**. Auth is email/password (PBKDF2 + JWT).

## Bindings (`wrangler.jsonc`)

| Binding | Resource | Purpose |
| ------- | -------- | ------- |
| `DB`     | D1 `wtm`        | users, nodes, pages, `pages_fts` (FTS5/BM25), per-user change log |
| `BUCKET` | R2 `wtm-pages`  | full readable text at `text/<userId>/<pageId>` |
| `AI`     | Workers AI      | `SUMMARY_MODEL` one-line summaries (background, `waitUntil`) |
| secret `JWT_SECRET` | — | HMAC key for session JWTs |

## Endpoints

```
GET  /health
POST /auth/register        POST /auth/login        GET /auth/me
POST /nodes                GET  /nodes
POST /sync/push            GET  /sync/pull?since=<seq>&limit=
GET  /search?q=&limit=&offset=        (FTS5, BM25, <mark> snippets)
GET  /pages?limit=&before=<visitedAt> (recent timeline)
GET  /pages/:id            GET  /pages/:id/text     DELETE /pages/:id
```

Sync model: every mutation (insert / summary / delete-tombstone) gets a unique
per-user `seq`; clients `pull` everything with `seq > cursor`, so new pages,
generated summaries, and deletions all converge across devices.

## Local dev

```bash
cp .dev.vars.example .dev.vars                 # sets a dev JWT_SECRET
pnpm --filter @wtm/backend exec wrangler d1 migrations apply wtm --local
pnpm --filter @wtm/backend exec wrangler dev -c wrangler.dev.jsonc   # D1+R2 local, no AI/remote
```

## Deploy (webtimemachine.io account)

Credentials come from `/Users/posix4e/src/.env` (`CF_API_TOKEN`, `CF_ACCOUNT_ID`):

```bash
set -a; . /Users/posix4e/src/.env; set +a
export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"

# one-time: R2 must be enabled on the account (dashboard), then:
pnpm --filter @wtm/backend exec wrangler r2 bucket create wtm-pages
pnpm --filter @wtm/backend exec wrangler d1 migrations apply wtm --remote   # already applied
pnpm --filter @wtm/backend exec wrangler deploy                            # -> api.webtm.io (custom domain) + workers.dev
echo "<strong-secret>" | pnpm --filter @wtm/backend exec wrangler secret put JWT_SECRET
```

Custom domain `api.webtm.io` is wired via `routes` in `wrangler.jsonc`; attaching it
needs the token to have **Zone:DNS:Edit**.

## State

- D1 `wtm` (`0e4724c9-5630-40b5-957d-6547cc14d649`) created + migrated on account
  `b732618f85b1356a957deddd468c4f58`.
- `workers.dev` subdomain `webtimemachine` registered.
- Pending: enable **R2**; grant **DNS edit** on the token.
