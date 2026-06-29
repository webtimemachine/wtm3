# Web Time Machine — web dashboard

Vite + React SPA: log in, browse a **timeline** of captured pages (`/pages`),
**full-text search** the content (`/search`, BM25 + highlighted snippets), read a
page's **AI summary** and full text, and **delete** (propagates to all devices).
Talks to the backend through `@wtm/shared` (`WtmClient`).

## Develop

```bash
pnpm --filter @wtm/web dev        # Vite dev server
```

Set the backend URL on the login screen (default `https://api.webtm.io`; use your
`wtm-backend.<subdomain>.workers.dev` or `http://localhost:8787` while developing).

## Build & deploy (Cloudflare Workers static assets)

```bash
pnpm --filter @wtm/web build      # tsc --noEmit && vite build -> dist/
set -a; . /Users/posix4e/src/.env; set +a
export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
pnpm --filter @wtm/web exec wrangler deploy   # serves dist/ as an SPA at webtm.io
```

`wrangler.jsonc` serves `dist/` with SPA fallback and attaches custom domains
`webtm.io` + `www.webtm.io` (needs **Zone:DNS:Edit** on the token).

## Security note

FTS snippets are escaped in `snippetHtml()` before rendering — only the server's
`<mark>` highlight tags survive, so captured page text can't inject HTML.
