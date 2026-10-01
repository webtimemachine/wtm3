import { captureXPostsFromDocument } from "@wtm/shared/capture";
import type { CapturedPage } from "@wtm/shared";

interface CaptureAck {
  ok?: boolean;
  skipped?: boolean;
}

const SCAN_DELAY = 500;
const POLL_MS = 2500;
const MAX_REMEMBERED_POSTS = 2000;

/** Observe rendered posts, including recycled feed cells and expanded text. */
export function startXCapture(
  doc: Document,
  getUrl: () => string,
  send: (page: CapturedPage) => Promise<CaptureAck | undefined>,
): () => void {
  const records = new Map<string, { id: string; visitedAt: number; signature: string; text: string }>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function isVisible(post: Element): boolean {
    if (post.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = post.getBoundingClientRect();
    const view = doc.defaultView;
    if (!view || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0
      || rect.right <= 0 || rect.top >= view.innerHeight || rect.left >= view.innerWidth) return false;
    let top = Math.max(0, rect.top);
    let bottom = Math.min(view.innerHeight, rect.bottom);
    let left = Math.max(0, rect.left);
    let right = Math.min(view.innerWidth, rect.right);
    for (let element: Element | null = post; element; element = element.parentElement) {
      const style = view.getComputedStyle(element);
      if (style.visibility === "hidden" || style.visibility === "collapse"
        || style.display === "none" || style.opacity === "0") return false;
      if (element === post) continue;
      const bounds = element.getBoundingClientRect();
      if (/^(?:auto|scroll|hidden|clip)$/.test(style.overflowY)) {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
      if (/^(?:auto|scroll|hidden|clip)$/.test(style.overflowX)) {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
    }
    return top < bottom && left < right;
  }

  function scan(): void {
    timer = undefined;
    if (stopped || doc.visibilityState === "hidden") return;
    for (const capture of captureXPostsFromDocument(doc, getUrl(), isVisible)) {
      const signature = JSON.stringify([capture.title, capture.text, capture.byline, capture.lang]);
      let record = records.get(capture.url);
      if (pending.has(capture.url) || record?.signature === signature) continue;
      // A recycled cell can show the truncated version of an expanded post.
      // Keep the fuller capture when the new text is just its shorter prefix.
      const prefix = capture.text.replace(/(?:…|\.\.\.)$/, "").trimEnd();
      if (record && record.text.length > capture.text.length && record.text.startsWith(prefix)) continue;
      if (!record) {
        record = { id: crypto.randomUUID(), visitedAt: Date.now(), signature: "", text: "" };
        records.set(capture.url, record);
      }
      const current = record;
      pending.add(capture.url);
      // Reuse the ID when text expands, even if the first version already synced.
      // Failed/disabled captures stay eligible for the next scan.
      void Promise.resolve().then(() => send({ ...capture, id: current.id, visitedAt: current.visitedAt }))
        .then((ack) => {
          if (ack?.ok && !ack.skipped) {
            current.signature = signature;
            current.text = capture.text;
          }
        })
        .catch(() => { /* Extension reloaded, or storage unavailable: retry later. */ })
        .finally(() => pending.delete(capture.url));
      while (records.size > MAX_REMEMBERED_POSTS) records.delete(records.keys().next().value!);
    }
  }

  // Throttle rather than trailing-edge debounce: continuously changing feeds
  // still get scanned, at most twice a second.
  function schedule(): void {
    if (!stopped && timer === undefined) timer = setTimeout(scan, SCAN_DELAY);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href", "datetime", "data-testid", "dir", "hidden"],
  });
  doc.addEventListener("scroll", schedule, { passive: true, capture: true });
  doc.addEventListener("visibilitychange", schedule);
  doc.defaultView?.addEventListener("resize", schedule);
  // Also catches SPA routes and retries when the background worker recovers.
  const poll = setInterval(schedule, POLL_MS);
  schedule();

  return () => {
    stopped = true;
    observer.disconnect();
    clearTimeout(timer);
    clearInterval(poll);
    doc.removeEventListener("scroll", schedule, true);
    doc.removeEventListener("visibilitychange", schedule);
    doc.defaultView?.removeEventListener("resize", schedule);
  };
}
