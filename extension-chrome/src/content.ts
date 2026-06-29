// Content script: passively capture the readable text of the current page and
// hand it to the background worker. Never blocks or alters the page.
import { capturePageFromDocument, isCapturableUrl } from "@wtm/shared/capture";

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
        url,
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

setTimeout(attempt, CAPTURE_DELAY);

// Single-page-app navigations don't reload the content script; poll the URL.
let href = location.href;
setInterval(() => {
  if (location.href !== href) {
    href = location.href;
    setTimeout(attempt, CAPTURE_DELAY);
  }
}, POLL_MS);
