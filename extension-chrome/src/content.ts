// Content script: passively capture the readable text of the current page and
// hand it to the background worker. Never blocks or alters the page.
import {
  capturePageFromDocument,
  isCapturableUrl,
  redactUrlCredentials,
} from "@wtm/shared/capture";

const CAPTURE_DELAY = 1500; // let late-rendering / SPA content settle
const POLL_MS = 2500; // detect client-side route changes

let lastCapturedUrl = "";

function attempt(): void {
  const url = location.href;
  if (!isCapturableUrl(url) || url === lastCapturedUrl) return;
  const res = capturePageFromDocument(document);
  if (!res || !res.text) return;
  lastCapturedUrl = url;
  try {
    chrome.runtime.sendMessage({
      type: "capture",
      page: {
        // Credentials are stripped here, on-device, so they are never sent.
        url: redactUrlCredentials(url),
        title: res.title,
        visitedAt: Date.now(),
        text: res.text,
        excerpt: res.excerpt,
        byline: res.byline,
        lang: res.lang,
      },
    });
  } catch {
    // Extension was reloaded/updated — context invalidated; ignore.
  }
}

// Bounded retries so late-rendering / SPA pages get captured once content lands.
// attempt() no-ops once this URL is captured, so the extra timers are cheap.
const RETRY_DELAYS = [CAPTURE_DELAY, 3500, 7000, 12000];
function scheduleCaptures(): void {
  for (const d of RETRY_DELAYS) setTimeout(attempt, d);
}
scheduleCaptures();

// Single-page-app navigations don't reload the content script; poll the URL and
// re-run the bounded attempts when the route changes.
let href = location.href;
setInterval(() => {
  if (location.href !== href) {
    href = location.href;
    scheduleCaptures();
  }
}, POLL_MS);
