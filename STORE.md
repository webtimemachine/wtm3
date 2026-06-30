# Store submission guide

Listing copy + step-by-step for publishing Web Time Machine to the **iOS App Store**
(the Safari extension ships inside the iOS app) and the **Chrome Web Store**.

Shared facts:

| | |
| --- | --- |
| Name | Web Time Machine |
| Version | 3.0.0 (build 1) |
| Privacy policy | https://webtm.io/privacy |
| Support / marketing | https://webtm.io |
| Source | https://github.com/webtimemachine/wtm3 |
| Backend | https://api.webtm.io |

---

## iOS App Store

**App record:** Apple ID `6477404511` · SKU `wtm2` · bundle id `com.ttt246llc.wtm`
· Team `2858MX5336`. Marketing icon (1024², opaque) is already in the asset catalog.

### Upload the build (Xcode)

1. Open `extension-safari/xcode/Web Time Machine/Web Time Machine.xcodeproj`.
2. Device selector → **Any iOS Device (arm64)**.
3. **Product → Archive** (signing is Automatic with your team).
4. In the Organizer: **Distribute App → App Store Connect → Upload**.
5. The build appears in App Store Connect under the app (Apple ID 6477404511) after processing.

### App Store Connect metadata

- **Name:** Web Time Machine
- **Subtitle:** Search everything you've read
- **Category:** Productivity (secondary: Utilities)
- **Promotional text:** Your browsing history, finally useful — full-text searchable, summarized, and synced across your devices.
- **Description:**
  ```
  Web Time Machine quietly remembers the readable text of every page you visit and
  makes your history actually useful.

  • Full-text search — find a page by something it said, not just its title or URL.
  • One-line AI summaries — skim what each page was about.
  • Synced across your devices — capture on iPhone and your Mac/PC, search anywhere.
  • Private to your account — your history syncs to your own space, never sold.
  • Auto-expiring — history rolls off on a retention schedule; delete anything instantly,
    and deletions propagate everywhere.

  Capture runs in a Safari Web Extension and is fully passive — it never changes the
  pages you browse, and nothing is recorded until you turn it on and sign in.
  ```
- **Keywords:** `history,search,browsing,bookmarks,memory,readlater,productivity,sync,safari,fulltext`
- **Privacy Policy URL:** https://webtm.io/privacy
- **Support URL:** https://webtm.io

### App Privacy (data collection)

Declare: **Browsing History** and **User Content** (page text) and **Contact Info**
(email), linked to the user's identity, used for **App Functionality** only. Not used
for tracking. Not shared with third parties (other than the hosting provider).

### Screenshots (you provide)

- Required sizes: 6.9"/6.7" iPhone (e.g. 1320×2868 or 1290×2796). Capture: the dashboard
  timeline at `webtm.io` and a search result. Use the iOS Simulator (iPhone 17 Pro) or a device.

---

## Chrome Web Store

### Package

```bash
pnpm --filter @wtm/extension-chrome package   # -> extension-chrome/wtm-chrome.zip
```

(MV3, version 3.0.0, source maps stripped.)

### Create the item

1. https://chromewebstore.google.com/devconsole (one-time $5 developer registration).
2. **New item → Upload** `extension-chrome/wtm-chrome.zip`.
3. Fill the listing (below), add assets, set privacy, **Submit for review**.

### Listing copy

- **Name:** Web Time Machine
- **Summary (≤132 chars):** Passively capture the readable text of every page you visit, then full-text search and sync your history across devices.
- **Category:** Productivity
- **Description:** (reuse the iOS description above)
- **Privacy policy URL:** https://webtm.io/privacy

### Permissions justification (Chrome requires this)

- **Single purpose:** Record the pages you visit and let you search/sync your own history.
- `storage` — keep your login, settings, and the local capture queue.
- `alarms` — periodically flush queued captures to your account.
- host access `http://*/*`, `https://*/*` — the content script reads the readable text of
  pages you visit, and the worker sends it to your backend. No page is modified.
- **Data use:** captured page text + URLs are sent only to the user's Web Time Machine
  backend (`api.webtm.io`); not sold, not used for ads. Privacy policy linked above.

### Privacy practices (the dashboard's required form)

- **Single purpose (one sentence):** Web Time Machine records the readable text of pages
  you visit so you can full-text search and sync your own browsing history across devices.
- **Data the item collects** (check + certify each):
  - *Web history* — URLs and the readable text of pages you visit.
  - *Authentication information* — your account email + password (to sign in/sync).
  - *Personally identifiable information* — email address.
- **How it's used / certifications (toggle all three "I certify"):**
  - Not sold to third parties.
  - Used only for the single purpose above (sync + search of your own history).
  - Not used to determine creditworthiness or for lending.
- **Remote code:** No — all code is contained in the package (no `eval`, no remote scripts).
- **Privacy policy URL:** https://webtm.io/privacy

### Assets

- **Store icon 128²:** `extension-chrome/icons/icon128.png` (in the zip).
- **Screenshots (1280×800, ready to upload):** the two generated images — a populated
  timeline with AI summaries, and a full-text search result. (Chrome needs ≥1; max 5.)
- Optional small promo tile 440×280 (not required).

---

## We update the EXISTING extension, not a new listing

There is already a published extension, **`dfijieibikhpelmfhkjmihgfgpoeigch`** (was v1.0).
We push v3 onto it (keeps existing users/reviews); the site's "Add to Chrome" already
points at it. The throwaway new listing `hfelig…` was archived.

## Reviewer / tester instructions (CWS dashboard "Account" tab)

The extension requires sign-in, so provide a test account + steps:

```
This is a Safari/Chrome extension that captures the readable text of pages you visit
and syncs it to your account for full-text search + one-line AI summaries.

To test:
1. After install, click the Web Time Machine toolbar icon.
2. The backend URL is prefilled (https://api.webtm.io). Sign in with the test account below.
3. Browse a few sites, reopen the popup: captured pages appear with summaries and are
   full-text searchable; click a result to revisit. The web dashboard at https://webtm.io
   shows the same history.

Test account (pre-seeded with sample pages):
  email:    review@webtm.io
  password: WtmReview2026!
```

## Chrome Web Store API automation (one-command updates)

One-time setup (so future `dfiji…` updates are a single command):

1. Google Cloud Console → create/pick a project → **enable the "Chrome Web Store API"**.
2. **OAuth consent screen**: External, add yourself as a Test user, scope
   `.../auth/chromewebstore`.
3. **Credentials → Create OAuth client ID → Web application**; add redirect URI
   `http://localhost`. Note the **client ID + secret**.
4. Put them in `/Users/posix4e/src/.env`:
   ```
   CWS_CLIENT_ID=...
   CWS_CLIENT_SECRET=...
   CWS_ITEM_ID=dfijieibikhpelmfhkjmihgfgpoeigch
   ```
5. Get a refresh token (cross-device friendly — copy the code from the failed localhost redirect):
   ```
   set -a; . /Users/posix4e/src/.env; set +a
   pnpm --filter @wtm/extension-chrome cws:auth-url        # open URL, approve, copy ?code=…
   pnpm --filter @wtm/extension-chrome cws:exchange -- <code>   # prints CWS_REFRESH_TOKEN
   ```
   Add the printed `CWS_REFRESH_TOKEN=…` to `.env`.

Then publish (builds + zips + uploads + publishes to `dfiji…`):
```
set -a; . /Users/posix4e/src/.env; set +a
pnpm --filter @wtm/extension-chrome cws:publish
```
(`cws-publish.mjs upload` uploads without publishing; `publish` publishes the last upload.)
