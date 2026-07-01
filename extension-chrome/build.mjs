// Bundles the Chrome (MV3) extension into dist/ with esbuild.
// Content script -> IIFE (classic), background -> ESM module worker, popup -> IIFE.
import { build } from "esbuild";
import { cp, mkdir, rm, access } from "node:fs/promises";

const outdir = "dist";
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  target: "chrome111",
  logLevel: "info",
  define: { __WTM_PLATFORM__: JSON.stringify("chrome") },
};

await build({ ...common, entryPoints: { content: "src/content.ts" }, format: "iife", outfile: `${outdir}/content.js` });
await build({ ...common, entryPoints: { background: "src/background.ts" }, format: "esm", outfile: `${outdir}/background.js` });
await build({ ...common, entryPoints: { popup: "src/popup.ts" }, format: "iife", outfile: `${outdir}/popup.js` });

await cp("manifest.json", `${outdir}/manifest.json`);
await cp("src/popup.html", `${outdir}/popup.html`);
await cp("src/popup.css", `${outdir}/popup.css`);

try {
  await access("icons");
  await cp("icons", `${outdir}/icons`, { recursive: true });
} catch {
  console.warn("! icons/ not found — run `pnpm --filter @wtm/extension-chrome icons` to generate them");
}

console.log(`✅ built extension -> ${outdir}/`);
