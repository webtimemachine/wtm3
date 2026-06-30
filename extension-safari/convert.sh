#!/usr/bin/env bash
# Generate the iOS Xcode project for the Safari Web Extension from the built
# web-extension resources. Requires FULL Xcode (not just Command Line Tools):
#   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
RES="$DIR/wtm-extension"
OUT="$DIR/xcode"

if [ ! -d "$RES" ]; then
  echo "Build the web extension first:  pnpm --filter @wtm/extension-safari build" >&2
  exit 1
fi

# Prefer full Xcode without needing `sudo xcode-select` (DEVELOPER_DIR override).
if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  if [ -d /Applications/Xcode.app ]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
fi
if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "safari-web-extension-converter not found — install full Xcode (Xcode.app)." >&2
  exit 1
fi

rm -rf "$OUT"
xcrun safari-web-extension-converter "$RES" \
  --project-location "$OUT" \
  --app-name "Web Time Machine" \
  --bundle-identifier "com.ttt246llc.wtm" \
  --ios-only \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force

echo
echo "✅ Xcode project generated under: $OUT"
echo "   Open it in Xcode, set your Team / signing, then run on a simulator or device."
echo "   App Store Connect: SKU wtm2, Apple ID 6477404511, bundle id com.ttt246llc.wtm"
