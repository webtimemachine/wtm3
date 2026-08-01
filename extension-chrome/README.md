# Web Time Machine — Chrome extension (MV3)

Passively captures the readable text of every page you visit and syncs it to your
Web Time Machine backend. Search and manage history in the hosted dashboard.

## Build

```bash
pnpm --filter @wtm/extension-chrome icons   # generate icons (once)
pnpm --filter @wtm/extension-chrome build   # -> dist/
```

## Load in Chrome

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `extension-chrome/dist/`.
3. Click the toolbar icon → set the **Backend URL** (default `https://api.webtm.io`,
   or your `wtm-backend.<subdomain>.workers.dev`, or `http://localhost:8787` for dev)
   → **Connect with webtm.io**. Sign in or create an account on the website and
   approve the browser connection.

## How it works

- `content.ts` — runs Mozilla Readability on each page (and on SPA route changes),
  sends `{url,title,visitedAt,text,…}` to the background worker. Never blocks the page.
- `background.ts` — queues captures in `chrome.storage.local`, registers this device
  as a **node**, and `POST`s batches to `/sync/push` (debounced + a 1-min alarm).
  A `401` clears the token so the popup re-prompts.
- `popup.ts` — passwordless website handoff, capture on/off, sync status,
  device-specific recovery controls, and a link to the hosted dashboard.

The extension never receives a password. The website exchanges a one-time,
PKCE-protected connection request for a token restricted to account identity and
capture uploads. Search and account settings continue to use the website session.

All API calls go through `@wtm/shared/api` (`WtmClient`), so the contract stays in
lockstep with the backend and the other clients.

## Notes

- `host_permissions` is `http/https` so the content script can read pages and the
  worker can reach your backend. Pages are captured passively; nothing is sent until
  you log in.
- This same bundle is the basis for the iOS Safari extension (see `extension-safari/`).
