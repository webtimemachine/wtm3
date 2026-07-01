// Builds the Safari web-extension resources by reusing the Chrome extension's
// source (content/background/popup) with the platform define set to "safari-ios".
// Output goes to wtm-extension/, which `convert.sh` feeds to the Xcode converter.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const CHROME = "../extension-chrome";
const outdir = "wtm-extension";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: false, // no source maps in the shipped Safari extension resources
  target: "safari16",
  logLevel: "info",
  define: { __WTM_PLATFORM__: JSON.stringify("safari-ios") },
};

await build({ ...common, entryPoints: { content: `${CHROME}/src/content.ts` }, format: "iife", outfile: `${outdir}/content.js` });
// Safari: classic (non-module) service worker — avoids the unsupported `type: module`.
await build({ ...common, entryPoints: { background: `${CHROME}/src/background.ts` }, format: "iife", outfile: `${outdir}/background.js` });
await build({ ...common, entryPoints: { popup: `${CHROME}/src/popup.ts` }, format: "iife", outfile: `${outdir}/popup.js` });

await cp("manifest.json", `${outdir}/manifest.json`);
await cp(`${CHROME}/src/popup.html`, `${outdir}/popup.html`);
await cp(`${CHROME}/src/popup.css`, `${outdir}/popup.css`);
await cp(`${CHROME}/icons`, `${outdir}/icons`, { recursive: true });

console.log(`✅ built Safari web extension -> ${outdir}/`);
console.log("   Next: pnpm --filter @wtm/extension-safari convert  (needs full Xcode)");
