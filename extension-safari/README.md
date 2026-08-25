# Web Time Machine — iOS Safari Web Extension

The iOS app wraps a Safari Web Extension around the **same** capture/sync and
popup JavaScript as the Chrome extension. `build.mjs` re-bundles `extension-chrome/src`
with the platform define set to `safari-ios`, so devices register as
`Safari on iPhone/iPad` and everything else is shared.

## 1. Build the web-extension resources

```bash
pnpm --filter @wtm/extension-chrome icons   # if icons/ not generated yet
pnpm --filter @wtm/extension-safari build    # -> extension-safari/wtm-extension/
```

## 2. Sync or generate the Xcode project

For the checked-in project, copy a new web-extension build into its Resources:

```bash
pnpm --filter @wtm/extension-safari sync-resources
```

To regenerate the project itself, you need full Xcode.

Command Line Tools is **not** enough — install Xcode and point to it:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
pnpm --filter @wtm/extension-safari convert   # runs convert.sh
```

This runs `xcrun safari-web-extension-converter wtm-extension/ …` with:

| Setting        | Value                  |
| -------------- | ---------------------- |
| App name       | Web Time Machine       |
| Bundle id      | `com.ttt246llc.wtm`    |
| Platform       | iOS                    |

Output: `extension-safari/xcode/`.

## 3. Build, run, submit

1. Open `extension-safari/xcode/Web Time Machine/Web Time Machine.xcodeproj`.
2. Select your **Team** under Signing & Capabilities for both the app and the
   extension targets (the extension's bundle id is `com.ttt246llc.wtm.Extension`).
   The checked-in entitlements require App Group `group.com.ttt246llc.wtm` and
   Keychain Sharing group `com.ttt246llc.wtm.shared` on both provisioning profiles.
3. Run on the iOS Simulator or a device. On device: **Settings → Safari → Extensions
   → Web Time Machine → Enable**, allow on All Websites, then open the popup and
   connect it through `webtm.io`.
4. Approve **Search Assist** separately from the popup. The containing app will
   show the resulting Core Spotlight item count and refresh/clear controls.
5. Archive (Product → Archive) and upload to **App Store Connect**:
   - **Apple ID:** 6477404511
   - **SKU:** wtm2
   - **Bundle id:** com.ttt246llc.wtm

## Notes / Safari caveats

- Rebuild and run `sync-resources` whenever the shared JS changes.
- Sign-in happens on `webtm.io`, where iCloud Keychain and other password managers
  work normally. Reopen the popup after approval if iOS closed it during handoff.
- Capture receives a write-only token. Search Assist receives a separate,
  read-only token limited to metadata suggestions and Spotlight snapshots.
  Neither receives the website password or full account session.
- Search Assist indexes titles, URLs, and visit times—not captured page text—and
  always excludes sensitive pages. The token is handed to the app through the
  native extension bridge and stored in the shared Keychain group.
- iOS does not let a Safari Web Extension register a native search provider.
  The optional popup toggle only redirects submitted Google, Bing, or DuckDuckGo
  searches that begin with `wtm ` or `!w `; normal queries and autocomplete are
  not intercepted.
- Safari supports the `chrome.*` namespace, `storage`, `alarms`, content scripts,
  and an MV3 `service_worker`, so the shared code runs as-is. If a future Safari
  version balks at the module service worker, switch `manifest.json` background to
  `{"scripts":["background.js"],"persistent":false}` and rebuild `background.js` as
  an IIFE.
- Set the backend URL in the popup just like the Chrome extension.
