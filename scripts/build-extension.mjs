// The one extension bundler. All three browser extensions (Chrome MV3,
// Firefox for Android MV2, iOS Safari) are builds of extension-chrome/src with
// per-platform knobs; each package's build.mjs is a thin config wrapper around
// this so the pipelines can't drift apart.
//
// The caller passes its own esbuild `build` function so module resolution
// stays inside the calling package (esbuild is a per-package dependency).
import { access, cp, mkdir, rm } from "node:fs/promises";

export async function buildExtension(build, opts) {
  const {
    outdir,
    platform, // __WTM_PLATFORM__ define: "chrome" | "firefox-android" | "safari-ios"
    target,
    backgroundFormat = "iife", // chrome uses "esm" (MV3 module worker)
    sourcemap = true, // safari ships without source maps
    banner, // firefox: browser→chrome shim
    chromeDir = "../extension-chrome", // chrome itself passes "."
    label = `${platform} extension`,
  } = opts;

  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const src = `${chromeDir}/src`;
  const common = {
    bundle: true,
    sourcemap,
    target,
    logLevel: "info",
    define: { __WTM_PLATFORM__: JSON.stringify(platform) },
    ...(banner ? { banner } : {}),
  };

  await build({ ...common, entryPoints: { content: `${src}/content.ts` }, format: "iife", outfile: `${outdir}/content.js` });
  await build({ ...common, entryPoints: { background: `${src}/background.ts` }, format: backgroundFormat, outfile: `${outdir}/background.js` });
  await build({ ...common, entryPoints: { popup: `${src}/popup.ts` }, format: "iife", outfile: `${outdir}/popup.js` });

  // Manifest is the caller's (platform-specific); popup assets are shared.
  await cp("manifest.json", `${outdir}/manifest.json`);
  await cp(`${src}/popup.html`, `${outdir}/popup.html`);
  await cp(`${src}/popup.css`, `${outdir}/popup.css`);

  try {
    await access(`${chromeDir}/icons`);
    await cp(`${chromeDir}/icons`, `${outdir}/icons`, { recursive: true });
  } catch {
    console.warn("! extension-chrome/icons/ not found — run `pnpm --filter @wtm/extension-chrome icons` first");
  }

  console.log(`✅ built ${label} -> ${outdir}/`);
}
