// Publish the Chrome extension via the Chrome Web Store API.
//   node scripts/cws-publish.mjs [upload|publish|deploy] [zipPath]
// Reads CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_ITEM_ID from env.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const { CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN } = process.env;
const ITEM_ID = process.env.CWS_ITEM_ID || "dfijieibikhpelmfhkjmihgfgpoeigch";
const cmd = process.argv[2] || "deploy"; // upload | publish | deploy(=upload+publish)
const zipPath = process.argv[3] || fileURLToPath(new URL("../wtm-chrome.zip", import.meta.url));

for (const [k, v] of Object.entries({ CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN })) {
  if (!v) {
    console.error(`Missing env ${k}. Set CWS_* in /Users/posix4e/src/.env (see cws-auth.mjs).`);
    process.exit(1);
  }
}

async function accessToken() {
  const body = new URLSearchParams({
    client_id: CWS_CLIENT_ID,
    client_secret: CWS_CLIENT_SECRET,
    refresh_token: CWS_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const j = await r.json();
  if (!j.access_token) {
    console.error("token error:", JSON.stringify(j));
    process.exit(1);
  }
  return j.access_token;
}

async function upload(token) {
  const zip = fs.readFileSync(zipPath);
  console.log(`uploading ${zipPath} (${zip.length} bytes) -> item ${ITEM_ID}`);
  const r = await fetch(`https://www.googleapis.com/upload/chromewebstore/v1.1/items/${ITEM_ID}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "x-goog-api-version": "2" },
    body: zip,
  });
  const j = await r.json();
  console.log("upload result:", JSON.stringify(j));
  if (j.uploadState !== "SUCCESS") {
    console.error("upload did not succeed");
    process.exit(1);
  }
}

async function publish(token) {
  const r = await fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM_ID}/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "x-goog-api-version": "2", "Content-Length": "0" },
  });
  const j = await r.json();
  console.log("publish result:", JSON.stringify(j));
}

const token = await accessToken();
if (cmd === "upload" || cmd === "deploy") await upload(token);
if (cmd === "publish" || cmd === "deploy") await publish(token);
console.log(`✅ ${cmd} complete for item ${ITEM_ID}`);
