// Builds the Firefox for Android WebExtension by reusing the Chrome extension's
// shared source. Firefox Android still accepts Manifest V2, so the output uses a
// classic background script and browser_action manifest shape.
import { build } from "esbuild";
import { access, cp, mkdir, rm } from "node:fs/promises";

const CHROME = "../extension-chrome";
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  target: "firefox109",
  logLevel: "info",
  define: { __WTM_PLATFORM__: JSON.stringify("firefox-android") },
  banner: {
    js: "var chrome = globalThis.browser || globalThis.chrome;",
  },
};

await build({ ...common, entryPoints: { content: `${CHROME}/src/content.ts` }, format: "iife", outfile: `${outdir}/content.js` });
await build({ ...common, entryPoints: { background: `${CHROME}/src/background.ts` }, format: "iife", outfile: `${outdir}/background.js` });
await build({ ...common, entryPoints: { popup: `${CHROME}/src/popup.ts` }, format: "iife", outfile: `${outdir}/popup.js` });

await cp("manifest.json", `${outdir}/manifest.json`);
await cp(`${CHROME}/src/popup.html`, `${outdir}/popup.html`);
await cp(`${CHROME}/src/popup.css`, `${outdir}/popup.css`);

try {
  await access(`${CHROME}/icons`);
  await cp(`${CHROME}/icons`, `${outdir}/icons`, { recursive: true });
} catch {
  console.warn("! extension-chrome/icons/ not found - run `pnpm --filter @wtm/extension-chrome icons` first");
}

console.log(`built Firefox Android extension -> ${outdir}/`);
