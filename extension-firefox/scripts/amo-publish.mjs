// Sign + publish the Firefox extension to addons.mozilla.org (AMO) via web-ext.
//   node scripts/amo-publish.mjs <listed|unlisted> [outDir]
// Reads AMO_JWT_ISSUER / AMO_JWT_SECRET from env (AMO API credentials:
//   addons.mozilla.org → Developer Hub → Manage API Keys).
//
//   listed   → submits the version for the public AMO listing (release).
//              NOTE: the listing must exist on AMO once (created on first manual
//              upload of gecko id web-time-machine@webtm.io); subsequent versions
//              are published by this step. AMO hosts the signed file — nothing is
//              downloaded locally.
//   unlisted → self-distribution: AMO signs the build and web-ext downloads the
//              signed .xpi. Pass an outDir to copy it to <outDir>/wtm-firefox.xpi
//              for hosting (used by the beta deploy).
//
// Expects the build to already exist in dist/ (run `pnpm --filter
// @wtm/extension-firefox build` first).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const channel = process.argv[2];
const outDir = process.argv[3];
if (channel !== "listed" && channel !== "unlisted") {
  console.error("usage: amo-publish.mjs <listed|unlisted> [outDir]");
  process.exit(1);
}

const { AMO_JWT_ISSUER, AMO_JWT_SECRET } = process.env;
for (const [k, v] of Object.entries({ AMO_JWT_ISSUER, AMO_JWT_SECRET })) {
  if (!v) {
    console.error(`Missing env ${k}. Set AMO_JWT_ISSUER/AMO_JWT_SECRET (AMO API key).`);
    process.exit(1);
  }
}

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = path.join(root, "dist");
const manifestPath = path.join(sourceDir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`No build at ${sourceDir} — run \`pnpm --filter @wtm/extension-firefox build\` first.`);
  process.exit(1);
}
const artifactsDir = path.join(root, "web-ext-artifacts");

// AMO rejects re-uploading an already-signed version. Beta (unlisted) builds set
// WTM_FIREFOX_VERSION to a unique value (e.g. 3.0.0.<run-number>) so each build
// signs cleanly. Listed releases leave it unset and use the committed version.
const versionOverride = process.env.WTM_FIREFOX_VERSION;
if (versionOverride) {
  const mf = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  mf.version = versionOverride;
  fs.writeFileSync(manifestPath, `${JSON.stringify(mf, null, 2)}\n`);
  console.log(`patched dist manifest version -> ${versionOverride}`);
}

const res = spawnSync(
  "npx",
  [
    "--yes",
    "web-ext@8",
    "sign",
    `--source-dir=${sourceDir}`,
    `--artifacts-dir=${artifactsDir}`,
    `--channel=${channel}`,
    `--api-key=${AMO_JWT_ISSUER}`,
    `--api-secret=${AMO_JWT_SECRET}`,
  ],
  { stdio: "inherit", cwd: root },
);
if (res.status !== 0) {
  console.error(`web-ext sign failed (exit ${res.status}).`);
  process.exit(res.status || 1);
}

// For self-distribution (unlisted) copy the produced .xpi to a stable hosting path.
if (channel === "unlisted" && outDir) {
  const xpi = fs.existsSync(artifactsDir)
    ? fs.readdirSync(artifactsDir).find((f) => f.endsWith(".xpi"))
    : undefined;
  if (!xpi) {
    console.error(`No signed .xpi produced in ${artifactsDir}.`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, "wtm-firefox.xpi");
  fs.copyFileSync(path.join(artifactsDir, xpi), dest);
  console.log(`copied signed xpi -> ${dest}`);
}

console.log(`✅ AMO ${channel} sign complete`);
