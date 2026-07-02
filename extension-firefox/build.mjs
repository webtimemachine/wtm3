// Firefox for Android (MV2): classic background script, browser→chrome shim.
// Shared pipeline in ../scripts.
import { build } from "esbuild";
import { buildExtension } from "../scripts/build-extension.mjs";

await buildExtension(build, {
  outdir: "dist",
  platform: "firefox-android",
  target: "firefox109",
  banner: { js: "var chrome = globalThis.browser || globalThis.chrome;" },
  label: "Firefox Android extension",
});
