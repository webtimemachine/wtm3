# Web Time Machine web dashboard

React/Vite SPA for the captured-history timeline, FTS5 search with quick time
ranges, custom dates, site filtering, and relevance/newest/oldest sorting;
readable-text viewing; device settings; retention; sensitive-page filtering;
and the complete account lifecycle:

- create account and log in
- request and consume a 30-minute password-reset link
- change password
- ordinary logout and log out everywhere
- permanently delete the account and its history

The app uses `@wtm/shared` for the API contract and client.

## Develop

```bash
pnpm --filter @wtm/web dev
pnpm --filter @wtm/web typecheck
pnpm --filter @wtm/web build
```

The login screen accepts a backend URL for local development; production
defaults to `https://api.webtm.io`.

## Deployments

`wrangler.jsonc` serves `dist/` with SPA fallback:

- production: `webtm.io` and `www.webtm.io`
- preview: `beta.webtm.io`

The pull-request preview workflow also stages a Chrome zip and, when AMO
credentials are available, a signed Firefox XPI under `/downloads/`. The
preview page has no public beta-signup form.

## Rendering safety

FTS snippets pass through `snippetHtml()` before React renders them. Captured
text is escaped, and only the server-provided `<mark>` highlight tags survive.
