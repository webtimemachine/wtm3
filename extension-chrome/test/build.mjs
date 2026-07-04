// Pretest: bundle the real extension sources for Node, once per platform
// define, into test/.build/ (gitignored). PLATFORM is baked at build time via
// __WTM_PLATFORM__, so "test both platforms" means two bundles per entry.
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const outdir = `${here}/.build`;
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const PLATFORMS = ["chrome", "safari-ios"];
const ENTRIES = ["storage", "background"];

for (const platform of PLATFORMS) {
  for (const entry of ENTRIES) {
    await build({
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      target: "node20",
      logLevel: "warning",
      define: { __WTM_PLATFORM__: JSON.stringify(platform) },
      entryPoints: { [entry]: `${here}/../src/${entry}.ts` },
      outfile: `${outdir}/${entry}.${platform}.mjs`,
    });
  }
}
console.log(`built ${PLATFORMS.length * ENTRIES.length} test bundles -> test/.build/`);
