// URL policy shared by capture (on-device) and ingest (Worker). Deliberately
// DOM-free so the backend can import it without pulling in Readability types.

const SKIP_URL_SCHEMES = [
  "about:",
  "chrome:",
  "chrome-extension:",
  "moz-extension:",
  "edge:",
  "view-source:",
  "devtools:",
];

// Web Time Machine's own surfaces. The dashboard renders other pages' text and
// summaries, so capturing it feeds search results back into the index.
const SKIP_HOSTS = ["webtm.io", "api.webtm.io", "webtimemachine.io"];

// Query parameters whose values are credentials rather than page identity.
// Compared case-insensitively and exactly, so ordinary params (`v`, `q`,
// `utm_source`) are never touched.
const CREDENTIAL_PARAMS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "code",
  "id_token",
  "key",
  "password",
  "pwd",
  "refresh_token",
  "secret",
  "session",
  "session_id",
  "sessionid",
  "sig",
  "signature",
  "token",
]);

const REDACTED = "REDACTED";

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith("." + domain);
}

/** Heuristic: should this URL be captured at all? */
export function isCapturableUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
  if (SKIP_URL_SCHEMES.some((s) => lower.startsWith(s))) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return !SKIP_HOSTS.some((d) => hostMatches(host, d));
  } catch {
    return false;
  }
}

/**
 * Strip credentials out of a URL before it is ever stored: magic-link tokens,
 * API keys, and OAuth codes routinely ride in query parameters and fragments,
 * and a browsing history should not double as a searchable credential store.
 *
 * Only the secret *values* are replaced, so the URL stays readable, findable,
 * and mostly usable. Fragments are rewritten only when they carry `key=value`
 * pairs — that is where SPA tokens hide; plain anchors like `#climate` survive.
 */
export function redactUrlCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // not parseable — leave exactly as captured
  }
  let touched = false;

  for (const name of [...parsed.searchParams.keys()]) {
    if (CREDENTIAL_PARAMS.has(name.toLowerCase()) && parsed.searchParams.get(name)) {
      parsed.searchParams.set(name, REDACTED);
      touched = true;
    }
  }

  const fragment = parsed.hash.replace(/^#/, "");
  if (fragment.includes("=")) {
    const pairs = new URLSearchParams(fragment);
    let fragmentTouched = false;
    for (const name of [...pairs.keys()]) {
      if (CREDENTIAL_PARAMS.has(name.toLowerCase()) && pairs.get(name)) {
        pairs.set(name, REDACTED);
        fragmentTouched = true;
      }
    }
    if (fragmentTouched) {
      parsed.hash = "#" + pairs.toString();
      touched = true;
    }
  }

  return touched ? parsed.toString() : url;
}
