// Chrome (MV3): ESM module background worker. Shared pipeline in ../scripts.
import { build } from "esbuild";
import { buildExtension } from "../scripts/build-extension.mjs";

await buildExtension(build, {
  outdir: "dist",
  platform: "chrome",
  target: "chrome111",
  backgroundFormat: "esm",
  chromeDir: ".",
  label: "Chrome extension",
});
