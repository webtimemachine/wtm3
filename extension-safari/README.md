# Web Time Machine — iOS Safari Web Extension

The iOS app is a thin Safari Web Extension wrapper around the **same** capture/sync
JavaScript as the Chrome extension. `build.mjs` re-bundles `extension-chrome/src`
with the platform define set to `safari-ios`, so devices register as
`Safari on iPhone/iPad` and everything else is shared.

## 1. Build the web-extension resources

```bash
pnpm --filter @wtm/extension-chrome icons   # if icons/ not generated yet
pnpm --filter @wtm/extension-safari build    # -> extension-safari/wtm-extension/
```

## 2. Generate the Xcode project (needs full Xcode)

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
3. Run on the iOS Simulator or a device. On device: **Settings → Safari → Extensions
   → Web Time Machine → Enable**, allow on All Websites, then open the popup and log in.
4. Archive (Product → Archive) and upload to **App Store Connect**:
   - **Apple ID:** 6477404511
   - **SKU:** wtm2
   - **Bundle id:** com.ttt246llc.wtm

## Notes / Safari caveats

- Re-run steps 1–2 whenever the shared JS changes (or just rebuild and re-copy
  `wtm-extension/` into the Xcode project's Resources).
- Safari supports the `chrome.*` namespace, `storage`, `alarms`, content scripts,
  and an MV3 `service_worker`, so the shared code runs as-is. If a future Safari
  version balks at the module service worker, switch `manifest.json` background to
  `{"scripts":["background.js"],"persistent":false}` and rebuild `background.js` as
  an IIFE.
- Set the backend URL in the popup just like the Chrome extension.
