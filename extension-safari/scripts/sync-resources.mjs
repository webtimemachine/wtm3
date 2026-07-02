// Copies the built wtm-extension/ bundle into the committed Xcode Resources
// dir IN PLACE — never regenerate the Xcode project with convert.sh for a
// JS-only change (it wipes signing + Xcode Cloud config). CI runs this and
// fails if the committed copy is stale.
import { cp } from "node:fs/promises";

const SRC = "wtm-extension";
const DEST = "xcode/Web Time Machine/Web Time Machine Extension/Resources";
const FILES = ["background.js", "content.js", "popup.js", "popup.html", "popup.css", "manifest.json"];

for (const f of FILES) await cp(`${SRC}/${f}`, `${DEST}/${f}`);
await cp(`${SRC}/icons`, `${DEST}/icons`, { recursive: true });
console.log(`✅ synced ${FILES.length} files + icons -> ${DEST}`);
