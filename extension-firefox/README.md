# Web Time Machine - Firefox for Android extension

Firefox for Android build of the Web Time Machine extension. It reuses the
Chrome extension source for capture, queueing, sync, auth, and popup UI,
but packages it as a Firefox-compatible Manifest V2 WebExtension.

## Build

```bash
pnpm --filter @wtm/extension-chrome icons   # if icons/ are not generated yet
pnpm --filter @wtm/extension-firefox build  # -> extension-firefox/dist/
pnpm --filter @wtm/extension-firefox package
```

The packaged archive is written to `extension-firefox/wtm-firefox-android.zip`.

## Android notes

- The build sets `browser_specific_settings.gecko_android.strict_min_version`
  for Firefox for Android.
- The shared TypeScript uses the `chrome.*` namespace; the Firefox bundle adds a
  small compatibility banner so it resolves to Firefox's `browser.*` APIs.
- Devices register with the backend as platform `firefox-android` and display as
  `Firefox on Android`.

## Local testing

Load `extension-firefox/dist/` as a temporary add-on in Firefox for Android using
Mozilla's Android extension debugging workflow, then start the website connection
from the toolbar popup. Sign in and approve it on `webtm.io`, reopen the popup,
and verify capture, queued sync, and the hosted-search link.
