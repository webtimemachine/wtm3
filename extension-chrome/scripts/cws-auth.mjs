// One-time OAuth helper to get a Chrome Web Store API refresh token.
//   node scripts/cws-auth.mjs url            -> prints the consent URL
//   node scripts/cws-auth.mjs exchange <code> -> swaps the code for a refresh_token
// Needs CWS_CLIENT_ID (+ CWS_CLIENT_SECRET for exchange) in env.
const { CWS_CLIENT_ID, CWS_CLIENT_SECRET } = process.env;
const REDIRECT = "http://localhost"; // register this as an authorized redirect URI on the OAuth client
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const cmd = process.argv[2];

if (cmd === "url") {
  if (!CWS_CLIENT_ID) {
    console.error("Set CWS_CLIENT_ID first.");
    process.exit(1);
  }
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", CWS_CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  console.log(
    "\n1) Open this URL in a browser and approve:\n\n" +
      u.toString() +
      "\n\n2) It redirects to http://localhost/?code=... (the page won't load — that's fine).\n" +
      "   Copy the `code` value from the address bar, then run:\n" +
      "   node scripts/cws-auth.mjs exchange <code>\n",
  );
} else if (cmd === "exchange") {
  const code = process.argv[3];
  if (!CWS_CLIENT_ID || !CWS_CLIENT_SECRET || !code) {
    console.error("Usage: exchange <code>  (with CWS_CLIENT_ID and CWS_CLIENT_SECRET set)");
    process.exit(1);
  }
  const body = new URLSearchParams({
    code,
    client_id: CWS_CLIENT_ID,
    client_secret: CWS_CLIENT_SECRET,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const j = await r.json();
  if (!j.refresh_token) {
    console.error("No refresh_token returned:", JSON.stringify(j));
    process.exit(1);
  }
  console.log("\n✅ Add this to /Users/posix4e/src/.env:\n\nCWS_REFRESH_TOKEN=" + j.refresh_token + "\n");
} else {
  console.error("Usage: cws-auth.mjs url | exchange <code>");
  process.exit(1);
}
