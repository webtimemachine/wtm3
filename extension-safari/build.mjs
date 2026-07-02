// iOS Safari: classic (non-module) worker, no source maps in shipped resources.
// Output feeds the committed Xcode Resources dir via scripts/sync-resources.mjs.
// Shared pipeline in ../scripts.
import { build } from "esbuild";
import { buildExtension } from "../scripts/build-extension.mjs";

await buildExtension(build, {
  outdir: "wtm-extension",
  platform: "safari-ios",
  target: "safari16",
  sourcemap: false,
  label: "Safari web extension",
});

console.log("   Next: pnpm --filter @wtm/extension-safari sync-resources  (updates the committed Xcode Resources)");
