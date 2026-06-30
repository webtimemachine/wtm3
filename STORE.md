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

## After Chrome is published

Set the live URL so the dashboard's "Coming soon to Chrome" badge becomes a real
**Add to Chrome** button:

1. Edit `web/src/links.ts` → `CHROME_STORE_URL = "https://chromewebstore.google.com/detail/<extension-id>"`.
2. `pnpm --filter @wtm/web build && (cd web && wrangler deploy)` (with the CF env from `.env`).
